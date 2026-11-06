import type { RememberedVoice, RememberVoiceResult } from './voices'
import type {
  Agent,
  AgentPatch,
  AgentPreview,
  AgentTemplate,
  HubListing,
  ShareChoice,
  ApprovedAnswer,
  AssistEvent,
  CallReview,
  CaptureSource,
  Frame,
  Lessons,
  PartialTranscript,
  AssistRequest,
  AskedAgain,
  ScreenOption,
  ScreenMonitorStatus,
  AuthStatus,
  ClaudeAuthStatus,
  SubscriptionAccount,
  ApiConnection,
  ApiConnectionInput,
  ClaudeConnections,
  CallAnswer,
  CallView,
  CallSession,
  CallSessionInfo,
  CallSessionSummary,
  CallLearningResult,
  CurrentCall,
  HotkeyAction,
  GivenExport,
  HotkeyId,
  HotkeyInfo,
  KnowledgeDoc,
  LocalModelId,
  LocalSpeechState,
  ModelOption,
  PastCall,
  PlanUsage,
  SegmentKind,
  SessionHome,
  Settings,
  SkillDraft,
  Speaker,
  SpeechApiId,
  SttStatus,
  TrainEvent,
  TrainTurn,
  TranscriptEntry,
  WorkSessionInfo
} from './types'
import type { CalendarStatus } from './meeting'
import type { DictationHistory, DictationReceipt, DictationState, DictationVocabulary, DictationVocabularyEdit } from './dictation'
import type { SavedConversation } from './chat'
import type { NoiseReport, TogleMicrophoneStatus } from './microphone'
import type { MicrophoneLinkPage } from './microphone-link'

export type Unsubscribe = () => void

/** Bridge exposed to the renderer as `window.togle`. */
export interface TogleApi {
  /** Togle Microphone, the separate app that cleans the microphone for every call app: found again, then its status. */
  microphoneStatus(): Promise<TogleMicrophoneStatus>
  onMicrophone(cb: (status: TogleMicrophoneStatus) => void): Unsubscribe
  /** Before a call starts: turns Togle Microphone on for it when it's installed and Settings say so. */
  prepareCallMicrophone(): Promise<TogleMicrophoneStatus>
  turnOnMicrophone(): Promise<TogleMicrophoneStatus>
  turnOffMicrophone(): Promise<TogleMicrophoneStatus>
  showMicrophone(page?: MicrophoneLinkPage): Promise<void>
  /** Togle Microphone's web page, tagged with where in Togle it was opened from. */
  openMicrophonePage(from: 'after-call' | 'settings' | 'call-strip' | 'microphone-check'): Promise<void>
  /** A call's noise measurement (no audio): whether to show the suggestion, which then counts as shown. */
  noiseMeasured(report: NoiseReport): Promise<boolean>
  subscriptionAccounts(refresh?: boolean): Promise<SubscriptionAccount[]>
  addSubscriptionAccount(provider: 'claude' | 'chatgpt', label: string): Promise<SubscriptionAccount>
  signInAccount(id: string, device?: boolean): Promise<void>
  cancelAccountSignIn(id: string): Promise<void>
  signOutAccount(id: string): Promise<void>
  onAccountsChanged(cb: () => void): Unsubscribe
  apiConnections(): Promise<ApiConnection[]>
  addApiConnection(input: ApiConnectionInput): Promise<ApiConnection>
  updateApiConnection(id: string, input: ApiConnectionInput): Promise<ApiConnection>
  removeApiConnection(id: string): Promise<void>
  onApiConnectionsChanged(cb: () => void): Unsubscribe
  setDictationAgent(id?: string): Promise<void>
  dictationStatus(): Promise<DictationState>
  dictationVocabulary(accountId: string): Promise<DictationVocabulary>
  editDictationVocabulary(accountId: string, edit: DictationVocabularyEdit): Promise<DictationVocabulary>
  dictationHistory(accountId: string): Promise<DictationHistory>
  keepDictationHistory(accountId: string, enabled: boolean): Promise<DictationHistory>
  correctDictationHistory(accountId: string, id: string, revision: string, text: string): Promise<DictationReceipt>
  removeDictationHistory(accountId: string, id?: string): Promise<DictationHistory>
  onDictationHistory(cb: (change: { accountId: string }) => void): Unsubscribe
  onSettingsChanged(cb: (settings: Settings) => void): Unsubscribe
  onDictation(cb: (state: DictationState) => void): Unsubscribe
  onDictationExpanded(cb: (expanded: boolean) => void): Unsubscribe
  expandDictation(expanded: boolean, explicit?: boolean): void
  dragDictation(action: 'start' | 'move' | 'end', x: number, y: number): void
  toggleDictation(): Promise<void>
  cancelDictation(): Promise<void>
  useOriginalDictation(id: string): Promise<void>
  pushDictationAudio(id: string, pcm: Float32Array): void
  finishDictationCapture(id: string): Promise<void>
  dictationCaptureFailed(id: string, message: string): void
  copyDictationText(): Promise<void>
  openDictationSettings(): Promise<void>
  getSettings(): Promise<Settings>
  calendarStatus(agentId?: string): Promise<CalendarStatus>
  refreshCalendar(agentId?: string): Promise<CalendarStatus>
  dismissMeeting(id: string): Promise<void>
  onCalendarStatus(cb: (status: CalendarStatus) => void): Unsubscribe
  updateSettings(patch: SettingsPatch): Promise<Settings>

