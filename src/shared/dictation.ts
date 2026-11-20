import type { Settings } from './types'

/** The plan that cleans up voice typing, when there is one: ChatGPT's. A key, or nothing, is not a plan. */
export function dictationSource(settings: Settings, choice = settings.dictation.speech): 'chatgpt' | undefined {
  if (choice === 'chatgpt') return choice
  return settings.provider === 'chatgpt' ? 'chatgpt' : undefined
}

/** A subscription account, as voice typing chooses among them. */
export interface VoiceAccountOption { id: string; provider: 'chatgpt'; signedIn?: boolean }

/**
 * The subscription account voice typing uses when it's left automatic (dictation.accountId ''): the AI's own account
 * when the AI runs on a subscription (the first job's that does, with a profile of jobs); otherwise one that's signed
 * in, else ChatGPT's. It cleans up the words and keeps the word list and history; this computer hears the speech.
 */
export function automaticVoiceAccount(settings: Settings, accounts: VoiceAccountOption[]): string {
  const known = (id?: string): VoiceAccountOption | undefined => (id ? accounts.find(account => account.id === id) : undefined)
  const source = dictationSource(settings)
  if (source) {
    if (settings.ai) {
      for (const lane of ['deep', 'background', 'vision', 'quick'] as const) {
        const account = known(settings.ai.tasks[lane].sourceId)
        if (account?.provider === source) return account.id
      }
    }
    const chosen = known(settings.subscriptionAccountId)
    return chosen?.provider === source ? chosen.id : `${source}-default`
  }
  return accounts.find(account => account.signedIn)?.id ?? 'chatgpt-default'
}

/** The account voice typing uses: the one picked for it, or the automatic one. */
export const voiceAccountId = (settings: Settings, accounts: VoiceAccountOption[]): string =>
  settings.dictation.accountId || automaticVoiceAccount(settings, accounts)

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'finishing' | 'polishing' | 'inserting' | 'done' | 'ready' | 'error'
export interface DictationState {
  phase: DictationPhase
  id?: string
  destination?: string
  message?: string
  text?: string
  lastText?: string
  /** The saved F8 screenshot held in the voice bar until copied again or dismissed. */
  picture?: string
  show?: boolean
  /** The compact bar has finished acknowledging a copy. Opening it still shows the held result. */
  waitingForPaste?: boolean
  startedAt?: number
  inCall?: boolean
  preparing?: boolean
  hold?: boolean
  streaming?: boolean
  microphoneId?: string
  outcome?: 'inserted' | 'copied'
}
/**
 * Done, with more to say than one line of the open voice bar holds (why the words were copied and not typed): the bar is
 * taller for it. Its page and the main process, which follows the pointer over it, both go by this.
 */
export const longDoneMessage = (state: Pick<DictationState, 'phase' | 'message'>): boolean => state.phase === 'done' && (state.message?.length ?? 0) > 34
/** The box dictation noted: its token for typing into it, its name, and (on Windows) its window, to put it in front again. */
/**
 * The box a dictation goes into. `copy`: Togle cannot type into it, so the words are copied, and `copyReason` says why
 * (without it: a window that runs as administrator); `terminal`: that window is a terminal, so they are copied as one line.
 */
export interface DictationTarget { token?: string; label: string; reason?: string; windowHandle?: string; copy?: boolean; copyReason?: string; terminal?: boolean }
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
