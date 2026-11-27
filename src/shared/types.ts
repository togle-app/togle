import type { HotkeyId } from './hotkeys'

export type { HotkeyId } from './hotkeys'

export type Speaker = 'me' | 'them'

/**
 * What a piece of audio is: a finished utterance, a live preview of one still in progress, or the utterance
 * so far when the speaker paused (it may be a whole question, so an answer can start right away).
 */
export type SegmentKind = 'final' | 'partial' | 'pause'

export interface TranscriptEntry {
  id: string
  speaker: Speaker
  text: string
  /** When the utterance started and ended (ms since epoch). */
  at: number
  end: number
  /** The audio segment it came from; replaces that segment's live caption. */
  segmentId?: string
  /** A local voice cluster within this call. */
  voiceId?: string
  voiceName?: string
  voiceNamedBy?: 'suggested' | 'user' | 'remembered'
  /** A confirmed person in encrypted, device-local voice memory. */
  voiceIdentityId?: string
}

/** A live caption: what someone is saying right now, before they finish. */
export interface PartialTranscript {
  segmentId: string
  speaker: Speaker
  text: string
  at: number
  voiceId?: string
  voiceName?: string
  voiceNamedBy?: TranscriptEntry['voiceNamedBy']
}

/**
 * A picture of the shared screen in the call timeline. Each frame stays "on screen" until the next one,
 * so every utterance can be matched to what people were looking at while it was said.
 */
export interface Frame {
  id: string
  /** F1, F2…: how prompts and the timeline refer to it. */
  n: number
  at: number
  /** "snapshot" when taken on purpose (hotkey/button), "recorded" when captured on change while recording. */
  kind: 'snapshot' | 'recorded'
  /** togle-frame:// URLs served from the session folder. */
  thumbUrl: string
  imageUrl: string
  /** What the model saw in it (diagram components and arrows, slide content, code…). */
  note?: string
  /** Its description found only people on camera: nothing shared. */
  people?: boolean
  /** Its description found nothing new since the frame before it (no note then). */
  unchanged?: boolean
  /**
   * Recorded for a change where the picture otherwise keeps still (a chat message, typing), not only people moving:
   * it's always described, even when it looks like people seen before.
   */
  content?: boolean
}

/** Where something an agent learned came from (kept in calls an earlier version reviewed). */
export interface LearningSource {
  kind: 'call' | 'user'
  at: number
  callId?: string
  /** Actual correction/approval ids, validated against the source call. */
  feedbackIds?: string[]
}

/**
 * What an earlier version learned from a call, kept in the calls it reviewed: how the agent handles one kind of
 * situation in a call (an objection, a type of question, a phase of the call).
 */
export interface Skill {
  id: string
  /** Short name, e.g. "Pricing objections". */
  name: string
  /** When it applies, in one line: what in the conversation calls for it. */
  when: string
  /** How to handle it: the approach, wording to use or avoid, pitfalls (Markdown). */
  how: string
  /** Earlier call-derived skills without this field are historical reference material. */
  purpose?: 'assistance' | 'reference'
  source?: LearningSource
  revision?: number
  /** Written by hand, told in Train, or learned from a call. */
  origin: 'manual' | 'train' | 'call'
  createdAt: number
  updatedAt: number
  /** How often the moment on a call called for it, and when it last did. */
  uses?: number
  usedAt?: number
}

/** A skill's content before it's saved. */
export type SkillDraft = Pick<Skill, 'name' | 'when' | 'how' | 'purpose' | 'source'>

/** Where a cited fact in an answer came from. `n` matches the [n] marker in the text. */
export interface Source {
  n: number
  doc: string
  section?: string
  url?: string
}

/**
 * What a call belongs to (agent-store.ts): Togle keeps one. An agent saved by an earlier version has more in its file
 * (the call assistant's documents, skills, training), which is not read.
 */
export interface Agent {
  id: string
  name: string
  /** Names and jargon speech recognition should spell right: comma-separated, or one rule a line (speech-words.ts). */
  vocabulary: string
  /** Empty inherits the global account. */
  subscriptionAccountId?: string
  /** Overrides of the general settings an earlier version saved for this agent. Omitted sections inherit them. */
  preferences?: AgentPreferences
  createdAt: number
  updatedAt: number
}

