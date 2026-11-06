import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { agentAccess, copilotWith, quick, workDir } from './helpers.mjs'

workDir('live-assist-tests')
const { AgentStore, Copilot } = await import('./.build/togle.mjs')
const store = new AgentStore(async () => 'digest')
await store.load()
const agent = store.list()[0]

test('live replies gather independent evidence together and leave code scans to deeper answers', async () => {
  const knowledge = Promise.withResolvers(), history = Promise.withResolvers(), talk = Promise.withResolvers(), overview = Promise.withResolvers()
  const started = [], inputs = [], events = [], timings = []
  const access = {
    ...agentAccess(store, agent.id),
    knowledgeFor: async () => { started.push('knowledge'); await knowledge.promise; return { text: 'The demo price is 42 euros.', passages: [], documents: [], searchable: false } },
    talk: async () => { started.push('talk'); await talk.promise; return [{ role: 'user', text: 'Keep the Acme demo under ten minutes.', at: Date.now() }] },
    pastCalls: { recall: async () => { started.push('history'); await history.promise; return [] } },
    code: () => ({ overview: async () => { started.push('code'); return overview.promise }, tools: () => [] })
  }
  const provider = { id: 'test', supportsTools: true, stream: async (input, options) => { inputs.push(input); options.onDelta(input.lane === 'quick' ? 'LEVEL: quick\nThe price is 42 euros.' : 'The deeper answer.') } }
  const copilot = new Copilot((channel, event) => { if (channel === 'assist') events.push(event) }, () => provider, { reset: async () => {} }, access, timing => timings.push(timing))
  const answering = copilot.assist({ kind: 'ask', question: 'What should I cover in the Acme demo?' })
  await setImmediate()
  assert.deepEqual([...started].sort(), ['history', 'knowledge', 'talk'], 'all independent reads start before any one resolves; chat is read once')
  knowledge.resolve(); history.resolve(); talk.resolve()
  await answering
  assert.equal(inputs.length, 1, 'the quick answer completes even while the code scan is unresolved')
  assert.match(inputs[0].system + inputs[0].user, /ten minutes/)
  assert.ok(!started.includes('code'))
  assert.ok(timings[0].providerStarted >= timings[0].request)
  copilot.deeper(events.find(event => event.type === 'start').id)
  await setImmediate()
  assert.equal(started.filter(name => name === 'code').length, 1)
  overview.resolve('Project: src/demo.ts')
  await setImmediate()
  assert.equal(inputs.length, 2)
  assert.match(inputs[1].system + inputs[1].user, /src\/demo.ts/)
  assert.equal(started.filter(name => name === 'talk').length, 1, 'quick, instant facts, and deep share only this question’s chat snapshot')
  copilot.cancel()
})

test('finished audio questions count time already spent in silence and transcription', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { copilot, inputs } = copilotWith(Copilot, store, agent.id, ['LEVEL: quick\nYes.'])
  copilot.setListening(true)
  copilot.add('them', 'Is single sign-on included?', Date.now() - 4000, Date.now() - 500, 'audio-question')
  t.mock.timers.tick(0)
  await setImmediate()
  assert.equal(quick(inputs).length, 1, 'no second 300 ms wait after the audio endpoint has already settled')
  copilot.setListening(false)
})

test('uncertain pauses keep their debounce, and an answer from the user suppresses a queued suggestion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = copilotWith(Copilot, store, agent.id, [])
  first.copilot.setListening(true)
  first.copilot.add('them', 'Tell me how onboarding works.', Date.now() - 4000, Date.now() - 500, 'statement')
  t.mock.timers.tick(1199)
  await setImmediate()
  assert.equal(quick(first.inputs).length, 0)
  t.mock.timers.tick(1)
  await setImmediate()
  assert.equal(quick(first.inputs).length, 1)
  first.copilot.setListening(false)
  const second = copilotWith(Copilot, store, agent.id, [])
  second.copilot.setListening(true)
  second.copilot.add('them', 'Is single sign-on included?', Date.now() - 4000, Date.now() - 1000, 'answered')
  second.copilot.add('me', 'Your team can use it from day one.', Date.now() - 700, Date.now(), 'my-answer')
  t.mock.timers.tick(0)
  await setImmediate()
  assert.equal(quick(second.inputs).length, 0)
  second.copilot.setListening(false)
})
