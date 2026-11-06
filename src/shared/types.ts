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

/** Something the recorder can follow: a whole screen or one window (e.g. the Zoom window). */
export interface CaptureSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbUrl?: string
}

/** Screen access is granted for one selected source during one call; it is never restored automatically. */
export interface ScreenTimeRequest {
  mode: 'frame' | 'range' | 'live'
  /** Epoch milliseconds on the same call clock as TranscriptEntry.at/end. A frame uses from === to. */
  from: number
  to: number
}

export interface ScreenReference {
  id: string
  speaker: Speaker
  text: string
  from: number
  to: number
}

export interface ScreenLookEvidence {
  requested: ScreenTimeRequest
  /** Actual sample times, retained even when identical image bytes are sent just once. */
  capturedAt: number[]
  availableSamples?: number
  gaps: { from: number; to: number }[]
  unavailable?: string
}

export interface ScreenMonitorStatus {
  state: 'off' | 'watching' | 'reading' | 'paused'
  id?: string
  source?: CaptureSource
  ready: boolean
  reads: number
  imagesSent: number
  lastReadAt?: number
  lastQuestion?: string
  availableFrom?: number
  availableTo?: number
  sampleIntervalMs?: number
  lastReference?: ScreenReference
  lastLook?: ScreenLookEvidence
  error?: string
}

/** A screen to take a picture of, for picking one when there are several. */
export interface ScreenOption {
  /** Electron's display id. */
  id: number
  /** As the recorder's list names it: "Screen 1", "Screen 2"… */
  name: string
  /** The main display in Windows' settings. */
  primary: boolean
  /** Togle's window is on it. */
  togle: boolean
  /** A small picture of what's on it now (data: URL). */
  thumbUrl?: string
}

/** Where a document came from: a file, text they pasted, a web page, or a work session with an AI agent (Claude Code, Codex). */
export type KnowledgeKind = 'file' | 'text' | 'web' | 'session'

export interface KnowledgeDoc {
  id: string
  name: string
  kind: KnowledgeKind
  /** File path or URL it was learned from. */
  source?: string
  chars: number
  addedAt: number
  /** "studying" while the agent distills it; it can already be searched meanwhile. */
  status: 'studying' | 'ready'
  /** Key facts the agent distilled from it (large knowledge bases, and every work session: where the work stands). */
  digest?: string
  /** Why studying failed; the document still works through search. */
  error?: string
  /** A work session's file as it was read (its size and time): read again before a call once it changed. */
  stamp?: string
  /** A work session read again since it was studied: `digest` is of what it said then, kept until it's studied again. */
  restudy?: boolean
  /**
   * The name a work session went in under, its tool's title, before it was named by what it's about once studied: the
   * lines that said it went in still find it by that.
   */
  addedAs?: string
}

/**
 * A work session with an AI agent on this PC, or a chat of theirs on claude.ai or ChatGPT (from their export of it),
 * to add to an agent's documents (see sessions.ts, chat-exports.ts).
 */
export interface WorkSessionInfo {
  id: string
  tool: 'claude-code' | 'codex' | 'claude-ai' | 'chatgpt'
  title: string
  /** They named it themselves (Claude Code's /rename): that name stays, where others give way to what it's about. */
  named?: boolean
  /** The folder it worked in. */
  cwd?: string
  branch?: string
  startedAt: number
  updatedAt: number
  bytes: number
  /** Its file; a chat on claude.ai or ChatGPT is known by its address there (https://chatgpt.com/c/…). */
  file: string
  /** What was asked first, and last. */
  first?: string
  last?: string
  /** Which of their Claude Code and Codex it's from, by name (SessionHome.name), when known. */
  home?: string
}

/**
 * Where Claude Code or Codex keeps its sessions on this PC: its folder, one for each account it's used with
 * (~/.claude, ~/.claude-work by CLAUDE_CONFIG_DIR; ~/.codex by CODEX_HOME). An account on claude.ai or ChatGPT is
 * one too, by its id ("chatgpt://user-…"), with its chats read from their export. An agent's own ones are where its
 * work sessions come from.
 */
export interface SessionHome {
  tool: WorkSessionInfo['tool']
  dir: string
  /** As it's shown and said: "Claude Code (work)", or just "Claude Code" when it's the only one. */
  name: string
  /** For an account on claude.ai or ChatGPT: the export its chats are read from. */
  from?: string
}

/** An export of their chats on claude.ai or ChatGPT they gave Togle (dropped in, picked): what it holds. */
export interface GivenExport {
  /** The account it's of, as it's shown: "ChatGPT", or "ChatGPT (me@acme.com)" beside another one's. */
  home: string
  chats: number
  /** When its newest chat was last written in. */
  newest: number
  /** A newer export of that account is read instead (one in Downloads): when it was made. */
  newer?: number
}

