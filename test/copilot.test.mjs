// The copilot: answers started at their pause, and which frames go with which answer.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, copilotWith, quick, shown, wait, workDir } from './helpers.mjs'

workDir('copilot')
const { AgentStore, Copilot } = await import('./.build/togle.mjs')

const store = new AgentStore(async () => 'digest')
await store.load()

test('a question answered at their pause shows the moment the final transcript says the same', async () => {
  const sales = await store.create('sales')
  const { copilot, events, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nThirty seats come to 1,050 euros a month.'])
  copilot.setListening(true)
  const at = Date.now() - 3000
  copilot.anticipate('How much is it for thirty seats?', at, 'seg-1')
  await wait(50)
  assert.equal(quick(inputs).length, 1, 'the request went out at the pause')
  assert.deepEqual(shown(events), [], 'and nothing shows before the final transcript')
  copilot.add('them', 'How much is it for thirty seats?', at, Date.now(), 'seg-1')
  assert.deepEqual(
    shown(events).map((e) => e.type),
    ['start', 'context', 'delta', 'done']
  )
  assert.equal(shown(events).find(event => event.type === 'delta').text, 'Thirty seats come to 1,050 euros a month.')
  await wait(400)
  assert.equal(quick(inputs).length, 1, 'no second answer for the same line')
})

test('talking on after the pause drops that answer unseen, and the whole question gets answered as usual', async () => {
  const sales = await store.create('sales')
  const { copilot, events, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nEarly.', 'LEVEL: quick\nThe whole answer.'])
  copilot.setListening(true)
  const at = Date.now() - 4000
  copilot.anticipate('Is it secure?', at, 'seg-2')
  await wait(50)
  copilot.dropAnticipated('seg-2') // a caption came in: they're talking again
  copilot.add('them', 'Is it secure? I mean, do you encrypt data at rest?', at, Date.now(), 'seg-2')
  await wait(450)
  assert.equal(shown(events).filter((e) => e.type === 'start').length, 1)
  assert.deepEqual(
    shown(events)
      .filter((e) => e.type === 'delta')
      .map((e) => e.text),
    ['The whole answer.']
  )
  assert.equal(quick(inputs).length, 2)
  assert.match(quick(inputs)[1].user, /What they just said, which is what to answer: "Is it secure\? I mean, do you encrypt data at rest\?"/)
})

test('a final transcript that says something else drops the early answer', async () => {
  const sales = await store.create('sales')
  const { copilot, events } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nYes, yearly.', 'LEVEL: quick\nYes, both.'])
  copilot.setListening(true)
  const at = Date.now() - 3000
  copilot.anticipate('Can we pay yearly?', at, 'seg-3')
  await wait(50)
  copilot.add('them', 'Can we pay yearly or quarterly?', at, Date.now(), 'seg-3')
  await wait(450)
  assert.deepEqual(
    shown(events)
      .filter((e) => e.type === 'delta')
      .map((e) => e.text),
    ['Yes, both.']
  )
})

test('small talk, a statement, or auto-suggest off starts nothing at a pause', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [])
  copilot.setListening(true)
  copilot.anticipate('Can you hear me?', Date.now(), 'seg-4')
  copilot.anticipate('We use Salesforce today.', Date.now(), 'seg-5')
  copilot.setListening(false)
  copilot.anticipate('How much is it?', Date.now(), 'seg-6')
  await wait(50)
  assert.equal(quick(inputs).length, 0)
})

test('asking on purpose wins over an answer started at a pause', async () => {
  const sales = await store.create('sales')
  const { copilot, events } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nEarly.', 'LEVEL: quick\nAsked for.'])
  copilot.setListening(true)
  copilot.anticipate('What does onboarding look like?', Date.now(), 'seg-7')
  await wait(50)
  await copilot.assist({ kind: 'ask', question: 'What does onboarding look like?' })
  copilot.add('them', 'What does onboarding look like?', Date.now() - 2000, Date.now(), 'seg-7')
  await wait(50)
  assert.deepEqual(
    shown(events)
      .filter((e) => e.type === 'delta')
      .map((e) => e.text),
    ['Asked for.']
  )
})

