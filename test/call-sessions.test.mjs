import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('call-sessions')
const { CallSessions, CallLearning, CallFile, AgentStore, emptyLessons, legacySession, exportCall } = await import('./.build/togle.mjs')
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

test('a restarted repository can inspect the full transcript and saved suggestions', async () => {
  const repo = new CallSessions()
  await repo.capture(info('inspect-call'), 'frames', state('What is our next step?'), { cards: [{ id: 'reply', kind: 'suggest', question: 'What is our next step?', text: 'Send the report.', deep: { text: 'Confirm the owner first.' }, at: 2500 }], reviewedLines: 0 })
  const saved = await new CallSessions().get('inspect-call')
  assert.equal(saved.transcript[0].text, 'What is our next step?')
  assert.equal(saved.suggestions[0].text, 'Send the report.')
  assert.equal(saved.suggestions[0].deep, 'Confirm the owner first.')
  assert.match(exportCall(saved), /Them: What is our next step\?/)
  assert.match(exportCall(saved), /Confirm the owner first/)
})

test('history keeps earlier replies after they leave the live window and updates a streaming reply in place', async () => {
  const repo = new CallSessions()
  await repo.capture(info('long-call'), 'frames', state('A long meeting.'), { reviewedLines: 0, cards: [{ id: 'early', kind: 'suggest', text: 'An early answer.', at: 1000 }, { id: 'stream', kind: 'suggest', text: 'The first words', at: 2000 }] })
  await repo.capture(info('long-call'), 'frames', state('A long meeting.'), { reviewedLines: 0, cards: [{ id: 'stream', kind: 'suggest', text: 'The first words and the completed answer.', at: 2000 }, { id: 'late', kind: 'suggest', text: 'A later answer.', at: 3000 }] })
  const saved = await repo.get('long-call')
  assert.deepEqual(saved.suggestions.map(card => card.id), ['early', 'stream', 'late'])
  assert.equal(saved.suggestions[1].text, 'The first words and the completed answer.')
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
  const file = new CallFile(() => ({ frameSession: 'frames', session, state: state('A short call still matters.') }), saved => repo.capture(saved.session, saved.frameSession, saved.state, saved.view))
  file.setView({ key: session.id, cards: [], reviewedLines: 0 })
  await file.flush()
  assert.equal((await repo.get(session.id)).transcript[0].text, 'A short call still matters.')
})

async function learner(mode = 'auto', extra = {}) {
  const agent = await agents.create('blank', { name: 'Learner ' + ++order, learning: mode })
  const repo = new CallSessions()
  const id = 'learning-' + order
  await repo.capture(info(id, agent.id), 'frame-' + id, state('How should we troubleshoot?'))
  const calls = []
  const service = new CallLearning(repo, {
    agent: id => agents.get(id), apply: (id, lessons, auto) => agents.applyLessons(id, lessons, auto),
    review: async record => { calls.push(record); return { ...emptyLessons(), agentId: agent.id, facts: ['Ask for the operating system before troubleshooting.', 'The price is EUR 49 per user.'] } },
    ...extra
  })
  return { id, repo, service, agent, calls }
}

test('automatic improvement keeps a reusable lesson but stages a price for approval', async () => {
  const { id, service, agent } = await learner()
  const result = await service.review(id)
  assert.deepEqual(agents.get(agent.id).memory, ['Ask for the operating system before troubleshooting.'])
  assert.deepEqual(result.session.learning.pending.facts, ['The price is EUR 49 per user.'])
  assert.equal(result.session.learning.changes.length, 1)
  assert.equal(result.session.learning.state, 'reviewed')
})

test('ask-first and manual-only modes stage every lesson without changing memory', async () => {
  for (const mode of ['ask', 'off']) {
    const { id, service, agent } = await learner(mode)
    const result = await service.review(id)
    assert.equal(result.session.learning.pending.facts.length, 2)
    assert.equal(agents.get(agent.id).memory.length, 0)
  }
})

test('approving selected lessons applies only persisted proposals and rejects a stale decision', async () => {
  const { id, service, agent } = await learner('ask')
  const reviewed = await service.review(id)
  const revision = reviewed.session.learning.reviewId
  const kept = await service.approve(id, revision, ['facts:0'])
  assert.equal(agents.get(agent.id).memory.length, 1)
  assert.equal(kept.session.learning.pending.facts.length, 1)
  await assert.rejects(service.approve(id, revision, ['facts:0']), /changed/)
  assert.ok(!agents.get(agent.id).memory.some(fact => fact.includes('49')))
})

