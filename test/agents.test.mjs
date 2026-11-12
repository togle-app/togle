// Training an agent: skills, Train (through the real ChatGPT provider and a fake Codex backend), and the
// call review. The tests run in order and build on each other's agent.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backend, call, say, workDir } from './helpers.mjs'

workDir('agents')
const { AgentStore, ChatGPTProvider, buildPrompt, parseLessons, train } = await import('./.build/togle.mjs')

const store = new AgentStore(async () => 'digest')
await store.load()
const agentId = store.list()[0].id
const agent = () => store.list().find((a) => a.id === agentId)
const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })

async function trainTurn(message, history = []) {
  const changes = []
  let reply = ''
  await train(store, provider, agentId, history, message, new AbortController().signal, {
    onDelta: (text) => (reply += text),
    onChange: (text) => changes.push(text)
  })
  return { changes, reply }
}

// ---- What a call taught: skills next to facts and answers ----

test('the review reads skills next to facts and answers', () => {
  const lessons = parseLessons(`FACT: Our Scale plan is 29 euros per seat a month.
QA: Do you integrate with SAP? => Yes, through our SAP connector.
SKILL: Pricing objections | They say we're too expensive

- Ask what they compare us with.
- Then show the yearly saving.
**SKILL:** Security questions | They ask about data protection or compliance
- Point to the ISO 27001 certificate first.
Skills: this line must not start a skill
SKILL: No pipe here
- One bullet.`)
  assert.deepEqual(lessons.facts, ['Our Scale plan is 29 euros per seat a month.'])
  assert.deepEqual(lessons.answers, [{ question: 'Do you integrate with SAP?', answer: 'Yes, through our SAP connector.' }])
  assert.deepEqual(
    lessons.skills.map((s) => [s.name, s.when]),
    [
      ['Pricing objections', "They say we're too expensive"],
      ['Security questions', 'They ask about data protection or compliance'],
      ['No pipe here', '']
    ]
  )
  assert.equal(lessons.skills[0].how, '- Ask what they compare us with.\n- Then show the yearly saving.')
  assert.equal(lessons.skills[1].how, '- Point to the ISO 27001 certificate first.\nSkills: this line must not start a skill')
  assert.deepEqual(parseLessons('NOTHING'), { facts: [], answers: [], skills: [], updates: [], forget: [] })
})

test('the review reads its lines however the model dresses them up: as a list, numbered or in bold', () => {
  const memory = ['Our Scale plan is 29 euros per seat a month.', 'We offer a 30-day trial.']
  const lessons = parseLessons(
    [
      '- **FACT:** Acme has 30 seats.',
      '1. FACT: Their renewal is in March.',
      '**FACT: Ana is their CFO.**',
      '**UPDATE 1:** Our Scale plan is **35 euros** per seat a month.',
      '**FORGET 2**',
      '2) **QA**: Do you integrate with SAP? => Yes, through our **SAP connector**.',
      '**SKILL**: Pricing objections | They say we are too expensive',
      '- **Ask** what they compare us with.',
      '1. Then show the yearly saving.',
      'Facts: none of these start a line of their own',
      'FACTORY: nor this'
    ].join('\n'),
    memory
  )
  assert.deepEqual(lessons.facts, ['Acme has 30 seats.', 'Their renewal is in March.', 'Ana is their CFO.'])
  assert.deepEqual(lessons.updates, [{ from: memory[0], to: 'Our Scale plan is 35 euros per seat a month.' }])
  assert.deepEqual(lessons.forget, [memory[1]])
  assert.deepEqual(lessons.answers, [{ question: 'Do you integrate with SAP?', answer: 'Yes, through our SAP connector.' }])
  assert.deepEqual(
    lessons.skills.map((s) => [s.name, s.when, s.how]),
    [
      [
        'Pricing objections',
        'They say we are too expensive',
        '- **Ask** what they compare us with.\n1. Then show the yearly saving.\nFacts: none of these start a line of their own\nFACTORY: nor this'
      ]
    ],
    "a skill's own lines keep their bold and numbers"
  )
})

test('the review offers no "fact" longer than a fact (memory keeps short ones, under 300 characters)', () => {
  const memory = ['Our Scale plan is 29 euros per seat a month.']
  const lessons = parseLessons([`FACT: ${'The call covered many things. '.repeat(15)}`, 'FACT: Acme has 30 seats.', `UPDATE 1: ${'x'.repeat(301)}`].join('\n'), memory)
  assert.deepEqual(lessons.facts, ['Acme has 30 seats.'])
  assert.deepEqual(lessons.updates, [])
})