test('the quick answer gets only the key frames, lighter; the deep answer gets them all', async () => {
  const sales = await store.create('sales')
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push(input)
      onDelta(input.lane === 'quick' ? 'LEVEL: deep\nLet me look at that function.' : 'F5: code.')
    }
  }
  const frameAccess = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f, width) => `data:F${f.n}@${width ?? 'full'}`, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frameAccess, agentAccess(store, sales.id))
  const now = Date.now()
  for (const [i, ago] of [100, 80, 60, 40, 20, 5].entries()) {
    copilot.addFrame({ id: `f${i + 1}`, n: i + 1, at: now - ago * 1000, kind: 'recorded', thumbUrl: '', imageUrl: '' })
  }
  // Asked while F5 was on screen; F6 is the newest.
  copilot.add('them', 'Why does this function fail on empty input?', now - 10_000, now - 8_000)
  await copilot.assist({ kind: 'suggest' })
  await wait(50)
  const [first] = quick(inputs)
  assert.deepEqual(
    first.images.map((i) => i.url),
    ['data:F5@1600', 'data:F6@1600']
  )
  assert.match(first.user, /The images of frames F5, F6 follow, each after its label\./)
  assert.doesNotMatch(first.user, /image attached/, 'the timeline reads the same whichever frames go with a request')
  const deep = inputs.find((input) => input.lane === 'deep')
  assert.equal(deep.images.length, 5)
  assert.deepEqual(
    deep.images.filter((i) => i.url.endsWith('@full')).map((i) => i.url),
    ['data:F5@full', 'data:F6@full']
  )
})

test('a picture goes to the screen that was picked, and to the one under the mouse otherwise', async () => {
  const sales = await store.create('sales')
  const model = { id: 'fake', supportsTools: false, listModels: async () => [], stream: async (_input, { onDelta }) => onDelta('LEVEL: quick\nOk.') }
  const taken = []
  const frameAccess = {
    snapshot: async (display) => {
      taken.push(display)
      return { id: `s${taken.length}`, n: taken.length, at: Date.now(), kind: 'snapshot', thumbUrl: '', imageUrl: '' }
    },
    dataUrl: async () => 'data:',
    reset: async () => {}
  }
  const copilot = new Copilot(() => {}, () => model, frameAccess, agentAccess(store, sales.id))
  await copilot.assist({ kind: 'suggest', withScreen: true, screen: 22 })
  await copilot.snapshot(33)
  await copilot.assist({ kind: 'suggest', withScreen: true })
  await copilot.snapshot()
  assert.deepEqual(taken, [22, 33, undefined, undefined])
})

test("lines of the agent's documents that answer the question show at once; an approved answer takes their place", async () => {
  const sales = await store.create('sales')
  await store.addText(sales.id, 'Pricing', '- Starter: €19 per user per month.\n- Growth: €39 per user per month, unlimited dashboards.')
  const ask = async (question) => {
    const { copilot, events } = copilotWith(Copilot, store, sales.id, [])
    await copilot.assist({ kind: 'ask', question })
    await wait(50)
    return shown(events)
  }
  const first = await ask('What does the Growth plan cost per month?')
  assert.deepEqual(first.find((e) => e.type === 'facts')?.facts, [{ text: 'Growth: €39 per user per month, unlimited dashboards.', doc: 'Pricing' }])
  await store.addAnswer(sales.id, 'What does the Growth plan cost?', '39 euros per user a month, billed monthly or yearly.', 'manual')
  const second = await ask('What does the Growth plan cost per month?')
  assert.ok(second.some((e) => e.type === 'match'))
  assert.ok(!second.some((e) => e.type === 'facts'), 'the approved answer says it better')
})

