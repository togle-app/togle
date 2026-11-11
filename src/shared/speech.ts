import type { AgentPreferences, LocalModelId, Settings } from './types'

export const SPEECH_LANGUAGES: [string, string][] = [
  ['auto', 'Detect automatically / mixed languages'],
  ['en', 'English'], ['hr', 'Croatian'], ['sr', 'Serbian'], ['bs', 'Bosnian'], ['sl', 'Slovenian'], ['sk', 'Slovak'],
  ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['de', 'German'], ['el', 'Greek'],
  ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish'],
  ['no', 'Norwegian'], ['sv', 'Swedish'], ['fi', 'Finnish'], ['et', 'Estonian'], ['lv', 'Latvian'], ['lt', 'Lithuanian'],
  ['ro', 'Romanian'], ['hu', 'Hungarian'], ['mt', 'Maltese'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['bg', 'Bulgarian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean']
]

/**
 * The 25 languages NVIDIA's Parakeet TDT 0.6B v3 hears, telling which by itself: this PC's fast recognizer. On a PC's
 * processor alone (2026-11-09, sherpa-onnx's test clips) it got Spanish and French all right, and one word each wrong in
 * German (a compound written as one) and Russian, where Whisper large-v3-turbo got none wrong but took 17 times as long.
 */
export const PARAKEET_LANGUAGES = new Set('bg hr cs da nl en et fi fr de el hu it lv lt mt pl pt ro ru sk sl es sv uk'.split(' '))

export const speechLanguageCode = (value: string): string => (value || 'auto').toLowerCase().split(/[-_]/)[0]

/** A language setting's name ("Croatian"); "every language" for automatic detection. */
export function speechLanguageName(value: string): string {
  const code = speechLanguageCode(value)
  if (code === 'auto') return 'every language'
  return SPEECH_LANGUAGES.find(([id]) => id === code)?.[1] ?? value
}

/** Whether Parakeet hears a language setting: one of its own, or automatic (it tries first, among its own). */
export function parakeetHears(language: string): boolean {
  const code = speechLanguageCode(language)
  return code === 'auto' || PARAKEET_LANGUAGES.has(code)
}

/**
 * The models this PC needs to hear a language: Parakeet for its 25 languages (and to try first when the language is
 * detected), with Whisper behind it. On a GPU that's large-v3-turbo, always: it re-checks unclear and noisy speech in a
 * moment, and hears every other language. On a CPU it's Whisper small, and only for languages Parakeet doesn't hear,
 * since there it takes seconds a sentence.
 */
export function localModelsFor(language: string, gpu: boolean): LocalModelId[] {
  const code = speechLanguageCode(language)
  const parakeet = parakeetHears(code)
  const whisper: LocalModelId | null = gpu ? 'whisper-turbo' : code === 'auto' || !PARAKEET_LANGUAGES.has(code) ? 'whisper-small' : null
  return [...(parakeet ? ['parakeet' as const] : []), ...(whisper ? [whisper] : [])]
}

/**
 * Voice typing's account, from when it was two settings: a speech account (shared with calls, which never used it:
 * this computer hears them) and voice typing's own account over it ('' for none). It's one setting now, voice typing's
 * own: the account it used then ('' still leaves it automatic).
 */
export function mergedVoiceAccount(voice?: string, speech?: string): string {
  return voice || speech || ''
}

/** The two accounts of an older Togle's settings: voice typing's own, and the shared speech account. */
export interface OldVoiceAccounts { voice: string; speech: string }

/**
 * An agent's voice typing and speech preferences, from when voice typing's account was two settings: its own voice
 * typing account where it had one; otherwise the account it used then, given the app settings of then. An account it
 * followed from the app settings it still follows, where those give the same one now. Undefined: nothing to change.
 */
export function migrateVoicePreferences(preferences: AgentPreferences | undefined, app: OldVoiceAccounts): AgentPreferences | undefined {
  const voice = preferences?.dictation
  const speech = preferences?.transcription as (Partial<Settings['transcription']> & { accountId?: unknown }) | undefined
  const ownVoice = typeof voice?.accountId === 'string', ownSpeech = typeof speech?.accountId === 'string'
  if (!preferences || (!ownVoice && !ownSpeech)) return undefined
  const used = mergedVoiceAccount(ownVoice ? voice!.accountId : app.voice, ownSpeech ? speech!.accountId as string : app.speech)
  const next = structuredClone(preferences)
  if (next.transcription) {
    delete (next.transcription as { accountId?: unknown }).accountId
    if (!Object.keys(next.transcription).length) delete next.transcription
  }
  if (ownVoice && voice!.accountId) return next
  if (used === mergedVoiceAccount(app.voice, app.speech)) {
    if (next.dictation) {
      delete next.dictation.accountId
      if (!Object.keys(next.dictation).length) delete next.dictation
    }
  } else next.dictation = { ...next.dictation, accountId: used }
  return next
}
