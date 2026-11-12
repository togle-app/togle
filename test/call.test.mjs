// The call saved as it goes: closing Togle or a crash doesn't lose it, and it comes back when Togle starts.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { ongoingCall, workDir } from './helpers.mjs'

const work = workDir('call')
const { CallFile, OngoingCall } = await import('./.build/togle.mjs')
const saved = path.join(work, 'call.bin')

const line = (speaker, text, at) => ({ id: `${speaker}-${at}`, speaker, text, at, end: at + 2000 })
const state = (transcript, extra = {}) => ({ transcript, ...extra })

test('the call is saved encrypted, comes back as it was, and Clear deletes it', async () => {
  const call = state([line('them', 'What does the Growth plan cost?', 1000), line('me', 'Thirty-nine euros a seat.', 4000)], { toldOthers: 2000, marks: [3000] })
  const file = new CallFile(() => ({ frameSession: 'call-1', state: call }))
  file.changed()
  await file.flush()
  assert.ok(existsSync(saved))
  // Through the OS keystore, as the ChatGPT sign-in is (the tests' stand-in only marks it).
  assert.ok(readFileSync(saved, 'utf8').startsWith('ENC:'), 'written encrypted')
  const back = await new CallFile(() => null).load()
  assert.equal(back.frameSession, 'call-1')
  assert.deepEqual(back.state, call)
  await file.clear()
  assert.equal(existsSync(saved), false)
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a change is saved a moment later, and a call with nothing in it leaves no file', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let call = state([line('them', 'Hello?', 1000)])
  const file = new CallFile(() => (call.transcript.length ? { frameSession: 's', state: call } : null))
  file.changed()
  assert.equal(file.pending, true)
  t.mock.timers.tick(2000)
  await file.flush()
  assert.equal(existsSync(saved), true)
  call = state([])
  file.changed()
  await file.flush()
  assert.equal(existsSync(saved), false)
})

test('a call saved days ago is not picked up again', async (t) => {
  const file = new CallFile(() => ({ frameSession: 's', state: state([line('them', 'Hello?', 1000)]) }))
  file.changed()
  await file.flush()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 24 * 3600_000 })
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a call saved by an earlier version, with what its call assistant kept, comes back with what is kept now', async () => {
  const older = { transcript: [line('them', 'Is there a trial?', 1000)], frames: [{ id: 'f1', n: 1, at: 1500 }], notes: 'A trial was asked about.', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: 'Acme renewal', toldOthers: 1200, marks: [1300] }
  const file = new CallFile(() => ({ frameSession: 'older', state: older }))
  file.changed()
  file.flushSync()
  const back = await new CallFile(() => null).load()
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.restore(back.state)
  assert.deepEqual(ongoing.callState(), { transcript: older.transcript, toldOthers: 1200, marks: [1300] })
})

test('every change to the call reaches the saving', () => {
  const changes = []
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.onChange = () => changes.push(true)
  ongoing.setListening(true)
  ongoing.add('them', 'Hello there.', Date.now() - 1000, Date.now())
  ongoing.mark()
  ongoing.setToldOthers(true)
  assert.equal(changes.length, 3)
})

test('closing waits for a save still being written; Windows shutting down saves at once', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T10:00:00Z') })
  let call = state([line('them', 'Is there a trial?', 1000)])
  const file = new CallFile(() => ({ frameSession: 's', state: call }))
  file.changed()
  const writing = file.flush()
  assert.equal(file.pending, true, 'still being written')
  await writing
  assert.equal(file.pending, false)
  // Togle starts two days later: the call is as old as it was.
  t.mock.timers.setTime(Date.parse('2026-10-22T10:00:00Z'))
  const later = new CallFile(() => ({ frameSession: 's', state: call }))
  assert.equal((await later.load()).savedAt, Date.parse('2026-10-20T10:00:00Z'))
  // Windows shutting down: saved at once.
  call = state([...call.transcript, line('me', 'Yes, fourteen days.', 4000)])
  later.changed()
  later.flushSync()
  const now = await new CallFile(() => null).load()
  assert.equal(now.state.transcript.length, 2)
  assert.equal(now.savedAt, Date.parse('2026-10-22T10:00:00Z'))
})

test('Windows shutting down while a save is still being written: the newest call is what stays', async () => {
  let call = state([line('them', 'Is there a trial?', 1000)])
  const file = new CallFile(() => ({ frameSession: 's', state: call }))
  file.changed()
  const writing = file.flush()
  // Said while that save was being written, then Windows stops Togle.
  call = state([line('them', 'Is there a trial?', 1000), line('me', 'Yes, fourteen days.', 4000)])
  file.changed()
  file.flushSync()
  assert.equal((await new CallFile(() => null).load()).state.transcript.length, 2, 'written at once')
  await writing
  await file.flush()
  assert.equal((await new CallFile(() => null).load()).state.transcript.length, 2, 'the older save, ending after, did not replace it')
})

test('a call cleared as Windows shuts down stays cleared: nothing saved meanwhile brings it back', async () => {
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.restore(state([line('them', 'Our budget is 40k, keep that between us.', 1000)]))
  const file = new CallFile(() => {
    const s = ongoing.callState()
    return s.transcript.length ? { frameSession: 's', state: s } : null
  })
  file.changed()
  await file.flush()
  // New call, as the window asks for it; Windows shuts down while the saved one is being deleted.
  const clearing = file.clear(async () => ongoing.clear())
  file.flushSync()
  await clearing
  await file.flush()
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a save that fails is tried again, and closing waits for that', async (t) => {
  const { safeStorage } = (await import('./electron.mjs')).default
  const call = state([line('them', 'Is there a trial?', 1000)])
  const file = new CallFile(() => ({ frameSession: 's', state: call }))
  const encrypt = safeStorage.encryptString
  safeStorage.encryptString = () => {
    throw new Error('The disk is full')
  }
  t.after(() => (safeStorage.encryptString = encrypt))
  file.changed()
  await file.flush()
  assert.equal(file.pending, true, 'still waiting to be saved')
  safeStorage.encryptString = encrypt
  await file.flush()
  assert.equal(file.pending, false)
  assert.equal((await new CallFile(() => null).load()).state.transcript.length, 1)
})
