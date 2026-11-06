import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
process.env.TOGLE_TEST_USER_DATA = path.join(import.meta.dirname, '.work', 'meeting-notes-' + process.pid)
mkdirSync(process.env.TOGLE_TEST_USER_DATA, { recursive: true })
const { CallSessions, MeetingNotes, meetingNoteChunks, CallLearning, emptyLessons, exportCall, sessionSummary } = await import('./.build/togle.mjs')
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
let sequence = 0
const info = id => ({ id, agentId: 'work', agentName: 'Team', accountId: 'claude-work', startedAt: 1000, endedAt: 100000, status: 'ended' })
const state = () => ({ transcript: [{ id: 'denis', speaker: 'them', text: 'I will send the incident report by Friday.', at: 240000, end: 245000, voiceName: 'Denis', voiceNamedBy: 'user' }], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: 'Engineering sync', group: true })
async function fixture(complete = async () => '## Action items\n- Denis: send the incident report by Friday. [3:59]') {
  const sessions = new CallSessions(), id = 'notes-' + ++sequence, input = []
  await sessions.capture(info(id), 'frames', state())
  const provider = { stream: async (request, handlers) => { input.push(request); handlers.onFinal(await complete(request)) } }
  const notes = new MeetingNotes(sessions, record => { assert.equal(record.accountId, 'claude-work'); return provider })
  return { sessions, id, notes, input }
}

test('meeting notes generate from unreviewed transcripts without changing agent learning', async () => {
  const f = await fixture(), record = await f.notes.generate(f.id)
  assert.equal(record.minutes.state, 'ready'); assert.equal(record.learning.state, 'not-reviewed')
  assert.match(record.summary, /Denis/); assert.match(f.input[0].system, /owner or deadline only when explicitly stated/)
  assert.equal(f.input[0].lane, 'background'); assert.deepEqual(f.input[0].tools, [])
})

test('duplicate generation shares one request; automatic calls reuse notes for the same transcript', async () => {
  const blocked = deferred(), f = await fixture(() => blocked.promise)
  const first = f.notes.generate(f.id), second = f.notes.generate(f.id)
  assert.equal(first, second)
  blocked.resolve('## Summary\nThe report is due Friday. [3:59]')
  const saved = await first; await second
  assert.equal(f.input.length, 1)
  await f.notes.generate(f.id, undefined, undefined, true)
  assert.equal(f.input.length, 1); assert.equal(saved.minutes.edited, false)
})

test('saving edits during generation aborts the old request and protects the user’s version', async () => {
  const started = deferred(), late = deferred(), f = await fixture(() => { started.resolve(); return late.promise })
  const generating = f.notes.generate(f.id); await started.promise
  const current = await f.sessions.get(f.id)
  await f.notes.save(f.id, current.minutes.revision, 'My corrected meeting notes.')
  late.resolve('Late AI notes must not replace the user.')
  await generating
  const saved = await f.sessions.get(f.id)
  assert.equal(saved.summary, 'My corrected meeting notes.'); assert.equal(saved.minutes.edited, true)
  await f.notes.generate(f.id, undefined, undefined, true); assert.equal(f.input.length, 1)
})

test('stale note editors cannot overwrite newer edits and capture preserves edited notes', async () => {
  const f = await fixture(), generated = await f.notes.generate(f.id)
  await f.notes.save(f.id, generated.minutes.revision, 'First editor’s notes.')
  await assert.rejects(f.notes.save(f.id, generated.minutes.revision, 'Stale editor.'), /changed/)
  await f.sessions.capture(info(f.id), 'frames', state())
  assert.equal((await f.sessions.get(f.id)).summary, 'First editor’s notes.')
  assert.equal((await f.sessions.get(f.id)).minutes.edited, true)
})

test('a resumed call prevents an earlier notes response replacing the current call state', async () => {
  const started = deferred(), late = deferred(), f = await fixture(() => { started.resolve(); return late.promise })
  const generating = f.notes.generate(f.id); await started.promise
  await f.sessions.capture({ ...info(f.id), status: 'live', endedAt: undefined }, 'frames', state())
  late.resolve('An outdated summary.')
  const record = await generating
  assert.equal(record.status, 'live'); assert.equal(record.summary, ''); assert.equal(record.minutes.state, 'idle')
})

test('automatic note generation pauses for live work and retries after the pause', async () => {
  const started = deferred(), late = deferred(), f = await fixture(() => { started.resolve(); return late.promise })
  const first = f.notes.generate(f.id, undefined, undefined, true); await started.promise
  f.notes.pauseAutomatic(); const paused = await first
  assert.equal(paused.minutes.state, 'idle')
  late.resolve('A complete retry.')
  const result = await f.notes.generate(f.id, undefined, undefined, true)
  assert.equal(result.minutes.state, 'ready'); assert.equal(result.summary, 'A complete retry.')
})