/** "When asked X, answer Y": the strongest way to train an agent. */
export interface ApprovedAnswer {
  id: string
  question: string
  answer: string
  origin: 'manual' | 'test' | 'call' | 'train'
  addedAt: number
  /** How often a call has shown it, and when it last did (as Hermes Agent counts its skills' use). */
  uses?: number
  usedAt?: number
}

/**
 * How the agent handles one kind of situation in a call (an objection, a type of question, a phase of the
 * call): its procedural memory. Approved answers hold exact answers and memory holds facts; a skill holds
 * the approach.
 */
export interface LearningSource {
  kind: 'call' | 'user'
  at: number
  callId?: string
  /** Actual correction/approval ids, validated against the source call. */
  feedbackIds?: string[]
}

export interface AssistanceContext {
  facts: { text: string; source?: LearningSource }[]
  skills: { id: string; name: string; revision: number }[]
  references: { id: string; name: string; revision: number }[]
}

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

/** Skills are read mid-call, so they stay short enough to glance at. */
export const SKILL_LIMITS = { name: 80, when: 300, how: 3000 } as const

/**
 * Live answers include this many characters of relevant facts. This limits prompt size, not saved memory;
 * approving a lesson must never require deleting another fact to make room.
 */
export const MEMORY_LIMIT = 4000
/** The longest a fact in memory may be: one short fact (under 25 words), not a passage. */
export const FACT_LIMIT = 300

/** Where a cited fact in an answer came from. `n` matches the [n] marker in the text. */
export interface Source {
  n: number
  doc: string
  section?: string
  url?: string
}

/** A specialist the user picks per call: its role, what it knows, and what it has learned. */
export interface Agent {
  id: string
  name: string
  description: string
  /** Role, goals and style for this kind of call. */
  instructions: string
  /** Facts about the user that matter for this kind of call. */
  aboutMe: string
  /** Facts learned from past calls (approved by the user) or added by hand. */
  memory: string[]
  /** Provenance of each exact fact. Missing entries are legacy context with an unrecorded source. */
  factSources?: Record<string, LearningSource>
  knowledge: KnowledgeDoc[]
  answers: ApprovedAnswer[]
  skills: Skill[]
  /** Model for this agent's chat and detailed answers; empty inherits its provider's deep task model. */
  model: string
  /** Names and jargon speech recognition should spell right (comma-separated); terms from knowledge are added automatically. */
  vocabulary: string
  /** Project folders on this PC that deep answers can search and read (read-only). */
  codeFolders: string[]
  /** Its own Claude Code and Codex, where its work sessions are looked for; none: all of them on this PC. */
  workHomes: SessionHome[]
  /** Connected Claude apps this agent may read, bound to the account that selected them. */
  claudeConnections?: ClaudeConnectionSelection
  /** Empty inherits the global account. A local account id; never included in shared agent packages. */
  subscriptionAccountId?: string
  /** Device-local overrides. Omitted sections inherit general settings. Never shared in agent packages. */
  preferences?: AgentPreferences
  /** Reminders belong to this agent and an explicitly selected Claude account. */
  calendar?: { enabled: boolean; accountId: string; accountEmail?: string }
  /** What the review at the end of a call does with what it finds (see CallLearning). */
  learning: CallLearning
  /** Every change to its training, oldest first, with what it was before: what it learned, and how to undo it. */
  history: TrainingChange[]
  /** When it last tidied up its training (merged overlapping skills, duplicate answers, related facts). */
  tidiedAt?: number
  /** Installed from someone else's package (a file or a hub), not made here. */
  source?: AgentSource
  createdAt: number
  updatedAt: number
}

export interface ClaudeConnectionSelection {
  account: string
  servers: string[]
}

