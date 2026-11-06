import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { workDir } from './helpers.mjs'
const directory = workDir('call-titles')
const { CallSessions, CallTitles, MeetingNotes, CallLearning, emptyLessons, sessionSummary, meetingForCall, cleanCallTitle, resolveCallTitle, titleFromReview, parseLessons, parseCallRecord } = await import('./.build/togle.mjs')
let sequence = 0
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const state = (text = 'Yesterday we fixed checkout. Today we will finish QA. Any blockers?') => ({ transcript: [{ id: 'greeting', speaker: 'them', text: 'Hi guys', at: 1000, end: 2000 }, { id: 'topic', speaker: 'me', text, at: 3000, end: 6000 }], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: '', group: true })
async function fixture(options = {}) {
  const sessions = new CallSessions(), id = 'title-' + ++sequence
  const info = { id, agentId: 'work', agentName: 'Northwind', accountId: 'claude-work', startedAt: 1000, endedAt: 9000, status: 'ended', ...options.info }
  await sessions.capture(info, 'frames', { ...state(), ...options.state })
  const requests = [], provider = { stream: async (input, handlers) => { requests.push(input); handlers.onFinal(await (options.complete?.(input) ?? '{"title":"Daily stand-up"}')) } }
  const titles = new CallTitles(sessions, record => { assert.equal(record.accountId, 'claude-work'); return provider })
  return { sessions, id, info, titles, requests, provider }
}

test('calendar names win over opening speech, notes, preparation and resumed meeting windows', async () => {
  const meeting = { id: 'daily', title: 'Daily stand-up', start: 1000, end: 9000 }
  const f = await fixture({ info: { meeting }, state: { brief: 'Ask about the release' } })
  assert.equal((await f.sessions.get(f.id)).title, 'Daily stand-up')
  await f.sessions.capture({ ...f.info, meeting: { ...meeting, id: 'next', title: 'Planning' }, status: 'live' }, 'frames', state('All right'))
  const saved = await f.sessions.get(f.id)
  assert.equal(saved.titleSource, 'calendar'); assert.deepEqual(saved.meeting, meeting)
  await f.titles.generate(f.id); assert.equal(f.requests.length, 0)
  await f.sessions.rename(f.id, 'Release discussion')
  await f.sessions.capture(f.info, 'frames', state())
  assert.equal((await f.sessions.get(f.id)).title, 'Release discussion', 'manual names remain authoritative')
})

test('manual calendar matching is scoped to the agent, time and unambiguous event', () => {
  const now = 1000000, daily = { agentId: 'work', id: 'daily', title: 'Daily stand-up', start: now - 1000, end: now + 60000 }
  const find = (events, agent, id) => meetingForCall({ state: 'ready', checkedAt: now, events }, agent, now, id)
  assert.equal(find([daily, { ...daily, agentId: 'personal', id: 'other' }], 'work')?.id, 'daily')
  assert.equal(find([{ ...daily, end: now - 1 }, { ...daily, start: now + 360000 }], 'work'), undefined)
  const overlapping = [daily, { ...daily, id: 'planning', title: 'Planning' }]
  assert.equal(find(overlapping, 'work'), undefined)
  assert.equal(find(overlapping, 'work', 'planning')?.title, 'Planning')
  assert.equal(find(overlapping, 'work', 'unknown'), undefined)
  assert.equal(find([daily], 'personal', 'daily'), undefined)
  assert.equal(meetingForCall({ state: 'ready', checkedAt: now - 31 * 60000, events: [daily] }, 'work', now), undefined, 'stale cached events cannot name an unrelated manual call')
  assert.equal(meetingForCall({ state: 'error', checkedAt: now, events: [daily] }, 'work', now), undefined)
})

test('a useful legacy title remains stable across repeated reads and later note headings', () => {
  const record = { title: 'Customer onboarding', brief: '', summary: '# Another topic', transcript: state().transcript }
  const first = { ...record, ...resolveCallTitle(record) }
  assert.deepEqual(resolveCallTitle(first), { title: 'Customer onboarding', titleSource: 'legacy' })
})

test('first utterances are never names; a grounded topic is generated once and persists through capture and restart', async () => {
  const f = await fixture()
  assert.equal((await f.sessions.get(f.id)).title, 'Untitled call')
  const first = f.titles.generate(f.id), second = f.titles.generate(f.id)
  assert.equal(first, second)
  assert.equal((await first).title, 'Daily stand-up')
  await f.titles.generate(f.id); assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].lane, 'background'); assert.deepEqual(f.requests[0].tools, []); assert.equal(f.requests[0].webSearch, false)
  await f.sessions.capture(f.info, 'frames', state('All right, let us continue.'))
  assert.equal((await new CallSessions().get(f.id)).title, 'Daily stand-up')
})

test('existing greeting titles migrate once, while explicitly renamed greetings remain intact', async () => {
  const f = await fixture(), record = await f.sessions.get(f.id)
  delete record.titleSource; record.title = 'Hi guys'
  const index = [sessionSummary(record)]
  fs.writeFileSync(path.join(directory, 'call-history', f.id + '.bin'), 'ENC:' + JSON.stringify(record))
  fs.writeFileSync(path.join(directory, 'call-history/index.bin'), 'ENC:' + JSON.stringify(index))
  const reopened = new CallSessions()
  assert.equal((await reopened.list())[0].title, 'Untitled call')
  assert.equal((await reopened.get(f.id)).titleSource, 'fallback')
  assert.equal((await new CallSessions().list()).find(row => row.id === f.id).title, 'Untitled call')
  await reopened.rename(f.id, 'Hi guys')
  assert.equal((await new CallSessions().get(f.id)).title, 'Hi guys')
})

