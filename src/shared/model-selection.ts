import type { SettingsPatch } from './api'
import type { Lane, LaneModel, ModelOption, ProviderId, Settings } from './types'

export interface ModelSource {
  id: string
  provider: ProviderId
  label: string
  subscription: boolean
  ready: boolean
  /** Changes when a different identity signs into the same local profile. */
  identity?: string
}

export function modelSourceId(settings: Settings): string {
  if (settings.ai) return settings.ai.tasks.deep.sourceId
  if (settings.provider === 'compat') return 'api:compat'
  if (settings.provider === 'claude' && settings.claude.auth === 'api-key') return 'api:claude'
  return settings.subscriptionAccountId || `${settings.provider}-default`
}

export function sourceLanes(settings: Settings, source: Pick<ModelSource, 'provider' | 'subscription'>): Record<Lane, LaneModel> | undefined {
  if (source.provider === 'compat') return
  return source.provider === 'chatgpt' ? settings.chatgpt.lanes : source.subscription ? settings.claude.subscriptionLanes : settings.claude.lanes
}

/** Account and model move together in one settings write. Other connections and dictation stay independent. */
export function selectDefaultModel(settings: Settings, source: ModelSource, model?: ModelOption): SettingsPatch {
  const patch: SettingsPatch = { provider: source.provider, subscriptionAccountId: source.subscription ? source.id : '' }
  if (source.provider === 'claude') patch.claude = { auth: source.subscription ? 'subscription' : 'api-key' }
  if (!model) return patch
  if (!model.id.trim()) throw new Error('Choose a model.')
  if (source.provider === 'compat') return { ...patch, compat: { model: model.id } }
  const previous = sourceLanes(settings, source)!
  const lanes = Object.fromEntries(Object.entries(previous).map(([lane, current]) => {
    const levels = model.reasoningLevels
    const effort = !levels?.length || levels.includes(current.effort) ? current.effort
      : model.defaultReasoning && levels.includes(model.defaultReasoning) ? model.defaultReasoning : levels[0]
    return [lane, { ...current, model: model.id, effort, fast: !!model.fast && !!current.fast }]
  })) as Record<Lane, LaneModel>
  return source.provider === 'chatgpt' ? { ...patch, chatgpt: { lanes } }
    : { ...patch, claude: { ...patch.claude, [source.subscription ? 'subscriptionLanes' : 'lanes']: lanes } }
}
