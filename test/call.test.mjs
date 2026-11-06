// The call saved as it goes: closing Togle or a crash doesn't lose it, and it comes back when Togle starts.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { copilotWith, quick, wait, workDir } from './helpers.mjs'

const work = workDir('call')
const { AgentStore, CallFile, Copilot, FrameStore } = await import('./.build/togle.mjs')
const saved = path.join(work, 'call.bin')

const store = new AgentStore(async () => 'digest')
await store.load()

const line = (speaker, text, at) => ({ id: `${speaker}-${at}`, speaker, text, at, end: at + 2000 })
const state = (transcript) => ({ transcript, frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [] })

test('the call is saved encrypted, comes back as it was, and Clear deletes it', async () => {
  const call = state([line('them', 'What does the Growth plan cost?', 1000), line('me', 'Thirty-nine euros a seat.', 4000)])
  const file = new CallFile(() => ({ frameSession: 'session-1', state: call }))
  file.setView({ cards: [{ id: 'card-1', text: 'Thirty-nine euros a seat.' }], reviewedLines: 0 })
  await file.flush()
  assert.ok(existsSync(saved))
  // Through the OS keystore, as the ChatGPT sign-in is (the tests' stand-in only marks it).
  assert.ok(readFileSync(saved, 'utf8').startsWith('ENC:'), 'written encrypted')
  const back = await new CallFile(() => null).load()
  assert.equal(back.frameSession, 'session-1')
  assert.deepEqual(back.state, call)
  assert.deepEqual(back.view.cards, [{ id: 'card-1', text: 'Thirty-nine euros a seat.' }])
  await file.clear()
  assert.equal(existsSync(saved), false)
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a change is saved a moment later, and a call with nothing in it leaves no file', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let call = state([line('them', 'Hello?', 1000)])
  const file = new CallFile(() => (call.transcript.length ? { frameSession: 's', state: call } : null))
  file.changed()
  assert.equal(file.pending, true)
  t.mock.timers.tick(2000)
  await file.flush()
  assert.equal(existsSync(saved), true)
  call = state([])
  file.changed()
  await file.flush()
  assert.equal(existsSync(saved), false)
})

test('a call saved days ago is not picked up again: its pictures are gone by then', async (t) => {
  const file = new CallFile(() => ({ frameSession: 's', state: state([line('them', 'Hello?', 1000)]) }))
  file.changed()
  await file.flush()
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 4 * 24 * 3600_000 })
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a call picked up again goes on: its questions are not answered again, the next one is', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nForty seats come to 1,560 euros.'])
  const t0 = Date.now() - 60_000
  copilot.restore({ ...state([line('them', 'What does the Growth plan cost?', t0), line('me', 'Thirty-nine euros a seat.', t0 + 5000)]), answeredUntil: t0 })
  copilot.setListening(true)
  copilot.add('them', 'And for forty seats?', Date.now() - 1500, Date.now())
  await wait(500)
  assert.equal(quick(inputs).length, 1)
  assert.match(quick(inputs)[0].user, /What they just said, which is what to answer: "And for forty seats\?"/)
  assert.match(quick(inputs)[0].user, /What does the Growth plan cost\?/, 'the earlier part of the call is in its timeline')
})

test("pictures of a call picked up again stay where they were, and new ones are numbered after them", async () => {
  const frames = new FrameStore()
  const first = await frames.add('recorded', Date.now(), Buffer.from('one'), Buffer.from('one-thumb'))
  const session = frames.sessionId
  const later = new FrameStore()
  later.resume(session, first.n)
  const next = await later.add('recorded', Date.now(), Buffer.from('two'), Buffer.from('two-thumb'))
  assert.equal(next.n, 2)
  assert.equal(new URL(next.imageUrl).hostname, new URL(first.imageUrl).hostname)
  assert.ok(existsSync(path.join(work, 'sessions', session, 'F1.jpg')))
  assert.ok(existsSync(path.join(work, 'sessions', session, 'F2.jpg')))
})