test('provider failures are saved visibly and can be retried without losing prior notes', async () => {
  let fail = true
  const f = await fixture(async () => { if (fail) throw Error('Subscription limit'); return 'Retry notes.' })
  await assert.rejects(f.notes.generate(f.id), /Subscription limit/)
  const failed = await f.sessions.get(f.id)
  assert.equal(failed.minutes.state, 'error'); assert.match(failed.minutes.error, /Subscription limit/)
  await f.notes.generate(f.id, undefined, undefined, true); assert.equal(f.input.length, 1, 'automatic retries cannot burn allowance on the same failed input')
  fail = false; const result = await f.notes.generate(f.id, 'concise', failed.minutes.revision)
  assert.equal(result.summary, 'Retry notes.')
})

test('long calls include every line, use bounded chunks, and keep the provider pinned for the merge', async () => {
  const f = await fixture()
  const long = state(); long.transcript = Array.from({ length: 40 }, (_, n) => ({ ...long.transcript[0], id: 'line-' + n, text: `Point ${n}: ` + 'discussion '.repeat(250) }))
  await f.sessions.capture(info(f.id), 'frames', long)
  const record = await f.sessions.get(f.id), chunks = meetingNoteChunks(record)
  assert.ok(chunks.length > 1); assert.ok(chunks.every(part => part.length <= 60000))
  const joined = chunks.join(''); for (let n = 0; n < 40; n++) assert.ok(joined.includes(`Point ${n}:`))
  let selected = 'work', pins = 0; const seen = []
  const notes = new MeetingNotes(f.sessions, () => { pins++; const account = selected; return { stream: async (input, handlers) => { selected = 'personal'; seen.push({ account, input }); handlers.onFinal('Notes with [3:59] evidence.') } } })
  await notes.generate(f.id)
  assert.equal(pins, 1); assert.ok(seen.every(item => item.account === 'work')); assert.equal(seen.length, chunks.length + 1)
  assert.match(seen.at(-1).input.user, /Merge these notes/)
})

test('personal notes are editable, included as a distinct source, exported, and omitted from the lightweight index', async () => {
  const f = await fixture()
  await f.notes.savePersonal(f.id, '', 'My observation: ask for the incident timeline.')
  await assert.rejects(f.notes.savePersonal(f.id, '', 'Stale personal notes'), /changed/)
  const saved = await f.notes.generate(f.id)
  assert.match(f.input[0].user, /My observation/); assert.match(exportCall(saved), /## My notes/)
  assert.equal(sessionSummary(saved).personalNotes, undefined)
  await f.sessions.capture(info(f.id), 'frames', state())
  assert.match((await f.sessions.get(f.id)).personalNotes, /incident timeline/)
})

test('learning reviews preserve generated and manually edited meeting notes', async () => {
  const f = await fixture(), generated = await f.notes.generate(f.id)
  await f.notes.save(f.id, generated.minutes.revision, 'My meeting notes.')
  const agent = { id: 'work', learning: 'off', history: [], memory: [], answers: [], skills: [], aboutMe: '', instructions: '' }
  const learning = new CallLearning(f.sessions, { agent: () => agent, apply: async () => agent, review: async () => ({ ...emptyLessons(), agentId: 'work', record: { summary: 'A separate learning summary.' } }) })
  await learning.review(f.id)
  assert.equal((await f.sessions.get(f.id)).summary, 'My meeting notes.')
})

test('deletion during generation cannot recreate a call or its notes', async () => {
  const started = deferred(), late = deferred(), f = await fixture(() => { started.resolve(); return late.promise })
  const generating = f.notes.generate(f.id); const failed = assert.rejects(generating, /no longer|deleted/)
  await started.promise; await f.sessions.remove(f.id); late.resolve('Deleted call notes.')
  await failed; assert.equal(await f.sessions.get(f.id), null)
})

test('restart recovers an interrupted notes job without changing its transcript or learning state', async () => {
  const f = await fixture()
  await f.sessions.update(f.id, record => ({ ...record, minutes: { template: 'concise', state: 'generating', revision: 'interrupted' } }))
  const fresh = new CallSessions(); await fresh.list(); const restored = await fresh.get(f.id)
  assert.equal(restored.minutes.state, 'error'); assert.match(restored.minutes.error, /interrupted/)
  assert.equal(restored.transcript.length, 1); assert.equal(restored.learning.state, 'not-reviewed')
})

test('a saved call retains its original subscription account across captures and updates', async () => {
  const f = await fixture()
  await assert.rejects(f.sessions.capture({ ...info(f.id), accountId: 'personal' }, 'frames', state()), /subscription account/)
  await f.sessions.capture({ ...info(f.id), accountId: undefined }, 'frames', state())
  const result = await f.sessions.update(f.id, record => ({ ...record, accountId: 'personal' }))
  assert.equal(result.accountId, 'claude-work')
})
