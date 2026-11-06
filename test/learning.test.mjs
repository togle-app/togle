// Getting better the way Hermes Agent does: what I said in place of a suggestion teaches it, a skill improves in place,
// facts about one customer stay with their call, earlier calls come back on the next one with the same people, what
// each skill and answer is used for is counted, and tidying up merges what overlaps.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('learning')
const {
  AgentStore,
  Copilot,
  PastCalls,
  buildLearnPrompt,
  buildPrompt,
  buildTidyPrompt,
  namesIn,
  ownNames,
  parseCallRecord,
  parseLesson,
  parseLessons,
  parseTidy,
  pastCallsText,
  plainAnswer,
  skillAfter,
  skillsInPlay,
  splitReview,
  suggestionsOnCall
} = await import('./.build/togle.mjs')

// What tidying up replies, set by each test that tidies.
let tidyReply = 'NOTHING'
const store = new AgentStore(async (system) => (/tidy up the training/.test(system) ? tidyReply : 'About: a document'))
await store.load()
const fresh = async () => (await store.create('sales')).id
const agent = (id) => store.list().find((a) => a.id === id)

/** A copilot for one agent with a scripted model, reaching the store's uses and (optionally) earlier calls. */
function copilotFor(id, replies, pastCalls) {
  const events = []
  const inputs = []
  const used = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push(input)
      onDelta(replies.shift() ?? 'LEVEL: quick\nOk.')
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => '', reset: async () => {} }
  const copilot = new Copilot(
    (channel, payload) => events.push({ channel, payload }),
    () => model,
    frames,
    {
      active: () => agent(id),
      get: (other) => agent(other),
      knowledgeFor: (a, query, seen) => store.knowledgeFor(a, query, seen),
      search: (a, query, seen, first) => store.search(a, query, seen, first),
      facts: (a, question) => store.factsFor(a, question),
      code: () => undefined,
      noteUse: (a, use) => {
        used.push(use)
        store.noteUse(a.id, use)
      },
      pastCalls: pastCalls && { recall: (a, context) => pastCalls.recall(a.id, context), search: (a, query) => pastCalls.search(a.id, query) }
    }
  )
  return { copilot, events, inputs, used }
}

const done = async (events) => {
  for (let i = 0; i < 100 && !events.some((e) => e.payload?.type === 'done'); i++) await new Promise((r) => setTimeout(r, 10))
}

// ---- A skill improves in place ----

test('a skill the review improves keeps what it said: a reworded rule takes its old place, a new one goes at the end', () => {
  const how = '- Ask what they compare us with.\n- Then show the yearly saving in euros.'
  assert.equal(
    skillAfter(how, '- Offer the Starter plan at 19 euros a seat to smaller teams.'),
    '- Ask what they compare us with.\n- Then show the yearly saving in euros.\n- Offer the Starter plan at 19 euros a seat to smaller teams.'
  )
  assert.equal(
    skillAfter(how, '- Then show the yearly saving in euros, per seat.'),
    '- Ask what they compare us with.\n- Then show the yearly saving in euros, per seat.'
  )
  // Rules that only share a word or two are different rules, and so are a rule and its opposite.
  assert.equal(skillAfter('- Ask about their budget.', '- Ask about their timeline.'), '- Ask about their budget.\n- Ask about their timeline.')
  assert.equal(
    skillAfter('- Never offer a discount on the first call.', '- Offer a discount on the second call.'),
    '- Never offer a discount on the first call.\n- Offer a discount on the second call.'
  )
  // A rule it had is never dropped for room: what doesn't fit is left out instead.
  assert.equal(skillAfter('- one rule here', `- ${'x'.repeat(40)}`, 30), '- one rule here')
  assert.equal(skillAfter('- one rule\n- two rule', '- one rule, reworded at length past the limit', 25), '- one rule\n- two rule')
  // Nothing new: the skill as it was written, paragraphs and all.
  assert.equal(skillAfter('Approach:\n\n- Ask what they compare us with.', '- ask what they compare us with'), 'Approach:\n\n- Ask what they compare us with.')
})

test('the skills a moment calls for are the ones whose name or "when" it shares a meaningful word with', () => {
  const skills = [
    { id: 'p', name: 'Pricing objections', when: 'They say we are too expensive' },
    { id: 's', name: 'Security questions', when: 'They ask about data protection or compliance' },
    { id: 'c', name: 'Closing', when: 'The call is near its end' }
  ]
  assert.deepEqual(
    skillsInPlay(skills, 'To be honest, this is too expensive for a team our size.').map((s) => s.id),
    ['p']
  )
  assert.deepEqual(
    skillsInPlay(skills, 'How do you handle data protection under GDPR?').map((s) => s.id),
    ['s']
  )
  assert.deepEqual(skillsInPlay(skills, 'Nice weather today, right?'), [])
})

// ---- What I said in place of a suggestion ----

