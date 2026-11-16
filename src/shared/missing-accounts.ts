import type { SettingsPatch } from './api'
import type { Agent, AgentPatch, Settings } from './types'

/**
 * What the settings name that is not there any more: an account an earlier Togle had (a Claude sign-in, or one that was
 * removed) or a connection that was deleted. It is forgotten, so the AI goes back to the general account instead of failing
 * on a name nothing answers to. `known` says whether a source (an account, or an API connection) is there.
 */
export function settingsForgetting(settings: Settings, known: (sourceId: string) => boolean): SettingsPatch {
  const patch: SettingsPatch = {}
  if (settings.subscriptionAccountId && !known(settings.subscriptionAccountId)) patch.subscriptionAccountId = ''
  if (settings.dictation.accountId && !known(settings.dictation.accountId)) patch.dictation = { accountId: '' }
  if (settings.ai && Object.values(settings.ai.tasks).some(task => !known(task.sourceId))) patch.ai = null
  return patch
}

/** The same for one agent: its own account, its own jobs and its own voice typing account. Nothing when all of it is there. */
export function agentForgetting(agent: Agent, known: (sourceId: string) => boolean): AgentPatch | undefined {
  const patch: AgentPatch = {}
  if (agent.subscriptionAccountId && !known(agent.subscriptionAccountId)) patch.subscriptionAccountId = ''
  if (agent.preferences) {
    const preferences = structuredClone(agent.preferences)
    let changed = false
    if (preferences.ai && Object.values(preferences.ai.tasks).some(task => !known(task.sourceId))) { delete preferences.ai; changed = true }
    if (preferences.dictation?.accountId && !known(preferences.dictation.accountId)) { delete preferences.dictation.accountId; changed = true }
    if (changed) patch.preferences = preferences
  }
  return Object.keys(patch).length ? patch : undefined
}
