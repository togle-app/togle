// The agent store's documents: importing files again, reading them while they change, studying each once, and
// what the call review's Keep may put in memory.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('store')
const { AgentStore, extractText } = await import('./.build/togle.mjs')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const store = new AgentStore(async () => 'About: a document\n- a fact')
await store.load()
const fresh = async () => (await store.create('sales')).id
const agent = (id) => store.list().find((a) => a.id === id)

test('a file imported again after it changed replaces its document; unchanged, it says so', async () => {
  const id = await fresh()
  const file = path.join(work, 'prices.txt')
  writeFileSync(file, 'Scale plan: 29 euros per seat a month, billed yearly.')
  await store.addFiles(id, [file])
  writeFileSync(file, 'Scale plan: 35 euros per seat a month (new price from June), billed yearly.')
  const { errors } = await store.addFiles(id, [file])
  assert.deepEqual(errors, [])
  assert.equal(agent(id).knowledge.length, 1, 'in place of the old one, not beside it')
  const knowledge = await store.knowledgeFor(agent(id), 'Scale plan price', new Set())
  assert.match(knowledge.standing, /35 euros/)
  assert.doesNotMatch(knowledge.standing, /29 euros/)
  const again = await store.addFiles(id, [file])
  assert.deepEqual(again.errors, [])
  assert.deepEqual(again.unchanged, ['prices.txt'], 'one it has already, as it is, is no error')
  assert.equal(agent(id).knowledge.length, 1)
})

test('the same files imported twice at once go in once', async () => {
  const id = await fresh()
  const files = [0, 1, 2].map((i) => {
    const file = path.join(work, `guide-${i}.md`)
    writeFileSync(file, `# Guide ${i}\nHow to set up part ${i} of the product, step by step.`)
    return file
  })
  await Promise.all([store.addFiles(id, files), store.addFiles(id, files)])
  assert.deepEqual(agent(id).knowledge.map((d) => d.name).sort(), ['guide-0.md', 'guide-1.md', 'guide-2.md'])
})

test('a document added while the documents are being read is in the next answer', async () => {
  const id = await fresh()
  for (let i = 0; i < 30; i++) await store.addText(id, `Doc ${i}`, `Background note number ${i} about onboarding and setup steps.`)
  // Speech recognition's words, or an answer, read the documents all through a call; a price list comes in meanwhile.
  const reading = store.vocabularyFor(agent(id))
  await store.addText(id, 'Price list', 'The Scale plan costs 35 euros per seat a month, billed yearly.')
  await reading
  const knowledge = await store.knowledgeFor(agent(id), 'How much is the Scale plan?', new Set())
  assert.match(knowledge.standing, /<document n="\d+" name="Price list">\nThe Scale plan costs 35 euros/)
  assert.deepEqual(
    (await store.search(agent(id), 'Scale plan euros', new Set(), 1)).map((p) => p.doc),
    ['Price list']
  )
})

test('a document being studied is not studied again when another comes in', async () => {
  const studied = []
  const slow = new AgentStore(async (_system, user) => {
    studied.push(user.split('\n')[0])
    await sleep(200)
    return 'About: a document\n- a fact'
  })
  await slow.load()
  const id = slow.list()[0].id
  const words = (n, seed) => Array.from({ length: n }, (_, i) => `${seed}${i} lorem ipsum dolor.`).join(' ')
  // Over what's read in full: each document is studied.
  await slow.addText(id, 'Price list', words(2500, 'p'))
  await sleep(20)
  await slow.addText(id, 'Note 1', words(20, 'a'))
  await slow.addText(id, 'Note 2', words(20, 'b'))
  for (let i = 0; i < 50 && slow.list()[0].knowledge.some((d) => d.status === 'studying'); i++) await sleep(50)
  assert.deepEqual(studied.sort(), ['Document: Note 1', 'Document: Note 2', 'Document: Price list'])
})

test('text files in UTF-16 and saved web pages are read as their text', async () => {
  const utf16 = path.join(work, 'faq-unicode.txt')
  writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Refunds: within 30 days of purchase.', 'utf16le')]))
  assert.equal(await extractText(utf16), 'Refunds: within 30 days of purchase.')
  const utf8 = path.join(work, 'notepad.txt')
  writeFileSync(utf8, '\uFEFFSupport answers within a day.')
  assert.equal(await extractText(utf8), 'Support answers within a day.')
  const page = path.join(work, 'pricing.html')
  writeFileSync(
    page,
    '<!doctype html><html><head><title>Pricing</title><style>.plan{color:#333}</style><script>track()</script></head>' +
      '<body><nav>Home</nav><h1>Pricing</h1><p>The Scale plan is 35&nbsp;euros per seat &amp; month.</p><ul><li>SSO</li><li>Audit log</li></ul>' +
      '<!-- old: 29 euros --></body></html>'
  )
  assert.equal(await extractText(page), 'Home\n\n# Pricing\nThe Scale plan is 35 euros per seat & month.\n\n- SSO\n- Audit log')
})