test('each suggestion goes beside what I said after it, until their next turn or the next card', () => {
  const t0 = 1_000_000
  const line = (speaker, text, at) => ({ id: `${at}`, speaker, text, at, end: at + 2000 })
  const transcript = [
    line('them', 'Can we pay annually?', t0),
    line('me', 'Yes, annual plans get two months free.', t0 + 3000),
    line('me', 'So you pay for ten.', t0 + 6000),
    line('them', 'And onboarding?', t0 + 10_000),
    line('me', 'About two weeks.', t0 + 14_000)
  ]
  const cards = [
    { kind: 'suggest', question: 'And onboarding?', text: 'Onboarding takes [onboarding time].', at: t0 + 11_000 },
    { kind: 'summary', question: '', text: '## Notes', at: t0 + 12_000 },
    { kind: 'suggest', question: 'Can we pay annually?', text: 'Yes, you get one month free [2].\n\nFacts:\n- Annual plans [2]', at: t0 + 1000 }
  ]
  assert.deepEqual(suggestionsOnCall(cards, transcript), [
    { question: 'Can we pay annually?', suggested: 'Yes, you get one month free.', said: 'Yes, annual plans get two months free. So you pay for ten.', approved: false },
    { question: 'And onboarding?', suggested: 'Onboarding takes [onboarding time].', said: 'About two weeks.', approved: false }
  ])
  assert.equal(plainAnswer('Yes [1, 2], with SSO.\n**Facts:**\n- x [1]'), 'Yes, with SSO.')
})

test("the review is shown what Togle suggested beside what I said, and my skills the call called for", async () => {
  const id = await fresh()
  await store.saveSkill(id, { name: 'Pricing objections', when: 'They say we are too expensive', how: '- Ask what they compare us with.' }, 'train')
  const { copilot, inputs } = copilotFor(id, ['NOTHING'])
  const t0 = Date.now() - 60_000
  copilot.add('them', 'Honestly, this is too expensive for us.', t0, t0 + 3000)
  copilot.add('me', 'For smaller teams we start on the Starter plan at 19 euros.', t0 + 5000, t0 + 9000)
  await copilot.learn([{ kind: 'suggest', question: 'Honestly, this is too expensive for us.', text: 'What are you comparing us with?', at: t0 + 3500, context: { facts: [], references: [], skills: [{ id: agent(id).skills[0].id, name: 'Pricing objections', revision: 1 }] } }])
  assert.equal(inputs[0].lane, 'deep', 'Durable learning uses the agent reasoning route, independently of lightweight background notes')
  assert.match(
    inputs[0].user,
    /What Togle suggested on the call, and what I said after it \(oldest first\):\n1\. They asked: "Honestly, this is too expensive for us\."\n {3}Togle suggested: What are you comparing us with\?\n {3}I said: For smaller teams we start on the Starter plan at 19 euros\./
  )
  assert.match(inputs[0].user, /Assistance policies supplied for these questions \(inclusion is not proof they were followed\):\n- Pricing objections \(when they asked: "Honestly, this is too expensive for us\."\)/)
  assert.match(inputs[0].system, /4\. Facts about the people on this call/)
  assert.match(inputs[0].system, /What the skill already says stays\./)
})

test('the review improving a skill it has offers the skill with its rules kept, and one that adds nothing not at all', async () => {
  const id = await fresh()
  await store.saveSkill(id, { name: 'Pricing objections', when: 'They say we are too expensive', how: '- Ask what they compare us with.\n- Then show the yearly saving.' }, 'train')
  const reply = [
    'ASSIST: pricing objections | When a small team says the price is too high',
    '- Offer the Starter plan at 19 euros a seat; they can move up as they grow.',
    'EVIDENCE: C1',
    'SKILL: Closing | Near the end of the call',
    '- Agree on one next step with a date.',
    'SUMMARY: A call with a small team about price.'
  ].join('\n')
  const { copilot } = copilotFor(id, [reply])
  copilot.add('them', 'This is too expensive for a team our size.', Date.now() - 9000, Date.now() - 6000)
  copilot.noteAnswer({ question: 'How should I respond?', suggested: 'Give a long pricing explanation.', answer: 'Show the Starter option concisely.' })
  const review = await copilot.learn()
  assert.deepEqual(review.skills, [{ name: 'Closing', when: 'Near the end of the call', how: '- Agree on one next step with a date.' }])
  // A price heard on the call waits for a yes; kept, the skill has all three rules.
  assert.deepEqual(review.check.skills.map(({ purpose, source, ...skill }) => skill), [
    {
      name: 'Pricing objections',
      when: 'They say we are too expensive',
      how: '- Ask what they compare us with.\n- Then show the yearly saving.\n- Offer the Starter plan at 19 euros a seat; they can move up as they grow.'
    }
  ])
  await store.applyLessons(id, review.check)
  assert.equal(agent(id).skills.find((s) => s.name === 'Pricing objections').how.split('\n').length, 3)
  // The same rule again: nothing to offer.
  assert.deepEqual(review.check.skills[0].source.feedbackIds, ['C1'])
  const again = copilotFor(id, ['ASSIST: Pricing objections | x\n- Ask what they compare us with.'])
  again.copilot.add('them', 'Too expensive.', Date.now() - 4000, Date.now())
  assert.deepEqual((await again.copilot.learn()).skills, [])
})

// ---- What I said, weighed rather than trusted ----

