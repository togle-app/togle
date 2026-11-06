// Requests to the model a call doesn't need: a deep answer nobody will read, the same question asked twice, a
// summary cut short, the call before's screen still being described.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, wait, workDir } from './helpers.mjs'

workDir('requests')
const { AgentStore, Copilot, updateSettings } = await import('./.build/togle.mjs')
await updateSettings({ assist: { auto: true } })

const store = new AgentStore(async () => 'digest')
await store.load()
const agentId = (await store.create('sales')).id

/** Waits `ms`, or rejects as soon as the request is stopped, as a real one does. */
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true })
  })

/** A copilot whose model plays each request with `play`, and the requests it got: their lane, input and end. */
function copilotPlaying(play, frames = {}) {
  const requests = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, opts) => {
      const request = { lane: input.lane, input, ended: 'running' }
      requests.push(request)
      try {
        await play(input, opts)
        request.ended = 'done'
      } catch (err) {
        request.ended = opts.signal.aborted ? 'stopped' : 'failed'
        throw err
      }
    }
  }
  const store$ = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, reset: async () => {}, ...frames }
  const events = []
  const copilot = new Copilot((channel, payload) => events.push({ channel, payload }), () => model, store$, agentAccess(store, agentId))
  return { copilot, requests, events }
}

const cards = (events) => {
  const out = new Map()
  for (const { channel, payload: e } of events) {
    if (channel !== 'assist') continue
    if (e.type === 'start') out.set(e.id, { question: e.question, text: '', deep: '' })
    const card = out.get(e.id)
    if (card && e.type === 'delta') card[e.part === 'deep' ? 'deep' : 'text'] += e.text
  }
  return [...out.values()]
}