  authStatus(): Promise<AuthStatus>
  signInWithBrowser(): Promise<AuthStatus>
  signInWithDeviceCode(): Promise<AuthStatus>
  cancelSignIn(): Promise<void>
  signOut(): Promise<AuthStatus>
  onAuthChanged(cb: (status: AuthStatus) => void): Unsubscribe

  hasApiKey(): Promise<boolean>
  setApiKey(key: string): Promise<void>
  /** The Anthropic API key Claude answers with, kept encrypted like the others. */
  hasClaudeKey(): Promise<boolean>
  setClaudeKey(key: string): Promise<void>
  claudeAuthStatus(): Promise<ClaudeAuthStatus>
  claudeConnections(refresh?: boolean, agentId?: string): Promise<ClaudeConnections>
  setClaudeConnections(agentId: string, servers: string[]): Promise<Agent>
  signInClaude(): Promise<ClaudeAuthStatus>
  cancelClaudeSignIn(): Promise<void>
  signOutClaude(): Promise<ClaudeAuthStatus>
  onClaudeAuthChanged(cb: (status: ClaudeAuthStatus) => void): Unsubscribe
  /** The key of a speech API that can hear a side of the call (OpenAI's, or another server's), kept encrypted like the others. */
  hasSpeechKey(id: SpeechApiId): Promise<boolean>
  setSpeechKey(id: SpeechApiId, key: string): Promise<void>
  /** Speech recognition on this PC: what's installed and what installing it would download. */
  localSpeech(): Promise<LocalSpeechState>
  onLocalSpeech(cb: (state: LocalSpeechState) => void): Unsubscribe
  /** Downloads whisper.cpp for this PC (unless it's there) and these models; it runs as soon as they're in. */
  installLocalSpeech(models: LocalModelId[]): Promise<void>
  cancelLocalSpeech(): Promise<void>
  removeLocalSpeech(): Promise<void>
  /** An explicit subscription profile, api:claude, or api:compat. Omitting it lists the global default. */
  listModels(sourceId?: string): Promise<ModelOption[]>
  /** How much of the ChatGPT plan's limits is used (null without a ChatGPT sign-in); asks at most once a minute. */
  planUsage(): Promise<PlanUsage | null>
  onPlanUsage(cb: (usage: PlanUsage) => void): Unsubscribe

  sttStatus(agentId?: string): Promise<SttStatus>
  onSttStatus(cb: (status: SttStatus) => void): Unsubscribe
  /** An utterance to transcribe: finished, a live preview of one in progress, or the part before a pause. */
  pushAudio(speaker: Speaker, pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind): void
  /** Live captions; an empty text means the caption is gone (the final line replaces it, or it was noise). */
  onPartialTranscript(cb: (partial: PartialTranscript) => void): Unsubscribe