test('a review keeps on its own only what adds without an amount or a deal it can be wrong about; the rest waits for a yes', () => {
  const agent = {
    memory: ['Our Scale plan is 35 euros per seat a month.', 'Annual plans get one month free.'],
    answers: [{ question: 'Is there a trial?', answer: 'Yes, 14 days.' }],
    skills: [{ name: 'Pricing objections', when: 'Too expensive', how: '- Ask what they compare us with.\n- Then show the yearly saving.', purpose: 'reference' }],
    aboutMe: '',
    instructions: ''
  }
  const noted = [{ question: 'Can we pay by invoice?', answer: 'Yes, with 30 days to pay.', suggested: 'Card only.' }]
  const { keep, check } = splitReview(
    {
      facts: [
        'We have a native HubSpot integration.',
        'Onboarding takes about two weeks.',
        'Nonprofits get a discount.',
        'Scale costs 35 euros per seat a month.',
        'Invoices are due within 30 days.'
      ],
      answers: [
        { question: 'Can we pay by invoice?', answer: 'Yes, with 30 days to pay.' },
        { question: 'Do you discount for nonprofits?', answer: 'For you, forty percent off the first year.' },
        { question: 'Does it work with HubSpot?', answer: 'Yes, natively.' }
      ],
      skills: [
        { name: 'Pricing objections', when: 'Too expensive', how: '- Ask what they compare us with.\n- Then show the yearly saving.\n- Ask who else decides.' },
        { name: 'Closing', when: 'Near the end', how: '- Agree on one next step.' },
        { name: 'Discounts', when: 'They ask for one', how: '- Offer a discount when they push.' },
        { name: 'pricing objections', when: 'x', how: '- Ask what they compare us with before naming any number.\n- Then show the yearly saving.' }
      ],
      updates: [{ from: 'Our Scale plan is 35 euros per seat a month.', to: 'Our Scale plan is 53 euros per seat a month.' }],
      forget: ['Annual plans get one month free.']
    },
    agent,
    noted
  )
  assert.deepEqual(keep.facts, ['We have a native HubSpot integration.', 'Scale costs 35 euros per seat a month.', 'Invoices are due within 30 days.'])
  assert.deepEqual(check.facts, ['Onboarding takes about two weeks.', 'Nonprofits get a discount.'])
  assert.deepEqual(
    keep.answers.map((a) => a.question),
    ['Can we pay by invoice?'],
    'the one I approved or corrected is kept as given, numbers and all'
  )
  assert.deepEqual(
    check.answers.map((a) => a.question),
    ['Do you discount for nonprofits?', 'Does it work with HubSpot?']
  )
  assert.deepEqual(
    keep.skills.map((s) => s.name),
    ['Pricing objections', 'Closing'],
    'a skill it has, with a rule added'
  )
  assert.deepEqual(
    check.skills.map((s) => s.name),
    ['Discounts', 'pricing objections'],
    'a deal, and a rule reworded'
  )
  // A change to what it knows always waits: one misheard line mustn't rewrite a price.
  assert.deepEqual(check.updates, [{ from: 'Our Scale plan is 35 euros per seat a month.', to: 'Our Scale plan is 53 euros per seat a month.' }])
  assert.deepEqual(check.forget, ['Annual plans get one month free.'])
  assert.deepEqual([keep.updates, keep.forget], [[], []])
})

test("the review's instructions weigh what I said: no guess, no deal for one customer, no wording, no dodge", async () => {
  const id = await fresh()
  const { copilot, inputs } = copilotFor(id, ['NOTHING'])
  copilot.add('them', 'Can you do anything on price?', Date.now() - 9000, Date.now() - 6000)
  await copilot.learn()
  for (const rule of [
    /Weigh what I said rather than trust it: speech recognition mishears words and numbers, and what I tell one customer may be for them alone/,
    /what I hedged or wasn't sure of/,
    /a price, discount, deal, date or commitment I offered them: it goes with this call \(ABOUT\)/,
    /how I worded it \(tone, length\): only my corrections teach that/,
    /a reply that doesn't answer what they asked/,
    /I confirm such changes before they're kept/
  ])
    assert.match(inputs[0].system, rule)
})

test('a misheard price and a deal for one customer come back held, not kept, even when the agent learns on its own', async () => {
  const id = await fresh()
  await store.update(id, { memory: ['Our Scale plan is 35 euros per seat a month.'] })
  const reply = [
    'UPDATE 1: Our Scale plan is 53 euros per seat a month.',
    'QA: Do you discount for nonprofits? => For you, forty percent off for the first year.',
    'FACT: We have a native HubSpot integration.',
    'SUMMARY: A nonprofit asked about price.'
  ].join('\n')
  const { copilot } = copilotFor(id, [reply])
  copilot.add('them', 'What does Scale cost, and can you do anything for a nonprofit?', Date.now() - 9000, Date.now() - 6000)
  copilot.add('me', 'Scale is fifty three euros. For you, forty percent off.', Date.now() - 5000, Date.now() - 2000)
  const review = await copilot.learn()
  assert.deepEqual([review.facts, review.answers, review.updates], [['We have a native HubSpot integration.'], [], []])
  assert.deepEqual(review.check.updates, [{ from: 'Our Scale plan is 35 euros per seat a month.', to: 'Our Scale plan is 53 euros per seat a month.' }])
  assert.equal(review.check.answers[0].question, 'Do you discount for nonprofits?')
  // Kept on its own, the agent gets only the plain fact: memory still says 35.
  await store.applyLessons(id, review, true)
  assert.deepEqual(agent(id).memory, ['Our Scale plan is 35 euros per seat a month.', 'We have a native HubSpot integration.'])
  assert.equal(agent(id).answers.length, 0)
})

// ---- Facts about them stay with the call ----

