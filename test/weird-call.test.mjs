// Weird moments of a live call: a model that sends nothing, or stops halfway; a burst of questions; a whole log pasted
// into the box; a call of hours. None of them may leave a card that looks like an answer when it isn't one, or cost
// far more than the moment needs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, workDir } from './helpers.mjs'

workDir('weird-call')
const { AgentStore, Copilot } = await import('./.build/togle.mjs')
const store = new AgentStore(async () => '')
await store.load()
const agent = store.list()[0]

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

/** A copilot whose model answers each request with `reply(input)`: text, or a function streaming its own way. */
function copilotFor(reply) {
  const events = []
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, handlers) => {
      inputs.push(input)
      const out = reply(input)
      if (typeof out === 'function') return out(handlers)
      handlers.onDelta(out)
    }
  }
  const frames = { snapshot: async () => Promise.reject(new Error('no screen')), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot((channel, payload) => events.push({ channel, payload }), () => model, frames, agentAccess(store, agent.id))
  return { copilot, events, inputs, shown: () => events.filter((e) => e.channel === 'assist').map((e) => e.payload) }
}

async function askOnce(reply, question = 'How much is the Growth plan?') {
  const call = copilotFor(reply)
  call.copilot.add('them', question, Date.now() - 2000, Date.now())
  await call.copilot.assist({ kind: 'suggest' })
  for (let i = 0; i < 100 && !call.shown().some((p) => p.part === 'main' && (p.type === 'done' || p.type === 'error')); i++) await settle(10)
  await settle()
  return call
}

const mainText = (shown) =>
  shown
    .filter((p) => p.type === 'delta' && p.part === 'main')
    .map((p) => p.text)
    .join('')

test('a model that sends nothing back leaves no empty card that looks answered: it says so', async () => {
  for (const reply of ['', 'LEVEL: quick', 'LEVEL: quick\n   \n']) {
    const { shown } = await askOnce(() => reply)
    const ended = shown().find((p) => p.part === 'main' && (p.type === 'done' || p.type === 'error'))
    assert.equal(ended?.type, 'error', `"${reply}" ends as an error, not an empty answer: ${JSON.stringify(shown())}`)
    assert.match(ended.message, /no answer/i)
  }
})

test('a reply without its LEVEL line is still the answer, shown whole', async () => {
  const { shown } = await askOnce(() => 'Thirty-nine euros per user a month.')
  assert.equal(mainText(shown()), 'Thirty-nine euros per user a month.')
})

test('a reply cut off by an error keeps what came, marked as cut off, and is not taken for a whole answer', async () => {
  const { shown } = await askOnce(() => async ({ onDelta }) => {
    onDelta('LEVEL: quick\nYes, through our partner conn')
    throw new Error('network: connection closed')
  })
  assert.equal(mainText(shown()), 'Yes, through our partner conn')
  const error = shown().find((p) => p.part === 'main' && p.type === 'error')
  assert.ok(error, 'it ends with an error')
  assert.ok(!shown().some((p) => p.part === 'main' && p.type === 'done'), 'not as done')
})

test('a burst of questions in a second or two gets answers for the latest, not a request each', async () => {
  const call = copilotFor(() => 'LEVEL: quick\nOk.')
  call.copilot.setListening(true)
  const t = Date.now() - 3000
  const questions = ['Is it secure?', 'Do you have SSO?', 'What about SCIM?', 'And audit logs?', 'Data in the EU?', 'How much?', 'Any discount?', 'A trial?', 'Onboarding time?', 'Support hours?']
  questions.forEach((q, i) => call.copilot.add('them', q, t + i * 200, t + i * 200 + 150))
  await settle(2500)
  const quick = call.inputs.filter((i) => i.lane === 'quick')
  assert.ok(quick.length >= 1 && quick.length <= 3, `${quick.length} requests for ten questions in two seconds`)
  call.copilot.setListening(false)
})

