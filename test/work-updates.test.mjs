import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, workDir } from './helpers.mjs'

workDir('work-updates')
const { AgentStore, Copilot, buildPrompt, isWorkUpdate, memoryChars, memoryForContext } = await import('./.build/togle.mjs')
const store = new AgentStore(async () => '')
await store.load()

test('saved memory can grow while live context keeps relevant older facts and stays bounded', () => {
  const old = 'The goodwill credits task is TC-152, assigned to Luka; QA is in progress.'
  const memory = [old, ...Array.from({ length: 100 }, (_, i) => `Unrelated archived fact ${i}: ${'detail '.repeat(30)}`)]
  const copy = [...memory]
  const selected = memoryForContext(memory, 'What is the goodwill credits QA status?')
  assert.ok(selected.includes(old))
  assert.ok(memoryChars(selected) <= 4000)
  assert.ok(selected.length < memory.length)
  assert.deepEqual(memory, copy, 'retrieval never compacts or deletes saved facts')
  assert.ok(memoryForContext(memory).includes(memory.at(-1)), 'recent facts break ties')
})

test('work-update intent includes the reported meeting wording and multiple languages', () => {
  for (const question of ['How your yesterday day passed?', 'What did you work on yesterday?', 'Daily update?', 'Как прошёл вчерашний день?', '昨天做了什么工作？', 'Was hast du gestern gemacht?']) assert.ok(isWorkUpdate(question), question)
  assert.equal(isWorkUpdate('Is single sign-on included?'), false)
})

test('a daily-update question reads this agent’s recent reports even without a matching company name', async () => {
  const agent = await store.create('blank', { name: 'Team meeting' })
  await store.update(agent.id, { claudeConnections: { account: 'luka@example.test', servers: ['work-jira'] } })
  const current = store.get(agent.id), inputs = [], reads = []
  const provider = { id: 'fake', supportsTools: true, stream: async (input, { onDelta }) => { inputs.push(input); onDelta('LEVEL: quick\nThe last report says QA was in progress; today’s result is unverified.') } }
  const access = { ...agentAccess(store, agent.id), pastCalls: {
    recall: async () => [],
    recent: async (owner, since) => { reads.push({ owner: owner.id, since }); return [{ id: 'prior', agentId: owner.id, at: Date.now() - 86400000, summary: 'Luka reported TC-152 QA in progress. Denis owns the deployment check.', with: [], about: [], asked: [] }] }
  } }
  const copilot = new Copilot(() => {}, () => provider, { reset: async () => {} }, access, undefined, () => 'Luka')
  await copilot.assist({ kind: 'ask', question: 'How your yesterday day passed?' })
  assert.equal(reads.length, 1)
  assert.equal(reads[0].owner, agent.id)
  assert.match(inputs[0].user, /TC-152 QA in progress/)
  assert.match(inputs[0].user, /Denis owns the deployment check/)
  assert.match(inputs[0].user, /Do not attribute a colleague's work to me/)
  assert.match(inputs[0].user, /Never claim "no blockers"/)
  assert.match(inputs[0].system, /Never output fill-in-the-blank templates/)
  assert.equal(inputs[0].maxToolRounds, 4, 'work lookups have room for discovery, search and a source read')
  assert.deepEqual(inputs[0].claudeConnections, current.claudeConnections, 'the selected work account remains pinned')
  await copilot.assist({ kind: 'ask', question: 'Is single sign-on included?' })
  assert.equal(reads.length, 1, 'ordinary answers avoid the extra history read')
  copilot.cancel()
})

test('facts excluded from the live prompt remain retrievable from the same agent', async () => {
  const agent = await store.create('blank', { name: 'Large memory' })
  const earlier = 'Refund review is TC-777 and still awaiting approval. ' + 'Awaiting owner confirmation. '.repeat(7)
  await store.update(agent.id, { memory: [earlier, ...Array.from({ length: 90 }, (_, i) => `Other work item ${i}: ${'verified detail '.repeat(12)}`)] })
  const inputs = [], events = []
  const provider = { id: 'fake', supportsTools: true, stream: async (input, { onDelta }) => { inputs.push(input); onDelta('LEVEL: quick\nLet’s verify the latest status.') } }
  const copilot = new Copilot((channel, event) => { if (channel === 'assist') events.push(event) }, () => provider, { reset: async () => {} }, agentAccess(store, agent.id))
  await copilot.assist({ kind: 'ask', question: 'What work is next?' })
  assert.ok(!inputs[0].system.includes(earlier))
  assert.ok(inputs[0].system.length < 14000)
  const tool = inputs[0].tools.find(tool => tool.name === 'search_memory')
  assert.ok(tool)
  assert.match(await tool.run({ query: 'TC-777 refund review' }), /TC-777 and still awaiting approval/)
  assert.ok(memoryChars(events.find(event => event.type === 'context').context.facts.map(fact => fact.text)) <= 4000)
  copilot.cancel()
})

test('daily-update prompt preserves historical attribution and never requests placeholder answers', async () => {
  const agent = store.list()[0]
  const knowledge = await store.knowledgeFor(agent, '', new Set())
  const prompt = buildPrompt({ agent, knowledge, request: { kind: 'suggest', auto: true }, part: 'main', question: 'What did you work on yesterday?', transcript: [], frames: [], attached: new Set(), canSearch: false, recentWork: 'Nov 2: Denis proposed deploying TC-11; the outcome was not confirmed.', ownName: 'Luka', now: new Date('2026-11-03T10:00:00+01:00').getTime() })
  assert.match(prompt.user, /Nov 03 2026/)
  assert.match(prompt.user, /Nov 2: Denis proposed deploying TC-11/)
  assert.match(prompt.user, /not proof of current status/)
  assert.doesNotMatch(prompt.system + prompt.user, /put a short \[placeholder\]|stays a \[placeholder\]/)
})