test('the review reads the call itself apart from what it learned: its summary, and facts about them', () => {
  const reply = [
    'FACT: Our Growth plan is 39 euros per user per month.',
    'SKILL: Integration questions | They ask whether we connect to their tools',
    '- Name the native integration first.',
    'ABOUT: Acme Logistics has about 40 dispatchers.',
    '- **ABOUT:** Their contract with their current vendor ends in March.',
    'WITH: Acme Logistics; Dana Smith, Mark (full name not given).',
    'SUMMARY: Discovery call with Dana from Acme Logistics,',
    'who wants Salesforce sync.',
    'About pricing, I promised a quote for 40 seats by Friday.',
    '',
    'QA: Do you connect to Salesforce? => Yes, natively; it syncs every five minutes.'
  ].join('\n')
  const lessons = parseLessons(reply)
  assert.deepEqual(lessons.facts, ['Our Growth plan is 39 euros per user per month.'])
  assert.equal(lessons.skills[0].how, '- Name the native integration first.', "the call's own lines end a skill's bullets")
  assert.deepEqual(parseCallRecord(reply), {
    summary: 'Discovery call with Dana from Acme Logistics, who wants Salesforce sync. About pricing, I promised a quote for 40 seats by Friday.',
    about: ['Acme Logistics has about 40 dispatchers.', 'Their contract with their current vendor ends in March.'],
    with: ['Acme Logistics', 'Dana Smith', 'Mark']
  })
  assert.deepEqual(parseCallRecord('NOTHING'), { summary: '', about: [], with: [] })
})

test('the review returns the call to keep: its brief, summary, facts about them, and what was asked with what I said', async () => {
  const id = await fresh()
  const reply = 'ABOUT: Northwind starts with radiology.\nWITH: Northwind Health; Priya Raman\nSUMMARY: Northwind needs SSO; I promised the SOC 2 report by Friday.'
  const { copilot } = copilotFor(id, [reply])
  copilot.setBrief('Discovery call with Northwind Health')
  const t0 = Date.now() - 60_000
  copilot.add('them', 'Do you support single sign-on?', t0, t0 + 3000)
  copilot.add('me', "SSO is on Enterprise. I'll send the SOC 2 report by Friday.", t0 + 5000, t0 + 9000)
  copilot.noteAnswer({ question: 'Is there a trial?', answer: 'Yes, 14 days.' })
  const review = await copilot.learn([{ kind: 'suggest', question: 'Do you support single sign-on?', text: 'Yes [1].', at: t0 + 3500 }], 'call-1')
  assert.deepEqual(review.record, {
    callId: 'call-1',
    at: t0,
    endedAt: t0 + 9000,
    brief: 'Discovery call with Northwind Health',
    with: ['Northwind Health', 'Priya Raman'],
    summary: 'Northwind needs SSO; I promised the SOC 2 report by Friday.',
    about: ['Northwind starts with radiology.'],
    asked: [
      { question: 'Is there a trial?', answer: 'Yes, 14 days.' },
      { question: 'Do you support single sign-on?', answer: "SSO is on Enterprise. I'll send the SOC 2 report by Friday." }
    ]
  })
  // A call of small talk keeps nothing.
  const quiet = copilotFor(id, ['NOTHING'])
  quiet.copilot.add('them', 'Nice weather today.', Date.now() - 4000, Date.now())
  assert.equal((await quiet.copilot.learn()).record, undefined)
})

test("a new call started while the review runs doesn't mix into what's kept of the call before", async () => {
  const id = await fresh()
  let reply
  const replied = new Promise((resolve) => (reply = resolve))
  const { copilot } = copilotFor(id, [])
  // The review's model takes its time: meanwhile New call, and the next call's brief and first line.
  copilot['provider'] = () => ({
    id: 'slow',
    supportsTools: false,
    listModels: async () => [],
    stream: async (_input, { onDelta }) => onDelta(await replied)
  })
  copilot.setBrief('Discovery call with Acme')
  const t0 = Date.now() - 60_000
  copilot.add('them', 'We have 40 dispatchers.', t0, t0 + 3000)
  const review = copilot.learn([], 'acme-call')
  await copilot.clear()
  copilot.setBrief('Globex renewal')
  copilot.add('them', 'Hi, Globex here.', Date.now() - 1000, Date.now())
  reply('WITH: Acme\nSUMMARY: Acme has 40 dispatchers.')
  const { record } = await review
  assert.deepEqual([record.callId, record.brief, record.at], ['acme-call', 'Discovery call with Acme', t0])
})

// ---- Earlier calls come back ----

const call = (over) => ({ at: Date.now() - 86_400_000, endedAt: Date.now() - 86_000_000, brief: '', with: [], summary: '', about: [], asked: [], ...over })

test('earlier calls are kept encrypted per agent, and the same call reviewed again is updated, not added', async () => {
  const calls = new PastCalls()
  const a = await calls.add('agent-a', call({ callId: 'c1', brief: 'Discovery call with Northwind Health', summary: 'They need SSO.' }))
  await calls.add('agent-a', call({ callId: 'c1', brief: 'Discovery call with Northwind Health', summary: 'They need SSO and SCIM.' }))
  await calls.add('agent-b', call({ brief: 'Intro with Contoso', summary: 'Contoso wants a demo.' }))
  const kept = await calls.list('agent-a')
  assert.equal(kept.length, 1)
  assert.equal(kept[0].id, a.id)
  assert.equal(kept[0].summary, 'They need SSO and SCIM.')
  // On disk, not as plain text (the test's stand-in for the OS keystore marks what it encrypted).
  const file = readFileSync(path.join(work, 'past-calls', 'agent-a.bin'), 'utf8')
  assert.ok(file.startsWith('ENC:'))
  // Another reader (the app started again) finds them.
  assert.equal((await new PastCalls().list('agent-a'))[0].summary, 'They need SSO and SCIM.')
  await calls.remove('agent-a', a.id)
  assert.deepEqual(await new PastCalls().list('agent-a'), [])
  await calls.clear('agent-b')
  assert.deepEqual(await new PastCalls().list('agent-b'), [])
})

