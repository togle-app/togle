import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSettings, modelSourceId, selectDefaultModel, sourceLanes } from './.build/togle.mjs'

const claude = { id: 'work-claude', provider: 'claude', label: 'Work', subscription: true, ready: true }
const gpt = { id: 'personal-gpt', provider: 'chatgpt', label: 'Personal', subscription: true, ready: true }

test('a cross-provider model choice selects its account atomically and preserves dictation and API preferences', () => {
  const settings = structuredClone(getSettings()), before = structuredClone(settings)
  settings.dictation.accountId = 'dictation-only'
  const patch = selectDefaultModel(settings, claude, { id: 'opus', label: 'Opus', reasoningLevels: ['low', 'high'], defaultReasoning: 'high' })
  assert.equal(patch.subscriptionAccountId, 'work-claude')
  assert.equal(patch.provider, 'claude'); assert.equal(patch.claude.auth, 'subscription')
  assert.deepEqual(new Set(Object.values(patch.claude.subscriptionLanes).map(lane => lane.model)), new Set(['opus']))
  assert.ok(Object.values(patch.claude.subscriptionLanes).every(lane => ['low', 'high'].includes(lane.effort)))
  assert.equal(patch.claude.lanes, undefined); assert.equal(patch.dictation, undefined); assert.equal(patch.chatgpt, undefined)
  assert.deepEqual(settings.claude.lanes, before.claude.lanes)
  assert.equal(settings.dictation.accountId, 'dictation-only')
})

test('API selection clears the subscription binding without changing subscription model settings', () => {
  const settings = structuredClone(getSettings()); settings.subscriptionAccountId = 'work-claude'
  const patch = selectDefaultModel(settings, { ...claude, id: 'api:claude', subscription: false }, { id: 'claude-test-model', label: 'API model' })
  assert.equal(patch.subscriptionAccountId, ''); assert.equal(patch.claude.auth, 'api-key')
  assert.equal(patch.claude.subscriptionLanes, undefined)
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
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.claude.auth = 'subscription'; settings.subscriptionAccountId = ''
  assert.equal(modelSourceId(settings), 'claude-default')
  assert.equal(sourceLanes(settings, claude), settings.claude.subscriptionLanes)
  const patch = selectDefaultModel(settings, { id: 'api:compat', provider: 'compat', label: 'Local', subscription: false, ready: true }, { id: 'local-model', label: 'Local' })
  assert.deepEqual(patch, { provider: 'compat', subscriptionAccountId: '', compat: { model: 'local-model' } })
  assert.throws(() => selectDefaultModel(settings, gpt, { id: '', label: '' }), /Choose a model/)
})