export interface ClaudeConnections {
  account: string
  apps: { name: string; label: string; status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'; readTools: number }[]
}

/** Where an agent installed from someone else came from (agents/package.ts), to show and to check for updates. */
export interface AgentSource {
  /** A .togle file, or a hub (a GitHub repository of agents). */
  from: 'file' | 'hub'
  /** The file's name, or "owner/repo/agents/slug". */
  ref: string
  author?: string
  version?: string
  /** Of the package's files as installed. */
  hash: string
  installedAt: number
}

/** Something an agent to install says that blocks it (danger) or is worth a look first (caution). */
export interface GuardFinding {
  level: 'danger' | 'caution'
  /** Where it says it: "Instructions", "Skill “Pricing”", "Document “FAQ”". */
  where: string
  /** In words: "asks for passwords, codes or payment details". */
  what: string
  excerpt: string
}

/** An agent package read for installing, shown before it is: everything it adds, and what the check found. */
export interface AgentPreview {
  /** To install it with (agents:install); the package itself stays in the main process. */
  id: string
  name: string
  description: string
  author?: string
  version?: string
  instructions: string
  vocabulary: string
  skills: SkillDraft[]
  answers: { question: string; answer: string }[]
  memory: string[]
  /** Its documents, each with how long it is and how it starts. */
  docs: { name: string; chars: number; excerpt: string }[]
  /** Requests of my plan studying its documents takes once it's installed (none when they fit into each request). */
  studies: number
  findings: GuardFinding[]
  /** An agent of mine installed from this same version already: to talk to it, rather than install a second. */
  installedAs?: { id: string; name: string }
  /** Where it comes from, as shown: a file's name, or a hub and the agent's folder in it. */
  from: string
  /** Official: from the hub Togle ships with; community: anyone's. */
  trust: 'official' | 'community'
  /** What wasn't installed as it was (cut to Togle's limits, a file it couldn't read). */
  notes: string[]
}

/** A hub's agents, as browsing shows them (or why they couldn't be read). */
export interface HubListing {
  /** "owner/repo", or "togle": the agents that come with Togle. */
  hub: string
  /** Togle's own hub. */
  official: boolean
  entries: { slug: string; name: string; description: string; author?: string; version?: string; tags: string[]; skills: number; answers: number }[]
  error?: string
}

/** What sharing an agent carries besides its setup, skills, approved answers and words to recognize. */
export interface ShareChoice {
  /** Memory facts to include, as written; none unless ticked. */
  memory: string[]
  /** Documents to include, by id; none unless ticked. */
  docs: string[]
  /** Shown with it as its author. */
  author?: string
}

/**
 * What the review at the end of a call does: keeps its finds on its own and lists them with Undo (the default, the way
 * Hermes Agent learns), asks which of them to keep, or doesn't run (Learn from call still reviews on demand).
 */
export type CallLearning = 'ask' | 'auto' | 'off'

/** The setup fields a change to the training can be in. */
export type SetupField = 'name' | 'description' | 'instructions' | 'aboutMe' | 'vocabulary'

/** One change to an agent's training: what, where it came from, and the item before and after it. */
export interface TrainingChange {
  id: string
  at: number
  /** The Train chat, a call review you approved, one kept on its own, an edit by hand, or tidying up. */
  origin: 'train' | 'call' | 'auto' | 'manual' | 'tidy'
  /** In a line, as Train says it: "Added skill: Pricing objections", "Forgot: …". */
  text: string
  /** The item as it was and as the change left it: no `before` when it was added, no `after` when removed. */
  change:
    | { kind: 'skill'; before?: Skill; after?: Skill }
    | { kind: 'answer'; before?: ApprovedAnswer; after?: ApprovedAnswer }
    | { kind: 'fact'; before?: string; after?: string; beforeSource?: LearningSource; afterSource?: LearningSource }
    | { kind: 'field'; field: SetupField; before: string; after: string }
    | { kind: 'homes'; before: SessionHome[]; after: SessionHome[] }
  /** Undone since: it stays in the history, marked. */
  undone?: boolean
}

export type AgentPatch = Partial<
  Pick<
    Agent,
    'name' | 'description' | 'instructions' | 'aboutMe' | 'memory' | 'answers' | 'skills' | 'model' | 'vocabulary' | 'codeFolders' | 'workHomes' | 'learning' | 'claudeConnections' | 'subscriptionAccountId' | 'preferences' | 'calendar'
  >
>

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
 * What the call review proposes, for the agent it reviewed the call for: kept, it goes to that one. When the agent
 * learns on its own, these lessons are kept at once; `check` waits for a yes either way.
 */
export interface CallReview extends Lessons {
  /** A concise topic label, produced with the existing call review. */
  title?: string
  /** A durable review was already applied or staged by the main process. */
  session?: CallSession
  agent?: Agent
  agentId: string
  /** What changes what it knows, or says an amount or a deal heard on the call (agents/trust.ts): kept only when I say. */
  check?: Lessons
  /** The call itself, to recall on later calls (Hermes Agent's searchable past sessions), when it found one to keep. */
  record?: PastCallDraft
  /** The call taught me about my product or work (a training, a walkthrough): its notes can be kept as a document. */
  lesson?: { id: string; title: string }
}

/**
 * A call as Togle keeps it once it's over (when summaries of past calls are on): enough to pick up where it left off
 * on the next call with the same people, without keeping what was said word for word. Encrypted on this PC.
 */
export interface PastCall {
  id: string
  agentId: string
  title?: string
  /** The call it's of (its pictures' session): reviewing the same call again updates it. */
  callId?: string
  /** Its first and last line. */
  at: number
  endedAt: number
  brief: string
  /** Who it was with, as the review named them: their company, the people by full name. What finds it again. */
  with: string[]
  /** Who it was with, what they wanted, what was decided and promised. */
  summary: string
  /** Facts about them (their company, people, plans), kept with the call rather than in the memory every call reads. */
  about: string[]
  /** What they asked, and what I answered. */
  asked: { question: string; answer: string }[]
}

export type PastCallDraft = Omit<PastCall, 'id' | 'agentId'>

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
  speechAccountId?: string
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
  /** Older versions saved summaries only. Keep them inspectable without inventing a transcript. */
  legacy?: { agentId: string; id: string }
}

