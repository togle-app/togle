import type { AIProfile, AIPreset, Lane, ModelOption, ReasoningEffort, Settings, TaskModel } from './types'
import type { ModelSource } from './model-selection'
import { AI_TASKS } from './preferences'

export const PRESET_VERSION = '2026-11-03-v1'
export const PRESETS: { id: AIPreset; label: string; note: string }[] = [
  { id: 'claude', label: 'Claude', note: 'Claude for every task' },
  { id: 'codex', label: 'ChatGPT', note: 'ChatGPT for every task' },
  { id: 'mixed', label: 'Mixed', note: 'Claude reasoning + ChatGPT speed' }
]
export interface PresetCatalog { source: ModelSource; models: ModelOption[] }
const concrete = (id: string): boolean => /^claude-(?:opus|sonnet|haiku|fable)-\d/i.test(id)
const newest = (models: ModelOption[]): ModelOption[] => [...models].sort((a, b) => Number(concrete(b.id)) - Number(concrete(a.id)) || b.id.localeCompare(a.id, undefined, { numeric: true }))
/** Full model IDs keep a saved recipe on the version advertised by its native catalog. */
export function pinnedClaudeModels(models: ModelOption[]): ModelOption[] {
  const pinned = models.flatMap(model => {
    if (!/^(opus|sonnet|haiku|fable)$/.test(model.id)) return []
    const match = /\b(opus|sonnet|haiku|fable)\s+(\d+)(?:\.(\d+))?\b/i.exec(model.label)
    if (!match) return []
    const id = `claude-${match[1].toLowerCase()}-${match[2]}${match[3] ? `-${match[3]}` : ''}`
    return models.some(model => model.id === id) ? [] : [{ ...model, id, label: `${model.label} · pinned version` }]
  })
  return [...models, ...pinned]
}
function modelFor(models: ModelOption[], patterns: RegExp[]): ModelOption | undefined {
  for (const pattern of patterns) { const found = newest(models).find(model => pattern.test(`${model.id} ${model.label}`)); if (found) return found }
}
const families = {
  claude: { quick: [/sonnet/i, /opus/i, /haiku/i], deep: [/opus/i, /fable/i, /sonnet/i], vision: [/opus/i, /sonnet/i], background: [/haiku/i, /sonnet/i, /opus/i] },
  chatgpt: { quick: [/gpt-6-luna/i, /luna/i, /mini/i, /gpt-6\.1-sol/i, /gpt/i], deep: [/gpt-6\.1-sol/i, /gpt-6-astra/i, /astra/i, /codex/i, /gpt/i], vision: [/gpt-6\.1-sol/i, /astra/i, /gpt/i], background: [/gpt-6-luna/i, /luna/i, /mini/i, /gpt/i] }
}
function effortFor(model: ModelOption, wanted: ReasoningEffort): ReasoningEffort {
  const levels = model.reasoningLevels
  if (!levels?.length || levels.includes(wanted)) return wanted
  return model.defaultReasoning && levels.includes(model.defaultReasoning) ? model.defaultReasoning : levels[0]
}

/** Three complete recipes using models actually listed by the explicitly chosen profiles. */
export function presetProfile(id: AIPreset, catalogs: PresetCatalog[], preferred: Partial<Record<'claude' | 'chatgpt', string>> = {}): AIProfile {
  const select = (provider: 'claude' | 'chatgpt'): PresetCatalog => {
    const choices = catalogs.filter(group => group.source.provider === provider && group.source.subscription && group.source.ready && group.models.length)
    const group = preferred[provider] ? choices.find(group => group.source.id === preferred[provider]) : choices[0]
    if (!group) throw new Error(`Connect a ${provider === 'claude' ? 'Claude' : 'ChatGPT / Codex'} subscription and load its models first.`)
    return group
  }
  const claude = id !== 'codex' ? select('claude') : undefined
  const codex = id !== 'claude' ? select('chatgpt') : undefined
  const tasks = Object.fromEntries(AI_TASKS.map(({ lane }) => {
    const provider = id === 'claude' || id === 'mixed' && lane === 'deep' ? 'claude' : 'chatgpt'
    const group = provider === 'claude' ? claude! : codex!
    const model = modelFor(group.models, families[provider][lane])
    if (!model) throw new Error(`No suitable ${lane} model was found on ${group.source.label}. Refresh the model list.`)
    const wanted = lane === 'deep' ? provider === 'claude' ? 'high' : 'medium' : 'low'
    return [lane, { sourceId: group.source.id, model: model.id, effort: effortFor(model, wanted) } satisfies TaskModel]
  })) as Record<Lane, TaskModel>
  return { preset: id, version: PRESET_VERSION, tasks }
}

/** Keep legacy default metadata in sync so onboarding, account labels and connected apps stay accurate. */
export function profileSettings(profile: AIProfile, catalogs: PresetCatalog[]): Pick<Settings, 'ai' | 'provider' | 'subscriptionAccountId'> & { claude?: Partial<Settings['claude']> } {
  const source = catalogs.find(group => group.source.id === profile.tasks.deep.sourceId)?.source
  if (!source) throw new Error('The detailed-answer connection is unavailable.')
  return { ai: profile, provider: source.provider, subscriptionAccountId: source.subscription ? source.id : '', ...(source.provider === 'claude' ? { claude: { auth: source.subscription ? 'subscription' : 'api-key' } } : {}) }
}