export type AgentPatch = Partial<Pick<Agent, 'name' | 'vocabulary' | 'subscriptionAccountId' | 'preferences'>>

/** What a call taught the agent, for the user to approve in the call review. */
export interface Lessons {
  facts: string[]
  answers: { question: string; answer: string }[]
  /** New skills, or better versions of the agent's own (same name). */
  skills: SkillDraft[]
  /** Facts in memory the call showed have changed: the entry as it reads, and as it should. */
  updates: { from: string; to: string }[]
  /** Facts in memory the call showed are wrong or no longer true. */
  forget: string[]
}

/**
 * An answer approved, or corrected, on a card during a call. It shapes the rest of the call right away; the
 * agent only learns it if it's kept in the call review.
 */
export interface CallAnswer {
  question: string
  answer: string
  /** What Togle had suggested, when the user corrected it. */
  suggested?: string
}

/** What the window keeps of a call besides its timeline: the answer cards, and how far the review went. */
export interface CallView {
  /** The window's answer cards, as it shows them. */
  cards: unknown[]
  /** Lines of the call the review has gone through. */
  reviewedLines: number
  /** Which call it is, as the agent's conversation knows it: the same call after Togle starts again. */
  key?: string
}

export interface CallSessionInfo {
  id: string
  agentId: string
  agentName: string
  startedAt: number
  endedAt?: number
  status: 'live' | 'ended' | 'interrupted'
  /** The subscription pinned when the call started. Older calls may not have one. */
  accountId?: string
  /** Speech may use a different subscription from the agent's answer model. */
  speechLanguage?: string
  ai?: AIProfile
  speechSettings?: Settings['transcription']
  /** Calendar identity is pinned to this call, including resumed stretches. */
  meeting?: { id: string; title: string; start: number; end: number }
}

export interface SessionSuggestion {
  id: string
  kind: AssistKind
  question: string
  text: string
  deep?: string
  at: number
}

export interface SessionLearning {
  state: 'not-reviewed' | 'reviewing' | 'reviewed' | 'error'
  reviewId?: string
  reviewedAt?: number
  sourceLines?: number
  sourceKey?: string
  pending: Lessons
  changes: { id: string; text: string }[]
  error?: string
}

export interface CallSession extends CallSessionInfo {
  version: 1
  updatedAt: number
  title: string
  customTitle?: boolean
  titleSource?: 'calendar' | 'brief' | 'generated' | 'legacy' | 'fallback'
  /** Last background naming input, including a failed attempt, to avoid repeated requests. */
  titleKey?: string
  /** Transient naming failures can retry on a later history visit after this time. */
  titleRetryAt?: number
  frameSession: string
  brief: string
  group: boolean
  transcript: TranscriptEntry[]
  suggestions: SessionSuggestion[]
  notes: string
  callAnswers: CallAnswer[]
  summary: string
  personalNotes?: string
  minutes?: CallMinutes
  learning: SessionLearning
  /** When the person said they had told the others on the call that it was being written down (absent: they did not). */
  toldOthers?: number
  /** The moments the person marked during the call, on the call's clock like the transcript's `at`. */
  marks?: number[]
  /** The voices to ask about after the call, while the short sound clips kept for it last. */
  confirm?: import('./confirm-names').CallConfirm
  /** Older versions saved summaries only. Keep them inspectable without inventing a transcript. */
  legacy?: { agentId: string; id: string }
}

export type MeetingNoteTemplate = 'concise' | 'detailed' | 'action-items'
export interface CallMinutes {
  state: 'idle' | 'generating' | 'ready' | 'error'
  template: MeetingNoteTemplate
  revision: string
  /** Account or connection explicitly chosen to update these notes after the original became unavailable. */
  sourceId?: string
  sourceKey?: string
  edited?: boolean
  generatedAt?: number
  /** What wrote them: the ChatGPT plan (`chatgpt`), a key (`compat`) or Claude (`claude`). */
  by?: string
  error?: string
}