test('the review keeps a long skill within the limits', () => {
  const [skill] = parseLessons(`SKILL: ${'N'.repeat(200)} | ${'w'.repeat(500)}\n${'- step\n'.repeat(1000)}`).skills
  assert.equal(skill.name.length, 80)
  assert.equal(skill.when.length, 300)
  assert.ok(skill.how.length <= 3000)
})

// ---- Skills in the store ----

test('a skill saved again under the same name replaces it', async () => {
  const first = await store.saveSkill(agentId, { name: 'Pricing objections', when: 'Too expensive', how: '- Ask what they compare.' }, 'train')
  assert.equal(first.created, true)
  const second = await store.saveSkill(agentId, { name: 'pricing OBJECTIONS', when: 'Too expensive', how: '- Ask, then show ROI.', purpose: 'assistance' }, 'call')
  assert.equal(second.created, false)
  assert.equal(second.skill.id, first.skill.id)
  assert.equal(second.skill.origin, 'train', 'keeps where it came from')
  assert.equal(agent().skills.length, 1)
  assert.equal(agent().skills[0].how, '- Ask, then show ROI.')
})

test('editing a skill by id can rename it, but not onto another skill', async () => {
  const other = await store.saveSkill(agentId, { name: 'Next steps', when: 'The call is ending', how: '- Book the next meeting.' }, 'manual')
  const renamed = await store.saveSkill(agentId, { name: 'Closing the call', when: 'The call is ending', how: '- Book it.' }, 'manual', other.skill.id)
  assert.equal(renamed.skill.id, other.skill.id)
  assert.equal(renamed.created, false)
  await assert.rejects(store.saveSkill(agentId, { name: 'Pricing objections', when: '', how: 'x' }, 'manual', other.skill.id), /already a skill named/)
  await assert.rejects(store.saveSkill(agentId, { name: ' ', when: '', how: 'x' }, 'manual'), /needs a name/)
  await assert.rejects(store.saveSkill(agentId, { name: 'Long', when: '', how: 'x'.repeat(3001) }, 'manual'), /Too long/)
  await assert.rejects(store.saveSkill(agentId, { name: 'Gone', when: '', how: 'x' }, 'manual', 'no-such-id'), /removed/)
  // Old agents on disk have no skills field: they load with none.
  const plain = await store.create('general')
  assert.deepEqual(plain.skills, [])
})