test('a review ID from another call cannot approve its lessons', async () => {
  const first = await learner('ask')
  const second = await learner('ask')
  const a = await first.service.review(first.id)
  await second.service.review(second.id)
  await assert.rejects(second.service.approve(second.id, a.session.learning.reviewId, ['facts:0']), /changed/)
  assert.equal(agents.get(second.agent.id).memory.length, 0)
})

test('a full live context does not block call approval and approved facts survive reopening', async () => {
  const { id, service, agent } = await learner('ask')
  const before = Array.from({ length: 20 }, (_, i) => `Existing fact ${i}: ${'verified '.repeat(26)}`)
  await agents.update(agent.id, { memory: before })
  const reviewed = await service.review(id)
  const kept = await service.approve(id, reviewed.session.learning.reviewId, ['facts:0', 'facts:1'])
  assert.equal(kept.session.learning.pending.facts.length, 0)
  assert.deepEqual(agents.get(agent.id).memory.slice(0, before.length), before)
  assert.equal(agents.get(agent.id).memory.length, before.length + 2)
  const reopened = new AgentStore(async () => '')
  await reopened.load()
  assert.deepEqual(reopened.get(agent.id).memory, agents.get(agent.id).memory)
  assert.equal((await new CallSessions().get(id)).learning.pending.facts.length, 0)
})

test('an unchanged call is reviewed once and undo is respected when it is inspected again', async () => {
  const { id, service, calls, agent } = await learner()
  const first = await service.review(id)
  await service.review(id)
  assert.equal(calls.length, 1)
  await agents.undo(agent.id, first.session.learning.changes[0].id)
  await service.review(id)
  assert.equal(calls.length, 1)
  assert.equal(agents.get(agent.id).memory.length, 0)
})

test('simultaneous review clicks share one model request', async () => {
  let finish
  const { id, service } = await learner('ask', { review: record => new Promise(resolve => { finish = () => resolve({ ...emptyLessons(), agentId: record.agentId, facts: ['A confirmed reusable fact.'] }) }) })
  const first = service.review(id)
  const second = service.review(id)
  assert.equal(first, second)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  finish()
  await first
})

test('a corrected answer causes a new review even when the transcript length stays the same', async () => {
  const { id, service, repo, calls } = await learner('ask')
  await service.review(id)
  await repo.update(id, record => ({ ...record, callAnswers: [{ question: 'Which product?', answer: 'The approved product.' }] }))
  await service.review(id)
  assert.equal(calls.length, 2)
})

test('a failed review is visible and can be retried without losing the transcript', async () => {
  let failed = false
  const { id, service, repo } = await learner('ask', { review: async record => { if (!failed) { failed = true; throw new Error('Temporary provider limit') }; return { ...emptyLessons(), agentId: record.agentId } } })
  await assert.rejects(service.review(id), /provider limit/)
  assert.equal((await repo.get(id)).learning.state, 'error')
  assert.equal((await repo.get(id)).transcript.length, 1)
  assert.equal((await service.review(id)).session.learning.state, 'reviewed')
})

test('deleting an agent during a review cannot redirect its lessons into the fallback agent', async () => {
  let finish
  const { id, service, agent } = await learner('auto', { review: record => new Promise(resolve => { finish = () => resolve({ ...emptyLessons(), agentId: record.agentId, facts: ['Private information for the deleted agent.'] }) }) })
  const fallback = agents.list().find(other => other.id !== agent.id)
  const memory = structuredClone(fallback.memory)
  const pending = service.review(id)
  while (!finish) await new Promise(resolve => setImmediate(resolve))
  await agents.remove(agent.id)
  finish()
  await assert.rejects(pending, /agent was deleted/)
  assert.deepEqual(agents.get(fallback.id).memory, memory)
})

test('marking an approved answer as reviewed does not cause a second model review', async () => {
  const { id, service, repo, calls } = await learner('ask')
  await repo.update(id, record => ({ ...record, callAnswers: [{ question: 'Which product?', answer: 'The approved product.', reviewed: false }] }))
  await service.review(id)
  await repo.update(id, record => ({ ...record, callAnswers: record.callAnswers.map(answer => ({ ...answer, reviewed: true })) }))
  await service.review(id)
  assert.equal(calls.length, 1)
})