export type MeetingNoteTemplate = 'concise' | 'detailed' | 'action-items'
export interface CallMinutes {
  state: 'idle' | 'generating' | 'ready' | 'error'
  template: MeetingNoteTemplate
  revision: string
  sourceKey?: string
  edited?: boolean
  generatedAt?: number
  error?: string
}

export type CallSessionSummary = Omit<CallSession, 'transcript' | 'suggestions' | 'notes' | 'personalNotes' | 'callAnswers' | 'learning'> & {
  lines: number
  replies: number
  learningState: SessionLearning['state']
  pendingLessons: number
  learned: number
}

export interface CallLearningResult {
  session: CallSession
  agent: Agent
}

/** The call so far, for a window that opens (or reopens) on it. */
export interface CurrentCall {
  session?: CallSessionInfo
  transcript: TranscriptEntry[]
  frames: Frame[]
  view?: CallView
  /** Answers approved or corrected on cards that no review has offered yet. */
  unreviewedAnswers: number
  /** What the call is, in the user's words. */
  brief: string
  /** A call with several people: suggestions only when the user is the one asked. */
  group: boolean
  /** Set when the call was picked up from disk as Togle started: when it was last saved. */
  restoredFrom?: number
  /** The parts of its cards still being answered ("<card id>:main", "<card id>:deep"). */
  answering: string[]
  /** The earlier calls with the same people its answers draw on. */
  recalled: PastCall[]
}

/** One message of a Train conversation. */
export interface TrainTurn {
  role: 'user' | 'assistant'
  text: string
}

export interface CallChatContext { id: string; title: string }

/** A Train reply as it streams (`id` names the turn): its text, and each change it made to the agent. */
export type TrainEvent =
  | { type: 'delta'; id: string; text: string }
  /** A change the agent made to itself, in a line ("Added skill: Pricing objections"). */
  | { type: 'change'; id: string; text: string }
  | { type: 'done'; id: string }
  | { type: 'error'; id: string; message: string }

