import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('call-sessions')
const { CallSessions, CallFile, AgentStore, legacySession, exportCall } = await import('./.build/togle.mjs')
const agents = new AgentStore(async () => '')
await agents.load()
let order = 0
const state = text => ({ transcript: text ? [{ id: 'line-' + ++order, speaker: 'them', text, at: 1000, end: 2000 }] : [], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: '', group: false })
const info = (id, agentId = 'agent-one') => ({ id, agentId, agentName: 'General', startedAt: 1000, endedAt: 9000, status: 'ended' })

test('short and empty calls are saved before any learning or summary exists', async () => {
  const repo = new CallSessions()
  await repo.capture(info('short-call'), 'frame-short', state('Can we meet Tuesday?'))
  await repo.capture(info('empty-call'), 'frame-empty', state(''))
  const list = await new CallSessions().list()
  assert.equal(list.find(call => call.id === 'short-call').lines, 1)
  assert.equal(list.find(call => call.id === 'empty-call').lines, 0)
  assert.equal(list.find(call => call.id === 'short-call').summary, '')
  assert.equal(list.find(call => call.id === 'short-call').learningState, 'not-reviewed')
  assert.ok(readFileSync(path.join(work, 'call-history/short-call.bin'), 'utf8').startsWith('ENC:'))
})

test('a restarted repository can inspect the full transcript, and its export says it', async () => {
  const repo = new CallSessions()
  await repo.capture(info('inspect-call'), 'frames', state('What is our next step?'))
  const saved = await new CallSessions().get('inspect-call')
  assert.equal(saved.transcript[0].text, 'What is our next step?')
  assert.deepEqual(saved.suggestions, [])
  assert.match(exportCall(saved), /Call: What is our next step\?/)
})

test('what an earlier version kept with a call stays with it when the call is saved again', async () => {
  const repo = new CallSessions()
  await repo.capture(info('older-call'), 'frames', state('A long meeting.'))
  await repo.update('older-call', call => ({ ...call, brief: 'Acme renewal', notes: 'Pricing came up.', suggestions: [{ id: 'early', kind: 'suggest', question: '', text: 'An early answer.', at: 1000 }] }))
  await repo.capture(info('older-call'), 'frames', state('A long meeting, still going.'))
  const saved = await repo.get('older-call')
  assert.equal(saved.transcript[0].text, 'A long meeting, still going.')
  assert.deepEqual(saved.suggestions.map(card => card.id), ['early'])
  assert.equal(saved.brief, 'Acme renewal')
  assert.equal(saved.notes, 'Pricing came up.')
})

test('capture updates preserve renamed titles and learning committed while the call was saving', async () => {
  const repo = new CallSessions()
  await repo.capture(info('renamed-call'), 'frames', state('Original title?'))
  await repo.rename('renamed-call', 'Customer onboarding')
  await repo.update('renamed-call', call => ({ ...call, summary: 'Agreed to send notes.', learning: { ...call.learning, state: 'reviewed', changes: [{ id: 'change', text: 'Learned a workflow' }] } }))
  await repo.capture(info('renamed-call'), 'frames', state('A later question?'))
  const saved = await repo.get('renamed-call')
  assert.equal(saved.title, 'Customer onboarding')
  assert.equal(saved.transcript[0].text, 'A later question?')
  assert.equal(saved.summary, 'Agreed to send notes.')
  assert.equal(saved.learning.changes.length, 1)
})

test('delete wins over queued and late capture updates and survives a restart', async () => {
  const repo = new CallSessions()
  await repo.capture(info('deleted-call'), 'frames', state('Private words.'))
  const pending = repo.capture(info('deleted-call'), 'frames', state('Late private words.'))
  await repo.remove('deleted-call')
  await pending
  assert.equal(await repo.capture(info('deleted-call'), 'frames', state('Even later.')), null)
  assert.equal(await new CallSessions().get('deleted-call'), null)
})

test('a call cannot be reassigned to another agent by a capture update', async () => {
  const repo = new CallSessions()
  await repo.capture(info('owned-call'), 'frames', state('Private context.'))
  await assert.rejects(repo.capture(info('owned-call', 'another-agent'), 'frames', state('Different context.')), /owning agent/)
  assert.equal((await repo.get('owned-call')).agentId, 'agent-one')
})

test('call IDs cannot name paths or the history index', async () => {
  const repo = new CallSessions()
  for (const id of ['../call', 'a/b', 'a\\b', 'index', '', 'C:\\outside']) {
    assert.throws(() => repo.remove(id), /No such call/)
    await assert.rejects(repo.get(id), /No such call/)
  }
})

test('an intact record remains discoverable if the history index is lost', async () => {
  const repo = new CallSessions()
  await repo.capture(info('recover-call'), 'frames', state('Keep this transcript.'))
  rmSync(path.join(work, 'call-history/index.bin'))
  const back = new CallSessions()
  assert.ok((await back.list()).some(call => call.id === 'recover-call'))
})

test('orphan records are reconciled even when an older valid index exists', async () => {
  const repo = new CallSessions()
  await repo.capture(info('before-orphan'), 'frames', state('An existing call.'))
  const oldIndex = readFileSync(path.join(work, 'call-history/index.bin'))
  await repo.capture(info('orphan-call'), 'frames', state('Index write was interrupted.'))
  writeFileSync(path.join(work, 'call-history/index.bin'), oldIndex)
  assert.ok((await new CallSessions().list()).some(call => call.id === 'orphan-call'))
})

test('an interrupted delete cannot leave a ghost history row after restart', async () => {
  const repo = new CallSessions()
  await repo.capture(info('deleted-before-index'), 'frames', state('Delete this call.'))
  const before = readFileSync(path.join(work, 'call-history/index.bin'))
  await repo.remove('deleted-before-index')
  writeFileSync(path.join(work, 'call-history/index.bin'), before)
  assert.ok(!(await new CallSessions().list()).some(call => call.id === 'deleted-before-index'))
})

test('a review interrupted by shutdown becomes retryable on the next start', async () => {
  const repo = new CallSessions()
  await repo.capture(info('interrupted-review'), 'frames', state('A useful conversation.'))
  await repo.update('interrupted-review', call => ({ ...call, learning: { ...call.learning, state: 'reviewing' } }))
  assert.equal((await repo.get('interrupted-review')).learning.state, 'reviewing', 'a live review stays in progress')
  const back = await new CallSessions().get('interrupted-review')
  assert.equal(back.learning.state, 'error')
  assert.match(back.learning.error, /interrupted/)
})

test('older summary-only calls remain inspectable without inventing transcript lines', () => {
  const legacy = legacySession({ id: 'old', agentId: 'agent', at: 1000, endedAt: 2000, brief: 'Acme', with: ['Acme'], summary: 'Send the report.', about: [], asked: [{ question: 'When?', answer: 'Tuesday.' }] }, 'General')
  assert.equal(legacy.transcript.length, 0)
  assert.equal(legacy.summary, 'Send the report.')
  assert.equal(legacy.suggestions[0].text, 'Tuesday.')
  assert.equal(legacy.legacy.id, 'old')
})

test('active call recovery forwards a committed snapshot into the history repository', async () => {
  const repo = new CallSessions()
  const session = info('recovery-hook')
  const file = new CallFile(() => ({ frameSession: 'frames', session, state: state('A short call still matters.') }), saved => repo.capture(saved.session, saved.frameSession, saved.state))
  file.changed()
  await file.flush()
  assert.equal((await repo.get(session.id)).transcript[0].text, 'A short call still matters.')
})