  setListening(listening: boolean, meetingId?: string): Promise<CallSessionInfo | void>
  pauseCallInput(speaker: Speaker, paused: boolean): Promise<void>
  /** Clears the call: transcript, frames (their files too), the timeline, and the call saved on disk. */
  clearTranscript(): Promise<CurrentCall | void>
  onCallReset(cb: (call: CurrentCall) => void): Unsubscribe
  callSessions(): Promise<CallSessionSummary[]>
  callSession(id: string): Promise<CallSession | null>
  renameCallSession(id: string, title: string): Promise<CallSession>
  deleteCallSession(id: string): Promise<void>
  exportCallSession(id: string): Promise<string | null>
  generateCallNotes(id: string, template: import('./types').MeetingNoteTemplate, revision?: string): Promise<CallSession>
  saveCallNotes(id: string, revision: string | undefined, text: string): Promise<CallSession>
  savePersonalCallNotes(id: string, before: string, text: string): Promise<CallSession>
  reviewCallSession(id: string): Promise<CallLearningResult>
  approveCallLearning(id: string, reviewId: string, selected: string[]): Promise<CallLearningResult>
  dismissCallLearning(id: string, reviewId: string): Promise<CallSession>
  onCallSessions(cb: (change: { id?: string }) => void): Unsubscribe
  /** The call so far: the one going on, or the one picked up from disk as Togle started. */
  currentCall(): Promise<CurrentCall>
  /** The window's part of the call (its answer cards), saved with it. */
  saveCallView(view: CallView): void
  /** What this call is, in the user's words: who it's with, what they want from it. */
  setBrief(text: string): void
  /** Several people on the call: suggestions only when the user is the one asked. */
  setGroupCall(group: boolean): void
  /** What the call is, as the agent set it from what it was told in the conversation. */
  onBrief(cb: (call: { brief: string; group: boolean }) => void): Unsubscribe
  onTranscript(cb: (entry: TranscriptEntry) => void): Unsubscribe
  onTranscriptUpdated(cb: (entries: TranscriptEntry[]) => void): Unsubscribe
  renameVoice(id: string, name: string, identity?: string): Promise<RememberVoiceResult>
  rememberedVoices(): Promise<RememberedVoice[]>
  forgetVoice(identity: string): Promise<void>
  onRememberedVoicesChanged(cb: () => void): Unsubscribe
  mergeVoices(from: string, into: string): Promise<void>
  renameCallSpeaker(callId: string, voiceId: string, name: string): Promise<CallSession>
  mergeCallSpeakers(callId: string, from: string, into: string): Promise<CallSession>
  /** Lines taken back out of the transcript (the mic picking up the other side). */
  onTranscriptRemoved(cb: (ids: string[]) => void): Unsubscribe

  listCaptureSources(previews?: boolean): Promise<CaptureSource[]>
  screenMonitorStatus(): Promise<ScreenMonitorStatus>
  startScreenMonitor(sourceId: string): Promise<ScreenMonitorStatus>
  stopScreenMonitor(id?: string): Promise<void>
  addScreenMonitorFrame(id: string, at: number, image: Uint8Array, change?: { thumb: Uint8Array; content: boolean }): Promise<boolean>
  voiceStatus(): Promise<{ state: 'off' | 'loading' | 'ready' | 'error'; error?: string; memoryError?: string }>
  onVoiceStatus(cb: (status: { state: 'off' | 'loading' | 'ready' | 'error'; error?: string; memoryError?: string }) => void): Unsubscribe
  onScreenMonitor(cb: (status: ScreenMonitorStatus) => void): Unsubscribe
  onScreenRefresh(cb: (id: string) => void): Unsubscribe
  /** Tells main what the next recorder getDisplayMedia() should capture ("cursor" = screen under the mouse). */
  prepareRecording(sourceId: string): Promise<void>
  setRecording(recording: boolean): Promise<void>
  /** `content`: it changed where the picture keeps still, not only where people move (ChangeDetector.content). */
  addRecordedFrame(at: number, image: Uint8Array, thumb: Uint8Array, content?: boolean): Promise<Frame>
  /** The screens, left to right; when there's more than one, each comes with a small picture of what's on it. */
  listScreens(): Promise<ScreenOption[]>
  /** Snapshots a screen into the timeline: the one picked (a ScreenOption id), or the one under the mouse. */
  snapshot(screen?: number): Promise<Frame>
  /** New frames, and frames whose description just arrived. */
  onFrame(cb: (frame: Frame) => void): Unsubscribe

  assist(request: AssistRequest): void
  /** Stops one card (call or agent test), or every call answer when no id is given. */
  cancelAssist(id?: string): void
  /** Approve or Correct on a call card: used for the rest of the call, and offered in the call review. */
  noteAnswer(entry: CallAnswer): Promise<void>
  /** A deep answer for a card (call or agent test), or for the newest call card when no id is given. */
  thinkDeeper(id?: string): void
  onAssist(cb: (event: AssistEvent) => void): Unsubscribe

