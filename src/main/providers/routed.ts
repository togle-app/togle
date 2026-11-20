import type { AIProfile, CallSessionInfo, Lane, TaskModel } from '@shared/types'
import { missingNotesAccount, NOTES_ACCOUNT_UNAVAILABLE } from '@shared/meeting'
import { validateAIProfile } from '@shared/preferences'
import type { CompletionInput, LLMProvider, PlanLimits } from './types'

export const planFor = (provider: LLMProvider, lane: Lane): PlanLimits | undefined => provider.planFor ? provider.planFor(lane) : provider.plan

const taskInput = (input: CompletionInput, task: TaskModel): CompletionInput =>
  ({ ...input, model: task.model, effort: input.effort ?? task.effort, fast: !!task.fast, fixedModel: true })

/** Meeting notes and titles only use the background job. Other jobs can reference retired accounts. */
export function meetingBackgroundProvider(record: Pick<CallSessionInfo, 'ai' | 'accountId'>, chosen: string | undefined, pin: (id: string) => LLMProvider, fallback: () => LLMProvider): LLMProvider {
  const task = record.ai?.tasks.background
  const source = chosen ?? task?.sourceId ?? record.accountId
  if (!source) return fallback()
  let provider: LLMProvider
  try { provider = pin(source) } catch (error) {
    if (missingNotesAccount((error as Error).message)) throw new Error(NOTES_ACCOUNT_UNAVAILABLE)
    throw error
  }
  if (task?.sourceId !== source) return provider
  return { id: provider.id, supportsTools: provider.supportsTools, listModels: () => provider.listModels(),
    stream: (input, options) => provider.stream(taskInput(input, task), options) }
}

/** Snapshot routes and authenticated providers once; requests never mutate global settings. */
export function routedProvider(profile: AIProfile, resolve: (sourceId: string) => LLMProvider): LLMProvider {
  const selected = validateAIProfile(profile)
  const sources = new Map<string, LLMProvider>()
  for (const task of Object.values(selected.tasks)) if (!sources.has(task.sourceId)) sources.set(task.sourceId, resolve(task.sourceId))
  const target = (lane: Lane): LLMProvider => sources.get(selected.tasks[lane].sourceId)!
  const inputFor = (input: CompletionInput): CompletionInput => taskInput(input, selected.tasks[input.lane])
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
