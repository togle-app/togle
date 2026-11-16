// Settings and agents that name an account that is not there (the Claude sign-in an earlier Togle had): forgotten, so the AI
// goes back to the general account instead of failing on a name nothing answers to.
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const work = workDir('missing-accounts')
const { settingsForgetting, agentForgetting, getSettings, loadSettings, validatePreferences } = await import('./.build/togle.mjs')
const known = (...ids) => id => ids.includes(id)
const profile = sourceId => ({ tasks: Object.fromEntries(['quick', 'deep', 'vision', 'background'].map(lane => [lane, { sourceId, model: 'm', effort: 'low' }])) })

test('settings that name an account that is gone are cleared, and what is there is kept', () => {
  const settings = structuredClone(getSettings())
  settings.subscriptionAccountId = 'claude-default'; settings.dictation.accountId = 'work-claude'; settings.ai = profile('claude-default')
  assert.deepEqual(settingsForgetting(settings, known('chatgpt-default', 'api:claude')), { subscriptionAccountId: '', dictation: { accountId: '' }, ai: null })
  // Everything it names is there: nothing to forget. A key (an API connection) counts as there.
  settings.subscriptionAccountId = 'chatgpt-default'; settings.dictation.accountId = 'chatgpt-default'; settings.ai = profile('connection:abc')
  assert.deepEqual(settingsForgetting(settings, known('chatgpt-default', 'connection:abc')), {})
  // One job on an account that is gone is enough to drop the profile: it is not a profile that can run.
  settings.ai = { tasks: { ...profile('chatgpt-default').tasks, deep: { sourceId: 'claude-default', model: 'm', effort: 'low' } } }
  assert.deepEqual(settingsForgetting(settings, known('chatgpt-default')), { ai: null })
})

test('an agent that names accounts that are gone forgets them, and keeps the rest of what it chose', () => {
  const agent = { id: 'a', name: 'Sales', vocabulary: '', subscriptionAccountId: 'claude-default', createdAt: 0, updatedAt: 0,
    preferences: { ai: profile('claude-default'), dictation: { accountId: 'work-claude', polish: false } } }
  assert.deepEqual(agentForgetting(agent, known('chatgpt-default')), { subscriptionAccountId: '', preferences: { dictation: { polish: false } } })
  assert.equal(agentForgetting({ ...agent, subscriptionAccountId: 'chatgpt-default', preferences: { ai: profile('chatgpt-default') } }, known('chatgpt-default')), undefined)
  assert.equal(agentForgetting({ ...agent, subscriptionAccountId: undefined, preferences: undefined }, known()), undefined)
  // What it leaves is a valid set of preferences.
  assert.doesNotThrow(() => validatePreferences(agentForgetting(agent, known('chatgpt-default')).preferences))
})

test('a settings file saved with the Claude sign-in on is cleaned up in two steps: loading, then forgetting the account', async () => {
  const lanes = model => Object.fromEntries(['quick', 'deep', 'vision', 'background'].map(lane => [lane, { model, effort: 'low' }]))
  writeFileSync(path.join(work, 'settings.json'), JSON.stringify({ provider: 'claude', subscriptionAccountId: 'claude-default', claude: { auth: 'subscription', subscriptionLanes: lanes('opus') }, ai: profile('claude-default'), dictation: { accountId: 'chatgpt-default' } }))
  await loadSettings()
  assert.equal(getSettings().provider, 'chatgpt')
  assert.equal(getSettings().subscriptionAccountId, 'claude-default', 'loading cannot tell which accounts there are')
  assert.deepEqual(settingsForgetting(getSettings(), known('chatgpt-default')), { subscriptionAccountId: '', ai: null })
})
