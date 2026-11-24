import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('task-routing')
const T = await import('./.build/togle.mjs')
// A job's model comes from the profile: a ChatGPT plan account, and a Claude API key (a named connection).
const job = (sourceId, model, effort = 'low') => ({ sourceId, model, effort })
const chatgpt = { tasks: { quick: job('personal-codex', 'gpt-6-luna'), deep: job('personal-codex', 'gpt-6.1-sol', 'medium'), vision: job('personal-codex', 'gpt-6.1-sol'), background: job('personal-codex', 'gpt-6-luna') } }
const claudeKey = { tasks: { quick: job('claude-key', 'claude-sonnet-5-5'), deep: job('claude-key', 'claude-opus-5-5', 'high'), vision: job('claude-key', 'claude-opus-5-5'), background: job('claude-key', 'claude-haiku-5-5') } }
const mixed = () => ({ tasks: { ...structuredClone(chatgpt.tasks), deep: job('claude-key', 'claude-opus-5-5', 'high') } })

test('a profile names an account and a model for each of the four jobs, and nothing else is kept from it', () => {
  for (const profile of [chatgpt, claudeKey, mixed()]) {
    assert.equal(Object.keys(profile.tasks).length, 4)
    assert.deepEqual(T.validateAIProfile(profile).tasks, profile.tasks)
  }
  // The recipes (presets) an earlier Togle had are gone: a saved name is not kept.
  assert.equal('preset' in T.validateAIProfile({ ...chatgpt, preset: 'claude' }), false)
  assert.throws(() => T.validateAIProfile({ tasks: { quick: {} } }), /Choose/)
})
test('a mixed call routes concurrent tasks without changing settings and pins routes against later edits', async () => {
  const requests = [], selected = mixed(), original = structuredClone(T.getSettings())
  const limits = { limited: () => 12345, saving: () => undefined }
  const provider = T.routedProvider(selected, sourceId => ({ id: sourceId === 'claude-key' ? 'claude' : 'chatgpt', supportsTools: true, plan: sourceId === 'personal-codex' ? limits : undefined,
    listModels: async () => [], stream: async (input, options) => { requests.push({ sourceId, input }); options.onDelta(sourceId) } }))
  selected.tasks.deep.sourceId = 'personal-codex'; selected.tasks.quick.model = 'changed-after-start'
  await Promise.all(T.AI_TASKS.map(({ lane }) => provider.stream({ lane, system: 'Fixture', user: 'Safe task', model: 'stale-agent-model' }, { signal: AbortSignal.timeout(1000), onDelta: () => {} })))
  assert.deepEqual(requests.map(request => request.sourceId), ['personal-codex', 'claude-key', 'personal-codex', 'personal-codex'])
  assert.equal(requests[0].input.model, 'gpt-6-luna'); assert.equal(requests[1].input.model, 'claude-opus-5-5')
  assert.ok(requests.every(request => request.input.fixedModel))
  assert.equal(T.planFor(provider, 'quick'), limits); assert.equal(T.planFor(provider, 'deep'), undefined)
  assert.deepEqual(T.getSettings(), original)
})
test('agent sections inherit separately and resets do not mutate global defaults', () => {
  const settings = structuredClone(T.getSettings()); settings.ai = structuredClone(chatgpt)
  const agent = { preferences: { ai: structuredClone(claudeKey), dictation: { polish: false, microphoneId: 'headset' } } }
  assert.equal(T.effectiveAI(settings, agent).tasks.deep.sourceId, 'claude-key')
  const effective = T.effectiveSettings(settings, agent)
  assert.equal(effective.dictation.polish, false); assert.equal(effective.dictation.microphoneId, 'headset')
  assert.equal(effective.dictation.accountId, settings.dictation.accountId)
  assert.equal(effective.transcription.language, settings.transcription.language)
  assert.notEqual(settings.dictation.microphoneId, 'headset')
  assert.equal(T.effectiveAI(settings, { preferences: {} }).tasks.deep.sourceId, 'personal-codex')
  assert.throws(() => T.validatePreferences({ dictation: { mode: 'other' } }), /Invalid/)
  assert.throws(() => T.validatePreferences({ transcription: { language: [] } }), /Invalid/)
})
test('old Claude choices an earlier Togle saved are read as what they stand for now', () => {
  // Voice typing that Claude cleaned up goes back to the automatic account.
  assert.equal(T.validatePreferences({ dictation: { speech: 'claude' } }).dictation.speech, 'auto')
  // A side of a call that Claude, OpenAI's speech API or a server heard: this PC hears every call now, so the sound never
  // leaves it, and nothing of that choice is kept. The language is.
  assert.deepEqual(T.validatePreferences({ transcription: { language: 'de', me: 'claude', them: 'openai', openaiModel: 'gpt-transcribe', serverUrl: 'https://speech.example/v1', serverModel: 'any' } }), { transcription: { language: 'de' } })
  assert.deepEqual(T.validatePreferences({ transcription: { me: 'server', them: 'server' } }), { transcription: {} })
  assert.equal(T.validatePreferences({ dictation: { speech: 'chatgpt' } }).dictation.speech, 'chatgpt')
})
