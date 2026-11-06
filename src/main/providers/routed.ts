import type { AIProfile, Lane } from '@shared/types'
import { validateAIProfile } from '@shared/preferences'
import type { CompletionInput, LLMProvider, PlanLimits } from './types'

export const planFor = (provider: LLMProvider, lane: Lane): PlanLimits | undefined => provider.planFor ? provider.planFor(lane) : provider.plan

/** Snapshot routes and authenticated providers once; requests never mutate global settings. */
export function routedProvider(profile: AIProfile, resolve: (sourceId: string) => LLMProvider): LLMProvider {
  const selected = validateAIProfile(profile)
  const sources = new Map<string, LLMProvider>()
  for (const task of Object.values(selected.tasks)) if (!sources.has(task.sourceId)) sources.set(task.sourceId, resolve(task.sourceId))
  const target = (lane: Lane): LLMProvider => sources.get(selected.tasks[lane].sourceId)!
  const inputFor = (input: CompletionInput): CompletionInput => {
    const task = selected.tasks[input.lane]
    return { ...input, model: task.model, effort: input.effort ?? task.effort, fast: !!task.fast, fixedModel: true }
  }
  const deep = target('deep')
  return { id: deep.id, supportsTools: deep.supportsTools, plan: target('quick').plan,
    planFor: lane => target(lane).plan,
    task: lane => ({ ...selected.tasks[lane], provider: target(lane).id }),
    listModels: () => deep.listModels(),
    stream: (input, options) => target(input.lane).stream(inputFor(input), options),
    prepareText: (input, options) => {
      const provider = target(input.lane)
      if (!provider.prepareText) return Promise.reject(new Error('This connection does not support preparing text in advance.'))
      return provider.prepareText(inputFor(input), options)
    }
  }
}
