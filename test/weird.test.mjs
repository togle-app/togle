// Weird cases: an agent's file damaged on disk, settings edited by hand, and the like. Each is something that happens,
// rarely, and mustn't break Togle or mislead.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('weird')
const { AgentStore, getSettings, loadSettings, updateSettings } =
  await import('./.build/togle.mjs')

// ---- An agent's file, damaged ----

test("an agent's file with fields missing loads with them empty; one that isn't an agent is skipped, not fatal; what an earlier version kept in it stays", async () => {
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
  const store = new AgentStore()
  await store.load()
  // (General is the agent an earlier test's store made in this folder.)
  const names = store
    .list()
    .map((a) => a.name)
    .filter((name) => name !== 'General')
    .sort()
  assert.deepEqual(names, ['Edited by hand', 'No id'])
  const edited = store.list().find((a) => a.id === 'a1')
  assert.equal(edited.vocabulary, '')
  assert.ok(edited.createdAt > 0 && edited.updatedAt > 0)
  assert.equal(store.list().find((a) => a.name === 'No id').id, 'a5')
  // And it can be changed and saved as any agent; what an earlier version kept in its file (its memory) stays there.
  const saved = await store.update('a1', { vocabulary: 'Flatbooks, SAP' })
  assert.equal(saved.vocabulary, 'Flatbooks, SAP')
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'a1.json'), 'utf8')).memory, ['A fact.'])
  assert.equal(store.vocabularyFor(saved), 'Flatbooks, SAP.')
})

test("an agent's file whose id is a path takes its file's name, and one whose name can't be an id is left out", async () => {
  writeFileSync(path.join(work, 'agents', 'hostile.json'), JSON.stringify({ id: '../../outside/x', name: 'Hostile' }))
  writeFileSync(path.join(work, 'agents', 'bad name.json'), JSON.stringify({ name: 'Spaced' }))
  const again = new AgentStore()
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

test('a task opens as its agent’s own screen unless Settings say cards, and nothing else is a view', async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  assert.equal((await loadSettings()).tasks.view, 'session', 'a new Togle opens tasks as the agent’s own screen')
  assert.equal((await updateSettings({ tasks: { view: 'cards' } })).tasks.view, 'cards')
  assert.deepEqual(getSettings().tasks, { notices: true, finished: true, notificationPreviews: true, view: 'cards', sortBySubject: true }, 'the notices keep what they were, and sorting by subject is on')
  assert.equal((await loadSettings()).tasks.view, 'cards', 'and it is kept')
  assert.equal((await updateSettings({ tasks: { view: 'sideways' } })).tasks.view, 'session', 'a word that is not a view is the default')
  assert.equal((await updateSettings({ tasks: { view: 12 } })).tasks.view, 'session')
  // Sorting by subject sends the names of tasks and the start of what was asked in each to the AI: on until turned off, and
  // kept off once it is.
  assert.equal((await updateSettings({ tasks: { sortBySubject: false } })).tasks.sortBySubject, false)
  assert.equal((await updateSettings({ tasks: { sortBySubject: 'yes' } })).tasks.sortBySubject, false, 'only a true or a false turns it')
  assert.equal((await loadSettings()).tasks.sortBySubject, false, 'and it is kept')
  assert.equal((await updateSettings({ tasks: { sortBySubject: true } })).tasks.sortBySubject, true)
  writeFileSync(file, JSON.stringify({ activeAgentId: 'work', tasks: { notices: false, finished: true } }))
  assert.deepEqual((await loadSettings()).tasks, { notices: false, finished: true, notificationPreviews: true, view: 'session', sortBySubject: true }, 'existing settings gain previews and retain their notification and view choices')
  rmSync(file, { force: true })
  await loadSettings()
})

test('only agents Togle knows by name can be on the list of removed ones, each once, and it is kept', async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  assert.deepEqual((await loadSettings()).hiddenAgents, [])
  assert.deepEqual((await updateSettings({ hiddenAgents: ['claude', 'claude', 'acp-goose', 3, 'hermes'] })).hiddenAgents, ['claude', 'hermes'])
  assert.deepEqual((await loadSettings()).hiddenAgents, ['claude', 'hermes'], 'kept')
  assert.deepEqual((await updateSettings({ hiddenAgents: 'claude' })).hiddenAgents, ['claude', 'hermes'], 'a word is not a list')
  writeFileSync(file, JSON.stringify({ activeAgentId: 'work', hiddenAgents: ['codex', '../x', { id: 'claude' }] }))
  assert.deepEqual((await loadSettings()).hiddenAgents, ['codex'], 'a hand-edited file is read for what it can be')
  rmSync(file, { force: true })
  await loadSettings()
})

