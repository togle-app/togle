import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSettings, modelSourceId, selectDefaultModel, sourceLanes } from './.build/togle.mjs'

// Claude is used with an Anthropic API key (there is no Claude sign-in): a key is not a plan, so it binds no account.
const claude = { id: 'api:claude', provider: 'claude', label: 'Claude key', subscription: false, ready: true }
const gpt = { id: 'personal-gpt', provider: 'chatgpt', label: 'Personal', subscription: true, ready: true }

test('a cross-provider model choice selects its source atomically and preserves dictation and the other provider', () => {
  const settings = structuredClone(getSettings()), before = structuredClone(settings)
  settings.dictation.accountId = 'dictation-only'
  const patch = selectDefaultModel(settings, claude, { id: 'claude-test-model', label: 'Test', reasoningLevels: ['low', 'high'], defaultReasoning: 'high' })
  assert.equal(patch.subscriptionAccountId, '')
  assert.equal(patch.provider, 'claude'); assert.equal(patch.claude.auth, undefined)
  assert.deepEqual(new Set(Object.values(patch.claude.lanes).map(lane => lane.model)), new Set(['claude-test-model']))
  assert.ok(Object.values(patch.claude.lanes).every(lane => ['low', 'high'].includes(lane.effort)))
  assert.equal(patch.dictation, undefined); assert.equal(patch.chatgpt, undefined)
  assert.deepEqual(settings.chatgpt.lanes, before.chatgpt.lanes)
  assert.equal(settings.dictation.accountId, 'dictation-only')
})

test('a key selection clears the plan binding without changing the plan model settings', () => {
  const settings = structuredClone(getSettings()); settings.subscriptionAccountId = 'personal-gpt'
  const patch = selectDefaultModel(settings, claude, { id: 'claude-test-model', label: 'API model' })
  assert.equal(patch.subscriptionAccountId, '')
  assert.equal(patch.chatgpt, undefined)
  assert.ok(Object.values(patch.claude.lanes).every(lane => lane.model === 'claude-test-model'))
  assert.equal(modelSourceId({ ...settings, ...patch, claude: { ...settings.claude, ...patch.claude } }), 'api:claude')
})

test('model changes discard incompatible reasoning and fast tiers, without mutating old lanes', () => {
  const settings = structuredClone(getSettings()); settings.chatgpt.lanes.deep.fast = true
  const before = structuredClone(settings)
  const patch = selectDefaultModel(settings, gpt, { id: 'gpt-test', label: 'GPT Test', reasoningLevels: ['low'], defaultReasoning: 'low' })
  assert.ok(Object.values(patch.chatgpt.lanes).every(lane => lane.effort === 'low' && lane.fast === false))
  assert.deepEqual(settings, before)
  assert.equal(patch.claude, undefined)
})

test('local/custom connections remain explicit and global inheritance resolves the correct authentication route', () => {
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.subscriptionAccountId = ''
  assert.equal(modelSourceId(settings), 'api:claude')
  assert.equal(sourceLanes(settings, claude), settings.claude.lanes)
  settings.provider = 'chatgpt'
  assert.equal(modelSourceId(settings), 'chatgpt-default')
  const patch = selectDefaultModel(settings, { id: 'api:compat', provider: 'compat', label: 'Local', subscription: false, ready: true }, { id: 'local-model', label: 'Local' })
  assert.deepEqual(patch, { provider: 'compat', subscriptionAccountId: '', compat: { model: 'local-model' } })
  assert.throws(() => selectDefaultModel(settings, gpt, { id: '', label: '' }), /Choose a model/)
})