  listAgents(): Promise<Agent[]>
  agentTemplates(): Promise<AgentTemplate[]>
  createAgent(templateId: string): Promise<Agent>
  /** A new agent set up from a description of the calls it's for (one request drafts its setup and first skills). */
  draftAgent(description: string): Promise<Agent>
  /** Saves the agent as a .togle file to share: its setup, skills, approved answers, and what `choice` adds. Null if cancelled. */
  exportAgent(id: string, choice: ShareChoice): Promise<string | null>
  /** Opens a .togle file and reads it for installing: what it adds and what the check found. Null if cancelled. */
  openAgentPackage(): Promise<AgentPreview | null>
  /** Installs an agent shown in a preview, as a new agent. */
  installAgent(previewId: string): Promise<Agent>
  /** The hubs: Togle's own (once there is one), then the ones added. */
  hubNames(): Promise<string[]>
  /** The agents in each hub. */
  /** All hubs' agents, or Togle's own hubs' ('own'), or one added hub's. */
  hubAgents(which?: string): Promise<HubListing[]>
  /** Reads an agent from a hub for installing, as openAgentPackage does a file. */
  previewHubAgent(hub: string, slug: string): Promise<AgentPreview>
  /** Adds a hub (a GitHub repository of agents: "owner/repo"); the hubs now. */
  addHub(text: string): Promise<string[]>
  removeHub(hub: string): Promise<string[]>
  /** Writes the agent's folder out and opens the hub's page for adding it (a pull request the hub's keepers review). */
  publishAgent(id: string, choice: ShareChoice, hub: string): Promise<{ folder: string; url: string }>
  updateAgent(id: string, patch: AgentPatch): Promise<Agent>
  removeAgent(id: string): Promise<void>
  /** The spelling hints speech recognition gets while this agent is active (own words + terms from knowledge). */
  agentVocabulary(id: string): Promise<string>
  /** Pushed whenever an agent changes, including background studying progress. */
  onAgentChanged(cb: (agent: Agent) => void): Unsubscribe
  onAgentRemoved(cb: (id: string) => void): Unsubscribe
  onAgentProgress(cb: (progress: { agentId: string; text: string }) => void): Unsubscribe

  addAgentText(id: string, name: string, text: string): Promise<Agent>
  /** Opens a file picker and teaches the agent the chosen documents. */
  importAgentFiles(id: string): Promise<ImportResult>
  importAgentFolder(id: string): Promise<ImportResult>
  importAgentWebsite(id: string, url: string, followLinks: boolean, maxPages: number): Promise<ImportResult>
  removeAgentDoc(id: string, docId: string): Promise<Agent>
  /** Retries studying documents that failed (e.g. before signing in). */
  restudyAgent(id: string): Promise<Agent>
  /** Picks a project folder the agent's deep answers can search and read. */
  addCodeFolder(id: string): Promise<Agent>
  /** How many files the deep answers would see in these folders. */
  countCodeFiles(folders: string[]): Promise<number>
  addApprovedAnswer(id: string, question: string, answer: string, origin: ApprovedAnswer['origin']): Promise<Agent>
  /** Add a short fact, or replace the exact fact opened for editing. */
  saveAgentFact(id: string, text: string, before?: string): Promise<Agent>
  removeAgentFact(id: string, text: string): Promise<Agent>
  /** Add or edit a skill. `before` prevents an old form from overwriting newer learning. */
  saveSkill(id: string, skill: SkillDraft, skillId?: string, before?: SkillDraft): Promise<Agent>
  removeSkill(id: string, skillId: string, before: SkillDraft): Promise<Agent>

  /**
   * Asks an agent a question as if a caller had; the answer streams through onAgentTest, its start with `tag`. With
   * `asked` (when a card of the current call started), the call's question is asked again as it was then, to see what
   * training changed.
   */
  testAgent(id: string, question: string, again?: AskedAgain | { tag: string }): void
  onAgentTest(cb: (event: AssistEvent) => void): Unsubscribe

  /**
   * Tells the agent in plain words what it should know or do. It changes its own training (skills, approved
   * answers, memory, setup) and the reply streams through onAgentTrain, tagged with `turnId`.
   */
  trainAgent(id: string, turnId: string, history: TrainTurn[], message: string, callId?: string): void
  stopTraining(turnId: string): void
  onAgentTrain(cb: (event: TrainEvent) => void): Unsubscribe