test('what I told the agent since, that answers the question, shows at once before its documents, with when', async () => {
  const sales = await store.create('sales')
  await store.addText(sales.id, 'Browsers', '- Safari 16: support ends with release 4.3, Marta decided.\n- Chrome: the last three versions.')
  const yesterday = Date.now() - 86_400_000
  const talk = [
    {
      role: 'user',
      text: "For tomorrow's standup, use my Claude Code session about Safari 16 support. If anyone asks about Safari 16, we keep supporting it until March: Marta changed her mind.",
      at: yesterday
    },
    { role: 'agent', text: 'Noted.', at: yesterday + 1000 },
    { role: 'user', text: 'Do we still support Safari 16 on the old checkout?', at: yesterday + 2000 }
  ]
  const ask = async (question, access) => {
    const { copilot, events } = copilotWith(Copilot, store, sales.id, [], access)
    await copilot.assist({ kind: 'ask', question })
    await wait(50)
    return shown(events).find((e) => e.type === 'facts')?.facts
  }
  const facts = await ask('Are we still supporting Safari 16?', { talk: async () => talk })
  assert.equal(facts.length, 2)
  // Mine first: the sentence that answers, not the one asking it to use a session, nor a question of mine.
  assert.equal(facts[0].text, 'If anyone asks about Safari 16, we keep supporting it until March: Marta changed her mind.')
  assert.match(facts[0].doc, /^you told me yesterday \d\d:\d\d$/)
  assert.equal(facts[0].mine, true)
  assert.deepEqual(facts[1], { text: 'Safari 16: support ends with release 4.3, Marta decided.', doc: 'Browsers' })
  // Without the conversation (or with nothing in it that answers), the documents' lines as before.
  assert.deepEqual(await ask('Are we still supporting Safari 16?'), [{ text: 'Safari 16: support ends with release 4.3, Marta decided.', doc: 'Browsers' }])
})

test('asked exactly an approved question, the approved answer stands alone; asked more, the model answers too', async () => {
  const sales = await store.create('sales')
  await store.addAnswer(sales.id, 'Do you integrate with SAP?', 'Yes, through a partner connector, set up in a day.', 'manual')
  const { copilot, events, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nYes, and with Salesforce too.'])
  copilot.add('them', 'Does it work with SAP?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  assert.equal(quick(inputs).length, 0, 'no model request')
  assert.deepEqual(
    shown(events).map((e) => e.type),
    ['start', 'match', 'done']
  )
  copilot.add('them', 'And does it work with SAP and Salesforce?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  assert.equal(quick(inputs).length, 1)
})

test('the approved answer alone is not enough when a screenshot was taken for it, or the question needs thinking through', async () => {
  const sales = await store.create('sales')
  await store.addAnswer(sales.id, 'How would you design a rate limiter?', 'With a token bucket per client, kept in Redis.', 'manual')
  await store.addAnswer(sales.id, 'Do you integrate with SAP?', 'Yes, through a partner connector, set up in a day.', 'manual')
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta, onAccepted }) => {
      inputs.push(input)
      onAccepted?.()
      onDelta(input.lane === 'quick' ? 'LEVEL: quick\nOk.' : '- A point')
    }
  }
  const shot = { id: 'shot', n: 1, at: Date.now(), kind: 'snapshot', thumbUrl: '', imageUrl: '' }
  const frames = { snapshot: async () => shot, dataUrl: async () => 'data:image/jpeg;base64,AAAA', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  copilot.add('them', 'How would you design a rate limiter?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await wait(50)
  assert.deepEqual(
    inputs.map((i) => i.lane),
    ['quick', 'deep'],
    'a design question gets its deep answer'
  )
  copilot.add('them', 'Does it work with SAP?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest', withScreen: true })
  assert.equal(inputs.filter((i) => i.lane === 'quick').at(-1).images.length, 1, 'the screenshot taken for it is looked at')
  copilot.add('them', 'When will it work with SAP?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  assert.equal(inputs.filter((i) => i.lane === 'quick').length, 3, 'asking when is asking something else')
})

test("each shown card logs its timeline from the caller's last word, with discarded work counted separately", async () => {
  const sales = await store.create('sales')
  const logged = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta, onUsage }) => {
      await wait(20)
      onDelta('LEVEL: quick\nThirty seats come to 1,050 euros.')
      onUsage?.({ lane: input.lane, model: 'gpt-6-luna', input: 900, cached: 0, output: 12, reasoning: 0, rounds: 1, ms: 20 })
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => '', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id), (timing) => logged.push(timing))
  copilot.setListening(true)
  copilot.anticipate('Is it secure?', Date.now() - 3000, 'seg-x')
  copilot.dropAnticipated('seg-x')
  const end = Date.now()
  copilot.anticipate('How much is it for thirty seats?', end - 2000, 'seg-1')
  await wait(60)
  const confirmedAt = Date.now()
  copilot.add('them', 'How much is it for thirty seats?', end - 2000, end, 'seg-1')
  await wait(60)
  assert.equal(logged.filter((t) => t.dismissed).length, 1)
  assert.equal(logged.find((t) => t.dismissed).dismissed, 'superseded')
  assert.equal(logged.find((t) => t.dismissed).shown, undefined, 'discarded work contributes no display time')
  assert.equal(logged.filter((t) => !t.dismissed).length, 1)
  const [first] = logged.filter((t) => !t.dismissed)
  assert.equal(first.from, 'speech')
  assert.equal(first.atPause, true)
  assert.equal(first.nthInCall, 0)
  assert.deepEqual(first.tokens, { input: 900, cached: 0, output: 12, reasoning: 0 })
  // Started at the pause, it can be done before the final transcript shows it.
  assert.ok(first.request < first.modelText && first.modelText <= first.shown && first.modelText <= first.done, JSON.stringify(first))
  // Shown when the final transcript confirmed it: at least 60 ms after the line ended, plus its quiet tail.
  assert.ok(first.shown >= confirmedAt - end + 190, `${first.shown}`)

  copilot.add('them', 'And for forty?', Date.now() - 1500, Date.now())
  await wait(600)
  const displayed = logged.filter((t) => !t.dismissed)
  assert.equal(displayed.length, 2)
  assert.equal(displayed[1].nthInCall, 1)
  assert.equal(displayed[1].atPause, false)
})

