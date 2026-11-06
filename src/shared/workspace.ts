import type { AIProfile, Settings, SttStatus, SubscriptionAccount } from './types'
import type { ModelSource } from './model-selection'

/** Calls have their own workspace. An agent's long-lived chat is for its reusable setup. */
export type Workspace = 'call' | 'agent'
export const CALL_NOTES_CHARS = 3000

/** Credentials stay with their owners. The workspace receives only connection status and capabilities. */
export function callReadiness(settings: Settings | null, accounts: { chatgpt: boolean; claudeSubscription: boolean; claudeKey: boolean }, speech: SttStatus, override?: SubscriptionAccount | null, routing?: { profile?: AIProfile; sources: ModelSource[] }): {
  needsAI: boolean
  noSpeech: boolean
  setup: 'ai' | 'speech' | undefined
  answers: string
  transcription: string
} {
  const needsAI = routing?.profile ? Object.values(routing.profile.tasks).some(task => !task.model.trim() || !routing.sources.some(source => source.id === task.sourceId && source.ready)) : override !== undefined ? !override?.signedIn : !settings || (settings.provider === 'chatgpt' ? !accounts.chatgpt : settings.provider === 'claude'
    ? settings.claude.auth === 'subscription' ? !accounts.claudeSubscription : !accounts.claudeKey
    : !settings.compat.model.trim())
  const noSpeech = speech.state === 'missing'
  const answers = routing?.profile ? needsAI ? 'Check this agent’s AI connections' : new Set(Object.values(routing.profile.tasks).map(task => task.sourceId)).size > 1 ? 'Mixed AI task models' : routing.sources.find(source => source.id === routing.profile!.tasks.deep.sourceId)?.label || 'Selected AI connection' : override !== undefined ? override?.signedIn ? `${override.label} · ${override.provider === 'claude' ? 'Claude' : 'ChatGPT'}` : 'Connect this agent’s account' : !settings || needsAI ? 'Connect your AI plan' : settings.provider === 'chatgpt' ? 'ChatGPT plan'
    : settings.provider === 'claude' ? settings.claude.auth === 'subscription' ? 'Claude subscription' : 'Claude API' : settings.compat.model
  const transcription = noSpeech ? 'Set up transcription' : speech.state === 'error' ? 'Transcription needs attention'
    : speech.state === 'starting' ? 'Getting speech ready' : settings?.transcription.me === 'local' && settings.transcription.them === 'local' ? 'Speech on this PC' : 'Speech connected'
  return { needsAI, noSpeech, setup: needsAI ? 'ai' : noSpeech || speech.state === 'error' ? 'speech' : undefined, answers, transcription }
}

export function workspaceEntries<T extends { role: string }>(entries: T[], workspace: Workspace, call: string): T[] {
  return entries.filter((entry) => workspace === 'agent'
    ? entry.role !== 'call'
    : entry.role === 'call' && 'call' in entry && entry.call === call)
}