test('the first minute is for a Togle that has never run', async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  assert.equal((await loadSettings()).firstMinute.done, false, 'a new Togle starts with it')
  writeFileSync(file, JSON.stringify({ activeAgentId: 'work' }))
  assert.equal((await loadSettings()).firstMinute.done, true, 'settings saved before it existed belong to a Togle already set up')
  writeFileSync(file, JSON.stringify({ activeAgentId: 'work', firstMinute: { done: false } }))
  assert.equal((await loadSettings()).firstMinute.done, false, 'settings saved since keep their answer')
  rmSync(file, { force: true })
  await loadSettings()
})

test('a new Togle remembers no one’s voice until the person turns it on; settings saved when it was on by default start off', async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  assert.equal((await loadSettings()).assist.rememberVoices, false)
  // Saved before the default changed: they say yes because it was the default (they have no meetings part).
  writeFileSync(file, JSON.stringify({ activeAgentId: 'work', assist: { auto: true, rememberVoices: true, autoNotes: false } }))
  assert.equal((await loadSettings()).assist.rememberVoices, false, 'the old default is not a choice')
  assert.equal((await loadSettings()).assist.autoNotes, false, 'nothing else changes')
  assert.equal((await loadSettings()).assist.auto, false, 'no suggestion comes unasked during a call, whatever was saved')
  // Saved since: a yes is the person's.
  writeFileSync(file, JSON.stringify({ activeAgentId: 'work', assist: { rememberVoices: true }, meetings: { introSeen: true, confirmNames: true } }))
  assert.equal((await loadSettings()).assist.rememberVoices, true, 'someone who turned it on keeps it')
  rmSync(file, { force: true })
  await loadSettings()
})

test('this PC hears every call: what an earlier Togle saved to send a side of a call to a speech service is gone when settings load, and no change brings it back', async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  assert.deepEqual((await loadSettings()).transcription, { language: 'auto' }, 'a new Togle: only the language is a setting')
  // Saved by an earlier Togle: a side heard by OpenAI's speech API, by a server of the person's own, by an account. The sound of
  // a call never leaves this PC now, so none of it is kept. The language is.
  for (const saved of [
    { language: 'hr', me: 'openai', them: 'openai', openaiModel: 'gpt-transcribe', serverUrl: '', serverModel: '' },
    { language: 'hr', me: 'local', them: 'server', openaiModel: '', serverUrl: 'https://speech.example/v1', serverModel: 'whisper-1' },
    { language: 'hr', me: 'chatgpt', them: 'claude', accountId: 'chatgpt-default' }
  ]) {
    writeFileSync(file, JSON.stringify({ transcription: saved }))
    assert.deepEqual((await loadSettings()).transcription, { language: 'hr' }, JSON.stringify(saved).slice(0, 70))
  }
  // A change that names a speech service changes nothing, and one with a language changes the language only.
  await updateSettings({ transcription: { me: 'openai', them: 'server', serverUrl: 'https://speech.example/v1' } })
  assert.deepEqual(getSettings().transcription, { language: 'hr' })
  await updateSettings({ transcription: { language: 'de', me: 'openai' } })
  assert.deepEqual(getSettings().transcription, { language: 'de' })
  // The file Togle writes has none of it either.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).transcription, { language: 'de' })
  // A language that is not a word (a file edited by hand) is the default one.
  writeFileSync(file, JSON.stringify({ transcription: { language: 7, them: 'openai' } }))
  assert.deepEqual((await loadSettings()).transcription, { language: 'auto' })
  rmSync(file, { force: true })
  await loadSettings()
})
