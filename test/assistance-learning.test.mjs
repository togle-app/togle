import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { workDir, copilotWith } from './helpers.mjs'

const directory = workDir('assistance-learning')
const { AgentStore, Copilot, buildPrompt, skillPurpose, packAgent, readPackage } = await import('./.build/togle.mjs')
const fresh = async () => { const store = new AgentStore(async () => { throw new Error('No model is needed for storage') }); await store.load(); const agent = await store.create('general', { name: 'Team meeting', skills: [], memory: [] }); return { store, agent } }

test('legacy meeting procedures remain intact as searchable reference, outside assistant instructions', async () => {
  const { store, agent } = await fresh()
  const legacy = { id: 'legacy-tdd', name: 'Test-first and TDD discussions', when: 'When the team discusses tests', how: '- QA writes acceptance scenarios before development.', origin: 'call', createdAt: 1, updatedAt: 1 }
  await store.update(agent.id, { skills: [legacy] })
  const file = path.join(directory, 'agents', agent.id + '.json'), before = await fs.readFile(file, 'utf8')
  const loaded = new AgentStore(); await loaded.load()
  assert.equal(await fs.readFile(file, 'utf8'), before, 'loading cannot rewrite original knowledge or history')
  const saved = loaded.get(agent.id), knowledge = await loaded.knowledgeFor(saved, 'Who writes QA acceptance scenarios before development?', new Set())
  assert.equal(saved.skills[0].id, legacy.id); assert.equal(saved.skills[0].how, legacy.how)
  assert.equal(skillPurpose(saved.skills[0]), 'reference')
  assert.equal(knowledge.skills, undefined)
  assert.ok(knowledge.references.includes('QA writes acceptance scenarios'))
  const prompt = buildPrompt({ agent: saved, knowledge, canSearch: false, part: 'main', request: { kind: 'ask' }, question: 'Who writes acceptance scenarios?', transcript: [], frames: [], attached: new Set() })
  assert.ok(!prompt.system.includes(legacy.how)); assert.ok(prompt.user.includes('Historical reference material'))
  assert.equal((await loaded.knowledgeFor(saved, 'What is the weather?', new Set())).references, undefined)
})

test('a meeting about testing can add project reference without creating an assistant behavior', async () => {
  const { store, agent } = await fresh()
  const { copilot } = copilotWith(Copilot, store, agent.id, ['SKILL: Test-first and TDD discussions | When planning QA\n- QA writes test cases before development.\nSUMMARY: The team discussed its testing process.'])
  copilot.add('them', 'Roman will write the test cases before development.', 1000, 2000)
  const review = await copilot.learn([], 'qa-call')
  const saved = await store.applyLessons(agent.id, review, true, { kind: 'call', callId: 'qa-call', at: 2000 })
  assert.equal(saved.skills.filter(skill => skillPurpose(skill) === 'assistance').length, 0)
  assert.equal(saved.skills[0].source.callId, 'qa-call')
  assert.ok((await store.knowledgeFor(saved, 'QA test cases before development', new Set())).references)
})

test('assistance learned from an actual correction has a source and a trace on the next answer', async () => {
  const { store, agent } = await fresh()
  const { copilot } = copilotWith(Copilot, store, agent.id, ['ASSIST: Verified status updates | When I am asked about progress\n- Suggest one sentence covering verified work and the next check.\nEVIDENCE: C1\nSUMMARY: The user corrected a long update.'])
  copilot.add('them', 'Luka, what did you finish?', 1000, 2000)
  copilot.noteAnswer({ question: 'What did you finish?', suggested: 'A long explanation about process and tests.', answer: 'The implementation is built; I am checking integration tests.' })
  const review = await copilot.learn([], 'status-call')
  assert.equal(review.skills[0].purpose, 'assistance'); assert.deepEqual(review.skills[0].source.feedbackIds, ['C1'])
  const saved = await store.applyLessons(agent.id, review, true, { kind: 'call', callId: 'status-call', at: 2000 })
  const replay = copilotWith(Copilot, store, agent.id, ['LEVEL: quick\nI will confirm the test results before calling it ready.'])
  await replay.copilot.assist({ kind: 'ask', question: 'How should I give a progress update?' })
  const trace = replay.events.find(event => event.payload.type === 'context').payload
  assert.deepEqual(trace.context.skills.map(skill => skill.id), [saved.skills[0].id])
  assert.equal(trace.context.skills[0].revision, 1)
  assert.ok(replay.inputs[0].system.includes('How Togle should assist me'))
})

test('invented feedback and an approval without a correction cannot automatically activate an assistance skill', async () => {
  for (const evidence of ['C1', 'C99', 'none']) {
    const { store, agent } = await fresh()
    const { copilot } = copilotWith(Copilot, store, agent.id, [`ASSIST: Standup summaries | A team meeting\n- Always restate the testing policy.\nEVIDENCE: ${evidence}`])
    copilot.add('them', 'Roman owns the test cases.', 1000, 2000)
    copilot.noteAnswer({ question: 'Who owns the cases?', answer: 'Roman.' })
    const review = await copilot.learn([], 'approval-call')
    assert.equal(review.skills.length, 0)
    assert.equal(review.check.skills.length, 1)
    assert.deepEqual(review.check.skills[0].source.feedbackIds, [])
  }
})

test('fact source survives an edit and undo; reference export cannot become an active imported skill', async () => {
  const { store, agent } = await fresh()
  const legacy = await store.create('general', { name: 'Legacy facts', memory: ['A rule remembered by an earlier version.'] })
  await store.update(legacy.id, { memory: [...legacy.memory, 'A newly taught user preference.'] }, 'train')
  assert.equal(store.get(legacy.id).factSources[legacy.memory[0]], undefined, 'an unrelated edit cannot invent provenance for legacy facts')
  assert.equal(store.get(legacy.id).factSources['A newly taught user preference.'].kind, 'user')
  const lessons = { facts: ['The release lead owns deployment.'], answers: [], skills: [{ name: 'QA procedure', when: 'QA planning', how: '- QA prepares acceptance cases.' }], updates: [], forget: [] }
  await store.applyLessons(agent.id, lessons, true, { kind: 'call', callId: 'policy-call', at: 1000 })
  const before = store.get(agent.id)
  await store.saveFact(agent.id, 'The on-call engineer owns deployment.', before.memory[0])
  assert.equal(store.get(agent.id).factSources['The on-call engineer owns deployment.'].kind, 'user')
  await store.undo(agent.id, store.get(agent.id).history.at(-1).id)
  assert.equal(store.get(agent.id).factSources[before.memory[0]].callId, 'policy-call')
  const files = await packAgent(before, { author: '', memory: [], docs: [] }, async () => '')
  assert.ok(!JSON.stringify(files).includes('policy-call'), 'private call provenance cannot enter a shared agent')
  const parsed = readPackage(files)
  assert.equal(parsed.pkg.skills[0].purpose, 'reference')
  await store.saveSkill(agent.id, { name: 'QA procedure', when: 'When I am asked about QA', how: '- Suggest a concise answer grounded in the reported QA process.' }, 'manual')
  const both = readPackage(await packAgent(store.get(agent.id), { author: '', memory: [], docs: [] }, async () => ''))
  assert.equal(both.pkg.skills.length, 2, 'same-name reference and assistance retain their different roles when shared')
})
