import type { Agent, AgentPreferences, AIProfile, Lane, LaneModel, ReasoningEffort, Settings } from './types'
import { modelSourceId } from './model-selection'

export const AI_TASKS: { lane: Lane; label: string }[] = [
  { lane: 'quick', label: 'Quick answers' }, { lane: 'deep', label: 'Deep answers & code' },
  { lane: 'vision', label: 'Reading the screen' }, { lane: 'background', label: 'Background work' }
]
const EFFORTS: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

export function validateAIProfile(value: unknown): AIProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Choose an AI model for each task.')
  const profile = value as AIProfile
  const tasks = Object.fromEntries(AI_TASKS.map(({ lane }) => {
    const task = profile.tasks?.[lane]
    if (!task || typeof task.sourceId !== 'string' || !task.sourceId.trim() || task.sourceId.length > 100 || typeof task.model !== 'string' || !task.model.trim() || task.model.length > 200 || !EFFORTS.includes(task.effort)) throw new Error(`Choose an account, model and reasoning level for ${lane}.`)
    return [lane, { sourceId: task.sourceId, model: task.model.trim(), effort: task.effort, ...(task.fast === true ? { fast: true } : {}) }]
  })) as AIProfile['tasks']
  return { tasks, ...(['claude', 'codex', 'mixed'].includes(profile.preset || '') ? { preset: profile.preset } : {}), ...(typeof profile.version === 'string' ? { version: profile.version.slice(0, 80) } : {}) }
}

/** Native clients still understand old settings; an explicit profile always wins. */
export function effectiveAI(settings: Settings, agent?: Agent, providerForSource?: (id: string) => string): AIProfile {
  if (agent?.preferences?.ai) return structuredClone(agent.preferences.ai)
  if (!agent?.subscriptionAccountId && settings.ai) return structuredClone(settings.ai)
  const sourceId = agent?.subscriptionAccountId || modelSourceId(settings)
  const provider = providerForSource?.(sourceId) || (sourceId.startsWith('claude') || sourceId === 'api:claude' ? 'claude' : sourceId.startsWith('api:') ? 'compat' : settings.provider)
  const lanes = provider === 'chatgpt' ? settings.chatgpt.lanes : provider === 'claude' ? sourceId === 'api:claude' ? settings.claude.lanes : settings.claude.subscriptionLanes : undefined
  const fallback: LaneModel = { model: settings.compat.model, effort: 'low' }
  return { tasks: Object.fromEntries(AI_TASKS.map(({ lane }) => [lane, { ...(lanes?.[lane] || fallback), sourceId, ...(lane === 'deep' && agent?.model ? { model: agent.model } : {}) }])) as AIProfile['tasks'] }
}

export function effectiveSettings(settings: Settings, agent?: Agent): Settings {
  const overrides = agent?.preferences
  return { ...settings, ...(overrides?.ai ? { ai: overrides.ai } : {}),
    transcription: { ...settings.transcription, ...overrides?.transcription },
    dictation: { ...settings.dictation, ...overrides?.dictation }
  }
}

export function validatePreferences(value: unknown): AgentPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as AgentPreferences, result: AgentPreferences = {}
  if (input.ai) result.ai = validateAIProfile(input.ai)
  for (const section of ['transcription', 'dictation'] as const) {
    const group = input[section]
    if (!group) continue
    if (typeof group !== 'object' || Array.isArray(group)) throw new Error('Speech and voice typing preferences must be settings objects.')
    const fields = section === 'dictation' ? ['speech', 'accountId', 'mode', 'polish', 'showBar', 'microphoneId'] : ['accountId', 'language', 'me', 'them', 'openaiModel', 'serverUrl', 'serverModel']
    const clean: Record<string, unknown> = {}
    for (const key of fields) {
      const value = (group as Record<string, unknown>)[key]
      if (value === undefined) continue
      const valid = ['polish', 'showBar'].includes(key) ? typeof value === 'boolean' : typeof value === 'string' && value.length <= (key === 'serverUrl' || key === 'microphoneId' ? 2000 : 200)
      if (!valid || key === 'mode' && !['hold', 'toggle'].includes(value as string) || key === 'speech' && !['auto', 'claude', 'chatgpt'].includes(value as string) || ['me', 'them'].includes(key) && !['local', 'openai', 'server', 'chatgpt', 'claude'].includes(value as string)) throw new Error(`Invalid ${section} preference: ${key}.`)
      clean[key] = value
    }
    result[section] = clean as never
  }
  return result
}