test('a call comes back on the next one with the same company or person, not for a shared tool, city, first name or surname', async () => {
  const calls = new PastCalls()
  await calls.add(
    'agent-r',
    call({
      at: 1000,
      brief: 'Discovery call with Northwind Health',
      with: ['Northwind Health', 'Dana Smith'],
      summary: 'Dana from Northwind needs SSO and uses Salesforce; I promised the SOC 2 report. Their office is in London.'
    })
  )
  await calls.add('agent-r', call({ at: 2000, brief: 'Demo for Contoso', with: ['Contoso', 'Flatbooks'], summary: 'Dana at Contoso liked the Flatbooks dashboards.' }))
  const recall = async (context) => (await calls.recall('agent-r', { said: '', brief: '', ...context })).map((c) => c.brief)
  assert.deepEqual(await recall({ brief: 'Follow-up call with Northwind Health' }), ['Discovery call with Northwind Health'])
  assert.deepEqual(await recall({ brief: 'follow-up with northwind' }), ['Discovery call with Northwind Health'], 'a brief typed in lower case')
  // Named on the call instead of in the brief: the company, or the person by full name.
  assert.deepEqual(await recall({ said: 'Hi again, Northwind here, about that report.' }), ['Discovery call with Northwind Health'])
  assert.deepEqual(await recall({ said: "Hello, it's Dana Smith." }), ['Discovery call with Northwind Health'])
  // What doesn't say who it is: a first name, another person of the same surname, a tool or a city both mention,
  // the user's own product, a kind of call.
  assert.deepEqual(await recall({ said: 'Hi, Dana here. Quick question.' }), [])
  assert.deepEqual(await recall({ said: 'John Smith here, from Initech.' }), [])
  assert.deepEqual(await recall({ said: 'We use Salesforce too, from our office in London.' }), [])
  const own = ownNames({ name: 'Sales', description: 'Calls for Flatbooks', instructions: '', aboutMe: '', vocabulary: '', knowledge: [] })
  assert.deepEqual(await recall({ said: 'How does Flatbooks handle invoices?', own }), [])
  assert.deepEqual(await recall({ brief: 'Weekly sync' }), [])
  // What the agent's chat finds when it looks.
  assert.match(await calls.search('agent-r', 'SOC 2 report'), /Northwind needs SSO and uses Salesforce; I promised the SOC 2 report\./)
  assert.equal(await calls.search('agent-r', 'kubernetes'), 'No earlier call mentions that.')
  assert.deepEqual([...namesIn('Great, thanks. We spoke with Acme Logistics and SAP last week.')].sort(), ['acme'])
  assert.deepEqual([...namesIn('Acme renewal call', true)], ['acme'])
  // Deleted with its agent: a review that ends after that keeps nothing.
  await calls.forget('agent-r')
  assert.equal(await calls.add('agent-r', call({ brief: 'Late review' })), undefined)
  assert.deepEqual(await new PastCalls().list('agent-r'), [])
})

