import type { SettingsPatch } from './api'
import type { Settings } from './types'

/** Claude Code's published dictation languages; other languages remain available through this PC's recognition. */
export const CLAUDE_SPEECH_LANGUAGES = new Set('cs da nl en fr de el hi id it ja ko no pl pt ru es sv tr uk'.split(' '))
export const SPEECH_LANGUAGES: [string, string][] = [
  ['auto', 'Detect automatically / mixed languages'],
  ['en', 'English'], ['hr', 'Croatian'], ['sr', 'Serbian'], ['bs', 'Bosnian'], ['sl', 'Slovenian'],
  ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'], ['de', 'German'], ['el', 'Greek'],
  ['fr', 'French'], ['es', 'Spanish'], ['it', 'Italian'], ['pt', 'Portuguese'], ['pl', 'Polish'],
  ['no', 'Norwegian'], ['sv', 'Swedish'], ['fi', 'Finnish'], ['ro', 'Romanian'], ['hu', 'Hungarian'],
  ['ru', 'Russian'], ['uk', 'Ukrainian'], ['tr', 'Turkish'], ['ar', 'Arabic'], ['he', 'Hebrew'],
  ['hi', 'Hindi'], ['id', 'Indonesian'], ['vi', 'Vietnamese'], ['th', 'Thai'],
  ['zh', 'Chinese'], ['ja', 'Japanese'], ['ko', 'Korean']
]

export const speechLanguageCode = (value: string): string => (value || 'auto').toLowerCase().split(/[-_]/)[0]
export function speechLanguageProblem(provider: 'chatgpt' | 'claude', value: string): string | undefined {
  if (provider !== 'claude') return
  const code = speechLanguageCode(value)
  if (code === 'auto') return "Choose a language for Claude speech. Automatic language detection is available with this PC's speech recognition."
  if (!CLAUDE_SPEECH_LANGUAGES.has(code)) return `${SPEECH_LANGUAGES.find(([id]) => id === code)?.[1] || value} is not supported by Claude speech. Choose a supported language, or this PC's speech recognition.`
}

/** Preserve old call/account choices while removing a redundant dictation override. */
export function migrateSpeechAccounts(settings: Settings, callAccountId?: string, dictationAccountId?: string): SettingsPatch {
  const accountId = callAccountId || dictationAccountId || 'chatgpt-default'
  return { transcription: { accountId }, dictation: { accountId: dictationAccountId && dictationAccountId !== accountId ? dictationAccountId : '' } }
}
