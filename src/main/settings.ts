import type { SettingsPatch } from '@shared/api'
import type { Settings } from '@shared/types'
import { readJson, writeJson } from './storage'
import { validateAIProfile } from '@shared/preferences'
import { MICROPHONE_DEFAULTS } from '@shared/microphone'
import { mergedVoiceAccount, type OldVoiceAccounts } from '@shared/speech'
import { addedAgentsFrom, hiddenAgentsFrom } from '@shared/runner'
import { DEFAULT_THEME, isThemeChoice } from '@shared/theme'
import { holdsByDefault } from './typing-way'

const FILE = 'settings.json'

export const DEFAULT_SETTINGS: Settings = {
  ai: null,
  subscriptionAccountId: '',
  provider: 'chatgpt',
  // Picked by measuring each job on these models: Luna writes fastest and answers simple questions well;
  // 6.1 Sol covered every point on design and debugging questions and read every arrow of a dense diagram,
  // where Luna missed one.
  chatgpt: {
    lanes: {
      quick: { model: 'gpt-6-luna', effort: 'low' },
      deep: { model: 'gpt-6.1-sol', effort: 'medium' },
      vision: { model: 'gpt-6.1-sol', effort: 'low' },
      background: { model: 'gpt-6-luna', effort: 'low' }
    }
  },
  // One model for every job, at the effort each needs: thinking is always on, and low effort keeps it short where
  // words have to come quickly. Caches are per model, and only lanes that share one can share an entry.
  claude: {
    lanes: {
      quick: { model: 'claude-opus-5-5', effort: 'low' },
      deep: { model: 'claude-opus-5-5', effort: 'high' },
      vision: { model: 'claude-opus-5-5', effort: 'low' },
      background: { model: 'claude-opus-5-5', effort: 'low' }
    }
  },
  compat: { baseUrl: 'https://api.openai.com/v1', model: '' },
  // Other people's voices are remembered only when the person turns it on (Settings → Speakers).
  assist: { auto: false, rememberVoices: false, autoNotes: true },
  activeAgentId: '',
  // Calls are heard by this PC (no sign-in includes transcription), which detects the spoken language, unless a speech
  // API is picked for them.
  transcription: { language: 'auto', me: 'local', them: 'local', openaiModel: 'gpt-transcribe', serverUrl: '', serverModel: '' },
  window: { alwaysOnTop: true, opacity: 1, keepOutOfCaptures: false },
  microphone: { ...MICROPHONE_DEFAULTS },
  // Voice typing is heard by this PC too; its account ('' : the AI's own, automatically) cleans up the words.
  dictation: { speech: 'auto', accountId: '', mode: holdsByDefault() ? 'hold' : 'toggle', polish: true, showBar: true, microphoneId: '' },
  // Hubs of agents added by hand (Togle's own comes first anyway). Here so that loading keeps them.
  hubs: [],
  // Shortcuts given other keys (or turned off): here so that loading keeps them.
  hotkeys: {},
  // A task that waits is told in a notice, and one that finished too, until turned off in Settings → Coding agents. A task
  // opens as its agent's own screen (Terminal) until Settings says Chat. The AI set in Accounts sorts the tasks by subject,
  // until that is turned off there too.
  tasks: { notices: true, finished: true, view: 'session', sortBySubject: true },
  // Said once, before the first call is written down.
  meetings: { introSeen: false, confirmNames: true, notice: true, apps: {} },
  // The first minute: once, on a Togle that has never run.
  firstMinute: { done: false },
  // The offer to change keys a code editor uses too: once, the first time it applies.
  keysOffer: { shown: false },
  // Agents added in Settings (Codex, Claude Code and Hermes are found by themselves).
  addedAgents: [],
  // Agents found by themselves that the person removed from Togle's lists.
  hiddenAgents: [],
  // An update that has been checked and downloaded waits for "Restart to update" until the person says it may go in as Togle closes.
  updates: { installOnQuit: false },
  // The window is dark, as the product is drawn, until the person chooses a light one or the system's.
  appearance: { theme: DEFAULT_THEME }
}

let current: Settings = DEFAULT_SETTINGS
let lastWrite: Promise<void> = Promise.resolve()
/**
 * Settings of earlier versions that another app reads from this file, kept in it as they were: the clean microphone's,
 * from before it became Togle Studio, which imports them the first time it runs.
 */