  /** What the active agent could learn from the current call (and the call itself, kept when summaries of past calls are on). */
  learnFromCall(): Promise<CallReview>
  /** Keeps lessons of the call review: the ones ticked, or (`auto`) what it found, kept on its own. */
  remember(id: string, lessons: Lessons, auto?: boolean): Promise<Agent>
  /** Writes up a call the review found taught the agent (its `lesson`) as notes, kept as one of its documents. */
  keepLesson(id: string): Promise<{ agentId: string; docId?: string; name: string }>
  /** Puts one change of the agent's training history back as it was. */
  undoChange(id: string, changeId: string): Promise<Agent>
  /** Tidies up an agent's training (merges overlapping skills, duplicate answers, related facts); says how many changes. */
  tidyAgent(id: string): Promise<{ agent: Agent; changes: number }>

  /** An agent's earlier calls, newest first. */
  pastCalls(agentId: string): Promise<PastCall[]>
  removePastCall(agentId: string, id: string): Promise<PastCall[]>
  clearPastCalls(agentId: string): Promise<void>
  onPastCalls(cb: (change: { agentId: string; calls: PastCall[] }) => void): Unsubscribe
  /** The earlier calls the current call's answers draw on, as they change (the brief, or who was named). */
  onRecall(cb: (calls: PastCall[]) => void): Unsubscribe
  /** Files, a folder or a project's code folder to attach in the conversation, as picked (none: an empty list). */
  pickToAttach(kind: 'files' | 'folder' | 'code'): Promise<string[]>
  /**
   * Files and folders attached in the conversation (picked or dropped), added to the agent's documents; an export of
   * their chats on claude.ai or ChatGPT among them goes into the list of work sessions instead.
   */
  /** `unchanged`: files it has already, as they are (not an error). */
  addAgentPaths(id: string, paths: string[]): Promise<{ agent: Agent; errors: string[]; unchanged?: string[]; exports?: GivenExport[] }>
  /**
   * Work sessions with Claude Code or Codex on this PC, and their chats on claude.ai and ChatGPT from an export,
   * newest first: all, or those matching a search. From the agent's own, when it has some.
   */
  findWorkSessions(query?: string, agentId?: string): Promise<WorkSessionInfo[]>
  /**
   * Their Claude Code and Codex on this PC (one for each account they use them with: ~/.claude, ~/.claude-work), and
   * their accounts on claude.ai and ChatGPT that there's an export of.
   */
  sessionHomes(): Promise<SessionHome[]>
  /** An export of their chats on claude.ai or ChatGPT, picked: what it holds (none picked: null). */
  pickChatExport(): Promise<GivenExport | null>
  /** Which of them the agent's work sessions come from (by folder); none: all of them. */
  setSessionHomes(id: string, dirs: string[]): Promise<Agent>
  /** A work session added to the agent's documents (or brought up to date): the document, and whether it changed. */
  addWorkSession(id: string, file: string): Promise<{ agent: Agent; doc?: KnowledgeDoc; done: 'added' | 'updated' | 'unchanged' | 'busy' }>
  /** Where a file dropped into the window is on this PC. */
  pathOf(file: File): string
  /** An agent's conversation, as it was last saved (none yet: null). */
  loadConversation(agentId: string): Promise<SavedConversation | null>
  saveConversation(agentId: string, conversation: SavedConversation): void

  listHotkeys(): Promise<HotkeyInfo[]>
  /** Gives a shortcut other keys (empty: turns it off); rejected with why, when they can't be its. */
  setHotkey(id: HotkeyId, keys: string): Promise<HotkeyInfo[]>
  /** While keys are pressed for one in Settings, none of the shortcuts does anything. */
  pauseHotkeys(paused: boolean): void
  onHotkeysChanged(cb: (hotkeys: HotkeyInfo[]) => void): Unsubscribe
  onHotkey(cb: (action: HotkeyAction) => void): Unsubscribe
  /** Copies text, also when the window isn't the one in front. */
  copyText(text: string): void
  openExternal(url: string): void
  /** The system Togle runs on: "win32", "darwin" (macOS) or "linux". */
  platform: string
  minimize(): void
  /** Closes Togle; during a call it asks first (onConfirmClose), unless `confirmed`. */
  close(confirmed?: boolean): void
  /** The window shows an error instead of the app: it can't ask before closing. */
  pageFailed(): void
  /** Closing was asked for during a call: the window asks whether to. */
  onConfirmClose(cb: () => void): Unsubscribe
}

export interface ImportResult {
  agent: Agent
  errors: string[]
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}
