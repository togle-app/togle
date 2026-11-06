// Weird cases: replies a model dresses up in ways the prompts didn't ask for, an agent's file damaged on disk, and
// the like. Each is something that happens, rarely, and mustn't break Togle or mislead.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('weird')
const { AgentStore, Copilot, PastCalls, getSettings, loadSettings, parseDraft, parseLesson, savedBeforeSpeechChoice, updateSettings } =
  await import('./.build/togle.mjs')

// ---- A draft, however the model writes it ----

test('a draft reads through Markdown headings, numbered skills, code fences and a value on the next line', () => {
  const draft = parseDraft(`Here's a setup for these calls:

\`\`\`
## NAME:
Clinic front desk

## FOR: Patient calls
### INSTRUCTIONS:
1. Book, move and cancel appointments.
2. Read back the date and time.

SKILL 1: Booking | They want an appointment
- Ask what it's for first: treatments take longer.
SKILL 2: Cancelling | They cancel
- Offer the next free slot.
WORDS:
Invisalign
\`\`\``)
  assert.equal(draft.name, 'Clinic front desk')
  assert.equal(draft.description, 'Patient calls')
  assert.equal(draft.instructions, '1. Book, move and cancel appointments.\n2. Read back the date and time.')
  assert.deepEqual(
    draft.skills.map((s) => s.name),
    ['Booking', 'Cancelling']
  )
  assert.equal(draft.vocabulary, 'Invisalign')
  // The fence's closing line isn't a rule of the last skill.
  assert.equal(draft.skills[1].how, '- Offer the next free slot.')
})

// ---- Whether a call was a lesson ----

test('"LESSON: none", however it is said, is no lesson; a title that only starts like "no" is one', () => {
  for (const said of ['LESSON: none', 'LESSON: None.', 'LESSON: none — this was a customer call', 'LESSON: none (a sales call)', 'LESSON: n/a', 'LESSON: no', '**LESSON:** _none_'])
    assert.equal(parseLesson(said), undefined, said)
  assert.equal(parseLesson('LESSON: No-code onboarding for partners'), 'No-code onboarding for partners')
  assert.equal(parseLesson('LESSON: Nonprofit pricing, explained'), 'Nonprofit pricing, explained')
})

// ---- A picture of the screen that can't be read ----

test("a picture whose file is gone is left out: the answer still comes with the others, and they're still described", async () => {
  const store = new AgentStore(async () => '')
  await store.load()
  const agent = store.list()[0]
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    listModels: async () => [],
    stream: async (input, { onDelta }) => {
      inputs.push(input)
      onDelta(/describe pictures/.test(input.system) ? 'F2: A slide: Growth plan, 39 euros per user a month.' : 'LEVEL: quick\nIt is 39 euros a user.')
    }
  }
  // F1's file was deleted; F2 reads.
  const frames = {
    snapshot: async () => assert.fail('no screen here'),
    dataUrl: async (f) => (f.n === 1 ? Promise.reject(new Error('ENOENT: F1.jpg')) : 'data:image/jpeg;base64,AAAA'),
    reset: async () => {}
  }
  const access = {
    active: () => store.list().find((a) => a.id === agent.id),
    get: (id) => store.list().find((a) => a.id === id),
    knowledgeFor: (a, q, seen) => store.knowledgeFor(a, q, seen),
    search: (a, q, seen, first) => store.search(a, q, seen, first),
    facts: (a, q) => store.factsFor(a, q),
    code: () => undefined
  }
  const events = []
  const copilot = new Copilot((channel, payload) => events.push({ channel, payload }), () => model, frames, access)
  const t0 = Date.now() - 30_000
  const f1 = { id: 'f1', n: 1, at: t0, kind: 'recorded', thumbUrl: '', imageUrl: '' }
  const f2 = { id: 'f2', n: 2, at: t0 + 10_000, kind: 'recorded', thumbUrl: '', imageUrl: '' }
  // Described: F1 is left out, F2 isn't held back by it.
  copilot['frames'] = [f1, f2]
  copilot['undescribed'] = [f1, f2]
  await copilot['describeFrames']()
  const described = inputs.find((i) => i.lane === 'vision')
  assert.equal(described.images.length, 1)
  assert.equal(f2.note, 'A slide: Growth plan, 39 euros per user a month.')
  assert.equal(f1.note, undefined)
  // Answered: with F2's picture, and no error.
  copilot.add('them', 'How much is the plan on this slide?', Date.now() - 2000, Date.now())
  await copilot.assist({ kind: 'suggest' })
  for (let i = 0; i < 50 && !events.some((e) => e.payload?.type === 'done'); i++) await new Promise((r) => setTimeout(r, 10))
  const quick = inputs.find((i) => i.lane === 'quick')
  assert.ok(quick, 'answered')
  assert.deepEqual(
    quick.images.map((image) => image.n),
    [2]
  )
  assert.ok(!events.some((e) => e.payload?.type === 'error'), JSON.stringify(events.filter((e) => e.payload?.type === 'error')))
})

// ---- An agent's file, damaged ----