test('every change to the call reaches the saving', async () => {
  const sales = await store.create('sales')
  const changes = []
  const { copilot } = copilotWith(Copilot, store, sales.id, [])
  copilot.onChange = () => changes.push(true)
  copilot.add('them', 'Hello there.', Date.now() - 1000, Date.now())
  copilot.addFrame({ id: 'f1', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  copilot.noteAnswer({ question: 'Is there a trial?', answer: 'Yes, 14 days.' })
  assert.equal(changes.length, 3)
})

test("the call's brief goes first in every answer's prompt, is saved with the call, and a new call starts without it", async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nLet us start with a two-week pilot.'])
  const brief = "Discovery call with Northwind's head of support. I want to book a two-week pilot."
  copilot.setBrief(`  ${brief}  `)
  copilot.add('them', 'So what would you suggest as a next step?', Date.now() - 1500, Date.now())
  await copilot.assist({ kind: 'suggest' })
  const [first] = quick(inputs)
  // Right after the instructions, which are the same for every answer: the first thing about the call.
  assert.ok(/^Start with one line, exactly "LEVEL[^]*?\n\nAbout this call \(my brief\): /.test(first.user), first.user.slice(0, 160))
  assert.ok(first.user.indexOf(`About this call (my brief): ${brief}`) < first.user.indexOf('Timeline of the call'))
  assert.equal(copilot.callState().brief, brief)
  assert.equal(copilot.currentCall().brief, brief)
  const restored = copilotWith(Copilot, store, sales.id, []).copilot
  restored.restore(copilot.callState())
  assert.equal(restored.currentCall().brief, brief)
  await copilot.clear()
  assert.equal(copilot.currentCall().brief, '')
})

test('a brief no call came of goes 12 hours after it was told; one a call used stays with that call', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const sales = await store.create('sales')
  const { copilot, events } = copilotWith(Copilot, store, sales.id, [])
  await copilot.setBrief('Call with Ana at 3 about the project plan.')
  t.mock.timers.tick(11 * 3600_000)
  assert.equal(copilot.currentCall().brief, 'Call with Ana at 3 about the project plan.', 'still there later that day')
  t.mock.timers.tick(3600_000)
  assert.equal(copilot.currentCall().brief, '', 'gone 12 hours after, with no call since')
  assert.ok(events.some((e) => e.channel === 'call:briefed' && e.payload.brief === ''), 'and the window is told')
  // Picked up after Togle was closed meanwhile: gone at once.
  const later = copilotWith(Copilot, store, sales.id, []).copilot
  later.restore({ ...state([]), brief: 'Call with Ana at 3.', briefAt: Date.now() - 13 * 3600_000 })
  assert.equal(later.currentCall().brief, '')
  // Told before a call that happened: it stays with that call.
  const used = copilotWith(Copilot, store, sales.id, []).copilot
  used.restore({ ...state([line('them', 'Shall we go through the plan?', Date.now() - 13 * 3600_000)]), brief: 'Call with Ana at 3.', briefAt: Date.now() - 14 * 3600_000 })
  assert.equal(used.currentCall().brief, 'Call with Ana at 3.')
})

test("what I told the agent lately goes with a live call's answers, after the brief, but not a week back nor in its chat", async () => {
  const sales = await store.create('sales')
  await store.addText(sales.id, 'Fixing the Safari checkout crash (Claude Code session)', 'The checkout crashed on Safari with an empty cart; fixed in src/cart.ts.')
  const now = Date.now()
  const talk = [
    { role: 'user', text: 'For the Acme call: they are still on the old plan.', at: now - 8 * 86_400_000 },
    { role: 'user', text: "For tomorrow's standup: if they ask about Android, it's Marko's team, and they'll know by Friday.", at: now - 20 * 3_600_000 },
    { role: 'agent', text: "I'll have that with you on the call.", at: now - 20 * 3_600_000 + 4000, changes: ['Added to Knowledge: Fixing the Safari checkout crash (Claude Code session)'] },
    { role: 'call', at: now - 60_000 }
  ]
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ["LEVEL: quick\nMarko's team has it; they'll know by Friday."], { talk: async () => talk })
  copilot.setBrief('Standup with the product team.')
  copilot.add('them', 'And what about the Android app?', Date.now() - 1500, Date.now())
  await copilot.assist({ kind: 'suggest' })
  const [first] = quick(inputs)
  const block = first.user.indexOf('What I said to you in Togle lately')
  assert.ok(block > first.user.indexOf('About this call (my brief)') && block < first.user.indexOf('Timeline of the call'), first.user.slice(0, 600))
  assert.match(first.user, /\nMe \((today|yesterday) \d\d:\d\d\): For tomorrow's standup: if they ask about Android, it's Marko's team/)
  assert.match(first.user, /\nYou \((today|yesterday) \d\d:\d\d\): I'll have that with you on the call\.\n {2}\(Added to Knowledge: Fixing the Safari checkout crash \(Claude Code session\)\)/)
  assert.match(first.user, /\n\[a call, (today|yesterday) \d\d:\d\d, going on\]/)
  assert.doesNotMatch(first.user, /old plan/, 'not what was said over a week ago')
  // A question tried in the agent's chat isn't on a call.
  await copilot.test(sales.id, 'And what about the Android app?')
  await wait(100)
  assert.doesNotMatch(quick(inputs).at(-1).user, /What I said to you in Togle lately/)
})

test("what I undid since, and a document taken out again, go to a call's answers as undone", async () => {
  const sales = await store.create('sales')
  await store.addText(sales.id, 'Pricing', 'Growth: 39 euros per user a month, billed yearly.')
  // It remembered an amount it misheard; I took that back.
  const remembered = (await store.update(sales.id, { memory: ['Globex pays 53 EUR per seat.'] }, 'train')).history.at(-1)
  await store.undo(sales.id, remembered.id)
  const at = Date.now() - 3_600_000
  const talk = [
    { role: 'user', text: 'Globex pays 53 a seat. Also add my old price list and the pricing page.', at },
    { role: 'agent', text: 'Done.', at: at + 4000, changes: [remembered.text, 'Added to Knowledge: Old price list', 'Added to Knowledge: Pricing'] }
  ]
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nOk.'], { talk: async () => talk })
  copilot.add('them', 'What do we pay per seat?', Date.now() - 1500, Date.now())
  await copilot.assist({ kind: 'suggest' })
  const { user } = quick(inputs)[0]
  assert.ok(user.includes(`\n  (undone since: ${remembered.text})`), user.slice(0, 900))
  assert.match(user, /\n {2}\(undone since: Added to Knowledge: Old price list\)/)
  assert.match(user, /\n {2}\(Added to Knowledge: Pricing\)/)
})

test("notes for a call, from before a week of pasting, come back on that call by its name, and not on another's", async () => {
  const sales = await store.create('sales')
  const now = Date.now()
  const talk = [
    { role: 'user', text: "For the Initech renewal: they're on Growth with 25 seats, and I can give 5% off at most.", at: now - 6 * 86_400_000 },
    { role: 'agent', text: 'Noted for the Initech call.', at: now - 6 * 86_400_000 + 60_000 },
    ...Array.from({ length: 6 }, (_, i) => ({ role: 'user', text: `Another log to look at, ${i}: ${'z'.repeat(1400)}`, at: now - (5 - i * 0.5) * 86_400_000 }))
  ]
  const asked = async (brief, question) => {
    const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nOk.'], { talk: async () => talk })
    copilot.setBrief(brief)
    copilot.add('them', question, Date.now() - 1500, Date.now())
    await copilot.assist({ kind: 'suggest' })
    return quick(inputs)[0].user
  }
  const initech = await asked('Renewal call with Initech', 'Can you do 30% off?')
  const block = initech.indexOf('What I said to you in Togle before that, naming who or what this call is about')
  assert.ok(block > initech.indexOf('Timeline of the call'), 'after the timeline, so the cached start stays the same')
  assert.match(initech.slice(block), /\nMe \([^)]+\): For the Initech renewal: they're on Growth with 25 seats, and I can give 5% off at most\.\nYou \([^)]+\): Noted for the Initech call\./)
  assert.doesNotMatch(await asked('Call with Acme about their Salesforce integration', 'Can you do 30% off?'), /Initech/)
})

test('what I said that answers the question goes beside it, with its day; not for a question it says nothing about', async () => {
  const sales = await store.create('sales')
  const now = Date.now()
  const talk = [
    { role: 'user', text: "For tomorrow's standup: if anyone asks about Safari 16, we keep supporting it until March, Marta changed her mind. And Ivan is back on Thursday.", at: now - 20 * 3_600_000 },
    { role: 'agent', text: 'Noted for the standup.', at: now - 20 * 3_600_000 + 1000 },
    { role: 'user', text: `A pasted log: ${'z'.repeat(1400)}`, at: now - 3_600_000 }
  ]
  const asked = async (question) => {
    const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nOk.'], { talk: async () => talk })
    copilot.add('them', question, Date.now() - 1500, Date.now())
    await copilot.assist({ kind: 'suggest' })
    return quick(inputs)[0].user
  }
  const sixteen = await asked('Are we still supporting safari sixteen or not?')
  const block = sixteen.indexOf('What I said to you in Togle about this, with when')
  assert.ok(block > sixteen.indexOf('Timeline of the call'), 'beside the question, after the timeline')
  // A short message whole; a long one by its sentence that answers.
  assert.match(sixteen.slice(block), /\nMe \((today|yesterday) \d\d:\d\d\): For tomorrow's standup: if anyone asks about Safari 16, we keep supporting it until March, Marta changed her mind\./)
  assert.doesNotMatch(sixteen.slice(block), /pasted log/)
  assert.doesNotMatch(await asked('Where is the postgres move at?'), /What I said to you in Togle about this/)
})

test("asked again after the review, a call's question comes with the call as it was then, and gets the quick answer only", async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: deep\nYes, through our Salesforce connector.'])
  const t0 = Date.now() - 120_000
  copilot.setBrief('Discovery call with Northwind; they use Salesforce.')
  copilot.restore({
    ...state([
      line('them', 'We run all our reporting in Salesforce today.', t0),
      line('them', 'Does it work with Salesforce?', t0 + 20_000),
      line('them', 'And what about HubSpot, later on?', t0 + 60_000)
    ]),
    brief: 'Discovery call with Northwind; they use Salesforce.'
  })
  await copilot.test(sales.id, 'Does it work with Salesforce?', { asked: t0 + 21_000, tag: 'again-1/0', kind: 'suggest' })
  await wait(100)
  assert.equal(inputs.length, 1, 'no deep answer')
  const [asked] = inputs
  assert.match(asked.user, /\n\nAbout this call \(my brief\): Discovery call with Northwind/)
  assert.match(asked.user, /We run all our reporting in Salesforce today\./)
  assert.doesNotMatch(asked.user, /HubSpot/, 'nothing said after the question')
})

test('a question asked again gets what I told the agent by then, as its first answer had it, and nothing I wrote after', async () => {
  const sales = await store.create('sales')
  const t0 = Date.now() - 120_000
  const talk = [
    { role: 'user', text: 'For the Northwind call: they are on Salesforce Enterprise, and our connector covers it.', at: t0 - 3_600_000 },
    { role: 'call', at: t0 },
    { role: 'user', text: 'Keep them.', at: t0 + 90_000 }
  ]
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nYes.'], { talk: async () => talk })
  copilot.restore({ ...state([line('them', 'Does it work with Salesforce?', t0 + 20_000)]), brief: '' })
  await copilot.test(sales.id, 'Does it work with Salesforce?', { asked: t0 + 21_000, tag: 'again-1/0', kind: 'suggest' })
  await wait(100)
  const [asked] = inputs
  assert.match(asked.user, /What I said to you in Togle lately[^\n]*\nMe \([^)]*\): For the Northwind call: they are on Salesforce Enterprise/)
  assert.doesNotMatch(asked.user, /Keep them/, 'not what I wrote after it was asked')
})

test('a question asked again is told apart from the Test tab, and comes back as it was asked: my question, with its screenshot', async () => {
  const sales = await store.create('sales')
  const { copilot, events, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nIt reads the export button.'])
  const t0 = Date.now() - 120_000
  const shot = { id: 'shot', n: 2, at: t0 + 30_500, kind: 'snapshot', thumbUrl: '', imageUrl: '', note: 'Code: the export function.' }
  copilot.restore({
    ...state([line('them', 'Have a look at this.', t0)]),
    frames: [{ id: 'f1', n: 1, at: t0 + 5_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Slide: pricing.' }, shot],
    notes: '## Notes\n- They export reports every Monday.',
    notesUntil: t0
  })
  await copilot.test(sales.id, 'What does this function do?', { asked: t0 + 30_000, tag: 'again-2/1', kind: 'ask', withScreen: true })
  const start = events.find((e) => e.channel === 'agent-test' && e.payload.type === 'start').payload
  assert.equal(start.again, 'again-2/1')
  assert.equal(start.kind, 'ask')
  const [asked] = inputs
  assert.match(asked.user, /My question: What does this function do\?/, 'asked as my own question, not as words to say')
  assert.equal(asked.images.length, 1, 'with the screenshot taken for it')
  assert.match(asked.user, /They export reports every Monday/, 'with the call notes of that moment')
})

test('a suggestion asked again that had a screenshot is answered with it, not by the approved answer alone', async () => {
  const sales = await store.create('sales')
  await store.update(sales.id, {
    answers: [{ id: 'a1', question: 'What does this error mean?', answer: 'It means the export timed out.', origin: 'manual', addedAt: 1 }]
  })
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nThe stack trace shows a null customer id in mergeOrders.'])
  const t0 = Date.now() - 120_000
  const shot = { id: 'shot', n: 1, at: t0 + 30_500, kind: 'snapshot', thumbUrl: '', imageUrl: '', note: 'Chat: a TypeError stack trace.' }
  copilot.restore({ ...state([line('them', 'What does this error mean?', t0 + 28_000)]), frames: [shot] })
  await copilot.test(sales.id, 'What does this error mean?', { asked: t0 + 30_000, tag: 'again-1/0', kind: 'suggest', withScreen: true })
  assert.equal(quick(inputs).length, 1, 'the model looks at the screenshot')
  assert.equal(quick(inputs)[0].images.length, 1)
})

test('asked again, the picture that goes with it is what was on screen then, and none while people were on camera', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nIt is 39 euros a seat.', 'LEVEL: quick\nIt is 39 euros a seat.'])
  const t0 = Date.now() - 120_000
  const slide = { id: 'f1', n: 1, at: t0 + 5_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Slide: pricing.' }
  const same = { id: 'f2', n: 2, at: t0 + 10_000, kind: 'recorded', thumbUrl: '', imageUrl: '', unchanged: true }
  const people = { id: 'f3', n: 3, at: t0 + 40_000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'Ana on camera.', people: true }
  copilot.restore({
    ...state([line('them', 'What does the Growth plan cost?', t0 + 12_000), line('them', 'And for fifty seats?', t0 + 45_000)]),
    frames: [slide, same, people]
  })
  await copilot.test(sales.id, 'What does the Growth plan cost?', { asked: t0 + 14_000, tag: 'again-1/0', kind: 'suggest' })
  assert.equal(quick(inputs)[0].images.length, 1, 'the slide, still on screen')
  await copilot.test(sales.id, 'And for fifty seats?', { asked: t0 + 47_000, tag: 'again-1/1', kind: 'suggest' })
  assert.equal(quick(inputs)[1].images.length, 0, 'Ana on camera, not the slide from before')
})

test('asked again, a question in a long call gets more of the call before it instead of notes that tell what came after', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nYes, through our Salesforce connector.'])
  const t0 = Date.now() - 3_600_000
  const filler = Array.from({ length: 180 }, (_, i) =>
    line(i % 2 ? 'me' : 'them', `Point ${i} about the rollout plan, the training sessions and who signs off on each step.`, t0 + 10_000 + i * 10_000)
  )
  const asked = t0 + 10_000 + 180 * 10_000
  copilot.restore({
    ...state([line('them', 'We run all our reporting in Salesforce today.', t0), ...filler, line('them', 'Does it work with Salesforce?', asked - 2_000)]),
    notes: '## Notes\n- Luka said it works through the Salesforce connector, set up in a day.',
    notesUntil: asked + 600_000
  })
  await copilot.test(sales.id, 'Does it work with Salesforce?', { asked, tag: 'again-1/0', kind: 'suggest' })
  const [prompt] = quick(inputs)
  assert.doesNotMatch(prompt.user, /set up in a day/, 'nothing from after the question')
  assert.match(prompt.user, /We run all our reporting in Salesforce today\./, 'the start of the call, which the notes would have held')
})

test('a question from before Togle closed is not answered when the call goes on with something that needs no reply', async () => {
  const sales = await store.create('sales')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nIt is 39 euros a seat.'])
  const t0 = Date.now() - 60_000
  // Saved while their question was still open (nothing had answered it yet).
  copilot.restore(state([line('them', 'What does the Growth plan cost?', t0)]))
  copilot.setListening(true)
  copilot.add('them', 'Let me check with my team first.', Date.now() - 1500, Date.now())
  await wait(1500)
  assert.equal(quick(inputs).length, 0)
})

test('closing waits for a save still being written; the same cards again change nothing', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-20T10:00:00Z') })
  const call = state([line('them', 'Is there a trial?', 1000)])
  const view = { cards: [{ id: 'card-1', text: 'Yes, 14 days.' }], reviewedLines: 0 }
  const file = new CallFile(() => ({ frameSession: 's', state: call }))
  file.setView(view)
  const writing = file.flush()
  assert.equal(file.pending, true, 'still being written')
  await writing
  assert.equal(file.pending, false)
  // Togle starts two days later and shows the same cards: the call is as old as it was.
  t.mock.timers.setTime(Date.parse('2026-10-22T10:00:00Z'))
  const later = new CallFile(() => ({ frameSession: 's', state: call }))
  const back = await later.load()
  later.setView(structuredClone(back.view))
  assert.equal(later.pending, false, 'showing what was picked up is no change')
  await later.flush()
  assert.equal((await new CallFile(() => null).load()).savedAt, Date.parse('2026-10-20T10:00:00Z'))
  // Windows shutting down: saved at once.
  later.setView({ ...view, reviewedLines: 1 })
  later.flushSync()
  const now = await new CallFile(() => null).load()
  assert.equal(now.view.reviewedLines, 1)
  assert.equal(now.savedAt, Date.parse('2026-10-22T10:00:00Z'))
})

test('Windows shutting down while a save is still being written: the newest call is what stays', async () => {
  let call = state([line('them', 'Is there a trial?', 1000)])
  const file = new CallFile(() => ({ frameSession: 's', state: call }))
  file.changed()
  const writing = file.flush()
  // Said while that save was being written, then Windows stops Togle.
  call = state([line('them', 'Is there a trial?', 1000), line('me', 'Yes, fourteen days.', 4000)])
  file.changed()
  file.flushSync()
  assert.equal((await new CallFile(() => null).load()).state.transcript.length, 2, 'written at once')
  await writing
  await file.flush()
  assert.equal((await new CallFile(() => null).load()).state.transcript.length, 2, 'the older save, ending after, did not replace it')
})

test('a call with only its brief, or only a card asked before anyone spoke, is saved too', async () => {
  const sales = await store.create('sales')
  const { copilot } = copilotWith(Copilot, store, sales.id, [])
  const file = new CallFile((hasCards) => {
    const s = copilot.callState()
    return s.transcript.length || s.frames.length || s.brief || s.callAnswers.length || hasCards ? { frameSession: 's', state: s } : null
  })
  await file.clear()
  copilot.setBrief('Renewal call with Acme; I want the three-year deal.')
  file.changed()
  await file.flush()
  assert.equal((await new CallFile(() => null).load()).state.brief, 'Renewal call with Acme; I want the three-year deal.')
  copilot.setBrief('')
  file.setView({ cards: [{ id: 'card-1', text: 'Our SSO works with Okta and Entra ID.' }], reviewedLines: 0 })
  await file.flush()
  assert.deepEqual((await new CallFile(() => null).load()).view.cards, [{ id: 'card-1', text: 'Our SSO works with Okta and Entra ID.' }])
  await file.clear()
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a call cleared as Windows shuts down stays cleared: nothing saved meanwhile brings it back', async () => {
  const sales = await store.create('sales')
  const { copilot } = copilotWith(Copilot, store, sales.id, [])
  copilot.restore(state([line('them', 'Our budget is 40k, keep that between us.', 1000)]))
  const file = new CallFile((hasCards) => {
    const s = copilot.callState()
    return s.transcript.length || s.frames.length || s.brief || s.callAnswers.length || hasCards ? { frameSession: 's', state: s } : null
  })
  file.setView({ cards: [{ id: 'c1', text: 'Thanks, noted.' }], reviewedLines: 0 })
  await file.flush()
  // New call, as the window asks for it; Windows shuts down while it's being deleted.
  const clearing = file.clear(() => copilot.clear())
  file.flushSync()
  await clearing
  await file.flush()
  assert.equal(await new CallFile(() => null).load(), null)
})

test('a save that fails is tried again, and closing waits for that', async (t) => {
  const { safeStorage } = (await import('./electron.mjs')).default
  const call = state([line('them', 'Is there a trial?', 1000)])
  const file = new CallFile(() => ({ frameSession: 's', state: call }))
  const encrypt = safeStorage.encryptString
  safeStorage.encryptString = () => {
    throw new Error('The disk is full')
  }
  t.after(() => (safeStorage.encryptString = encrypt))
  file.changed()
  await file.flush()
  assert.equal(file.pending, true, 'still waiting to be saved')
  safeStorage.encryptString = encrypt
  await file.flush()
  assert.equal(file.pending, false)
  assert.equal((await new CallFile(() => null).load()).state.transcript.length, 1)
})