/** A call that has the words searched for, with the first few lines that do. */
export interface CallSearchHit {
  id: string
  title: string
  startedAt: number
  /** Lines of the transcript that have the words, in the order said. Empty when only the notes or title do. */
  lines: { at: number; who: string; text: string }[]
}

export type CallSessionSummary = Omit<CallSession, 'transcript' | 'suggestions' | 'notes' | 'personalNotes' | 'callAnswers' | 'learning'> & {
  lines: number
  replies: number
  learningState: SessionLearning['state']
  pendingLessons: number
  learned: number
}

/** The call so far, for a window that opens (or reopens) on it. */
export interface CurrentCall {
  session?: CallSessionInfo
  /** The call's key: its record in Meetings once it is saved. */
  key: string
  transcript: TranscriptEntry[]
  /** When the person said they had told the others the call is written down (0: not yet). */
  toldOthers?: number
  /** The moments marked so far, on the call's clock. */
  marks?: number[]
  /** Set when the call was picked up from disk as Togle started: when it was last saved. */
  restoredFrom?: number
}

export type ProviderId = 'chatgpt' | 'claude' | 'compat'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

/** Reasoning efforts from weakest to strongest. */
export const EFFORT_ORDER: ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/**
 * The jobs Togle gives a model, each with its own speed/quality trade-off: the "say this now" answer,
 * the deep answer to hard questions and code, describing screen pictures, and background work
 * (studying documents, Teach).
 */
export type Lane = 'quick' | 'deep' | 'vision' | 'background'

export interface TaskModel extends LaneModel { sourceId: string }
export interface AIProfile {
  version?: string
  tasks: Record<Lane, TaskModel>
}
export interface AgentPreferences {
  ai?: AIProfile
  transcription?: Partial<Settings['transcription']>
  dictation?: Partial<Settings['dictation']>
}
export interface ApiConnection {
  id: string
  kind: 'anthropic' | 'compatible' | 'local'
  label: string
  baseUrl: string
  model: string
  hasKey: boolean
  /** Changes when connection settings or credentials change; no credential information. */
  revision: number
  legacy?: boolean
}
export type ApiConnectionInput = Pick<ApiConnection, 'kind' | 'label' | 'baseUrl' | 'model'> & { key?: string }

export interface LaneModel {
  model: string
  effort: ReasoningEffort
  /** The model's Fast service tier, where the plan offers one: faster writing, for some models more usage. */
  fast?: boolean
}

/** Below this the window is too faint to read (and too easy to lose). */
export const MIN_OPACITY = 0.3

/** How the Togle window floats over the call. */
export interface WindowSettings {
  /** Stays above other windows: the call, the editor. */
  alwaysOnTop: boolean
  /** MIN_OPACITY to 1; lower lets the call show through. */
  opacity: number
  /**
   * Asks the system to leave Togle's window out of screenshots, screen sharing and recordings, so that only the person at this PC sees it.
   * Off unless the person turns it on in Settings: a screenshot taken of Togle (a report of what is wrong) showed a hole where it is. The voice
   * bar, the notices and the call strip are always left out.
   */
  keepOutOfCaptures: boolean
}