test('a whole log pasted into the box is asked about by its start and its end, not sent in full', async () => {
  const call = copilotFor(() => 'LEVEL: quick\nThe null check is missing.')
  const log = `TypeError at checkout\n${'at frame (worker.js:12:3)\n'.repeat(40_000)}Caused by: null user id`
  await call.copilot.assist({ kind: 'ask', question: log })
  for (let i = 0; i < 100 && !call.shown().some((p) => p.part === 'main' && p.type === 'done'); i++) await settle(10)
  const asked = call.inputs.find((i) => i.lane === 'quick')
  assert.ok(asked.user.length < 120_000, `the request is ${asked.user.length.toLocaleString()} characters`)
  assert.match(asked.user, /TypeError at checkout/)
  assert.match(asked.user, /Caused by: null user id/)
  assert.match(asked.user, /characters left out/)
  const start = call.shown().find((p) => p.type === 'start')
  assert.ok(start.title.length <= 300, `the card's title is ${start.title.length} characters`)
})

test('the clock set back an hour mid-call: what comes after still comes after, and is what gets answered', async () => {
  const call = copilotFor(() => 'LEVEL: quick\nOk.')
  const t = Date.now()
  call.copilot.add('them', 'What does onboarding look like?', t - 20_000, t - 18_000)
  await call.copilot.assist({ kind: 'suggest' })
  await settle(60)
  // A time sync sets the clock an hour back: the window stamps the next words by it.
  call.copilot.add('them', 'And how long until we are live?', t - 3_600_000, t - 3_598_000)
  call.copilot.addFrame({ id: 'f1', n: 1, at: t - 3_597_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'A timeline slide.' })
  const transcript = call.copilot['transcript']
  assert.equal(transcript.at(-1).text, 'And how long until we are live?', 'after what came before, not an hour back')
  assert.ok(transcript.at(-1).at > transcript.at(-2).end)
  assert.ok(call.copilot['frames'][0].at > transcript.at(-1).at, 'the picture after the words it came with')
  await call.copilot.assist({ kind: 'suggest' })
  await settle(60)
  const asked = call.inputs.filter((i) => i.lane === 'quick').at(-1)
  assert.match(asked.user, /"And how long until we are live\?"/)
  // A clip transcribed late, stamped by the clock as it is now: a few seconds back stays where it was said.
  call.copilot.add('me', 'Mm-hm.', t - 3_600_000 - 3000, t - 3_600_000 - 2500)
  assert.equal(transcript.at(-2).text, 'Mm-hm.')
})

test('the clock set back after New call: what is said next is heard, not dropped as the call before', async () => {
  const call = copilotFor(() => 'LEVEL: quick\nOk.')
  call.copilot.add('them', 'Earlier call.', Date.now() - 5000, Date.now() - 4000)
  await call.copilot.clear()
  call.copilot.add('them', 'Hello, is this the new call?', Date.now() - 3_600_000, Date.now() - 3_599_000)
  assert.deepEqual(
    call.copilot['transcript'].map((e) => e.text),
    ['Hello, is this the new call?']
  )
})

test('a call of hours stays quick to add to, and each request stays within its size', async () => {
  const call = copilotFor((input) => (/running notes/.test(input.system) ? '## Notes\n- A long call.' : 'LEVEL: quick\nOk.'))
  const t0 = Date.now() - 4 * 3600_000
  const started = Date.now()
  for (let i = 0; i < 2400; i++) call.copilot.add(i % 2 ? 'me' : 'them', `Line ${i} of a four-hour call, with enough words to be a real sentence about the project.`, t0 + i * 6000, t0 + i * 6000 + 4000)
  assert.ok(Date.now() - started < 2000, `adding 2,400 lines took ${Date.now() - started} ms`)
  await settle(200)
  call.copilot.add('them', 'So what do we decide?', Date.now() - 2000, Date.now())
  await call.copilot.assist({ kind: 'suggest' })
  for (let i = 0; i < 100 && !call.shown().some((p) => p.part === 'main' && p.type === 'done'); i++) await settle(10)
  const asked = call.inputs.filter((i) => i.lane === 'quick').at(-1)
  assert.ok(asked.user.length < 150_000, `the request is ${asked.user.length.toLocaleString()} characters`)
})