const KEPT_FOR_OTHERS = ['cleanMic'] as const
let kept: Record<string, unknown> = {}
// Saved by a Togle from before the speech model was a choice, when this PC heard every call.
let fromBeforeSpeechChoice = false
// Saved when voice typing's account was two settings (a shared speech account, and voice typing's own over it): what
// they were, for the agents' own choices to carry over too (migrateVoicePreferences). Undefined once carried over.
let oldVoiceAccounts: OldVoiceAccounts | undefined
export const voiceAccountsToMigrate = (): OldVoiceAccounts | undefined => oldVoiceAccounts

/** Whether a value can take a setting's place: of the same kind as its default (any kind, for one it doesn't have). */
const fits = (value: unknown, by: unknown): boolean =>
  by === undefined ||
  (Array.isArray(by)
    ? Array.isArray(value)
    : by !== null && typeof by === 'object'
      ? !!value && typeof value === 'object' && !Array.isArray(value)
      : typeof value === typeof by)

/**
 * Settings with a change applied. Only settings Togle has, each of its own kind: a hand-edited settings.json, or a
 * change sent wrong, can't put a word where a group of settings goes. Groups merge key by key; a list (the hubs) is
 * replaced as a whole.
 */
function merge(base: Settings, patch: SettingsPatch): Settings {
  const next = { ...base } as Record<string, unknown>
  const defaults = DEFAULT_SETTINGS as unknown as Record<string, unknown>
  for (const [key, value] of Object.entries((patch ?? {}) as Record<string, unknown>)) {
    if (key === 'microphone') {
      const config = value as Partial<Settings['microphone']> | null
      if (!config || typeof config !== 'object') continue
      next.microphone = { ...base.microphone, ...Object.fromEntries(Object.entries(config).filter(([name, item]) =>
        (name === 'suggestions' || name === 'autoStart') && typeof item === 'boolean'
        || (name === 'suggestedAt' || name === 'dismissals') && typeof item === 'number' && Number.isFinite(item) && item >= 0)) }
      continue
    }
    if (key === 'ai' && value !== undefined) { next.ai = value === null ? null : validateAIProfile(value); continue }
    if (value === undefined || !Object.hasOwn(defaults, key) || !fits(value, defaults[key])) continue
    const prev = next[key]
    if (prev && typeof prev === 'object' && !Array.isArray(prev) && value && typeof value === 'object' && !Array.isArray(value)) {
      const group = defaults[key] as Record<string, unknown>
      next[key] = { ...prev, ...Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== undefined && fits(v, group[k]))) }
    } else next[key] = value
  }
  // A word that is not one of the themes is the default one.
  const appearance = next.appearance as Settings['appearance']
  if (!isThemeChoice(appearance.theme)) next.appearance = { ...appearance, theme: DEFAULT_THEME }
  // A task opens as its agent's own screen or as cards: any other word is the default.
  const tasks = next.tasks as Settings['tasks']
  if (tasks.view !== 'session' && tasks.view !== 'cards') next.tasks = { ...tasks, view: 'session' }
  // Only agents Togle knows by name can be taken off its lists, each once.
  next.hiddenAgents = hiddenAgentsFrom(next.hiddenAgents)
  // What hears a side of a call is this PC or a speech API. Neither sign-in includes transcription (the ChatGPT plan's
  // isn't part of Sign in with ChatGPT; Claude's speech isn't open to other apps), so a side saved or sent as either,
  // or as anything else, is heard by this PC.
  const t = next.transcription as Settings['transcription']
  const heard = (source: string): Settings['transcription']['me'] => source === 'openai' || source === 'server' ? source : 'local'
  if (heard(t.me) !== t.me || heard(t.them) !== t.them) next.transcription = { ...t, me: heard(t.me), them: heard(t.them) }
  // No account hears calls: the speech account they shared with voice typing is voice typing's own now (loadSettings).
  if ('accountId' in (next.transcription as object)) {
    const { accountId: _moved, ...rest } = next.transcription as Settings['transcription'] & { accountId?: unknown }
    next.transcription = rest
  }
  return next as unknown as Settings
}