export interface AgentTemplate {
  id: string
  name: string
  description: string
  instructions: string
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
export type AIPreset = 'claude' | 'codex' | 'mixed'
export interface AIProfile {
  preset?: AIPreset
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
  /** Leaves Togle out of screenshots, screen sharing and recordings, so only the person at this PC sees it. */
  hideFromCapture: boolean
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
  /** Claude through an API key or the official Agent SDK with a subscription sign-in. */
  claude: {
    auth: 'api-key' | 'subscription'
    lanes: Record<Lane, LaneModel>
    /** The SDK's model aliases are kept apart from the API's model IDs. */
    subscriptionLanes: Record<Lane, LaneModel>
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
    /** Calendar reminders use the signed-in Claude account's calendar connector. */
    calendarReminders?: boolean
    calendarAgentId?: string
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
  transcription: {
    /** Shared subscription for meeting transcription and voice typing without an override. */
    accountId?: string
    /** Whisper language code, or "auto". */
    language: string
    /** What hears my voice (the microphone). */
    me: Recognizer
    /** What hears the others (the call's sound). */
    them: Recognizer
    /** OpenAI's speech model, for a side OpenAI hears. Its API key is kept apart, encrypted. */
    openaiModel: string
    /** The address of a server with OpenAI's speech API (".../v1"), for a side it hears, and its model (some servers
     * take any). A key, if it needs one, is kept apart, encrypted. */
    serverUrl: string
    serverModel: string
  }
  window: WindowSettings
  /** Local outgoing audio for other call apps, independent of transcription and F9. */
  microphone: import('./microphone').MicrophoneSettings
  /** Dictation is independent of the call and never falls back to a paid API key. */
  dictation: { speech: 'auto' | 'local' | 'chatgpt' | 'claude'; accountId: string; mode: 'hold' | 'toggle'; polish: boolean; showBar: boolean; microphoneId: string }
  /** Shortcuts given other keys than their own (empty: turned off); the others keep theirs. */
  hotkeys: Partial<Record<HotkeyId, string>>
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

/** The official Claude Code sign-in used by the subscription SDK. No credentials cross into the window. */
export interface ClaudeAuthStatus {
  available: boolean
  signedIn: boolean
  email?: string
  name?: string
  plan?: string
  signingIn?: boolean
  url?: string
  error?: string
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
  provider: 'chatgpt' | 'claude'
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

/**
 * What turns a side of the call into words: this PC's models (Parakeet, with Whisper for unclear speech), OpenAI's
 * speech API, another server that speaks it (a model run on this PC, or a service's), or the dictation of the ChatGPT
 * plan Togle is signed in to.
 */
export type Recognizer = 'local' | 'openai' | 'server' | 'chatgpt' | 'claude'

/** The speech APIs that can hear a side in place of this PC's models. */
export type SpeechApiId = Exclude<Recognizer, 'local'>

/** The models Togle can install to hear on this PC. */
export type LocalModelId = 'parakeet' | 'whisper-turbo' | 'whisper-base'

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
  /** The actual subscription profile used to transcribe call audio. Public metadata only. */
  transcriptionAccount?: Pick<SubscriptionAccount, 'id' | 'provider' | 'label' | 'shared' | 'email' | 'signedIn'>
  transcriptionLanguage?: string
  /** Why the API picked for a side can't hear it, or didn't hear its last line: this PC hears that side meanwhile, if it can. */
  problem?: string
  /** What the API picked needs before it can hear ("a ChatGPT sign-in", "an OpenAI API key"), while nothing else can. */
  needs?: string
}

export type AssistKind = 'suggest' | 'ask' | 'summary'

export interface AssistRequest {
  kind: AssistKind
  question?: string
  withScreen?: boolean
  /** The screen `withScreen` looks at (a ScreenOption id); the one under the mouse when not given. */
  screen?: number
  /** Fired by auto-suggest: answer fast (at most one knowledge lookup). */
  auto?: boolean
  /** Think it through right away too, not only when the quick answer finds the question hard. */
  deep?: boolean
}

/**
 * An answer card has up to two parts: the main answer (words to say now, fast) and, for questions that
 * need real thinking, a deep answer from the stronger model that streams in below it.
 */
export type AnswerPart = 'main' | 'deep'

/** A line of a document that answers what was asked, and the document it's from; or of what I told the agent, and when. */
export interface InstantFact {
  text: string
  doc: string
  /** It's what I told the agent in its conversation (`doc` says when), not a document's. */
  mine?: boolean
}

export type AssistEvent =
  | {
      type: 'start'
      id: string
      kind: AssistKind
      title: string
      withScreen: boolean
      at: number
      /** What was asked (the caller's question or mine), for saving a corrected answer. */
      question: string
      agentId: string
      /** A question of the call asked again (Ask them again): the tag that tells its answer apart from the ones tried in an agent's chat. */
      again?: string
    }
  /** An approved answer whose question matches, shown at once while the model answers. */
  | { type: 'match'; id: string; question: string; answer: string }
  /** Lines of the agent's documents that answer the question, found on this PC and shown at once. */
  | { type: 'facts'; id: string; facts: InstantFact[] }
  | { type: 'context'; id: string; context: AssistanceContext }
  | { type: 'delta'; id: string; part: AnswerPart; text: string }
  /** Progress while the agent works, e.g. "Looking up: scale plan price". */
  | { type: 'status'; id: string; part: AnswerPart; text: string }
  | { type: 'sources'; id: string; sources: Source[] }
  /** The deep answer started thinking, or was dropped because the question turned out to be simple. */
  | { type: 'deep'; id: string; state: 'start' | 'drop'; at: number }
  /** `cut`: stopped for a newer question's deep answer, before it was through. */
  | { type: 'done'; id: string; part: AnswerPart; cut?: boolean }
  | { type: 'error'; id: string; part: AnswerPart; message: string }

/** A question of the current call asked again after its review (Ask them again): when its card started, and as what. */
export interface AskedAgain {
  asked: number
  tag: string
  kind: 'suggest' | 'ask'
  withScreen?: boolean
}

export type HotkeyAction = 'toggle-listening' | 'toggle-recording' | 'snapshot' | 'ask' | 'copy' | 'dictation-settings'

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