test("a skill added by hand doesn't replace one of the same name; Train and the call review improve one by its name", async () => {
  const id = await fresh()
  await store.saveSkill(id, { name: 'Pricing objections', when: 'Too expensive', how: '- Ask what they compare us with.' }, 'train')
  await assert.rejects(
    store.saveSkill(id, { name: 'pricing objections', when: 'Price', how: '- Offer annual billing.' }, 'manual'),
    /There's already a skill named "Pricing objections"/
  )
  assert.equal(agent(id).skills[0].how, '- Ask what they compare us with.')
  await store.saveSkill(id, { name: 'Pricing objections', when: 'Too expensive', how: '- Ask, then show the yearly saving.', purpose: 'assistance' }, 'call')
  assert.equal(agent(id).skills[0].how, '- Ask, then show the yearly saving.')
})

test("call approval keeps every fact beyond the live prompt budget without deleting earlier facts", async () => {
  const id = await fresh()
  const filler = Array.from({ length: 13 }, (_, i) => `Filler fact number ${i} ${'x'.repeat(270)}`)
  await store.update(id, { memory: filler })
  const lessons = (facts, more = {}) => ({ facts, answers: [], skills: [], updates: [], forget: [], ...more })
  await store.applyLessons(id, lessons(['Acme renews in March.', `Acme has ${'many '.repeat(40)}seats.`]))
  assert.equal(agent(id).memory.length, 15, 'all approved facts kept')
  assert.deepEqual(agent(id).memory.slice(0, 13), filler, 'earlier facts are preserved verbatim')
  await assert.rejects(store.applyLessons(id, lessons([`A fact ${'y'.repeat(400)}`])), /memory keeps short facts, under 300/)
  // Making room in the same review: allowed.
  await store.applyLessons(id, lessons(['Acme renews in March.'], { forget: [filler[0]] }))
  assert.ok(agent(id).memory.includes('Acme renews in March.'))
  assert.ok(!agent(id).memory.includes(filler[0]))
})

// ---- What it learned: every change to the training, and putting one back ----

const lines = (id) => agent(id).history.map((h) => `${h.origin}: ${h.text}${h.undone ? ' (undone)' : ''}`)

test('every change to the training goes into the history, in a line as Train says it, with where it came from', async () => {
  const id = await fresh()
  // A new agent keeps what its call reviews find on its own, as Hermes Agent does.
  assert.equal(agent(id).learning, 'auto')
  await store.saveSkill(id, { name: 'Pricing objections', when: 'Too expensive', how: '- Ask what they compare us with.' }, 'train')
  await store.update(id, { memory: ['Scale is 29 euros a seat.', 'Trial is 30 days.'] }, 'manual')
  await store.update(id, { memory: ['Scale is 35 euros a seat.', 'Trial is 30 days.'] }, 'train')
  await store.addAnswer(id, 'Is there a free trial?', 'Yes, 30 days.', 'manual')
  await store.applyLessons(
    id,
    {
      facts: ['Acme renews in March.'],
      answers: [{ question: 'is there a free trial?', answer: 'Yes, 14 days.' }],
      skills: [{ name: 'Pricing objections', when: 'Too expensive', how: '- Ask, then show the yearly saving.', purpose: 'assistance' }],
      updates: [],
      forget: ['Trial is 30 days.']
    },
    true
  )
  await store.update(id, { instructions: 'Keep it to one sentence.' }, 'manual')
  // Approve on a question tried in the agent's chat is training from the chat.
  await store.addAnswer(id, 'Do you have SSO?', 'Yes, SAML on Scale.', 'test')
  assert.deepEqual(lines(id), [
    'train: Added skill: Pricing objections',
    'manual: Remembered: Scale is 29 euros a seat.',
    'manual: Remembered: Trial is 30 days.',
    'train: Updated fact: Scale is 35 euros a seat.',
    'manual: Added approved answer: Is there a free trial?',
    'auto: Updated skill: Pricing objections',
    'auto: Updated approved answer: is there a free trial?',
    'auto: Forgot: Trial is 30 days.',
    'auto: Remembered: Acme renews in March.',
    'manual: Updated instructions',
    'train: Added approved answer: Do you have SSO?'
  ])
  // A fact rewritten in place keeps what it was.
  assert.equal(agent(id).history[3].change.before, 'Scale is 29 euros a seat.')
  assert.equal(agent(id).history[3].change.after, 'Scale is 35 euros a seat.')
  assert.equal(agent(id).history[3].change.beforeSource.kind, 'user')
  assert.equal(agent(id).history[3].change.afterSource.kind, 'user')
  // Studying and other housekeeping isn't training: nothing more in the history.
  await store.addText(id, 'Price list', 'Scale is 35 euros a seat a month, billed yearly.')
  assert.equal(agent(id).history.length, 11)
})

