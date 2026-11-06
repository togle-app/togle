import type { Settings } from './types'

export function dictationSource(settings: Settings, choice = settings.dictation.speech): 'chatgpt' | 'claude' | undefined {
  if (choice === 'chatgpt' || choice === 'claude') return choice
  return settings.provider === 'chatgpt' ? 'chatgpt' : settings.provider === 'claude' && settings.claude.auth === 'subscription' ? 'claude' : undefined
}

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'finishing' | 'polishing' | 'inserting' | 'done' | 'ready' | 'error'
export interface DictationState {
  phase: DictationPhase
  id?: string
  destination?: string
  message?: string
  text?: string
  lastText?: string
  startedAt?: number
  inCall?: boolean
  preparing?: boolean
  hold?: boolean
  streaming?: boolean
  microphoneId?: string
  outcome?: 'inserted' | 'copied'
}
export interface DictationTarget { token?: string; label: string; reason?: string }
export interface DictationInsertion { inserted: boolean; message?: string }

export interface DictationWord { id: string; word: string; heardAs: string }
export interface DictationSnippet { id: string; phrase: string; text: string }
/** Each subscription account has its own device-local vocabulary. No recordings are stored here. */
export interface DictationVocabulary { words: DictationWord[]; snippets: DictationSnippet[] }
export type DictationVocabularyEdit =
  | { kind: 'word'; id?: string; word: string; heardAs: string }
  | { kind: 'snippet'; id?: string; phrase: string; text: string }
  | { kind: 'remove'; id: string }

export interface DictationReceipt {
  id: string
  startedAt: number
  finishedAt: number
  originalText: string
  text: string
  destination: string
  outcome: 'inserted' | 'ready'
  revision: string
  corrected?: boolean
}
export interface DictationHistory { enabled: boolean; entries: DictationReceipt[] }

/** One short, contiguous spelling change. Rewrites and punctuation changes are not learned automatically. */
export function spellingCorrection(before: string, after: string): { heardAs: string; word: string } | undefined {
  const tokens = (value: string): string[] => value.match(/[\p{L}\p{N}\p{M}]+(?:['’\-][\p{L}\p{N}\p{M}]+)*|[^\p{L}\p{N}\p{M}]+/gu) ?? []
  const a = tokens(before), b = tokens(after)
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const heardAs = a.slice(start, endA).join('').trim(), word = b.slice(start, endB).join('').trim()
  const shortPhrase = (value: string): boolean => value.length > 0 && value.length <= 80 && /^[\p{L}\p{N}\p{M}'’\-]+(?: +[\p{L}\p{N}\p{M}'’\-]+){0,2}$/u.test(value)
  if (heardAs === word || !shortPhrase(heardAs) || !shortPhrase(word)) return
  return { heardAs, word }
}