test('an everyday question gets the quick answer only; the strong model waits for its verdict', async () => {
  const sales = await store.create('sales')
  const inputs = []
  // Accepted at once, but its first words take a while: long enough for a deep answer started on a hunch.
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta, onAccepted }) => {
      inputs.push(input)
      setTimeout(() => onAccepted?.(), 10)
      await wait(300)
      onDelta(input.lane === 'quick' ? 'LEVEL: quick\nYou sign up, and we set it up together in a week.' : '- A point')
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => '', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  for (const question of ['How do we get started?', 'What happens if we cancel after a month?']) {
    copilot.add('them', question, Date.now() - 2000, Date.now())
    await copilot.assist({ kind: 'suggest' })
  }
  copilot.add('them', 'How would you design the sync between our two warehouses?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await wait(400)
  assert.deepEqual(
    inputs.map((input) => input.lane),
    ['quick', 'quick', 'quick', 'deep'],
    'only the design question started the deep answer before the verdict'
  )
})

test('frames of only people on camera are described less and less often, and a shared screen brings it back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  const sales = await store.create('sales')
  const described = []
  let sharing = false
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      if (input.lane !== 'vision') return onDelta('LEVEL: quick\nOk.')
      const asked = [...input.user.matchAll(/F(\d+)/g)].map((m) => Number(m[1])).filter((n, i, all) => all.indexOf(n) === i)
      const listed = asked.slice(input.user.includes('previous frame') ? 1 : 0)
      described.push({ at: Date.now(), frames: listed, images: input.images.length })
      onDelta(listed.map((n) => (sharing ? `F${n}: Slide: pricing for the Growth plan.` : `F${n}: PEOPLE: Ana and Marko on camera.`)).join('\n'))
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const start = Date.now()
  let n = 0
  // A frame every 5 s: four minutes of people, then a shared screen.
  for (let s = 0; s < 300; s += 5) {
    sharing = s >= 240
    copilot.addFrame({ id: `f${++n}`, n, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
    await flush()
    t.mock.timers.tick(5000)
    await flush()
  }
  const people = described.filter((d) => d.at - start < 240_000)
  // Every 10 s would be 24 rounds; backing off to a minute leaves 7.
  assert.ok(people.length <= 7, `${people.length} rounds: ${JSON.stringify(described)}`)
  const shared = described.filter((d) => d.at - start >= 240_000)
  assert.ok(shared.length >= 3, `back to every 10 s once something is shared: ${JSON.stringify(shared)}`)
})

test("pictures of only people go with no answer, and frames with nothing new stay out of the timeline", async () => {
  const sales = await store.create('sales')
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push(input)
      onDelta(input.lane === 'vision' ? '' : input.lane === 'quick' ? 'LEVEL: deep\nLet me think.' : '- A point')
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const now = Date.now()
  copilot.addFrame({ id: 'a', n: 1, at: now - 60_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Slide: the Growth plan, 39 euros a seat.' })
  copilot.addFrame({ id: 'b', n: 2, at: now - 40_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Ana on camera.', people: true })
  copilot.addFrame({ id: 'c', n: 3, at: now - 20_000, kind: 'recorded', thumbUrl: '', imageUrl: '', unchanged: true, people: true })
  copilot.add('them', 'What do you think about this price?', now - 10_000, now - 8_000)
  await copilot.assist({ kind: 'suggest' })
  await wait(50)
  const [first] = quick(inputs)
  assert.deepEqual(first.images, [], 'on screen now: only people')
  assert.match(first.user, /Frame F1 appeared: Slide: the Growth plan/)
  assert.match(first.user, /Frame F2 appeared: Ana on camera\./)
  assert.doesNotMatch(first.user, /F3/)
  const deep = inputs.find((input) => input.lane === 'deep')
  assert.deepEqual(
    deep.images.map((i) => i.url),
    ['data:F1'],
    'the deep answer still gets the slide shown earlier'
  )
})

test('frames that look like the last one of only people are taken as read; a shared screen is not', async () => {
  const sales = await store.create('sales')
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push(input)
      if (input.lane === 'vision') onDelta(input.user.includes('F1') && !input.user.includes('F3') ? 'F1: PEOPLE: Ana on camera.' : 'F3: Slide: the Growth plan.')
      else onDelta('LEVEL: quick\nOk.')
    }
  }
  // Miniatures: Ana, Ana again a little moved, then a slide.
  const minis = { 1: new Uint8Array(576).fill(90), 2: new Uint8Array(576).fill(96), 3: new Uint8Array(576).fill(220) }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, miniature: async (f) => minis[f.n], reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const frame = (n) => ({ id: `f${n}`, n, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  const vision = () => inputs.filter((input) => input.lane === 'vision').length
  const f1 = frame(1)
  copilot.addFrame(f1)
  await wait(50)
  assert.equal(f1.people, true)
  const f2 = frame(2)
  copilot.addFrame(f2)
  await wait(50)
  assert.deepEqual([f2.people, f2.unchanged], [true, true], 'the same people again')
  copilot.add('them', 'So what do you think?', Date.now() - 1000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  assert.deepEqual(quick(inputs)[0].images, [], 'no picture of people with the answer')
  const f3 = frame(3)
  copilot.addFrame(f3)
  await wait(50)
  assert.ok(!f3.people && !f3.unchanged, 'a shared screen looks different')
  await copilot.assist({ kind: 'ask', question: 'What is on the slide?' })
  assert.deepEqual(
    quick(inputs)[1].images.map((i) => i.url),
    ['data:F3'],
    'the slide goes with the answer before it is described'
  )
  assert.equal(vision(), 1, 'only the first frame was described so far')
})

/** A model whose frame descriptions come from `describe(n)`, and that answers everything else with "Ok". */
function describer(describe) {
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push({ ...input, at: Date.now() })
      if (input.lane !== 'vision') return onDelta('LEVEL: quick\nOk.')
      const asked = input.user.replace(/^The previous frame[^\n]*\n[^\n]*\n\n/, '')
      const ns = [...new Set([...asked.matchAll(/F(\d+)/g)].map((m) => Number(m[1])))]
      onDelta(ns.map((n) => `F${n}: ${describe(n)}`).join('\n'))
    }
  }
  return { model, inputs, vision: () => inputs.filter((input) => input.lane === 'vision') }
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
}

test('people back on camera after a slide stay in the timeline, and a new view is described at the usual pace', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const sales = await store.create('sales')
  const { model, inputs, vision } = describer((n) => (n === 3 ? 'Slide: the Growth plan, 39 euros a seat.' : 'PEOPLE: Ana on camera.'))
  const ana = new Uint8Array(576).fill(90)
  const minis = { 1: ana, 2: new Uint8Array(576).fill(96), 3: new Uint8Array(576).fill(220), 4: ana }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, miniature: async (f) => minis[f.n], reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const start = Date.now()
  const added = []
  for (const n of [1, 2, 3, 4]) {
    added.push({ id: `f${n}`, n, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
    copilot.addFrame(added.at(-1))
    await settle()
    t.mock.timers.tick(5000)
    await settle()
  }
  // Ana was described first; the slide, a view like none described as people, 10 s after that rather than 20.
  const [ana1, slide1] = vision().map((input) => input.at)
  assert.equal(vision().length, 2)
  assert.equal((slide1 - ana1) / 1000, 10)
  assert.ok(ana1 - start <= 5000)
  const [, f2, , f4] = added
  assert.deepEqual([f2.people, f2.unchanged], [true, true], 'Ana again, right after Ana: nothing new')
  assert.deepEqual([f4.people, f4.unchanged, f4.note], [true, undefined, 'Ana on camera.'], 'Ana again after the slide: back on camera')
  copilot.add('them', 'Does this make sense to you?', Date.now() - 1000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  const [first] = quick(inputs)
  assert.match(first.user, /Frame F3 appeared: Slide[^\n]*\n[^\n]*Frame F4 appeared: Ana on camera\./)
  assert.deepEqual(first.images, [], 'only Ana is on screen')
})

test('a frame with nothing new keeps what the frame the model compared it with showed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const sales = await store.create('sales')
  const { model, vision } = describer((n) => (n === 3 ? 'SAME' : ''))
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  // A slide, then a frame already known to show only people (and nothing new), then the slide again.
  copilot.addFrame({ id: 'a', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Slide: pricing.' })
  copilot.addFrame({ id: 'b', n: 2, at: Date.now() + 1, kind: 'recorded', thumbUrl: '', imageUrl: '', people: true, unchanged: true })
  await settle()
  t.mock.timers.tick(5000)
  const f3 = { id: 'c', n: 3, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' }
  copilot.addFrame(f3)
  await settle()
  t.mock.timers.tick(10_000)
  await settle()
  assert.match(vision().at(-1).user, /The previous frame, F1, was described as:\nSlide: pricing\./)
  assert.deepEqual([f3.unchanged, f3.people], [true, undefined], 'still the slide, not people')
})

test('more snapshots than one round takes are described in the next round, not dropped', async () => {
  const sales = await store.create('sales')
  const { model, vision } = describer((n) => `Snapshot ${n}: the dashboard.`)
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const shots = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}`, n, at: Date.now() + n, kind: 'snapshot', thumbUrl: '', imageUrl: '' }))
  for (const shot of shots) copilot.addFrame(shot)
  await wait(50)
  assert.deepEqual(
    vision().map((input) => input.images.length),
    [4, 2]
  )
  assert.ok(
    shots.every((s) => s.note),
    shots.map((s) => s.note).join(' | ')
  )
})

test('a frame of people seen before is recognized even when a round of descriptions is due as it arrives', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const sales = await store.create('sales')
  const { model, vision } = describer(() => 'PEOPLE: Ana on camera.')
  // Reading a miniature takes a moment, as reading its file does.
  const miniature = async () => {
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve))
    return new Uint8Array(576).fill(90)
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', miniature, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  copilot.addFrame({ id: 'a', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  t.mock.timers.tick(0)
  await settle()
  assert.equal(vision().length, 1)
  t.mock.timers.tick(60_000)
  const again = { id: 'b', n: 2, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' }
  copilot.addFrame(again)
  t.mock.timers.tick(0)
  await settle()
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(vision().length, 1, 'Ana again needs no description')
  assert.deepEqual([again.people, again.unchanged], [true, true])
})

test('a change where the picture keeps still goes with the next answer, and is described, though it looks like the people seen before', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const sales = await store.create('sales')
  const { model, inputs, vision } = describer((n) => (n === 1 ? 'PEOPLE: Ana on camera.' : 'Ana on camera; the chat shows a TypeError stack trace from mergeOrders.'))
  // The paste changes a small part of the picture: its miniature is as close to Ana's as Ana moving.
  const minis = { 1: new Uint8Array(576).fill(90), 2: new Uint8Array(576).fill(93) }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, miniature: async (f) => minis[f.n], reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const f1 = { id: 'f1', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' }
  copilot.addFrame(f1)
  await settle()
  t.mock.timers.tick(1)
  await settle()
  assert.equal(f1.people, true)
  t.mock.timers.tick(5_000)
  const paste = { id: 'f2', n: 2, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '', content: true }
  copilot.addFrame(paste)
  await settle()
  assert.ok(!paste.people && !paste.unchanged, JSON.stringify(paste))
  copilot.add('them', 'Any idea what this error means?', Date.now() - 1000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  assert.deepEqual(
    inputs.filter((i) => i.lane === 'quick').at(-1).images.map((i) => i.url),
    ['data:F2'],
    'the answer sees it before it is described'
  )
  t.mock.timers.tick(30_000)
  await settle()
  assert.match(paste.note ?? '', /stack trace/)
  assert.equal(vision().length, 2)
})

test('"nothing new" on a shared screen (a pointer moved) does not slow descriptions down; only people on camera do', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const sales = await store.create('sales')
  // A slide, then frames where only the pointer moved, then the next slide at 60 s.
  const { model, vision } = describer((n) => (n === 1 ? 'Slide: pricing.' : n < 13 ? 'SAME' : 'Slide: the roadmap for next year.'))
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  for (let n = 1; n <= 16; n++) {
    copilot.addFrame({ id: `f${n}`, n, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
    await settle()
    t.mock.timers.tick(5_000)
    await settle()
  }
  const roadmap = vision().find((input) => input.user.includes('F13'))
  assert.ok(roadmap, 'the new slide was described')
  assert.ok(roadmap.at - Date.parse('2026-10-23T10:00:00Z') <= 75_000, `within 15 s of showing up at 60 s: at ${(roadmap.at - Date.parse('2026-10-23T10:00:00Z')) / 1000} s`)
})

test('a change where the picture keeps still is described however many recorded frames came with it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const sales = await store.create('sales')
  const { model, vision } = describer((n) => (n === 5 ? 'The chat shows a TypeError stack trace from mergeOrders.' : 'A video of the warehouse.'))
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const frame = (n) => ({ id: `f${n}`, n, at: Date.now() + n, kind: 'recorded', thumbUrl: '', imageUrl: '', ...(n === 5 ? { content: true } : {}) })
  copilot.addFrame(frame(1))
  t.mock.timers.tick(0)
  await settle()
  // Ten more before the next round, a video playing, and among them a paste in the chat.
  const later = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map(frame)
  for (const f of later) copilot.addFrame(f)
  t.mock.timers.tick(60_000)
  await settle()
  assert.equal(vision().length, 2)
  assert.match(vision()[1].user, /\bF5\b/)
  assert.match(later[3].note ?? '', /stack trace/)
})

test('frames still waiting for a description when Togle closed are described when the call is picked up again', async () => {
  const sales = await store.create('sales')
  const { model, vision } = describer(() => 'Slide: the Growth plan, 39 euros a seat.')
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const t0 = Date.now() - 60_000
  const frame = (n, more = {}) => ({ id: `f${n}`, n, at: t0 + n * 1000, kind: 'recorded', thumbUrl: '', imageUrl: '', ...more })
  // F2 and F3 were left to their neighbours, described around them; F5 and F6 were still waiting.
  const all = [frame(1, { note: 'Slide: pricing.' }), frame(2), frame(3), frame(4, { note: 'Slide: plans.' }), frame(5), frame(6)]
  copilot.restore({ transcript: [], frames: all, notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], undescribed: ['f5', 'f6'] })
  await wait(50)
  assert.equal(vision().length, 1)
  const asked = vision()[0].user.replace(/^The previous frame[^\n]*\n[^\n]*\n\n/, '')
  assert.deepEqual([...new Set(asked.match(/\bF\d+\b/g))], ['F5', 'F6'], 'not the ones left to their neighbours')
  assert.match(all[4].note ?? '', /Growth plan/)
})

test('what a call saves says which frames are still waiting for a description, also those being described', async () => {
  const sales = await store.create('sales')
  let release
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: (input) => (input.lane === 'vision' ? new Promise((resolve) => (release = resolve)) : Promise.resolve())
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async (f) => `data:F${f.n}`, reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  copilot.addFrame({ id: 'a', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  await wait(20)
  copilot.addFrame({ id: 'b', n: 2, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  assert.deepEqual(copilot.callState().undescribed, ['a', 'b'], 'a is being described, b waits')
  release()
  await copilot.clear()
})

test("the call's questions asked again and a question in Agents > Test don't stop each other", async () => {
  const sales = await store.create('sales')
  const words = 'LEVEL: quick\nThe Growth plan is 39 euros a seat a month.'.split(' ')
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { signal, onDelta }) => {
      for (const word of words) {
        signal.throwIfAborted()
        onDelta(`${word} `)
        await wait(15)
      }
    }
  }
  const events = []
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot((channel, payload) => events.push(payload), () => model, frames, agentAccess(store, sales.id))
  const t0 = Date.now() - 120_000
  copilot.restore({
    transcript: [{ id: 'q', speaker: 'them', text: 'What does the Growth plan cost?', at: t0, end: t0 + 2000 }],
    frames: [],
    notes: '',
    notesUntil: 0,
    answeredUntil: 0,
    callAnswers: []
  })
  const again = copilot.test(sales.id, 'What does the Growth plan cost?', { asked: t0 + 2000, tag: 'again-1/0', kind: 'suggest' })
  await wait(30)
  await Promise.all([again, copilot.test(sales.id, 'Is there a free trial?')])
  const texts = new Map()
  for (const e of events) if (e.type === 'delta') texts.set(e.id, (texts.get(e.id) ?? '') + e.text)
  assert.deepEqual(
    [...texts.values()].map((t) => t.trim()),
    ['The Growth plan is 39 euros a seat a month.', 'The Growth plan is 39 euros a seat a month.'],
    'both answered in full'
  )
})

test("asking for a deeper answer again thinks harder each time, up to the provider's hardest effort", async () => {
  const { updateSettings } = await import('./.build/togle.mjs')
  const sales = await store.create('sales')
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const efforts = async (provider) => {
    await updateSettings({ provider })
    const asked = []
    const model = {
      id: provider,
      supportsTools: false,
      listModels: async () => [],
      stream: async (input, { onDelta }) => {
        if (input.lane === 'deep') asked.push(input.effort)
        onDelta(input.lane === 'deep' ? 'Start with the logs.' : 'LEVEL: deep\nLet me look.')
      }
    }
    const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
    copilot.add('them', 'Why does the export crash every Monday?', Date.now() - 1500, Date.now())
    await copilot.assist({ kind: 'suggest' })
    await wait(50)
    for (let i = 0; i < 3; i++) {
      copilot.deeper()
      await wait(50)
    }
    return asked
  }
  try {
    // The lane's own effort first (undefined: as set up), then a step harder each time.
    assert.deepEqual(await efforts('claude'), [undefined, 'xhigh', 'max', 'max'])
    assert.deepEqual(await efforts('chatgpt'), [undefined, 'high', 'xhigh', 'xhigh'], "ChatGPT's deep lane starts at medium")
  } finally {
    await updateSettings({ provider: 'chatgpt' })
  }
})

test('New call: what was said before it and comes in late, a snapshot being taken, and questions asked again stay with the call before', async () => {
  const sales = await store.create('sales')
  let shot
  const frames = {
    snapshot: () => new Promise((resolve) => (shot = resolve)),
    dataUrl: async () => 'data:',
    reset: async () => {}
  }
  const requests = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: (input, { signal }) => {
      requests.push({ input, signal })
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    }
  }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  const said = Date.now() - 2000
  copilot.restore({ transcript: [{ id: 'q', speaker: 'them', text: 'What does the Growth plan cost?', at: said - 60_000, end: said - 58_000 }], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [] })
  void copilot.test(sales.id, 'What does the Growth plan cost?', { asked: said - 58_000, tag: 'again-1/0', kind: 'suggest' })
  await wait(20)
  const taking = copilot.snapshot()
  await copilot.clear()
  // Said before New call, transcribed only now.
  copilot.add('them', 'Our budget is 40k, keep that between us.', said, said + 1500)
  assert.equal(copilot.callState().transcript.length, 0)
  shot({ id: 's', n: 1, at: Date.now(), kind: 'snapshot', thumbUrl: '', imageUrl: '' })
  await assert.rejects(taking, /new call started/)
  assert.equal(copilot.callState().frames.length, 0)
  await wait(20)
  assert.equal(requests.length, 1, 'the question asked again had started')
  assert.equal(requests[0].signal.aborted, true, 'and stopped with the call')
  copilot.add('them', 'Hello again!', Date.now(), Date.now() + 500)
  assert.equal(copilot.callState().transcript.length, 1, 'what is said after it is the new call')
})

test('a frame still being compared with the people seen before is saved as waiting for a description', async () => {
  const sales = await store.create('sales')
  let read
  const frames = {
    snapshot: async () => assert.fail('no screen here'),
    dataUrl: async () => 'data:',
    miniature: () => new Promise((resolve) => (read = resolve)),
    reset: async () => {}
  }
  const { model } = describer(() => 'PEOPLE: Ana on camera.')
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, sales.id))
  copilot.restore({ transcript: [], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [] })
  // People were seen before: the next recorded frame is compared with them first.
  copilot.peopleViews = [{ mini: new Uint8Array(576).fill(90), note: 'PEOPLE: Ana on camera.' }]
  copilot.addFrame({ id: 'share', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  assert.deepEqual(copilot.callState().undescribed, ['share'])
  read(new Uint8Array(576).fill(10))
  await copilot.clear()
})