test('every skill goes into the prompt while they fit', async () => {
  const knowledge = await store.knowledgeFor(agent(), 'They say we are too expensive', new Set())
  assert.equal(knowledge.allSkills, true)
  assert.match(knowledge.skills, /### Pricing objections\nWhen: Too expensive\n- Ask, then show ROI\./)
  assert.match(knowledge.skills, /### Closing the call/)
  const prompt = buildPrompt({
    request: { kind: 'suggest' },
    part: 'main',
    question: 'This is too expensive for us.',
    transcript: [],
    frames: [],
    attached: new Set(),
    agent: agent(),
    knowledge,
    canSearch: false
  })
  assert.match(prompt.system, /How Togle should assist me during calls/)
  assert.match(prompt.system, /### Pricing objections/)
  assert.doesNotMatch(prompt.user, /skills that fit this moment/)
})

test('with many skills, the ones that fit the moment come in full', async () => {
  const many = await store.create('general')
  for (let i = 0; i < 12; i++) {
    await store.saveSkill(many.id, { name: `Topic ${i}`, when: `They ask about topic number ${i}`, how: `- ${'Explain the details carefully. '.repeat(40)}` }, 'manual')
  }
  await store.saveSkill(many.id, { name: 'Refund requests', when: 'They want their money back or ask for a refund', how: '- Offer a credit first.' }, 'manual')
  const fresh = store.list().find((a) => a.id === many.id)
  const knowledge = await store.knowledgeFor(fresh, 'Can I get a refund? I want my money back.', new Set())
  assert.equal(knowledge.allSkills, false)
  assert.match(knowledge.skills, /^- Topic 0: They ask about topic number 0$/m)
  assert.doesNotMatch(knowledge.skills, /Explain the details/, 'the list is one line per skill')
  assert.match(knowledge.matchedSkills, /### Refund requests\nWhen: They want their money back or ask for a refund\n- Offer a credit first\./)
  const ask = (kind) =>
    buildPrompt({ request: { kind }, part: 'main', question: 'Can I get a refund?', transcript: [], frames: [], attached: new Set(), agent: fresh, knowledge, canSearch: false })
  assert.match(ask('suggest').user, /How to assist in this situation:\n### Refund requests/)
  assert.doesNotMatch(ask('summary').user, /skills that fit this moment/)
})

test('names in skills help speech recognition', async () => {
  await store.saveSkill(agentId, { name: 'CRM questions', when: 'They ask about HubSpot', how: '- We sync contacts with HubSpot both ways.' }, 'manual')
  assert.match(await store.vocabularyFor(agent()), /HubSpot/)
})

test('names I wrote to the agent lately help speech recognition too, said once, ahead of its documents', async () => {
  const now = Date.now()
  const talk = [
    { role: 'user', text: "For the Initech renewal: their CFO, Monica, wants a two-year deal. And Ivan is back on Thursday.", at: now - 2 * 86_400_000 },
    { role: 'agent', text: 'Noted for Zorblax.', at: now - 2 * 86_400_000 + 1000 },
    { role: 'user', text: `Look at this log:\n${'2026-10-18 ERROR payments.retry order=A1040 status=409\n'.repeat(5)}`, at: now - 86_400_000 },
    { role: 'user', text: 'For the Globex call: they use Freshdesk.', at: now - 9 * 86_400_000 }
  ]
  const words = await store.vocabularyFor(agent(), talk)
  for (const name of ['Initech', 'Monica', 'Ivan']) assert.match(words, new RegExp(`\\b${name}\\b`), `${name} in ${words}`)
  assert.ok(words.indexOf('Initech') < words.indexOf('HubSpot'), 'before what the documents and skills have')
  assert.doesNotMatch(words, /Zorblax/, 'what it wrote back is not a name I said')
  assert.doesNotMatch(words, /\bERROR\b|A1040/, "a pasted log's words are not names")
  assert.doesNotMatch(words, /Freshdesk|Globex/, 'nor what I said over a week ago')
})

// ---- Train ----

// ---- The call review: corrections, and memory that stays true ----

test('the review names facts to change or drop by their number', () => {
  const memory = ['Our Scale plan is 29 euros per seat a month.', 'We offer a 30-day trial.', 'Support answers within a day.']
  const lessons = parseLessons(
    [
      'UPDATE 1: Our Scale plan is 35 euros per seat a month.',
      'FORGET 2',
      'UPDATE 2: already dropped above, so ignored',
      'UPDATE 3:   ',
      'UPDATE 9: there is no fact 9',
      'SKILL: Price questions | They ask what it costs',
      '- Give the per-seat price.',
      'FORGET 3',
      'FACT: Acme has 30 seats.'
    ].join('\n'),
    memory
  )
  assert.deepEqual(lessons.updates, [{ from: memory[0], to: 'Our Scale plan is 35 euros per seat a month.' }])
  assert.deepEqual(lessons.forget, [memory[1], memory[2]])
  assert.deepEqual(lessons.facts, ['Acme has 30 seats.'])
  assert.equal(lessons.skills[0].how, '- Give the per-seat price.', 'a FORGET line ends the skill')
})

test('keeping the review rewrites changed facts in place and drops outdated ones', async () => {
  const fresh = await store.create('general')
  await store.update(fresh.id, { memory: ['Scale is 29 euros a seat.', 'Trial is 30 days.', 'CEO is Ana.'] })
  const kept = await store.applyLessons(fresh.id, {
    facts: ['Acme has 30 seats.', 'CEO is Ana.'],
    answers: [{ question: 'Is there a free trial?', answer: 'Yes, 14 days.' }],
    skills: [{ name: 'Trial requests', when: 'They ask to try it', how: '- Offer the 14-day trial.' }],
    updates: [{ from: 'Scale is 29 euros a seat.', to: 'Scale is 35 euros a seat.' }],
    forget: ['Trial is 30 days.']
  })
  assert.deepEqual(kept.memory, ['Scale is 35 euros a seat.', 'CEO is Ana.', 'Acme has 30 seats.'])
  assert.equal(kept.answers.find((a) => a.question === 'Is there a free trial?').origin, 'call')
  assert.equal(kept.skills.find((s) => s.name === 'Trial requests').origin, 'call')
})

// ---- What the conversation does in place of What it knows ----

// ---- The conversation, kept across restarts ----