export async function loadSettings(): Promise<Settings> {
  const stored = await readJson<SettingsPatch>(FILE, {})
  const raw = stored as Record<string, unknown>
  kept = Object.fromEntries(KEPT_FOR_OTHERS.filter(key => raw[key] !== undefined).map(key => [key, raw[key]]))
  if (stored.ai) try { stored.ai = validateAIProfile(stored.ai) } catch { stored.ai = null }
  current = merge(DEFAULT_SETTINGS, stored)
  // Other people's voices were remembered by default, and are not any more. Settings saved before that (they have no
  // `meetings` part) say yes because it was the default, not because the person chose it: it starts off, and the
  // person can turn it on in Settings → Speakers. Voices already remembered stay until they are forgotten there.
  if (Object.keys(stored).length > 0 && stored.meetings === undefined && current.assist.rememberVoices) current.assist = { ...current.assist, rememberVoices: false }
  // Togle gives no answer or advice during a call that the person did not ask for: suggestions that came by themselves
  // are gone, whatever an older version saved.
  current.assist = { ...current.assist, auto: false }
  // Added agents, each checked: a hand-edited file cannot make Togle start something that is not one.
  current.addedAgents = addedAgentsFrom(current.addedAgents)
  // The first minute is for a Togle that has never run: settings saved before it existed have been through setup.
  if (Object.keys(stored).length > 0 && stored.firstMinute === undefined) current.firstMinute = { done: true }
  // Voice typing's account was two settings: a speech account it shared with calls (which never used it), and its own
  // over it. One now, voice typing's: the account it used.
  const speechAccount = (stored.transcription as { accountId?: unknown } | undefined)?.accountId
  oldVoiceAccounts = undefined
  if (typeof speechAccount === 'string') {
    const voice = typeof stored.dictation?.accountId === 'string' ? stored.dictation.accountId : ''
    oldVoiceAccounts = { voice, speech: speechAccount }
    current.dictation = { ...current.dictation, accountId: mergedVoiceAccount(voice, speechAccount) }
  }
  if (current.dictation.speech === 'local') current.dictation = { ...current.dictation, speech: 'auto' }
  fromBeforeSpeechChoice = Object.keys(stored).length > 0 && stored.transcription?.me === undefined && stored.transcription?.them === undefined
  // Lanes merge one by one, so a lane added in a newer version keeps its default; settings from before
  // lanes existed (one model for everything) start from the lane defaults.
  current.chatgpt = { ...current.chatgpt, lanes: { ...DEFAULT_SETTINGS.chatgpt.lanes, ...stored.chatgpt?.lanes } }
  current.claude = { ...current.claude, lanes: { ...DEFAULT_SETTINGS.claude.lanes, ...stored.claude?.lanes } }
  // Claude used to have a plan sign-in too. It has none now: what was set up on it falls back to ChatGPT's plan, and voice
  // typing that Claude cleaned up goes back to the automatic account. A Claude API key is untouched.
  const claudeSettings = (stored as { claude?: { auth?: unknown } }).claude
  if (current.provider === 'claude' && claudeSettings?.auth === 'subscription') current.provider = 'chatgpt'
  if ((current.dictation.speech as string) === 'claude') current.dictation = { ...current.dictation, speech: 'auto' }
  delete (current.claude as { auth?: unknown }).auth
  delete (current.claude as { subscriptionLanes?: unknown }).subscriptionLanes
  // Drop settings earlier versions had (watchScreen; hideFromScreenShare, which defaulted to off; and window.hideFromCapture, which
  // was on with no switch to turn it off, so that what an earlier Togle saved was its default and not a choice: it is
  // window.keepOutOfCaptures now, off, a switch in Settings; the old word is not a setting any more).
  delete (current.window as { hideFromCapture?: unknown }).hideFromCapture
  for (const key of Object.keys(current)) if (!(key in DEFAULT_SETTINGS)) Reflect.deleteProperty(current, key)
  return current
}

export function getSettings(): Settings {
  return current
}

/** The agents' own voice typing choices are carried over too: saved now, the old two settings are gone from the file. */
export function voiceAccountsMigrated(): Promise<Settings> {
  oldVoiceAccounts = undefined
  return updateSettings({})
}

/** Whether the settings loaded were saved before the speech model was a choice: this PC heard every call then. */
export function savedBeforeSpeechChoice(): boolean {
  return fromBeforeSpeechChoice
}

/** Applies at once (the caller can act on getSettings() right away) and saves in the background. */
export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  current = merge(current, patch)
  // One write at a time, skipping any a newer change makes stale: a slider sends many changes a second.
  const saving = current
  lastWrite = lastWrite.catch(() => undefined).then(() => (saving === current ? writeJson(FILE, { ...kept, ...current }) : undefined))
  return lastWrite.then(() => current)
}
