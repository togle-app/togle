import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('task-routing')
const T = await import('./.build/togle.mjs')
const catalog = [
  { source: { id: 'work-claude', provider: 'claude', subscription: true, ready: true, label: 'Work Claude' }, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map(id => ({ id, label: id, reasoningLevels: ['low', 'medium', 'high'] })) },
  { source: { id: 'personal-codex', provider: 'chatgpt', subscription: true, ready: true, label: 'Personal Codex' }, models: ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6-astra'].map(id => ({ id, label: id, reasoningLevels: ['low', 'medium', 'high'] })) }
]
test('three versioned recipes select real account catalog models for all four tasks', () => {
  assert.deepEqual(T.PRESETS.map(preset => preset.id), ['claude', 'codex', 'mixed'])
  for (const id of ['claude', 'codex', 'mixed']) {
    const profile = T.presetProfile(id, catalog)
    assert.equal(profile.version, T.PRESET_VERSION)
    assert.equal(Object.keys(profile.tasks).length, 4)
    for (const [lane, task] of Object.entries(profile.tasks)) {
      const group = catalog.find(group => group.source.id === task.sourceId)
      assert.ok(group.models.some(model => model.id === task.model))
      assert.ok(task.sourceId === (id === 'claude' || id === 'mixed' && lane === 'deep' ? 'work-claude' : 'personal-codex'))
    }
    T.validateAIProfile(profile)
  }
  assert.throws(() => T.presetProfile('mixed', catalog.slice(0, 1)), /Connect a ChatGPT/)
})
test('preset generation never uses API billing or another identity when a preferred account is available', () => {
  const other = { ...catalog[0], source: { ...catalog[0].source, id: 'personal-claude' } }
  const api = { ...catalog[0], source: { ...catalog[0].source, id: 'paid-api', subscription: false } }
  assert.equal(T.presetProfile('claude', [api, other, ...catalog], { claude: 'work-claude' }).tasks.deep.sourceId, 'work-claude')
  assert.throws(() => T.presetProfile('claude', [api]), /Connect/)
  assert.throws(() => T.presetProfile('claude', [other, { ...catalog[0], source: { ...catalog[0].source, ready: false } }], { claude: 'work-claude' }), /Connect/, 'a disconnected work profile cannot silently become a personal profile')
})
test('Claude recipe snapshots use full model versions rather than rolling aliases', () => {
  const models = T.pinnedClaudeModels(['opus', 'sonnet', 'haiku'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) + ' 5.5' })))
  const profile = T.presetProfile('claude', [{ ...catalog[0], models }])
  assert.equal(profile.tasks.quick.model, 'claude-sonnet-5-5')
  assert.equal(profile.tasks.deep.model, 'claude-opus-5-5')
  assert.equal(profile.tasks.background.model, 'claude-haiku-5-5')
})
test('a mixed call routes concurrent tasks without changing settings and pins routes against later edits', async () => {
  const requests = [], selected = T.presetProfile('mixed', catalog), original = structuredClone(T.getSettings())
  const limits = { limited: () => 12345, saving: () => undefined }
  const provider = T.routedProvider(selected, sourceId => ({ id: sourceId === 'work-claude' ? 'claude' : 'chatgpt', supportsTools: true, plan: sourceId === 'personal-codex' ? limits : undefined,
    listModels: async () => [], stream: async (input, options) => { requests.push({ sourceId, input }); options.onDelta(sourceId) } }))
  selected.tasks.deep.sourceId = 'personal-codex'; selected.tasks.quick.model = 'changed-after-start'
  await Promise.all(T.AI_TASKS.map(({ lane }) => provider.stream({ lane, system: 'Fixture', user: 'Safe task', model: 'stale-agent-model' }, { signal: AbortSignal.timeout(1000), onDelta: () => {} })))
  assert.deepEqual(requests.map(request => request.sourceId), ['personal-codex', 'work-claude', 'personal-codex', 'personal-codex'])
  assert.equal(requests[0].input.model, 'gpt-6-luna'); assert.equal(requests[1].input.model, 'claude-opus-5-5')
  assert.ok(requests.every(request => request.input.fixedModel))
  assert.equal(T.planFor(provider, 'quick'), limits); assert.equal(T.planFor(provider, 'deep'), undefined)
  assert.deepEqual(T.getSettings(), original)
})
test('agent sections inherit separately and resets do not mutate global defaults', () => {
  const settings = structuredClone(T.getSettings()); settings.ai = T.presetProfile('codex', catalog)
  const agent = { preferences: { ai: T.presetProfile('claude', catalog), dictation: { polish: false, microphoneId: 'headset' } } }
  assert.equal(T.effectiveAI(settings, agent).tasks.deep.sourceId, 'work-claude')
  const effective = T.effectiveSettings(settings, agent)
  assert.equal(effective.dictation.polish, false); assert.equal(effective.dictation.microphoneId, 'headset')
  assert.equal(effective.transcription.accountId, settings.transcription.accountId)
  assert.notEqual(settings.dictation.microphoneId, 'headset')
  assert.equal(T.effectiveAI(settings, { preferences: {} }).tasks.deep.sourceId, 'personal-codex')
  assert.throws(() => T.validateAIProfile({ tasks: { quick: {} } }), /Choose/)
  assert.throws(() => T.validatePreferences({ dictation: { mode: 'other' } }), /Invalid/)
  assert.throws(() => T.validatePreferences({ transcription: { language: [] } }), /Invalid/)
})