test('a change is undone back to what it was, and marked so; one that changed since says so instead', async () => {
  const id = await fresh()
  await store.update(id, { instructions: 'Be brief.', memory: ['Scale is 29 euros a seat.', 'Trial is 30 days.'] })
  await store.saveSkill(id, { name: 'Pricing objections', when: 'Too expensive', how: '- Ask what they compare us with.' }, 'train')
  await store.saveSkill(id, { name: 'Pricing objections', when: 'Too expensive', how: '- Show the yearly saving.' }, 'train')
  await store.update(id, { memory: ['Scale is 35 euros a seat.'] }, 'train')
  await store.update(id, { instructions: 'Be brief. Two sentences at most.' }, 'train')
  const entry = (text) => agent(id).history.find((h) => h.text === text)
  // The skill's improvement goes, the skill stays as it was.
  await store.undo(id, entry('Updated skill: Pricing objections').id)
  assert.equal(agent(id).skills[0].how, '- Ask what they compare us with.')
  // The rewritten fact is back as it read, in its place, and the forgotten one comes back too.
  await store.undo(id, entry('Updated fact: Scale is 35 euros a seat.').id)
  await store.undo(id, entry('Forgot: Trial is 30 days.').id)
  assert.deepEqual(agent(id).memory, ['Scale is 29 euros a seat.', 'Trial is 30 days.'])
  await store.undo(id, entry('Updated instructions').id)
  assert.equal(agent(id).instructions, 'Be brief.')
  assert.ok(entry('Updated instructions').undone)
  // Added, then changed by hand since: not put back over that.
  await store.update(id, { instructions: 'Something else now.' }, 'manual')
  const added = entry('Added skill: Pricing objections')
  await store.saveSkill(id, { name: 'Pricing objections', when: 'Too expensive', how: '- Edited by hand.' }, 'manual', agent(id).skills[0].id)
  await assert.rejects(store.undo(id, added.id), /The skill "Pricing objections" changed since\. Tell me how it should be, and I'll change it\./)
  assert.equal(agent(id).skills.length, 1)
})

test('a rule taught before others is undone on its own; one rewritten since says to tell the agent instead', async () => {
  const id = await fresh()
  await store.update(id, { instructions: 'Be brief.\n\nNever promise dates.' })
  const teach = (instructions) => store.update(id, { instructions }, 'train')
  await teach('Be brief.\n\nNever promise dates.\nKeep suggestions to one or two sentences.')
  await teach('Be brief.\n\nNever promise dates.\nKeep suggestions to one or two sentences.\nAsk what level they are at first.')
  await teach('Be brief.\n\nNever promise dates.\nKeep suggestions to one or two sentences.\nAsk what level they are at first.\nUse their first name.')
  const [first, second, third] = agent(id).history.filter((h) => h.text === 'Updated instructions')
  // The first rule goes, the later two stay, and the lines before it keep their blank line.
  await store.undo(id, first.id)
  assert.equal(agent(id).instructions, 'Be brief.\n\nNever promise dates.\nAsk what level they are at first.\nUse their first name.')
  assert.ok(agent(id).history.find((h) => h.id === first.id).undone)
  // The last one is still the instructions as it left them, less the first: undone too, on its own.
  await store.undo(id, third.id)
  assert.equal(agent(id).instructions, 'Be brief.\n\nNever promise dates.\nAsk what level they are at first.')
  // A rule rewritten since isn't taken out over that.
  await teach('Be brief.\n\nNever promise dates.\nAsk what level they are at first, and their goal.')
  await assert.rejects(store.undo(id, second.id), /The instructions changed since\. Tell me what to take out, and I'll do it\./)
  // A fact about me, taught after another, the same way.
  await store.update(id, { aboutMe: '' })
  await store.update(id, { aboutMe: 'I teach piano online.' }, 'train')
  await store.update(id, { aboutMe: 'I teach piano online.\nMost of my students are adults.' }, 'train')
  const [piano] = agent(id).history.filter((h) => h.origin === 'train' && h.change.kind === 'field' && h.change.field === 'aboutMe')
  await store.undo(id, piano.id)
  assert.equal(agent(id).aboutMe, 'Most of my students are adults.')
})

test('edits of one field by hand close together are one change; the history keeps the last 200', async () => {
  const id = await fresh()
  for (const text of ['Be brief.', 'Be brief and kind.', 'Be brief, kind and specific.']) await store.update(id, { instructions: text }, 'manual')
  const edits = agent(id).history.filter((h) => h.text === 'Updated instructions')
  assert.equal(edits.length, 1)
  assert.equal(edits[0].change.after, 'Be brief, kind and specific.')
  await store.undo(id, edits[0].id)
  assert.equal(agent(id).instructions, store.list().find((a) => a.id === id) && edits[0].change.before)
  for (let i = 0; i < 210; i++) await store.update(id, { memory: [`Fact ${i}.`] }, 'train')
  assert.equal(agent(id).history.length, 200)
  assert.equal(agent(id).history.at(-1).text, 'Updated fact: Fact 209.')
})