export interface Settings {
  /** Explicit account/model for each job. Null keeps older single-provider settings. */
  ai?: AIProfile | null
  subscriptionAccountId: string
  provider: ProviderId
  chatgpt: {
    lanes: Record<Lane, LaneModel>
    /** Near the plan's limit (SAVE_AT), every job uses the quick answers' model, so what's left lasts. On unless turned off. */
    saveNearLimit?: boolean
    /** "You're using your ChatGPT plan" was shown, after the first sign-in. */
    planIntroSeen?: boolean
  }
  /** Claude through an Anthropic API key. There is no Claude sign-in: Togle never offers one. */
  claude: {
    lanes: Record<Lane, LaneModel>
    /** Deep answers may search the web (a few searches each, billed by Anthropic). On unless turned off. */
    webSearch?: boolean
  }
  /** Any OpenAI-compatible Chat Completions endpoint: OpenAI API, OpenRouter, Anthropic, Ollama, LM Studio... */
  compat: {
    baseUrl: string
    model: string
  }
  assist: {
    /** Suggest automatically when the other side asks something, or only on demand. */
    auto: boolean
    /** The user's name as people say it in calls, a few comma-separated ("Luka, Luke"): in group calls,
     * questions to them by name get suggestions and questions to others by name don't. */
    names?: string
    /** Local speaker matching, independent of the transcription provider. On unless disabled. */
    voiceLabels?: boolean
    rememberVoices?: boolean
    /** Legacy free-form notes; migrated into the first agent's "About me". */
    context?: string
    /** A summary of each reviewed call is kept (encrypted on this PC) and recalled on later calls with the same people. On unless turned off. */
    rememberCalls?: boolean
    autoNotes?: boolean
  }
  /** The agent used for the current call. */
  activeAgentId: string
  /** Hubs of agents to browse and install from (GitHub repositories: "owner/repo"), besides Togle's own. */
  hubs?: string[]
  /** Calls are heard by this PC's own models, and nowhere else: the sound of a call never leaves the computer. */
  transcription: {
    /** Whisper language code, or "auto". */
    language: string
  }
  window: WindowSettings
  /** Local outgoing audio for other call apps, independent of transcription and F9. */
  microphone: import('./microphone').MicrophoneSettings
  /**
   * Dictation is independent of the call and never falls back to a paid API key. `accountId` is the subscription
   * account that cleans up what's dictated and keeps its word list and history ('': the AI's account, see
   * automaticVoiceAccount); this computer hears the speech either way.
   */
  dictation: { speech: 'auto' | 'local' | 'chatgpt'; accountId: string; mode: 'hold' | 'toggle'; polish: boolean; showBar: boolean; microphoneId: string }
  /** Shortcuts given other keys than their own (empty: turned off); the others keep theirs. */
  hotkeys: Partial<Record<HotkeyId, string>>
  /** The coding agents' tasks. */
  tasks: {
    /** A small notice in the corner of the screen when a task waits for you and Togle is not in front. */
    notices: boolean
    /** One as well when a task finishes or stops with an error. */
    finished: boolean
    /** Include the task name and an excerpt of its outcome or request in new Windows notifications. */
    notificationPreviews: boolean
    /** Which view a task opens in (a switch in its header changes it for that task): its agent's own screen, or the cards and a reply box. */
    view: 'session' | 'cards'
    /**
     * Whether the AI set in Accounts sorts the tasks of a project, and of Everyday, under subjects. It reads the names of the
     * tasks, the start of what was asked in each, and the names of their folders: on until the person turns it off.
     */
    sortBySubject: boolean
  }
  /** Writing calls down. */
  meetings: {
    /** The first-call notice (rules differ by place, where the words and the sound go) was shown and understood. */
    introSeen: boolean
    /** Keep one short clip of each voice for a day, so the person can hear who spoke when they confirm the names. */
    confirmNames: boolean
    /** Say when a call starts in Zoom, Teams, Webex, Skype or Slack (Windows). */
    notice: boolean
    /** What to do when a call starts in each of those apps: ask (the default), write it down at once, or leave it. */
    apps: Partial<Record<import('./call-apps').CallApp, import('./call-apps').CallAppMode>>
  }
  /** The person has opened or dismissed the first-launch task offer. */
  firstMinute: { done: boolean }
  /** The offer to change Togle's keys, made once: the first time one is pressed while a code editor that uses it is in front. */
  keysOffer: { shown: boolean; key: string; editor: string }
  /** Agents the person added in Settings: any that speaks ACP, by the command that starts it. */
  addedAgents: import('./runner').AddedAgent[]
  /** Agents Togle finds by itself that the person took off its lists (Settings → Agents → Remove). They stay installed. */
  hiddenAgents: string[]
  /** How the window looks (Settings → Appearance): a light one, a dark one (the default), or the system's. */
  appearance: { theme: import('./theme').ThemeChoice }
  /** How Togle's own updates go in (Settings → Updates). Every one is checked against the release key first, whatever this says. */
  updates: {
    /**
     * A signed update that has been downloaded goes in as Togle closes, when the person quits it: not by itself, not at a
     * shutdown, and Togle is not opened again after it. Off (the default): it waits for "Restart to update".
     */
    installOnQuit: boolean
  }
}