test("an answer on a call with the same people draws on the earlier call, and the window is told which", async () => {
  const id = await fresh()
  const calls = new PastCalls()
  await calls.add(
    id,
    call({ brief: 'Discovery call with Northwind Health', with: ['Northwind Health'], summary: "Northwind needs SSO; I'll send the SOC 2 report by Friday.", about: ['They start with radiology.'] })
  )
  const { copilot, events, inputs } = copilotFor(id, ['LEVEL: quick\nYes, I sent the SOC 2 report.'], calls)
  // Told to the agent in its conversation, the brief brings the earlier call back for it to tell.
  const found = await copilot.setBrief('Follow-up call with Northwind Health')
  assert.deepEqual(found.map((c) => c.brief), ['Discovery call with Northwind Health'])
  copilot.add('them', 'Did you manage to send the report you mentioned last time?', Date.now() - 4000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await done(events)
  assert.match(inputs[0].user, /My earlier calls with them \(newest first\)[^\n]*\n- \w{3} \d+ \(Discovery call with Northwind Health\): Northwind needs SSO; I'll send the SOC 2 report by Friday\.\n {2}About them: They start with radiology\./)
  // After the timeline, which the backend caches from one answer to the next.
  assert.ok(inputs[0].user.indexOf('My earlier calls with them') > inputs[0].user.indexOf('Timeline of the call'))
  const recalled = events.filter((e) => e.channel === 'call:recall').map((e) => e.payload.map((c) => c.brief))
  assert.deepEqual(recalled.at(-1), ['Discovery call with Northwind Health'])
  assert.equal(recalled.length, 1, 'told once, not again for the answer that drew on the same call')
  // A call with someone else: nothing from Northwind.
  const other = copilotFor(id, ['LEVEL: quick\nSure.'], calls)
  other.copilot.setBrief('Intro call with Contoso')
  other.copilot.add('them', 'Did you get a chance to look at our requirements?', Date.now() - 4000, Date.now())
  await other.copilot.assist({ kind: 'suggest' })
  await done(other.events)
  assert.doesNotMatch(other.inputs[0].user, /earlier calls/)
  assert.match(pastCallsText([]), /^$/)
})

// ---- What's used is counted ----

test('an approved answer shown and a skill a moment calls for are counted, written later, not as a change to undo', async () => {
  const id = await fresh()
  await store.addAnswer(id, 'Do you integrate with SAP?', 'Yes, through our SAP connector.', 'manual')
  await store.saveSkill(id, { name: 'Pricing objections', when: 'They say we are too expensive', how: '- Ask what they compare us with.' }, 'train')
  const history = agent(id).history.length
  const { copilot, events, used } = copilotFor(id, ['LEVEL: quick\nWhat are you comparing us with?'])
  copilot.add('them', 'Does it work with SAP?', Date.now() - 9000, Date.now() - 6000)
  await copilot.assist({ kind: 'suggest' })
  copilot.add('them', 'Hmm, it sounds too expensive for us.', Date.now() - 3000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  await done(events)
  const sap = agent(id).answers[0]
  const pricing = agent(id).skills[0]
  assert.deepEqual(used, [
    { answers: [sap.id], skills: [] },
    { answers: [], skills: [pricing.id] }
  ])
  assert.equal(agent(id).answers[0].uses, undefined, 'not written at once')
  await store.saveUses()
  assert.equal(agent(id).answers[0].uses, 1)
  assert.equal(agent(id).skills[0].uses, 1)
  assert.ok(agent(id).skills[0].usedAt > 0)
  assert.equal(agent(id).history.length, history, 'counting is no change to the training')
  // Undoing a change still works with the counts in.
  const added = agent(id).history.find((h) => h.text === 'Added skill: Pricing objections')
  await store.undo(id, added.id)
  assert.equal(agent(id).skills.length, 0)
})

// ---- Tidying up ----

test('tidying up merges overlapping skills under one name, drops an answer asked twice and merges facts; each change undoes', async () => {
  const id = await fresh()
  await store.saveSkill(id, { name: 'Pricing objections', when: 'They say we are too expensive', how: '- Ask what they compare us with.' }, 'train')
  await store.applyLessons(
    id,
    {
      facts: ['Annual plans get two months free.', 'Yearly billing gives two months free.'],
      answers: [
        { question: 'Is there a free trial?', answer: 'Yes, 14 days.' },
        { question: 'Can we try it for free first?', answer: 'Yes, a 14-day trial, no card needed.' }
      ],
      skills: [
        { name: 'Price too high', when: 'Small teams say the price is too high', how: '- Offer the Starter plan.', purpose: 'assistance' },
        { name: 'Discount requests', when: 'They ask for a discount', how: '- Point to the yearly saving.', purpose: 'assistance' }
      ],
      updates: [],
      forget: []
    },
    true
  )
  const prompt = buildTidyPrompt(agent(id))
  assert.match(prompt.user, /1\. \[mine\] \(not used yet\) ### Pricing objections/)
  assert.match(prompt.user, /2\. \[learned\] \(not used yet\) ### Price too high/)
  tidyReply = [
    'SKILL: Pricing objections | They say we are too expensive, or ask for a discount',
    '- Ask what they compare us with.',
    '- Small teams: offer the Starter plan.',
    '- Asked for a discount: point to the yearly saving.',
    'MERGES: 1, 2, 3',
    'DROP ANSWER 1',
    'UPDATE 1: Annual plans get two months free, so they pay for ten.',
    'FORGET 2'
  ].join('\n')
  const { agent: tidied, changes } = await store.tidy(id)
  assert.deepEqual(
    tidied.skills.map((s) => [s.name, s.origin, s.how.split('\n').length]),
    [['Pricing objections', 'train', 3]]
  )
  assert.deepEqual(
    tidied.answers.map((a) => a.question),
    ['Can we try it for free first?']
  )
  assert.deepEqual(tidied.memory, ['Annual plans get two months free, so they pay for ten.'])
  assert.ok(tidied.tidiedAt > 0)
  const lines = tidied.history.filter((h) => h.origin === 'tidy').map((h) => h.text)
  assert.equal(changes, lines.length)
  assert.deepEqual(lines.sort(), [
    'Forgot: Yearly billing gives two months free.',
    'Removed approved answer: Is there a free trial?',
    'Removed skill: Discount requests',
    'Removed skill: Price too high',
    'Updated fact: Annual plans get two months free, so they pay for ten.',
    'Updated skill: Pricing objections'
  ])
  // Each one undoes on its own.
  const removed = tidied.history.find((h) => h.text === 'Removed skill: Price too high')
  await store.undo(id, removed.id)
  assert.deepEqual(
    agent(id).skills.map((s) => s.name).sort(),
    ['Price too high', 'Pricing objections']
  )
  // Nothing to tidy: only when it was last looked at changes.
  tidyReply = 'NOTHING'
  const before = agent(id).history.length
  const again = await store.tidy(id)
  assert.equal(again.changes, 0)
  assert.equal(agent(id).history.length, before)
})

test("tidying up never merges away a skill of the user's, and ignores numbers it wasn't shown", () => {
  const plan = parseTidy(
    ['**SKILL:** Objections | Any objection', '- Ask what is behind it.', 'MERGES: 2, 4', 'DROP ANSWER 9', 'UPDATE 1: merged', 'FORGET 3'].join('\n')
  )
  assert.deepEqual(plan, {
    skills: [{ draft: { name: 'Objections', when: 'Any objection', how: '- Ask what is behind it.' }, merges: [2, 4] }],
    dropAnswers: [9],
    updates: [{ n: 1, to: 'merged' }],
    forget: [3]
  })
  assert.deepEqual(parseTidy('NOTHING'), { skills: [], dropAnswers: [], updates: [], forget: [] })
})

test('a mine skill merged into a new name keeps its own name; learned ones it takes in go', async () => {
  const id = await fresh()
  await store.saveSkill(id, { name: 'Objections', when: 'They object', how: '- Ask what is behind it.' }, 'manual')
  await store.applyLessons(id, { facts: [], answers: [], skills: [{ name: 'Too busy', when: 'They say they have no time', how: '- Offer a 15-minute slot.', purpose: 'assistance' }], updates: [], forget: [] }, true)
  tidyReply = 'SKILL: Handling objections | Any objection\n- Ask what is behind it.\n- No time: offer a 15-minute slot.\nMERGES: 1, 2, 7'
  const { agent: tidied } = await store.tidy(id)
  assert.deepEqual(
    tidied.skills.map((s) => [s.name, s.origin]),
    [['Objections', 'manual']]
  )
  // Its own lines stay as they were, the other's join them.
  assert.equal(tidied.skills[0].how, '- Ask what is behind it.\n- No time: offer a 15-minute slot.')
})

test('tidying up acts only on what it was shown: an item gone or changed meanwhile is left alone, and one pass runs at a time', async () => {
  let release
  const thinking = new Promise((resolve) => (release = resolve))
  const slow = new AgentStore(async () => {
    await thinking
    return 'DROP ANSWER 1\nFORGET 1\nUPDATE 2: Fact two, merged.'
  })
  await slow.load()
  const id = (await slow.create('sales')).id
  await slow.update(id, { memory: ['Fact one.', 'Fact two.', 'Fact three.'] })
  await slow.addAnswer(id, 'Q one?', 'A one.', 'manual')
  await slow.addAnswer(id, 'Q two?', 'A two.', 'manual')
  const tidying = slow.tidy(id)
  await assert.rejects(slow.tidy(id), /tidying up already/)
  // While the model works, the user forgets fact one and removes answer one: its numbers now point elsewhere.
  const now = slow.list().find((a) => a.id === id)
  await slow.update(id, { memory: ['Fact two.', 'Fact three.'], answers: now.answers.filter((a) => a.question !== 'Q one?') })
  release()
  const { agent: tidied, changes } = await tidying
  assert.deepEqual(tidied.memory, ['Fact two, merged.', 'Fact three.'])
  assert.deepEqual(
    tidied.answers.map((a) => a.question),
    ['Q two?']
  )
  assert.equal(changes, 1)
})

test('what tidying up did is counted by its changes, also once the history is full', async () => {
  const id = await fresh()
  for (let i = 0; i < 201; i++) await store.update(id, { memory: [`Fact ${i}.`] }, 'manual')
  await store.update(id, { memory: ['Alpha fact.', 'Beta fact.'] }, 'manual')
  assert.equal(agent(id).history.length, 200)
  tidyReply = 'FORGET 1'
  const { changes } = await store.tidy(id)
  assert.equal(changes, 1)
})

test('a skill learned from calls that the user changes is theirs: tidying up keeps it', async () => {
  const id = await fresh()
  await store.applyLessons(id, { facts: [], answers: [], skills: [{ name: 'Too busy', when: 'They have no time', how: '- Offer 15 minutes.' }], updates: [], forget: [] }, true)
  const learned = agent(id).skills[0]
  assert.equal(learned.origin, 'call')
  await store.saveSkill(id, { name: 'Too busy', when: 'They have no time', how: '- Offer 15 minutes this week.' }, 'manual', learned.id)
  assert.equal(agent(id).skills[0].origin, 'manual')
  // Improved by a call review, it stays theirs.
  await store.applyLessons(id, { facts: [], answers: [], skills: [{ name: 'Too busy', when: 'x', how: '- And offer a recording.' }], updates: [], forget: [] }, true)
  assert.equal(agent(id).skills[0].origin, 'manual')
})

test('the prompt says where earlier calls come in, and the review where facts about them go', () => {
  const learn = buildLearnPrompt(agent(store.list()[0].id), [], [], undefined, [])
  assert.match(learn.system, /ABOUT: <a fact about them>/)
  assert.match(learn.system, /SUMMARY: <the call in 1-3 sentences>/)
  const prompt = buildPrompt({
    request: { kind: 'summary' },
    part: 'main',
    question: '',
    transcript: [],
    frames: [],
    attached: new Set(),
    agent: store.list()[0],
    knowledge: { passages: [], documents: [], searchable: false, allAnswers: true, allSkills: true },
    canSearch: false,
    pastCalls: '- Oct 1: something'
  })
  assert.doesNotMatch(prompt.user, /earlier calls/, "a summary of this call doesn't need the ones before")
})

// ---- A call that teaches it ----

test('the review keeps colleagues’ procedures as reference and requires correction evidence for assistance skills', () => {
  const { system } = buildLearnPrompt(agent(store.list()[0].id), [], [], undefined, [])
  // Decided first, on every call: a line a model always writes is one it doesn't forget.
  assert.match(system, /Format, one line each, with a skill's bullets under it, LESSON first:\nLESSON: <a title for notes of what the call taught me, or none>\n/)
  assert.match(system, /First decide whether the call was a LESSON/)
  assert.match(system, /A call with a customer, prospect or candidate is no lesson, even when things were explained on it: then LESSON: none/)
  assert.match(system, /so give FACT lines only for the few facts I'll need on most calls/)
  assert.match(system, /A colleague explaining TDD, QA responsibilities, engineering steps or epic planning teaches project context/)
  assert.match(system, /An ASSIST requires evidence from an actual correction/)
  assert.match(system, /Each is one fact that stands alone/)
})

test("the review's LESSON line is the lesson's title, however it's dressed; other calls have none", () => {
  assert.equal(parseLesson('SUMMARY: Marko walked me through the API.\nLESSON: API, webhooks and SSO'), 'API, webhooks and SSO')
  assert.equal(parseLesson('- **LESSON:** "Webhooks for support".'), 'Webhooks for support')
  assert.equal(parseLesson('LESSON: none'), undefined)
  assert.equal(parseLesson('SUMMARY: Acme asked about pricing.\nLesson learned: ask about the budget early.'), undefined)
  assert.equal(parseLesson('FACT: Exports are CSV or JSON.'), undefined)
  // It ends a skill's bullets rather than becoming one, and a summary before it.
  assert.equal(parseLessons('SKILL: Webhooks stopped | They say webhooks stopped\n- Check the secret first.\nLESSON: Webhooks').skills[0].how, '- Check the secret first.')
  assert.equal(parseCallRecord('SUMMARY: Marko explained webhooks.\nLESSON: Webhooks').summary, 'Marko explained webhooks.')
})

test('a call that taught me is written up on request from the whole call as reviewed: what was shown, the notes, not the next call', async () => {
  const id = await fresh()
  const notes = '## API keys\n- API keys are shown only once, when created.'
  const { copilot, inputs } = copilotFor(id, ['FACT: API keys are shown only once.\nSUMMARY: Marko walked me through the API.\nLESSON: The API for support', notes])
  copilot.setBrief('Training with Marko')
  const t0 = Date.now() - 600_000
  copilot.add('them', 'Every workspace gets its own API keys, and a key is shown only once.', t0, t0 + 4000)
  copilot.add('them', 'The rate limit is 100 requests per minute per key.', t0 + 6000, t0 + 9000)
  // Set as the call has them (adding one would ask for its description).
  copilot['frames'] = [{ id: 'f1', n: 1, at: t0 + 5000, kind: 'recorded', thumbUrl: '', imageUrl: '', note: 'A slide: Rate limits, bursts of 20 per second' }]
  copilot['notes'] = '## Notes\n- Marko explained API keys first.'
  const review = await copilot.learn([], 'call-9')
  assert.deepEqual(Object.keys(review.lesson).sort(), ['id', 'title'])
  assert.equal(review.lesson.title, 'The API for support')
  assert.deepEqual(review.facts, ['API keys are shown only once.'], 'what it found is offered as ever')
  // "Yes, keep notes" said to the agent: the latest offer for it, not another agent's.
  assert.deepEqual(copilot.lessonFor(id), review.lesson)
  assert.equal(copilot.lessonFor('another-agent'), undefined)
  // New call meanwhile: the notes are of the call reviewed.
  await copilot.clear()
  copilot.add('them', 'Hi, Globex here.', Date.now() - 1000, Date.now())
  assert.deepEqual(await copilot.keepLesson(review.lesson.id), { agentId: id, name: 'Lesson: The API for support', text: notes })
  const asked = inputs.at(-1)
  assert.equal(asked.lane, 'background')
  assert.match(asked.system, /You write up a call that taught me about my own product, company or work/)
  assert.match(asked.system, /reply exactly NOTHING/)
  assert.match(asked.user, /Notes for: The API for support/)
  assert.match(asked.user, /What this call was for \(my brief\): Training with Marko/)
  assert.match(asked.user, /a key is shown only once[\s\S]*Frame F1 appeared: A slide: Rate limits[\s\S]*100 requests per minute per key/)
  assert.match(asked.user, /Marko explained API keys first/)
  assert.doesNotMatch(asked.user, /Globex/)
  // Written up once: the card can't write it again.
  await assert.rejects(copilot.keepLesson(review.lesson.id), /no longer has that call/)
  // A call that didn't teach me offers nothing to write up.
  const sales = copilotFor(id, ['FACT: Annual plans get two months free.\nSUMMARY: Acme asked about annual billing.'])
  sales.copilot.add('them', 'Do you give anything for paying yearly?', Date.now() - 4000, Date.now())
  assert.equal((await sales.copilot.learn()).lesson, undefined)
})

test('a lesson is written up once at a time, and one with nothing to write up says so and can be tried again', async () => {
  const id = await fresh()
  const { copilot } = copilotFor(id, ['SUMMARY: Marko explained webhooks.\nLESSON: Webhooks'])
  copilot.add('them', 'Every webhook is signed with HMAC SHA-256.', Date.now() - 4000, Date.now())
  const { lesson } = await copilot.learn()
  let reply
  const replied = new Promise((resolve) => (reply = resolve))
  const model = (stream) => () => ({ id: 'fake', supportsTools: false, listModels: async () => [], stream })
  copilot['provider'] = model(async (_input, { onDelta }) => onDelta(await replied))
  const first = copilot.keepLesson(lesson.id)
  await assert.rejects(copilot.keepLesson(lesson.id), /being written already/)
  reply('NOTHING')
  await assert.rejects(first, /didn't teach enough to write up/)
  copilot['provider'] = model(async (_input, { onDelta }) => onDelta('## Webhooks\n- Every webhook is signed with HMAC SHA-256.'))
  assert.equal((await copilot.keepLesson(lesson.id)).text, '## Webhooks\n- Every webhook is signed with HMAC SHA-256.')
})

test('only the latest few calls that taught me wait to be written up', async () => {
  const id = await fresh()
  const { copilot } = copilotFor(id, ['LESSON: Part 1', 'LESSON: Part 2', 'LESSON: Part 3', 'LESSON: Part 4'])
  const offered = []
  for (let i = 1; i <= 4; i++) {
    copilot.add('them', `Part ${i}: how the exports work.`, Date.now() - 4000, Date.now())
    offered.push((await copilot.learn()).lesson)
  }
  assert.deepEqual(
    offered.map((l) => l.title),
    ['Part 1', 'Part 2', 'Part 3', 'Part 4']
  )
  await assert.rejects(copilot.keepLesson(offered[0].id), /no longer has that call/)
  assert.equal(copilot['lessons'].size, 3)
})