test("an agent's file with fields missing loads with them empty; one that isn't an agent is skipped, not fatal", async () => {
  const dir = path.join(work, 'agents')
  mkdirSync(dir, { recursive: true })
  // Hand-edited: only a name and some memory.
  writeFileSync(path.join(dir, 'a1.json'), JSON.stringify({ id: 'a1', name: 'Edited by hand', memory: ['A fact.'] }))
  // Not an agent at all, and not even an object.
  writeFileSync(path.join(dir, 'a2.json'), 'null')
  writeFileSync(path.join(dir, 'a3.json'), '[1, 2]')
  // Cut off by a crash.
  writeFileSync(path.join(dir, 'a4.json'), '{"id": "a4", "name": "Cut o')
  // No id: it takes its file's name.
  writeFileSync(path.join(dir, 'a5.json'), JSON.stringify({ name: 'No id', instructions: 'Help.' }))
  const store = new AgentStore(async () => '')
  await store.load()
  // (General is the agent an earlier test's store made in this folder.)
  const names = store
    .list()
    .map((a) => a.name)
    .filter((name) => name !== 'General')
    .sort()
  assert.deepEqual(names, ['Edited by hand', 'No id'])
  const edited = store.list().find((a) => a.id === 'a1')
  assert.deepEqual([edited.knowledge, edited.skills, edited.answers, edited.description, edited.instructions], [[], [], [], '', ''])
  assert.ok(edited.createdAt > 0 && edited.updatedAt > 0)
  assert.equal(store.list().find((a) => a.name === 'No id').id, 'a5')
  // And it can be changed and saved as any agent.
  const saved = await store.update('a1', { instructions: 'Be brief.' }, 'manual')
  assert.equal(saved.instructions, 'Be brief.')
})

// ---- What the window sends, if it ever sent anything ----

test("ids that are paths delete nothing: an agent, a document, an agent's earlier calls", async () => {
  // Things outside Togle's folders that a path-like id would reach.
  const outside = path.join(work, 'outside')
  mkdirSync(path.join(outside, 'precious', 'sub'), { recursive: true })
  writeFileSync(path.join(outside, 'precious', 'sub', 'keep.txt'), 'keep')
  writeFileSync(path.join(outside, 'secret.txt'), 'keep')
  writeFileSync(path.join(outside, 'model.bin'), 'keep')
  const store = new AgentStore(async () => '')
  await store.load()
  const agent = await store.create('sales')
  await store.remove('../../outside/precious')
  await store.remove('..')
  await store.removeDocument(agent.id, '../../../outside/secret')
  const pastCalls = new PastCalls()
  await assert.rejects(pastCalls.clear('../../outside/model'), /No such agent/)
  await assert.rejects(pastCalls.remove('../outside/model', 'x'), /No such agent/)
  assert.ok(existsSync(path.join(outside, 'precious', 'sub', 'keep.txt')), 'the folder is still there')
  assert.ok(existsSync(path.join(outside, 'secret.txt')), 'the text file is still there')
  assert.ok(existsSync(path.join(outside, 'model.bin')), 'the .bin file is still there')
  assert.ok(store.list().some((a) => a.id === agent.id), 'and the agent too')
  // An agent's file whose id is a path is left out, rather than written elsewhere.
  writeFileSync(path.join(work, 'agents', 'hostile.json'), JSON.stringify({ id: '../../outside/x', name: 'Hostile' }))
  writeFileSync(path.join(work, 'agents', 'bad name.json'), JSON.stringify({ name: 'Spaced' }))
  const again = new AgentStore(async () => '')
  await again.load()
  const names = again.list().map((a) => a.name)
  assert.ok(names.includes('Hostile') && !again.list().some((a) => a.id.includes('/')), 'the id came from its file name instead')
  assert.ok(!names.includes('Spaced'), "a file whose name can't be an id is left out")
})

test('settings take only what they have, each of its kind, and hubs survive a restart', async () => {
  await updateSettings({ provider: 12345, injected: { a: 1 }, window: 'big', activeAgentId: { not: 'a string' }, assist: { auto: 'yes' } })
  const now = getSettings()
  assert.equal(typeof now.provider, 'string')
  assert.ok(!('injected' in now))
  assert.equal(typeof now.window, 'object')
  assert.equal(typeof now.activeAgentId, 'string')
  assert.equal(typeof now.assist.auto, 'boolean')
  await updateSettings({ hubs: ['acme/agents'] })
  assert.deepEqual((await loadSettings()).hubs, ['acme/agents'])
})

test("a new Togle hears calls on this PC (ChatGPT's sign-in has no transcription); settings saved before the speech model was a choice say so", async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  const fresh = await loadSettings()
  assert.deepEqual([fresh.transcription.me, fresh.transcription.them], ['local', 'local'])
  // Saved when the ChatGPT plan transcribed: this PC hears those calls now.
  writeFileSync(file, JSON.stringify({ transcription: { me: 'chatgpt', them: 'chatgpt', accountId: 'chatgpt-default' } }))
  const moved = await loadSettings()
  assert.deepEqual([moved.transcription.me, moved.transcription.them], ['local', 'local'])
  rmSync(file, { force: true })
  await loadSettings()
  assert.equal(savedBeforeSpeechChoice(), false, 'nothing saved yet: a new Togle')
  // From then: this PC heard every call (Togle keeps it so, where its speech recognition is installed).
  writeFileSync(file, JSON.stringify({ provider: 'chatgpt', transcription: { language: 'en' } }))
  await loadSettings()
  assert.equal(savedBeforeSpeechChoice(), true)
  await updateSettings({ transcription: { me: 'local', them: 'local' } })
  const kept = await loadSettings()
  assert.deepEqual([kept.transcription.me, kept.transcription.them], ['local', 'local'])
  assert.equal(savedBeforeSpeechChoice(), false, 'once saved with the choice, it is a choice like any other')
})