export interface AuthStatus {
  signedIn: boolean
  signingIn?: boolean
  email?: string
  name?: string
  plan?: string
  /** Set while a device-code sign-in is waiting for the user. */
  pending?: { verificationUrl: string; userCode: string }
  error?: string
}

/** One of the ChatGPT plan's usage limits: how much of it is used, in a window that starts over (5 hours, a week). */
export interface PlanWindow {
  usedPercent: number
  minutes: number
  /** When it starts over (epoch ms). */
  resetsAt?: number
}

/** The ChatGPT plan's usage, as the backend last said: every answer brings it, and Togle asks now and then. */
export interface PlanUsage {
  /** Shortest window first. */
  windows: PlanWindow[]
  /** The backend turns requests down until then (epoch ms): a limit is reached. */
  limitedUntil?: number
  /** Since when it does (epoch ms): the same reached limit, however its end is estimated again. */
  limitedSince?: number
  /** Near the limit: the model (its name) that every job uses meanwhile, to make the rest last. */
  saving?: string
  /** The current (or last) call's share so far of the window closest to its limit, in percentage points. */
  call?: number
}

export interface ModelOption {
  id: string
  label: string
  description?: string
  reasoningLevels?: ReasoningEffort[]
  defaultReasoning?: ReasoningEffort
  /** How the plan describes the model's Fast tier ("2x speed, increased usage"), when it has one. */
  fast?: string
}

/** Public account metadata only. Tokens and account directories never cross the IPC bridge. */
export interface SubscriptionAccount {
  id: string
  provider: 'chatgpt'
  label: string
  shared?: boolean
  signedIn: boolean
  email?: string
  name?: string
  plan?: string
  signingIn?: boolean
  url?: string
  pending?: AuthStatus['pending']
  error?: string
}

/** The models Togle can install to hear on this PC (Whisper base only for installs from before Whisper small). */
export type LocalModelId = 'parakeet' | 'whisper-turbo' | 'whisper-small' | 'whisper-base'

/** Speech recognition on this PC, for Settings: what's installed, what installing it would download, and an install under way. */
export interface LocalSpeechState {
  /** The models installed (empty: none yet). */
  installed: LocalModelId[]
  /** Set up for development instead (npm run setup:whisper): nothing to install. */
  dev: boolean
  /**
   * What installing downloads here: whisper.cpp for this system (0 when it's there, or on this PC already) and each
   * model, in bytes, with the ones that suit this PC (`here`: the same file is on this PC already, to take from there);
   * null where whisper.cpp has no build.
   */
  offer: { gpu: boolean; engine: number; models: { id: LocalModelId; label: string; bytes: number; recommended: boolean; here?: boolean }[] } | null
  /** An install under way: what it's fetching (`here`: taking from this PC), and the bytes so far of all it fetches. */
  installing?: { what: string; received: number; total: number; here?: boolean }
  /** Why the last install stopped. */
  error?: string
}

export type SttState = 'missing' | 'starting' | 'ready' | 'error'

export interface SttStatus {
  callId?: string
  state: SttState
  detail?: string
  transcriptionLanguage?: string
}

export type AssistKind = 'suggest' | 'ask' | 'summary'

/** 'start-call-unseen': the call shortcut while Togle's window is hidden or minimized (no picker it couldn't show). */
export type HotkeyAction = 'toggle-listening' | 'start-call-unseen' | 'stop-call' | 'toggle-recording' | 'snapshot' | 'ask' | 'copy' | 'dictation-settings' | 'speech-settings' | 'keys-settings'

/** One of Togle's keys was pressed in a code editor that uses it too: the key ("F9") and the editor ("VS Code"). */
export interface KeysOffer {
  key: string
  editor: string
}

/** A shortcut that works from any app (see shared/hotkeys.ts). */
export interface HotkeyInfo {
  id: HotkeyId
  /** As Electron writes them ("Ctrl+Alt+Space"); empty when it's turned off. */
  keys: string
  /** What it is until it's changed (empty: off until it's given keys). */
  defaultKeys: string
  label: string
  /** False when another app already owns the combination. */
  ok: boolean
}