test("a deep answer started on a hunch stops with its card's quick answer when a newer question takes over", async () => {
  const { copilot, requests } = copilotPlaying(async (input, { signal, onDelta, onAccepted }) => {
    onAccepted?.()
    await sleep(input.lane === 'deep' ? 3000 : 700, signal)
    onDelta(input.lane === 'deep' ? '- A deep answer.' : 'LEVEL: quick\nYes.')
  })
  copilot.addFrame({ id: 'f1', n: 1, at: Date.now() - 20_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Code: a TypeScript function exportOrders in export.ts.' })
  copilot.add('them', 'Is that something you support?', Date.now() - 1500, Date.now())
  void copilot.assist({ kind: 'suggest' })
  await wait(100)
  copilot.add('them', 'And what is your timeline for the rollout?', Date.now() - 1500, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await wait(100)
  assert.deepEqual(
    requests.filter((r) => r.lane !== 'vision').map((r) => [r.lane, r.ended]),
    [
      ['quick', 'stopped'],
      ['deep', 'stopped'],
      ['quick', 'done']
    ]
  )
})

test('Think deeper by its key after an "Okay." deepens the answer they got, not the "Okay."', async () => {
  const { copilot, requests, events } = copilotPlaying(async (input, { onDelta, onAccepted }) => {
    onAccepted?.()
    onDelta(input.lane === 'deep' ? '- Version vectors per order.' : 'LEVEL: quick\nWe keep one writer per order.')
  })
  copilot.add('them', 'How do you keep the sync consistent when both warehouses update the same order?', Date.now() - 4000, Date.now() - 2000)
  await copilot.assist({ kind: 'suggest' })
  copilot.add('them', 'Okay.', Date.now() - 500, Date.now())
  copilot.deeper()
  await wait(50)
  assert.deepEqual(
    requests.map((r) => r.lane),
    ['quick', 'deep']
  )
  assert.deepEqual(
    cards(events).map((c) => [c.question.slice(0, 40), c.deep]),
    [['How do you keep the sync consistent when', '- Version vectors per order.']]
  )
})

test("a summary of the call isn't cut short by the next question's suggestion", async () => {
  const { copilot, requests, events } = copilotPlaying(async (input, { signal, onDelta, onAccepted }) => {
    onAccepted?.()
    if (input.lane === 'background') {
      for (const part of ['Key points\n- pricing agreed\n', 'Next steps\n- pilot in May\n']) {
        await sleep(300, signal)
        onDelta(part)
      }
    } else {
      await sleep(100, signal)
      onDelta('LEVEL: quick\nYes, SAML and OIDC.')
    }
  })
  copilot.add('them', 'We agreed on the pricing.', Date.now() - 4000, Date.now() - 2000)
  const summary = copilot.assist({ kind: 'summary' })
  await wait(100)
  copilot.add('them', 'Do you support single sign-on?', Date.now() - 1500, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await summary
  await wait(700)
  assert.deepEqual(
    requests.map((r) => [r.lane, r.ended]),
    [
      ['background', 'done'],
      ['quick', 'done']
    ]
  )
  assert.equal(cards(events)[0].text, 'Key points\n- pricing agreed\nNext steps\n- pilot in May\n')
})

test("New call stops the call before's frame descriptions and notes, and the new call's snapshot is described at once", async () => {
  let described = 0
  const { copilot, requests } = copilotPlaying(async (input, { signal, onDelta }) => {
    if (input.lane === 'vision') described++
    await sleep(input.lane === 'vision' && described > 1 ? 10 : 5000, signal)
    onDelta(input.lane === 'vision' ? 'F1: A slide.' : '## Notes\n- Pricing.')
  })
  copilot.setListening(true)
  copilot.addFrame({ id: 'f1', n: 1, at: Date.now(), kind: 'snapshot', thumbUrl: '', imageUrl: '' })
  await wait(50)
  await copilot.clear()
  const frame = { id: 'f2', n: 1, at: Date.now(), kind: 'snapshot', thumbUrl: '', imageUrl: '' }
  copilot.addFrame(frame)
  await wait(200)
  assert.deepEqual(
    requests.map((r) => [r.lane, r.ended]),
    [
      ['vision', 'stopped'],
      ['vision', 'done']
    ]
  )
  assert.equal(frame.note, 'A slide.')
})

test('a click or a breath after their question starts nothing again: the answer under way is for the same words', async () => {
  const { copilot, requests, events } = copilotPlaying(async (_input, { signal, onDelta, onAccepted }) => {
    onAccepted?.()
    await sleep(300, signal)
    onDelta('LEVEL: quick\nAbout two weeks.')
  })
  copilot.setListening(true)
  const question = 'How long does the onboarding take?'
  const at = Date.now() - 2000
  copilot.anticipate(question, at, 'seg-1')
  // A sound after the pause: heard again, it's still the question.
  copilot.talkedOn('seg-1', question)
  copilot.anticipate(question, at, 'seg-1')
  await wait(50)
  copilot.add('them', question, at, Date.now(), 'seg-1')
  await wait(400)
  assert.deepEqual(
    requests.map((r) => r.ended),
    ['done']
  )
  assert.deepEqual(
    cards(events).map((c) => c.text),
    ['About two weeks.']
  )
  // More words since the pause: the answer started there was early.
  copilot.anticipate('Is there a trial?', Date.now() - 1000, 'seg-2')
  await wait(50)
  copilot.talkedOn('seg-2', 'Is there a trial? And how long is it?')
  await wait(50)
  assert.deepEqual(
    requests.map((r) => r.ended),
    ['done', 'stopped']
  )
})

test("an earlier line's suggestion waits for the answer started at the pause of their follow-up, which covers both", async () => {
  const { copilot, requests, events } = copilotPlaying(async (_input, { signal, onDelta, onAccepted }) => {
    onAccepted?.()
    await sleep(300, signal)
    onDelta('LEVEL: quick\nOur plans start at 19 euros a seat.')
  })
  copilot.setListening(true)
  // A request that ends in "." waits a moment longer for its suggestion; the follow-up's pause comes meanwhile.
  copilot.add('them', 'Tell me about your pricing.', Date.now() - 1800, Date.now())
  await wait(900)
  const at = Date.now() - 800
  copilot.anticipate('What about yearly billing?', at, 'seg-b')
  await wait(600)
  copilot.add('them', 'What about yearly billing?', at, Date.now(), 'seg-b')
  await wait(1500)
  assert.deepEqual(
    requests.map((r) => r.ended),
    ['done']
  )
  assert.deepEqual(
    cards(events).map((c) => c.question),
    ['Tell me about your pricing. What about yearly billing?']
  )
})
