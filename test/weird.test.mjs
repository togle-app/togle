// Weird cases: an agent's file damaged on disk, settings edited by hand, and the like. Each is something that happens,
// rarely, and mustn't break Togle or mislead.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('weird')
const { AgentStore, getSettings, loadSettings, savedBeforeSpeechChoice, updateSettings } =
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

test("a new Togle hears calls on this PC (ChatGPT's sign-in has no transcription); settings saved before the speech model was a choice say so", async () => {
  const file = path.join(work, 'settings.json')
  rmSync(file, { force: true })
  const fresh = await loadSettings()
  assert.deepEqual([fresh.transcription.me, fresh.transcription.them], ['local', 'local'])
  // Saved when the ChatGPT plan transcribed: this PC hears those calls now.
  writeFileSync(file, JSON.stringify({ transcription: { me: 'chatgpt', them: 'chatgpt', accountId: 'chatgpt-default' } }))
  const moved = await loadSettings()
  assert.deepEqual([moved.transcription.me, moved.transcription.them], ['local', 'local'])
  // Saved with Claude speech, which was removed: this PC hears those calls too, and a change can't bring it back.
  writeFileSync(file, JSON.stringify({ transcription: { me: 'claude', them: 'openai', accountId: 'claude-default' } }))
  const fromClaude = await loadSettings()
  assert.deepEqual([fromClaude.transcription.me, fromClaude.transcription.them], ['local', 'openai'])
  await updateSettings({ transcription: { me: 'claude', them: 'claude' } })
  assert.deepEqual([getSettings().transcription.me, getSettings().transcription.them], ['local', 'local'])
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