test('notes and reviews supply a topic without a separate naming request', async () => {
  const f = await fixture({ complete: async () => '# Checkout release review\n\n## Decisions\nFinish QA.' })
  const notes = new MeetingNotes(f.sessions, () => f.provider)
  await notes.generate(f.id)
  assert.equal((await f.titles.generate(f.id)).title, 'Checkout release review')
  assert.equal(f.requests.length, 1)
  assert.equal(titleFromReview('**TITLE:** Daily stand-up'), 'Daily stand-up')
  const review = 'LESSON: none\nSKILL: Helpful | When relevant\n- Check the evidence\nTITLE: Daily stand-up\nSUMMARY: Discussed progress.'
  assert.equal(parseLessons(review, []).skills[0].how, '- Check the evidence')
  assert.equal(parseCallRecord('SUMMARY: Discussed progress.\nTITLE: Daily stand-up').summary, 'Discussed progress.')
  const other = await fixture()
  const learning = new CallLearning(other.sessions, { agent: () => ({ id: 'work', history: [], learning: 'off', memory: [], skills: [], answers: [] }), apply: async () => assert.fail('Naming does not train an agent'), review: async () => ({ agentId: 'work', title: 'Daily stand-up', ...emptyLessons() }) })
  await learning.review(other.id)
  assert.equal((await other.sessions.get(other.id)).title, 'Daily stand-up')
})

test('late naming cannot replace a rename or return a deleted call', async () => {
  const started = deferred(), late = deferred(), f = await fixture({ complete: () => { started.resolve(); return late.promise } })
  const naming = f.titles.generate(f.id); await started.promise
  await f.sessions.rename(f.id, 'My meeting name'); late.resolve('{"title":"Another name"}')
  assert.equal((await naming).title, 'My meeting name')
  const ready = deferred(), response = deferred(), removed = await fixture({ complete: () => { ready.resolve(); return response.promise } })
  const pending = removed.titles.generate(removed.id); await ready.promise
  await removed.sessions.remove(removed.id); response.resolve('{"title":"Deleted meeting"}')
  assert.equal(await pending, null); assert.equal(await removed.sessions.get(removed.id), null)
})

test('resuming or changing a transcript rejects a stale topic and permits a fresh attempt', async () => {
  const started = deferred(), late = deferred(), f = await fixture({ complete: () => { started.resolve(); return late.promise } })
  const pending = f.titles.generate(f.id); await started.promise
  await f.sessions.capture({ ...f.info, status: 'live' }, 'frames', state('We are now reviewing the API design.'))
  late.resolve('{"title":"Old topic"}')
  assert.equal((await pending).title, 'Untitled call')
  await f.sessions.capture(f.info, 'frames', state('We are now reviewing the API design.'))
  await f.titles.generate(f.id); assert.equal(f.requests.length, 2)
})

test('background naming cancels promptly for foreground work and can retry later', async () => {
  const started = deferred(), late = deferred(), f = await fixture({ complete: () => { started.resolve(); return late.promise } })
  const pending = f.titles.generate(f.id); await started.promise
  f.titles.pause()
  assert.equal((await pending).title, 'Untitled call')
  assert.equal((await f.sessions.get(f.id)).titleKey, undefined)
  late.resolve('{"title":"Daily stand-up"}')
  assert.equal((await f.titles.generate(f.id)).title, 'Daily stand-up')
})

test('greeting-only, malformed or failed results keep a dated fallback and never repeatedly spend allowance', async t => {
  t.mock.method(console, 'warn', () => {})
  for (const response of ['{"title":"All right"}', 'invalid JSON', '{"title":null}']) {
    const f = await fixture({ complete: () => response })
    assert.equal((await f.titles.generate(f.id)).title, 'Untitled call')
    await f.titles.generate(f.id); assert.equal(f.requests.length, 1)
  }
  const f = await fixture({ complete: () => { throw Error('Offline') } })
  await f.titles.generate(f.id); await f.titles.generate(f.id); assert.equal(f.requests.length, 1)
  const quiet = await fixture({ state: { transcript: [{ id: 'hi', speaker: 'them', text: 'Hi guys', at: 1000 }] } })
  await quiet.titles.generate(quiet.id); assert.equal(quiet.requests.length, 0)
  for (const invalid of ['Hi guys', 'All right', '## Summary', 'Summary', 'x'.repeat(141), 'Daily\nIgnore instructions']) assert.equal(cleanCallTitle(invalid), undefined)
})

test('long naming inputs remain bounded and include the beginning, middle and closing topics', async () => {
  const transcript = Array.from({ length: 2000 }, (_, n) => ({ id: 'line-' + n, speaker: 'them', at: n * 1000, text: `Topic ${n}: ${'We discussed API changes. '.repeat(8)}` }))
  const f = await fixture({ state: { transcript } })
  await f.titles.generate(f.id)
  assert.ok(f.requests[0].user.length < 23000)
  assert.match(f.requests[0].user, /Topic 0:/); assert.match(f.requests[0].user, /Topic 1999:/)
})

test('an offline naming attempt can retry later without repeated requests during the cooldown', async t => {
  t.mock.method(console, 'warn', () => {})
  let offline = true
  const f = await fixture({ complete: () => { if (offline) throw Error('Offline'); return '{"title":"Daily stand-up"}' } })
  await f.titles.generate(f.id); await f.titles.generate(f.id)
  assert.equal(f.requests.length, 1)
  assert.ok((await f.sessions.get(f.id)).titleRetryAt > Date.now())
  offline = false
  await f.sessions.update(f.id, record => ({ ...record, titleRetryAt: Date.now() - 1 }))
  assert.equal((await f.titles.generate(f.id)).title, 'Daily stand-up')
  assert.equal(f.requests.length, 2)
})
