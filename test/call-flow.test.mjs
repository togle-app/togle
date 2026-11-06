// A call's questions coming fast: an answer already being written finishes, a deep answer cut short by a newer one
// says so and finishes as it was, Suggest pressed as they ask gives one card, and a service at its limit is left
// alone by the automatic suggestions.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, shown, wait, workDir } from './helpers.mjs'

workDir('call-flow')
const { AgentStore, Copilot, hearing } = await import('./.build/togle.mjs')

const store = new AgentStore(async () => 'digest')
await store.load()

const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }

/** A copilot whose model answers each request with `answer(input, signal)`: what it writes, a piece at a time. */
function copilotOn(agentId, answer) {
  const events = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta, signal }) => {
      for await (const piece of answer(input, signal)) {
        if (signal?.aborted) return
        onDelta(piece)
      }
    }
  }
  const copilot = new Copilot((channel, payload) => events.push({ channel, payload }), () => model, frames, agentAccess(store, agentId))
  return { copilot, events }
}

const text = (events, id, part = 'main') =>
  shown(events)
    .filter((e) => e.id === id && e.type === 'delta' && e.part === part)
    .map((e) => e.text)
    .join('')
const started = (events) => shown(events).filter((e) => e.type === 'start')

test('an answer already being written when they ask something new is written to its end; one still thinking goes', async () => {
  const agent = await store.create('general')
  const { copilot, events } = copilotOn(agent.id, async function* (input) {
    if (/first month/.test(input.user) && !/how much/i.test(input.user)) {
      yield 'LEVEL: quick\nWe meet once a week, '
      await wait(120)
      yield 'an hour each time.'
    } else yield 'LEVEL: quick\nForty euros a lesson.'
  })
  copilot.add('them', 'How would the first month go?', Date.now() - 1500, Date.now())
  void copilot.assist({ kind: 'suggest', question: 'How would the first month go?' })
  await wait(40)
  await copilot.assist({ kind: 'suggest', question: 'And how much is it?' })
  await wait(200)
  const [first, second] = started(events).map((e) => e.id)
  assert.equal(text(events, first), 'We meet once a week, an hour each time.', 'the first answer is whole')
  assert.equal(text(events, second), 'Forty euros a lesson.')
  // Still thinking when the next question came: it goes, said nothing (and the window doesn't show it).
  const slow = copilotOn(agent.id, async function* (input) {
    if (/first month/.test(input.user)) {
      await wait(120)
      yield 'LEVEL: quick\nToo late.'
    } else yield 'LEVEL: quick\nForty euros a lesson.'
  })
  void slow.copilot.assist({ kind: 'suggest', question: 'How would the first month go?' })
  await wait(30)
  await slow.copilot.assist({ kind: 'suggest', question: 'And how much is it?' })
  await wait(200)
  const [dropped] = started(slow.events).map((e) => e.id)
  assert.equal(text(slow.events, dropped), '', 'dropped before it wrote')
})

test("a deep answer cut short by a newer question's says so, and finishing it is the same run again, not a harder one", async () => {
  const agent = await store.create('general')
  const efforts = []
  const { copilot, events } = copilotOn(agent.id, async function* (input) {
    if (input.lane !== 'deep') {
      yield 'LEVEL: deep\nLet me think.'
      return
    }
    efforts.push(input.effort)
    yield 'Point 1. Start with the logs. '
    await wait(150)
    yield 'Point 2. Then the exports.'
  })
  await copilot.assist({ kind: 'suggest', question: 'Why does the export crash every Monday?' })
  await wait(60)
  await copilot.assist({ kind: 'suggest', question: 'And why is the report empty on Fridays?' })
  await wait(300)
  const [first] = started(events).map((e) => e.id)
  const done = shown(events).find((e) => e.id === first && e.type === 'done' && e.part === 'deep')
  assert.equal(done?.cut, true, 'it says it was cut short')
  assert.equal(text(events, first, 'deep'), 'Point 1. Start with the logs. ')
  // Finish it: the same effort as the run it cut.
  copilot.deeper(first)
  await wait(300)
  assert.equal(efforts.length, 3)
  assert.equal(efforts[2], efforts[0], 'finished as it was, not thought through harder')
  const finished = shown(events).filter((e) => e.id === first && e.type === 'done' && e.part === 'deep')
  assert.equal(finished.at(-1).cut, undefined, 'and once finished, not said to be cut')
})

test('Suggest pressed as they ask gives one card: the automatic one for those words is that one', async () => {
  const agent = await store.create('general')
  const { copilot, events } = copilotOn(agent.id, async function* () {
    yield 'LEVEL: quick\nWe start with the basics.'
  })
  copilot.setListening(true)
  copilot.add('them', 'Walk me through how you would structure the first month?', Date.now() - 2500, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await wait(1500)
  assert.equal(started(events).length, 1, `one card, not two: ${started(events).length}`)
  copilot.setListening(false)
})

test('speech results arriving backwards answer the full turn once, with both questions', async () => {
  const agent = await store.create('general')
  const { copilot, events } = copilotOn(agent.id, async function* () {
    yield 'LEVEL: quick\nWe meet weekly, at forty euros a lesson.'
  })
  const finish = []
  const handler = hearing({
    parakeet: () => null,
    whisper: { transcribe: async () => ({ text: '' }) },
    api: () => ({ id: 'server', transcribe: () => new Promise((resolve) => finish.push(resolve)) }),
    language: () => 'en', vocabulary: async () => '', caption: () => {}, copilot
  })
  copilot.setListening(true)
  const now = Date.now()
  const first = handler('them', new Float32Array(16000), now - 6000, 'first-question', 'final')
  const next = handler('them', new Float32Array(16000), now - 3000, 'next-question', 'final')
  try {
    await wait(0)
    finish[1]('And what does it cost?')
    await wait(500)
    assert.equal(started(events).length, 0, 'a later result cannot start an answer with the first question missing')
    finish[0]('How often would lessons be?')
    await Promise.all([first, next])
    await wait(700)
    assert.deepEqual(started(events).map((e) => e.question), ['How often would lessons be? And what does it cost?'])
  } finally {
    copilot.setListening(false)
    finish[0]?.('How often would lessons be?')
    await Promise.all([first, next])
  }
})

test('a service that says it is at its limit is left alone by the automatic suggestions for a while; Suggest still asks', async () => {
  const agent = await store.create('general')
  let asked = 0
  const { copilot, events } = copilotOn(agent.id, async function* () {
    asked++
    throw new Error('The AI service is at its limit right now. Try again in a moment.')
  })
  copilot.setListening(true)
  copilot.add('them', 'How long is a lesson?', Date.now() - 2000, Date.now())
  await wait(700)
  assert.equal(asked, 1, 'the automatic suggestion asked once')
  assert.ok(shown(events).some((e) => e.type === 'error'))
  copilot.add('them', 'And what does it cost?', Date.now() - 1000, Date.now())
  await wait(700)
  assert.equal(asked, 1, 'the next question waits: no automatic request while the service rests')
  copilot.anticipate('What should I bring to the lesson?', Date.now(), 'pause-at-limit')
  await wait(50)
  assert.equal(asked, 1, 'a question heard at a pause also waits for the service')
  await copilot.assist({ kind: 'suggest' })
  await wait(50)
  assert.equal(asked, 2, 'Suggest still asks')
  copilot.setListening(false)
})
