// Training an agent: skills, Train (through the real ChatGPT provider and a fake Codex backend), and the
// call review. The tests run in order and build on each other's agent.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backend, call, copilotWith, say, wait, workDir } from './helpers.mjs'

workDir('agents')
const { AgentStore, ChatGPTProvider, Copilot, buildPrompt, buildTrainSystem, parseLessons, train, trainHistory } = await import('./.build/togle.mjs')

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

test('Train: telling it a rule becomes a skill, and it says so', async () => {
  const requests = backend([
    call(1, 'save_skill', { name: 'Unknown answers', when: "I'm asked something I can't answer", how: '- Promise a follow-up by email today.' }),
    say('Added a skill: when you can’t answer, offer an email follow-up.')
  ])
  const history = [
    { role: 'user', text: 'Hi' },
    { role: 'assistant', text: 'Hello! What should it learn?' }
  ]
  const { changes, reply } = await trainTurn("When I can't answer something, suggest I follow up by email.", history)
  assert.deepEqual(changes, ['Added skill: Unknown answers'])
  assert.equal(reply, 'Added a skill: when you can’t answer, offer an email follow-up.')
  const skill = agent().skills.find((s) => s.name === 'Unknown answers')
  assert.equal(skill.origin, 'train')

  // The request: Train's instructions with the agent's training, the conversation so far, then the new message.
  const [first, second] = requests
  assert.equal(first.input[0].role, 'developer')
  assert.match(first.input[0].content[0].text, /You train an agent inside Togle/)
  assert.match(first.input[0].content[0].text, /### Pricing objections/, 'it sees the skills it can improve')
  assert.deepEqual(first.input[1], { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] })
  assert.deepEqual(first.input[2], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello! What should it learn?' }] })
  assert.equal(first.input[3].content[0].text, "When I can't answer something, suggest I follow up by email.")
  // The ChatGPT plan's route takes the tools grouped in one namespace.
  assert.equal(first.tools.length, 1)
  assert.equal(first.tools[0].type, 'namespace')
  assert.deepEqual(
    first.tools[0].tools.map((t) => t.name),
    [
      'save_speech_word',
      'save_skill',
      'delete_skill',
      'save_answer',
      'delete_answer',
      'remember',
      'update_fact',
      'forget',
      'edit_setup',
      'save_document',
      'import_website',
      'forget_document',
      'set_learning',
      'remove_code_folder',
      'tidy_up',
      'read_call',
      'set_call_brief',
      'keep_call_notes',
      'search_past_calls',
      'read_saved_call',
      'forget_past_calls',
      'find_work_sessions',
      'set_session_sources',
      'add_work_session',
      'search_knowledge'
    ]
  )
  assert.equal(first.model, 'gpt-6.1-sol', 'the deep model writes the training')
  // The tool's result went back to the model.
  const output = second.input.find((item) => item.type === 'function_call_output')
  assert.equal(output.output, 'Created the skill "Unknown answers".')
})

test('Train: facts, answers and setup land in their own places', async () => {
  backend([
    [
      ...call(2, 'remember', { fact: 'Our Scale plan is 29 euros per seat a month.' }),
      ...call(3, 'save_answer', { question: 'Do you integrate with SAP?', answer: 'Yes, through our SAP connector.' })
    ],
    [
      ...call(4, 'edit_setup', { field: 'instructions', new_text: '- Keep every suggestion to two short sentences.' }),
      ...call(5, 'edit_setup', { field: 'vocabulary', new_text: 'Flatbooks, SAP' })
    ],
    say('Done.')
  ])
  const before = agent().instructions
  const { changes } = await trainTurn('Scale is 29 euros a seat; we integrate with SAP; keep it short; spell Flatbooks right.')
  assert.deepEqual(changes, [
    'Remembered: Our Scale plan is 29 euros per seat a month.',
    'Added approved answer: Do you integrate with SAP?',
    'Updated instructions',
    'Updated words to recognize'
  ])
  assert.ok(agent().memory.includes('Our Scale plan is 29 euros per seat a month.'))
  assert.equal(agent().answers.find((a) => a.question === 'Do you integrate with SAP?').origin, 'train')
  assert.equal(agent().instructions, `${before}\n- Keep every suggestion to two short sentences.`, 'added at the end, the rest kept')
  assert.equal(agent().vocabulary, 'Flatbooks, SAP')
})

test("Train: told about a call, it sets the call's brief, and hears what earlier calls with them said", async () => {
  const requests = backend([call(30, 'set_call_brief', { brief: 'Call with Acme at 3, they want SSO', group: true }), say('Set. Last time they were on Okta.')])
  const told = []
  const changes = []
  await train(store, provider, agentId, [], 'Call with Acme at 3, they want SSO. A few of them will join.', new AbortController().signal, {
    onDelta() {},
    onChange: (text) => changes.push(text),
    brief: async (text, group) => {
      told.push([text, group])
      const at = Date.UTC(2026, 9, 12, 10)
      return [{ id: 'p1', agentId, at, endedAt: at, brief: 'Discovery call with Acme', with: ['Acme'], summary: 'They are on Okta; I promised the SOC 2 report.', about: [], asked: [] }]
    }
  })
  assert.deepEqual(told, [['Call with Acme at 3, they want SSO', true]])
  assert.deepEqual(changes, [], "the call's brief isn't a change to its training")
  assert.equal(
    requests[1].input.find((item) => item.type === 'function_call_output').output,
    'Set. Earlier calls with them, newest first:\n- 2026-10-12 (Discovery call with Acme): They are on Okta; I promised the SOC 2 report.'
  )
  // Where there's no call to set it for, the model hears so.
  const none = backend([call(31, 'set_call_brief', { brief: 'Call with Acme' }), say('OK.')])
  await trainTurn('Call with Acme.')
  assert.match(none[1].input.find((item) => item.type === 'function_call_output').output, /can't be set from here/)
})

test('Train: told yes to keeping notes of a call that taught it, it writes them up as one of its documents', async () => {
  const requests = backend([call(32, 'keep_call_notes', {}), say('Kept them.')])
  const changes = []
  await train(store, provider, agentId, [], 'Yes, keep notes of that call.', new AbortController().signal, {
    onDelta() {},
    onChange: (text) => changes.push(text),
    keepNotes: async () => 'Lesson: The API for support'
  })
  assert.deepEqual(changes, ['Added to Knowledge: Lesson: The API for support'])
  assert.equal(requests[1].input.find((item) => item.type === 'function_call_output').output, 'Kept the notes as the document "Lesson: The API for support".')
  // Nothing waiting to be written up: the model hears why.
  const none = backend([call(33, 'keep_call_notes', {}), say('There was nothing to keep.')])
  await train(store, provider, agentId, [], 'Keep notes.', new AbortController().signal, {
    onDelta() {},
    onChange() {},
    keepNotes: async () => {
      throw new Error('No call that taught it is waiting to be written up.')
    }
  })
  assert.match(none[1].input.find((item) => item.type === 'function_call_output').output, /^Error: No call that taught it is waiting/)
})

test('Train: changing and removing things, and what it hears back when it gets one wrong', async () => {
  const requests = backend([
    [
      ...call(6, 'edit_setup', { field: 'instructions', old_text: 'two short sentences', new_text: 'one sentence' }),
      ...call(7, 'edit_setup', { field: 'about_me', old_text: 'not there', new_text: 'x' }),
      ...call(8, 'forget', { text: 'scale plan' }),
      ...call(9, 'delete_skill', { name: 'No such skill' }),
      ...call(10, 'delete_answer', { question: 'sap' }),
      ...call(11, 'remember', { fact: 'x'.repeat(301) })
    ],
    say('Updated.')
  ])
  const { changes } = await trainTurn('One sentence, forget the Scale price, drop the SAP answer.')
  assert.deepEqual(changes, ['Updated instructions', 'Forgot: Our Scale plan is 29 euros per seat a month.', 'Removed approved answer: Do you integrate with SAP?'])
  assert.match(agent().instructions, /- Keep every suggestion to one sentence\.$/)
  assert.equal(
    agent().memory.some((m) => /Scale plan/.test(m)),
    false
  )
  assert.equal(
    agent().answers.some((a) => /SAP/.test(a.question)),
    false
  )
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
  assert.match(outputs[1], /^The About me doesn't contain that text/)
  assert.match(outputs[3], /^No skill named "No such skill"\. Its skills: Pricing objections, Closing the call, CRM questions, Unknown answers\./)
  assert.match(outputs[5], /^That's 301 characters; a memory entry is one short fact/)
})

test('Train: a skill that is too long comes back as an error it can fix', async () => {
  const requests = backend([call(12, 'save_skill', { name: 'Essay', when: 'Always', how: 'x'.repeat(3001) }), say('Let me shorten it.')])
  const { changes } = await trainTurn('Write a very long skill.')
  assert.deepEqual(changes, [])
  assert.match(requests[1].input.find((item) => item.type === 'function_call_output').output, /^Error: Too long/)
})

test('Train needs a provider with tools, and says it needs them', async () => {
  const compat = { supportsTools: false, stream: async () => assert.fail('should not stream') }
  await assert.rejects(
    train(store, compat, agentId, [], 'hi', new AbortController().signal, { onDelta() {}, onChange() {} }),
    /This model can't change your agent, so I can't learn from what you tell me. Pick another in Settings → AI/
  )
  // With one, it asks for them as needed: a model that can't call them is an error, not an answer without them.
  let asked
  const withTools = { supportsTools: true, stream: async (input) => (asked = input) }
  await train(store, withTools, agentId, [], 'hi', new AbortController().signal, { onDelta() {}, onChange() {} })
  assert.equal(asked.toolsRequired, true)
})

test("Train's context shows the agent as it is now", () => {
  const system = buildTrainSystem(agent())
  assert.match(system, /Instructions:\n[\s\S]*one sentence/)
  assert.match(system, /Words to recognize: Flatbooks, SAP/)
  assert.match(system, /### Unknown answers\nWhen: I'm asked something I can't answer/)
})

test("the conversation goes back to the agent's model one turn each way, with what each reply changed", () => {
  const turns = trainHistory([
    { role: 'user', text: 'Scale is 35 euros a seat now.' },
    { role: 'agent', text: 'Updated the price.', changes: ['Updated fact: Scale is 35 euros a seat.'] },
    { role: 'user', text: 'Call with Acme at 3.' },
    // A call, then what its review kept, said by the agent one after the other: one turn.
    { role: 'agent', text: '[A call, 15:02–15:31: 2 suggestions]', changes: [] },
    { role: 'agent', text: 'I looked back at the call.', changes: ['Remembered: Acme renews in March.'] },
    { role: 'user', text: 'Keep only the first one.' }
  ])
  assert.deepEqual(turns, [
    { role: 'user', text: 'Scale is 35 euros a seat now.' },
    { role: 'assistant', text: 'Updated the price.\n(Updated fact: Scale is 35 euros a seat.)' },
    { role: 'user', text: 'Call with Acme at 3.' },
    { role: 'assistant', text: '[A call, 15:02–15:31: 2 suggestions]\n\nI looked back at the call.\n(Remembered: Acme renews in March.)' },
    { role: 'user', text: 'Keep only the first one.' }
  ])
  // It's told what to do when they answer about what a review held back.
  assert.match(buildTrainSystem(agent()), /keep exactly what they confirm, as they say it/)
})

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

test('a correction on a call card answers at once when the question comes again', async () => {
  const sales = await store.create('general')
  const { copilot, events, inputs } = copilotWith(Copilot, store, sales.id, ['LEVEL: quick\nYes, SAML single sign-on.'])
  copilot.noteAnswer({ question: 'Do you support single sign-on?', answer: 'Yes, SAML SSO on the Scale plan.', suggested: 'No.' })
  await copilot.assist({ kind: 'ask', question: 'Do you support single sign-on?' })
  assert.equal(events.find((e) => e.payload.type === 'match')?.payload.answer, 'Yes, SAML SSO on the Scale plan.')
  assert.match(
    inputs[0].user,
    /Answers I approved or corrected earlier in this call \(when one comes up again, answer this way\):\nQ: Do you support single sign-on\?\nA: Yes, SAML SSO on the Scale plan\./
  )
  assert.equal(store.list().find((a) => a.id === sales.id).answers.length, 0, 'the agent itself waits for the review')
})

test("the review offers the call's corrections first, learns from them once, and keeps memory true", async () => {
  const sales = await store.create('general')
  await store.update(sales.id, { memory: ['Our Scale plan is 29 euros per seat a month.', 'We offer a 30-day trial.'] })
  const reply = [
    'UPDATE 1: Our Scale plan is 35 euros per seat a month.',
    'FORGET 2',
    'QA: Is there a free trial? => a second answer to the corrected question is dropped',
    'SKILL: Trial questions | They ask about trying it first',
    '- Say 14 days, no card needed.'
  ].join('\n')
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, [reply])
  copilot.noteAnswer({ question: 'Is there a free trial?', answer: 'Yes, 14 days, no card needed.', suggested: 'Yes, 30 days.' })
  const lessons = await copilot.learn()
  assert.deepEqual(lessons.answers, [{ question: 'Is there a free trial?', answer: 'Yes, 14 days, no card needed.' }])
  // Changing what it knows waits for a yes, also when the agent learns on its own.
  assert.deepEqual([lessons.updates, lessons.forget], [[], []])
  assert.deepEqual(lessons.check.updates, [{ from: 'Our Scale plan is 29 euros per seat a month.', to: 'Our Scale plan is 35 euros per seat a month.' }])
  assert.deepEqual(lessons.check.forget, ['We offer a 30-day trial.'])
  // Its 14 days are the corrected answer's: sure.
  assert.equal(lessons.skills[0].name, 'Trial questions')
  // What the review was shown: the numbered memory and the correction.
  assert.match(inputs[0].user, /My memory:\n1\. Our Scale plan is 29 euros per seat a month\.\n2\. We offer a 30-day trial\./)
  assert.match(inputs[0].user, /Q: Is there a free trial\?\nTogle suggested: Yes, 30 days\.\nI corrected it to: Yes, 14 days, no card needed\./)
  assert.match(inputs[0].system, /1\. My corrections: the suggestions I approved or corrected \(listed below\) are what I want/)
  assert.match(inputs[0].system, /Weigh what I said rather than trust it/)
  // That review decided on it: nothing from this call is left for the next one.
  await assert.rejects(copilot.learn(), /Nothing has been said/)
})

test('the review says which agent it was for, and offers each fact and skill once', async () => {
  const sales = await store.create('general')
  await store.update(sales.id, { memory: ['Acme has 30 seats.'] })
  const reply = [
    'FACT: Their renewal is in March.',
    'FACT: their renewal is in march.',
    'FACT: ACME has 30 seats.',
    'SKILL: Trial questions | They ask about trying it first',
    '- Say 14 days.',
    'SKILL: trial questions | Again',
    '- Say 30 days.'
  ].join('\n')
  const { copilot } = copilotWith(Copilot, store, sales.id, [reply])
  copilot.add('them', 'When does your renewal come up?', Date.now() - 4000, Date.now())
  const review = await copilot.learn()
  assert.equal(review.agentId, sales.id, 'kept, it goes to this agent even when another is picked meanwhile')
  assert.deepEqual(review.facts, ['Their renewal is in March.'], 'one already in memory, in other letters, is not offered')
  // An amount heard on the call that it doesn't know yet: offered to check, once.
  assert.deepEqual([review.skills, review.check.skills.map((s) => s.how)], [[], ['- Say 14 days.']])
})

test('a large memory does not ask the review to forget facts to make room', async () => {
  const sales = await store.create('general')
  await store.update(sales.id, { memory: Array.from({ length: 12 }, (_, i) => `Fact ${i}: ${'x'.repeat(280)}`) })
  const { copilot, inputs } = copilotWith(Copilot, store, sales.id, ['NOTHING'])
  copilot.noteAnswer({ question: 'Is it fast?', answer: 'Yes.' })
  await copilot.learn()
  assert.match(inputs[0].system, /this is not a storage limit/)
  assert.match(inputs[0].system, /never drop facts merely to fit a prompt/)
})

test('Train: changed facts update in place and new facts remain savable beyond the live budget', async () => {
  // Already over the limit (facts added by hand), as an older agent might be.
  const filler = Array.from({ length: 14 }, (_, i) => `Filler fact number ${i} ${'x'.repeat(265)}`)
  await store.update(agentId, { memory: ['Our Scale plan is 29 euros per seat a month.', ...filler] })
  const requests = backend([
    [
      ...call(20, 'remember', { fact: 'Acme renews in March.' }),
      ...call(21, 'update_fact', { old_text: 'Filler fact number 3 ', new_fact: `Filler fact number 3 ${'y'.repeat(270)}` }),
      ...call(22, 'update_fact', { old_text: 'Scale plan', new_fact: 'Our Scale plan is 35 euros per seat a month.' }),
      ...call(23, 'update_fact', { old_text: 'Filler fact', new_fact: 'x' })
    ],
    say('Updated the price.')
  ])
  const { changes } = await trainTurn('The Scale price is now 35 euros. Also remember Acme renews in March.')
  assert.deepEqual(changes, ['Remembered: Acme renews in March.', `Updated fact: Filler fact number 3 ${'y'.repeat(270)}`, 'Updated fact: Our Scale plan is 35 euros per seat a month.'])
  assert.equal(agent().memory[0], 'Our Scale plan is 35 euros per seat a month.')
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
  assert.equal(outputs[0], 'Saved to memory.')
  assert.match(outputs[1], /^Updated the fact to:/)
  assert.equal(outputs[2], 'Updated the fact to: "Our Scale plan is 35 euros per seat a month."', 'one that stays the same size or shrinks may')
  assert.equal(outputs[3], '14 memory entries contain that; give more of the fact.')
})

test('Train: text that replaces a line of the setup keeps the lines apart', async () => {
  const fresh = await store.create('general')
  await store.update(fresh.id, { instructions: '- Greet them by name.\n- Keep it short.\n- Offer a demo.' })
  backend([
    [
      ...call(50, 'edit_setup', { field: 'instructions', old_text: '- Keep it short.\n', new_text: '- Keep every suggestion to one sentence.\n' }),
      ...call(51, 'edit_setup', { field: 'instructions', old_text: '- Offer a demo.', new_text: '- Offer a demo.\n- Never discuss discounts.' })
    ],
    say('Updated your instructions.')
  ])
  await train(store, provider, fresh.id, [], 'One sentence per suggestion, and no discounts.', new AbortController().signal, { onDelta() {}, onChange() {} })
  assert.equal(
    store.list().find((a) => a.id === fresh.id).instructions,
    '- Greet them by name.\n- Keep every suggestion to one sentence.\n- Offer a demo.\n- Never discuss discounts.'
  )
})

test('Train: a fact named exactly is the one meant, also when another contains it or it is there twice', async () => {
  const fresh = await store.create('general')
  await store.update(fresh.id, { memory: ['Support is 24/7.', 'Premium support is 24/7.', 'Trial is 14 days.', 'Trial is 14 days.'] })
  const requests = backend([
    [
      ...call(52, 'update_fact', { old_text: 'Support is 24/7.', new_fact: 'Support is weekdays 8-18 CET.' }),
      ...call(53, 'update_fact', { old_text: 'Trial is 14 days', new_fact: 'Trial is 30 days.' }),
      ...call(54, 'forget', { text: 'is 24/7' })
    ],
    say('Updated.')
  ])
  await train(store, provider, fresh.id, [], 'Support is weekdays 8 to 18 now, the trial is 30 days, and premium is gone.', new AbortController().signal, {
    onDelta() {},
    onChange() {}
  })
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
  assert.deepEqual(outputs, [
    'Updated the fact to: "Support is weekdays 8-18 CET."',
    'Updated the fact to: "Trial is 30 days."',
    'Removed from memory: "Premium support is 24/7."'
  ])
  assert.deepEqual(store.list().find((a) => a.id === fresh.id).memory, ['Support is weekdays 8-18 CET.', 'Trial is 30 days.'], 'both copies of the trial fact became one')
})

test("Train: it reads the agent's documents to build skills from them", async () => {
  await store.addText(
    agentId,
    'Sales guide',
    'When customers say the price is too high, ask what they compare it with. Then show the yearly saving of the annual plan: two months free.'
  )
  const requests = backend([call(30, 'search_knowledge', { query: 'price too high' }), say('Found the pricing part.')])
  await trainTurn('Turn the pricing part of our sales guide into a skill.')
  assert.match(requests[1].input.find((item) => item.type === 'function_call_output').output, /^\[1\] Sales guide\nWhen customers say the price is too high/)

  const empty = await store.create('general')
  const noDocs = backend([call(31, 'search_knowledge', { query: 'refunds' }), say('Nothing to read yet.')])
  await train(store, provider, empty.id, [], 'Use our refund policy.', new AbortController().signal, { onDelta() {}, onChange() {} })
  assert.equal(noDocs[1].input.find((item) => item.type === 'function_call_output').output, 'The agent has no documents in Knowledge yet.')
})

test('Train: material pasted into the chat goes into Knowledge without being copied out, a fact or two into memory', async () => {
  const fresh = await store.create('general')
  const prices = 'Starter: 19 euros a seat a month, up to 10 seats.\nScale: 35 euros a seat a month, SSO included.\nEnterprise: from 900 euros a month.'
  const message = `Here's our new price list, keep it handy:\n\n${prices}`
  const requests = backend([
    [...call(40, 'save_document', { name: 'Price list 2026', starts_with: 'Starter: 19 euros' }), ...call(41, 'remember', { fact: 'Scale is 35 euros a seat a month.' })],
    say('Saved the price list to Knowledge.')
  ])
  const changes = []
  await train(store, provider, fresh.id, [], message, new AbortController().signal, { onDelta() {}, onChange: (c) => changes.push(c) })
  assert.deepEqual(changes, ['Added to Knowledge: Price list 2026', 'Remembered: Scale is 35 euros a seat a month.'])
  const [doc] = store.list().find((a) => a.id === fresh.id).knowledge
  assert.equal(doc.name, 'Price list 2026')
  assert.equal(doc.chars, prices.length, 'from where the material starts: not the line asking for it')
  assert.match(requests[1].input.find((item) => item.type === 'function_call_output').output, /^Saved "Price list 2026" to Knowledge \(\d+ characters\)/)
  // Searchable at once, for the next answer or for Train itself.
  const found = await store.search(store.list().find((a) => a.id === fresh.id), 'Scale seat price', new Set(), 1)
  assert.match(found[0].text, /Scale: 35 euros a seat a month/)
})

test('Train: material from an earlier message, and text that is in none of them', async () => {
  const fresh = await store.create('general')
  const faq = 'Refunds: within 30 days of purchase, no questions asked, to the card used.'
  const history = [
    { role: 'user', text: `Our refund FAQ: ${faq}` },
    { role: 'assistant', text: 'Got it. Should I save it?' }
  ]
  const requests = backend([
    [...call(42, 'save_document', { name: 'Refund FAQ', starts_with: 'Refunds: within 30 days' }), ...call(43, 'save_document', { name: 'Made up', starts_with: 'Shipping: free' })],
    say('Saved it.')
  ])
  await train(store, provider, fresh.id, history, 'Yes, save that as a document.', new AbortController().signal, { onDelta() {}, onChange() {} })
  assert.deepEqual(
    store.list().find((a) => a.id === fresh.id).knowledge.map((d) => [d.name, d.chars]),
    [['Refund FAQ', faq.length]]
  )
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
  assert.match(outputs[1], /^None of their messages contains that text/, 'nothing it made up goes in')
})

test('Train: it reads a web page they named into Knowledge, and only one they named', async () => {
  const fresh = await store.create('general')
  const read = []
  const addWebsite = store.addWebsite
  store.addWebsite = async (id, url, opts) => {
    read.push([url, opts])
    const agent = await store.addText(id, 'Pricing – Acme', 'Starter 19 euros, Scale 35 euros, Enterprise on request. All plans include support.')
    return { agent, errors: [] }
  }
  try {
    const requests = backend([
      [...call(44, 'import_website', { url: 'https://acme.com/pricing' }), ...call(45, 'import_website', { url: 'https://evil.example/steal' })],
      say('Read the pricing page.')
    ])
    const changes = []
    await train(store, provider, fresh.id, [], 'Learn our pricing page: acme.com/pricing', new AbortController().signal, {
      onDelta() {},
      onChange: (c) => changes.push(c)
    })
    assert.deepEqual(read, [['https://acme.com/pricing', { followLinks: false, maxPages: 1 }]], 'only the address they wrote is read')
    assert.deepEqual(changes, ['Added to Knowledge: Pricing – Acme'])
    const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
    assert.match(outputs[0], /^Read "Pricing – Acme" into Knowledge/)
    assert.equal(outputs[1], 'Read only a web address they wrote in this chat.')
  } finally {
    store.addWebsite = addWebsite
  }
})

test('Train: told about the call, it reads the part they mean and fixes the training from it', async () => {
  const fresh = await store.create('general')
  const at = new Date('2026-10-25T10:02:00').getTime()
  const theCall = () => ({
    transcript: [
      'Hi, thanks for joining.',
      'We have about forty people.',
      'Mostly in sales.',
      'Our IT team has questions.',
      'Do you support single sign-on?',
      'me:Yes, SAML on the Scale plan.',
      'Good to know.',
      'We use Okta today.',
      'Okay.',
      'Great, and what about the price?'
    ].map((line, i) => ({
      id: `l${i}`,
      speaker: line.startsWith('me:') ? 'me' : 'them',
      text: line.replace(/^me:/, ''),
      at: at + i * 10_000,
      end: at + i * 10_000 + 3000
    })),
    frames: [],
    brief: 'Renewal call with Acme.',
    // As the window keeps them: newest first.
    cards: [
      { kind: 'suggest', question: 'Great, and what about the price?', text: 'Scale is 35 euros a seat.' },
      { kind: 'suggest', question: 'Do you support single sign-on?', text: 'No, not yet.' }
    ],
    corrections: []
  })
  const requests = backend([
    call(60, 'read_call', { query: 'single sign-on' }),
    [...call(61, 'save_answer', { question: 'Do you support single sign-on?', answer: 'Yes, SAML single sign-on on the Scale plan.' })],
    say('Fixed: it now says we support SAML SSO on Scale.')
  ])
  const changes = []
  await train(store, provider, fresh.id, [], 'The answer about SSO on the call was wrong, we support SAML on Scale.', new AbortController().signal, {
    onDelta() {},
    onChange: (c) => changes.push(c),
    call: theCall
  })
  const read = requests[1].input.find((item) => item.type === 'function_call_output').output
  assert.match(read, /^What the call is for \(their brief\): Renewal call with Acme\./)
  assert.match(read, /Them: Do you support single sign-on\?\n\[[^\]]+\] Me: Yes, SAML on the Scale plan\./, 'the part about it, with what came around it')
  assert.doesNotMatch(read, /Hi, thanks for joining/, 'not what was said about other things')
  assert.match(read, /Asked "Do you support single sign-on\?", Togle suggested: No, not yet\./)
  assert.doesNotMatch(read, /35 euros/)
  assert.deepEqual(changes, ['Added approved answer: Do you support single sign-on?'])
  // No call open: it says so.
  const empty = await (async () => {
    const sent = backend([call(63, 'read_call', {}), say('Nothing to read.')])
    await train(store, provider, fresh.id, [], 'Learn from this call.', new AbortController().signal, { onDelta() {}, onChange() {}, call: () => ({ transcript: [], frames: [], brief: '', cards: [], corrections: [] }) })
    return sent[1].input.find((item) => item.type === 'function_call_output').output
  })()
  assert.equal(empty, 'No call is open in Togle: nothing has been said yet.')
})

// ---- What the conversation does in place of What it knows ----

test('Train: a document goes when they ask, by its name or a unique part of it', async () => {
  const fresh = await store.create('general')
  await store.addText(fresh.id, 'Price list 2025', 'Starter 15 euros, Scale 29 euros a seat, billed monthly or yearly.')
  await store.addText(fresh.id, 'Price list 2026', 'Starter 19 euros, Scale 35 euros a seat, billed monthly or yearly.')
  const requests = backend([[...call(60, 'forget_document', { name: 'price list' }), ...call(61, 'forget_document', { name: '2025' })], say('Removed the old one.')])
  const changes = []
  await train(store, provider, fresh.id, [], 'Remove the old price list.', new AbortController().signal, { onDelta() {}, onChange: (c) => changes.push(c) })
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
  assert.equal(outputs[0], '2 documents match: Price list 2025, Price list 2026. Which one?', 'two that match: it asks which')
  assert.deepEqual(changes, ['Removed from Knowledge: Price list 2025'])
  assert.deepEqual(store.list().find((a) => a.id === fresh.id).knowledge.map((d) => d.name), ['Price list 2026'])
})

test('Train: how it learns after calls, its code folders and tidying up change when they say', async () => {
  const fresh = await store.create('general')
  await store.update(fresh.id, { codeFolders: ['C:/code/billing', 'C:/code/web'] })
  const requests = backend([
    [...call(62, 'set_learning', { mode: 'ask' }), ...call(63, 'remove_code_folder', { folder: 'billing' }), ...call(64, 'set_learning', { mode: 'sometimes' })],
    say('Done.')
  ])
  const changes = []
  await train(store, provider, fresh.id, [], 'Ask me before you keep anything, and stop reading the billing code.', new AbortController().signal, {
    onDelta() {},
    onChange: (c) => changes.push(c)
  })
  const after = store.list().find((a) => a.id === fresh.id)
  assert.equal(after.learning, 'ask')
  assert.deepEqual(after.codeFolders, ['C:/code/web'])
  assert.deepEqual(changes, ['After calls: asks before keeping anything', 'No longer reads the code in: C:/code/billing'])
  assert.equal(requests[1].input.filter((item) => item.type === 'function_call_output').at(-1).output, 'mode must be auto, ask or off.')
  // Its context says how it learns, what code it reads, and where its work sessions come from.
  assert.ok(
    buildTrainSystem(after).includes(
      'Code it reads: C:/code/web\n\nWork sessions from: all their Claude Code and Codex on this PC, and the chats they exported\n\nAfter each call it asks before keeping anything.'
    )
  )
})

test('Train: tidying up when they ask lists what it merged, each a change to undo', async () => {
  const fresh = await store.create('general')
  await store.addAnswer(fresh.id, 'Is there a free trial?', 'Yes, 14 days.', 'manual')
  await store.addAnswer(fresh.id, 'Can we try it for free first?', 'Yes, a 14-day trial, no card needed.', 'manual')
  const tidyStore = new AgentStore(async () => 'DROP ANSWER 1')
  await tidyStore.load()
  backend([call(65, 'tidy_up', {}), say('Tidied.')])
  const changes = []
  await train(tidyStore, provider, fresh.id, [], 'Tidy up your training.', new AbortController().signal, { onDelta() {}, onChange: (c) => changes.push(c) })
  assert.deepEqual(changes, ['Removed approved answer: Is there a free trial?'])
  assert.equal(tidyStore.list().find((a) => a.id === fresh.id).history.at(-1).origin, 'tidy')
})

test('Train: earlier calls with someone are forgotten when they ask, and it hears which', async () => {
  const requests = backend([[...call(66, 'forget_past_calls', { with: 'Northwind' }), ...call(67, 'forget_past_calls', { with: 'Globex' })], say('Forgot them.')])
  const changes = []
  await train(store, provider, agentId, [], 'Forget everything about Northwind.', new AbortController().signal, {
    onDelta() {},
    onChange: (c) => changes.push(c),
    forgetCalls: async (who) => (/northwind/i.test(who) ? ['Oct 12, Discovery call with Northwind Health'] : [])
  })
  assert.deepEqual(changes, ['Forgot the call: Oct 12, Discovery call with Northwind Health'])
  const outputs = requests[1].input.filter((item) => item.type === 'function_call_output').map((item) => item.output)
  assert.equal(outputs[0], 'Forgot 1 earlier call: Oct 12, Discovery call with Northwind Health.')
  assert.equal(outputs[1], 'No earlier call with "Globex" is kept.')
})

test('Train: a whole site, when they ask for all of it', async () => {
  const fresh = await store.create('general')
  const read = []
  const addWebsite = store.addWebsite
  store.addWebsite = async (id, url, opts) => {
    read.push([url, opts])
    return { agent: await store.addText(id, 'Docs – Acme', 'Getting started, the API, webhooks and SSO, in full.'), errors: [] }
  }
  try {
    backend([call(68, 'import_website', { url: 'https://docs.acme.com/', whole_site: true }), say('Read the docs.')])
    await train(store, provider, fresh.id, [], 'Read all of docs.acme.com', new AbortController().signal, { onDelta() {}, onChange() {} })
    assert.deepEqual(read, [['https://docs.acme.com/', { followLinks: true, maxPages: 20 }]])
  } finally {
    store.addWebsite = addWebsite
  }
})

// ---- The conversation, kept across restarts ----

test('an agent conversation is kept encrypted, read back, and deleted with the agent', async () => {
  const { Conversations } = await import('./.build/togle.mjs')
  const conversations = new Conversations()
  assert.equal(await conversations.load('agent-c'), null, 'none yet')
  const saved = { entries: [{ id: 'm1', role: 'user', text: 'Call with Acme at 3.' }], cards: { c1: { id: 'c1', text: 'Yes, through our connector.' } } }
  await conversations.save('agent-c', saved)
  assert.deepEqual(await conversations.load('agent-c'), saved)
  await assert.rejects(conversations.save('agent-c', { entries: 'not a list', cards: {} }), /Not a conversation/)
  await assert.rejects(conversations.save('agent-c', { entries: ['x'.repeat(8_000_001)], cards: {} }), /too long to keep/)
  await assert.rejects(conversations.load('../settings'), /No such agent/)
  await conversations.forget('agent-c')
  assert.equal(await conversations.load('agent-c'), null)
  // A save that comes after the agent was deleted keeps nothing.
  await conversations.save('agent-c', saved)
  assert.equal(await conversations.load('agent-c'), null)
})

test('the window loading a conversation while its last save is still being written gets that save', async () => {
  const { Conversations } = await import('./.build/togle.mjs')
  const { promises: fs } = await import('node:fs')
  const conversations = new Conversations()
  const first = { entries: [{ id: 'u1', role: 'user', text: 'Call with Acme at 3.', at: Date.now() - 60_000 }], cards: {} }
  await conversations.save('agent-l', first)
  // Windows holds the file a moment (an antivirus, the indexer): the next save's rename waits.
  const rename = fs.rename
  fs.rename = async (...args) => {
    await wait(200)
    return rename.apply(fs, args)
  }
  try {
    const newer = { entries: [...first.entries, { id: 'u2', role: 'user', text: "Don't give Acme any dates.", at: Date.now() }], cards: {} }
    const saving = conversations.save('agent-l', newer)
    assert.deepEqual(await conversations.load('agent-l'), newer, 'a reloaded window gets the newer one, and saves that back')
    await saving
  } finally {
    fs.rename = rename
  }
})

test("what was said with an agent lately is there for its calls: my messages, its replies, when calls were, not what was said on them", async () => {
  const { Conversations } = await import('./.build/togle.mjs')
  const conversations = new Conversations()
  const at = Date.parse('2026-10-26T16:05:00')
  const entries = [
    // From before the conversation noted when: left out.
    { id: 'u0', role: 'user', text: 'Keep answers short.' },
    { id: 'u1', role: 'user', text: "Use my Claude Code session about the Safari crash for tomorrow's standup. If they ask about Android, it's Marko's team.", at },
    { id: 'a1', role: 'agent', text: "Added it; I'll have that with you at the standup.", changes: ['Added to Knowledge: Fixing the Safari checkout crash (Claude Code session)'], at: at + 5000, status: 'done' },
    { id: 'c1', role: 'call', call: 'k1', startedAt: at + 3_600_000, endedAt: at + 3_900_000, cards: ['card-1'] },
    { id: 'c2', role: 'call', call: 'k1', startedAt: at + 3_910_000, endedAt: at + 4_200_000, cards: [], resumed: true },
    { id: 'r1', role: 'review', agentId: 'agent-t', at: at + 4_300_000, review: { state: 'learned', changes: [], left: [] } },
    { id: 'u2', role: 'user', text: 'x'.repeat(5000), at: at + 4_400_000 },
    { id: 'a2', role: 'agent', text: '', changes: [], at: at + 4_500_000, status: 'error', error: 'No connection.' }
  ]
  await conversations.save('agent-t', { entries, cards: {} })
  const talk = await conversations.talk('agent-t')
  assert.deepEqual(
    talk.map((t) => t.role),
    ['user', 'agent', 'call', 'user']
  )
  assert.deepEqual(talk[1].changes, ['Added to Knowledge: Fixing the Safari checkout crash (Claude Code session)'])
  assert.deepEqual([talk[2].at, talk[2].endedAt], [at + 3_600_000, at + 4_200_000], 'a call stopped and started again is one call')
  assert.match(talk[3].text, /^x{1500} \[… 3500 more characters\]$/, 'a long paste by its start')
  // Read from disk when Togle started again.
  assert.deepEqual(await new Conversations().talk('agent-t'), talk)
  await conversations.forget('agent-t')
  assert.deepEqual(await conversations.talk('agent-t'), [])
})
