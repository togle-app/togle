import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

workDir('call-performance')
const { CallSessions, emptyLessons, reviewAfterCall } = await import('./.build/togle.mjs')
const info = id => ({ id, agentId: 'agent', agentName: 'General', startedAt: 1000, endedAt: 2000, status: 'ended' })
const state = () => ({ transcript: [{ id: 'line', speaker: 'them', text: 'Send the report Tuesday.', at: 1000, end: 2000 }], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: '', group: false })

test('repeated and concurrent inspection decrypts a call once and returns independent values', async () => {
  const writer = new CallSessions()
  await writer.capture(info('hot-call'), 'frames', state())
  const repo = new CallSessions()
  await repo.list()
  const decrypt = electron.safeStorage.decryptString
  let reads = 0
  electron.safeStorage.decryptString = buffer => { reads++; return decrypt(buffer) }
  try {
    const records = await Promise.all(Array.from({ length: 12 }, () => repo.get('hot-call')))
    assert.equal(reads, 1)
    records[0].transcript[0].text = 'Changed in the renderer'
    records[0].learning.pending.facts.push('Unapproved')
    assert.equal(records[1].transcript[0].text, 'Send the report Tuesday.')
    const next = await repo.get('hot-call')
    assert.deepEqual(next.learning.pending.facts, [])
    assert.equal(next.transcript[0].text, 'Send the report Tuesday.')
    assert.equal(reads, 1)
  } finally { electron.safeStorage.decryptString = decrypt }
})

test('capture takes an immediate content snapshot while avoiding unused screen frame state', async () => {
  const repo = new CallSessions()
  const owner = info('snapshot-call')
  const call = state()
  call.callAnswers.push({ question: 'When?', answer: 'Tuesday', reviewed: false })
  const view = { reviewedLines: 0, cards: [{ id: 'reply', kind: 'suggest', text: 'Tuesday.', deep: { text: 'Confirm the owner.' }, at: 1500 }] }
  const pending = repo.capture(owner, 'frames', call, view)
  owner.id = 'wrong-call'
  owner.agentName = 'Changed'
  call.transcript[0].text = 'Later words'
  call.callAnswers[0].answer = 'Friday'
  view.cards[0].deep.text = 'Later deep answer'
  const saved = await pending
  assert.equal(saved.id, 'snapshot-call')
  assert.equal(saved.agentName, 'General')
  assert.equal(saved.transcript[0].text, 'Send the report Tuesday.')
  assert.equal(saved.callAnswers[0].answer, 'Tuesday')
  assert.equal(saved.suggestions[0].deep, 'Confirm the owner.')
  assert.equal(saved.frames, undefined)
})

test('inspecting many calls evicts old cached content and preserves every archive on disk', async () => {
  const repo = new CallSessions()
  for (let index = 0; index < 12; index++) await repo.capture(info('evict-' + index), 'frames', state())
  const decrypt = electron.safeStorage.decryptString
  let reads = 0
  electron.safeStorage.decryptString = buffer => { reads++; return decrypt(buffer) }
  try {
    const old = await repo.get('evict-0')
    assert.equal(old.transcript[0].text, 'Send the report Tuesday.')
    assert.equal(reads, 1, 'an old archive is read from disk instead of accumulating forever in memory')
    await repo.get('evict-0')
    assert.equal(reads, 1, 'the inspected call is reused')
    assert.ok((await repo.list()).some(call => call.id === 'evict-11'))
  } finally { electron.safeStorage.decryptString = decrypt }
})

test('a failed index write cannot leave stale cached call content or poison later saves', async () => {
  const repo = new CallSessions()
  await repo.capture(info('failed-index'), 'frames', state())
  const encrypt = electron.safeStorage.encryptString
  electron.safeStorage.encryptString = text => {
    if (Array.isArray(JSON.parse(text))) throw new Error('Simulated index write failure')
    return encrypt(text)
  }
  try { await assert.rejects(repo.rename('failed-index', 'A committed record'), /index write failure/) }
  finally { electron.safeStorage.encryptString = encrypt }
  assert.equal((await repo.get('failed-index')).title, 'A committed record')
  await repo.rename('failed-index', 'Recovered save')
  assert.equal((await new CallSessions().get('failed-index')).title, 'Recovered save')
})

test('archive refreshes preserve unchanged reviews and update only a new approval revision', () => {
  const review = { state: 'learned', sessionId: 'call', reviewId: 'revision-one', changes: [], left: [], held: { ...emptyLessons(), facts: ['Ask for the operating system.'] } }
  const record = { id: 'call', learning: { reviewId: 'revision-one', pending: review.held, changes: [] } }
  assert.equal(reviewAfterCall(review, record), review, 'unchanged review must not trigger conversation persistence')
  record.learning = { reviewId: 'revision-two', pending: emptyLessons(), changes: [{ id: 'kept', text: 'Remembered a fact' }] }
  const approved = reviewAfterCall(review, record)
  assert.equal(approved.decided, true)
  assert.equal(approved.held, undefined)
  assert.deepEqual(approved.changes, ['kept'])
  assert.equal(reviewAfterCall(approved, record), approved)
  const removed = reviewAfterCall(review, null)
  assert.equal(removed.decided, true)
  assert.equal(removed.held, undefined)
  assert.equal(reviewAfterCall(removed, null), removed, 'a deleted record must settle only once')
})
