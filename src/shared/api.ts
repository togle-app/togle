import type { RememberedVoice, RememberVoiceResult } from './voices'
import type {
  PartialTranscript,
  AuthStatus,
  SubscriptionAccount,
  ApiConnection,
  ApiConnectionInput,
  CallSession,
  CallSessionInfo,
  CallSessionSummary,
  CurrentCall,
  HotkeyAction,
  HotkeyId,
  HotkeyInfo,
  LocalModelId,
  LocalSpeechState,
  ModelOption,
  SegmentKind,
  Settings,
  Speaker,
  SttStatus,
  TranscriptEntry
} from './types'
import type { DictationHistory, DictationState, DictationVocabulary, DictationVocabularyEdit } from './dictation'
import type { NoiseReport, TogleMicrophoneStatus } from './microphone'
import type { MicrophoneLinkPage } from './microphone-link'
import type { CloseWarning } from './close-warning'
import type { TodoList, TodoRef } from './todo'
import type { CallAgents, Decision, GiveCall, GiveResult, RunnerStatus, StartRequest, TaskDetail, TaskNotice, TaskView } from './runner'

export type Unsubscribe = () => void

/** Bridge exposed to the renderer as `window.togle`. */
export interface TogleApi {
  /** Togle Studio, the separate app that cleans the microphone for every call app: found again, then its status. */
  microphoneStatus(): Promise<TogleMicrophoneStatus>
  /** Togle's own updates: checked against the release key before anything installs. */
  updateStatus(): Promise<import('./updates').UpdateState>
  onUpdate(cb: (state: import('./updates').UpdateState) => void): Unsubscribe
  installUpdate(): Promise<'quitting' | 'shown'>
  onMicrophone(cb: (status: TogleMicrophoneStatus) => void): Unsubscribe
  /** Before a call starts: turns Togle Studio on for it when it's installed and Settings say so. */
  prepareCallMicrophone(): Promise<TogleMicrophoneStatus>
  turnOnMicrophone(): Promise<TogleMicrophoneStatus>
  showMicrophone(page?: MicrophoneLinkPage): Promise<void>
  /** Togle Studio's web page, tagged with where in Togle it was opened from. */
  openMicrophonePage(from: 'after-call' | 'settings' | 'call-strip' | 'microphone-check'): Promise<void>
  /** A call's noise measurement (no audio): whether to show the suggestion, which then counts as shown. */
  noiseMeasured(report: NoiseReport): Promise<boolean>
  subscriptionAccounts(): Promise<SubscriptionAccount[]>
  signInAccount(id: string, device?: boolean): Promise<void>
  cancelAccountSignIn(id: string): Promise<void>
  signOutAccount(id: string): Promise<void>
  onAccountsChanged(cb: () => void): Unsubscribe
  apiConnections(): Promise<ApiConnection[]>
  addApiConnection(input: ApiConnectionInput): Promise<ApiConnection>
  removeApiConnection(id: string): Promise<void>
  onApiConnectionsChanged(cb: () => void): Unsubscribe
  setDictationAgent(id?: string): Promise<void>
  dictationStatus(): Promise<DictationState>
  dictationVocabulary(accountId: string): Promise<DictationVocabulary>
  editDictationVocabulary(accountId: string, edit: DictationVocabularyEdit): Promise<DictationVocabulary>
  dictationHistory(accountId: string): Promise<DictationHistory>
  keepDictationHistory(accountId: string, enabled: boolean): Promise<DictationHistory>
  onSettingsChanged(cb: (settings: Settings) => void): Unsubscribe
  onDictation(cb: (state: DictationState) => void): Unsubscribe
  onDictationExpanded(cb: (expanded: boolean) => void): Unsubscribe
  expandDictation(expanded: boolean, explicit?: boolean): void
  /** The resting voice bar's size as drawn (bigger while listening or with words in it), so clicks on it aren't passed through. */
  setDictationPill(width: number, height: number): void
  dragDictation(action: 'start' | 'move' | 'end', x: number, y: number): void
  toggleDictation(): Promise<void>
  cancelDictation(): Promise<void>
  pushDictationAudio(id: string, pcm: Float32Array): void
  finishDictationCapture(id: string): Promise<void>
  dictationCaptureFailed(id: string, message: string): void
  copyDictationText(): Promise<void>
  openDictationSettings(): Promise<void>
  getSettings(): Promise<Settings>
  updateSettings(patch: SettingsPatch): Promise<Settings>

  authStatus(): Promise<AuthStatus>
  onAuthChanged(cb: (status: AuthStatus) => void): Unsubscribe

  /** Speech recognition on this PC: what's installed and what installing it would download. */
  localSpeech(): Promise<LocalSpeechState>
  onLocalSpeech(cb: (state: LocalSpeechState) => void): Unsubscribe
  /** Downloads whisper.cpp for this PC (unless it's there) and these models; it runs as soon as they're in. */
  installLocalSpeech(models: LocalModelId[]): Promise<void>
  cancelLocalSpeech(): Promise<void>
  /** An explicit subscription profile, api:claude, or api:compat. Omitting it lists the global default. */
  listModels(sourceId?: string): Promise<ModelOption[]>

  sttStatus(agentId?: string): Promise<SttStatus>
  onSttStatus(cb: (status: SttStatus) => void): Unsubscribe
  /** An utterance to transcribe: finished, a live preview of one in progress, or the part before a pause. */
  pushAudio(speaker: Speaker, pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind): void
  /** Live captions; an empty text means the caption is gone (the final line replaces it, or it was noise). */
  onPartialTranscript(cb: (partial: PartialTranscript) => void): Unsubscribe

  setListening(listening: boolean): Promise<CallSessionInfo | void>
  pauseCallInput(speaker: Speaker, paused: boolean): Promise<void>
  /** Clears the call: transcript, frames (their files too), the timeline, and the call saved on disk. */
  clearTranscript(): Promise<CurrentCall | void>
  onCallReset(cb: (call: CurrentCall) => void): Unsubscribe
  callSessions(): Promise<CallSessionSummary[]>
  /** The saved calls with these words in what was said, in their notes or title, with the first lines that have them. */
  searchCalls(query: string): Promise<import('./types').CallSearchHit[]>
  /** What calls left for the person's day: names to confirm, notes that are ready, and the to-dos in them that are theirs. */
  meetingOffers(): Promise<{ calls: import('./call-todo').CallOffer[]; items: import('./call-todo').TodoOffer[] }>
  /** The agent tasks connected to a call (the one going on or about to start, or a saved one), and when each was last sent it. */
  callAgents(call: string): Promise<CallAgents>
  /** Connects tasks to a call, or takes them off it: the list as it should be. */
  setCallAgents(call: string, keys: string[]): Promise<CallAgents>
  /**
   * Gives a call to agents: the call is written as a text file as it stands, each running task is told where it is in one line,
   * and a new task can start with it. Says what each got, or why not.
   */
  giveCall(request: GiveCall): Promise<GiveResult[]>
  callSession(id: string): Promise<CallSession | null>
  renameCallSession(id: string, title: string): Promise<CallSession>
  deleteCallSession(id: string): Promise<void>
  exportCallSession(id: string): Promise<string | null>
  generateCallNotes(id: string, template: import('./types').MeetingNoteTemplate, revision?: string): Promise<CallSession>
  saveCallNotes(id: string, revision: string | undefined, text: string): Promise<CallSession>
  savePersonalCallNotes(id: string, before: string, text: string): Promise<CallSession>
  onCallSessions(cb: (change: { id?: string }) => void): Unsubscribe
  /** The call so far: the one going on, or the one picked up from disk as Togle started. */
  currentCall(): Promise<CurrentCall>
  /** The person told the others on the call that it is being written down (or took that back). */
  setToldOthers(told: boolean): void
  /** Marks this moment of the call; gives every mark of the call so far. */
  markCall(): Promise<number[]>
  /** Told the others, and the marks, whenever either changes. */
  onCallFlags(cb: (flags: { toldOthers: number; marks: number[] }) => void): Unsubscribe
  /** The short clip kept of a voice to confirm after a call, as samples at 16 kHz (null: none is kept any more). */
  confirmSound(callId: string, clip: string): Promise<Float32Array | null>
  /** Who a voice is, as the person says: a name, or none. Gives the call as it is then. */
  confirmAnswer(callId: string, voiceId: string, name: string | null): Promise<CallSession>
  /** The person skips the rest: nothing more is asked, and the sound is deleted now. */
  confirmFinish(callId: string): Promise<CallSession>
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

  voiceStatus(): Promise<{ state: 'off' | 'loading' | 'ready' | 'error'; error?: string; memoryError?: string }>
  onVoiceStatus(cb: (status: { state: 'off' | 'loading' | 'ready' | 'error'; error?: string; memoryError?: string }) => void): Unsubscribe








  /** The coding agents on this PC (Codex, Claude Code), and whether each is installed. */
  runnerStatus(): Promise<RunnerStatus[]>
  /**
   * Adds an agent by its name and the command that starts it. A command for ACP is talked to directly; any other runs in a
   * terminal of Togle's own. Answers with every agent as it is now.
   */
  addCodingAgent(name: string, command: string): Promise<RunnerStatus[]>
  /** A task in a terminal of Togle's own: what it printed so far, and where that ends among all it printed. */
  terminalRead(key: string): Promise<{ text: string; end: number }>
  /** The keys the person types into that terminal. */
  terminalWrite(key: string, data: string): Promise<void>
  /** The size that terminal is shown at, in characters. */
  terminalResize(key: string, cols: number, rows: number): Promise<void>
  /**
   * A picture pasted into a terminal (a screenshot), as its bytes and type: kept as a file for a week in Togle's own folder,
   * whose path goes into the terminal for the agent to attach. The path comes back.
   */
  savePastedPicture(bytes: Uint8Array, type: string): Promise<string>
  /** Types the task's words into its terminal, without Enter. */
  typeTerminalWords(key: string): Promise<void>
  /** What a terminal of Togle's own printed, as it comes: `at` is where the part starts among all it printed. */
  onTerminalData(cb: (chunk: { key: string; at: number; data: string; screen?: string }) => void): Unsubscribe
  /**
   * Removes an agent from Togle's lists: one the person added is forgotten; one Togle finds by itself stays installed, its
   * tasks go on in it, and it can be added back.
   */
  removeCodingAgent(id: string): Promise<RunnerStatus[]>
  /** Adds back an agent Togle finds by itself that was removed from its lists. */
  restoreCodingAgent(id: string): Promise<RunnerStatus[]>
  /** Every agent task on this PC in one list: waiting for the person first, then working, then the rest. */
  runnerTasks(): Promise<TaskView[]>
  /** One task with what happened in it, as far as Togle ran it. */
  runnerDetail(key: string): Promise<TaskDetail>
  /** Starts a task. It asks before every command and edit. */
  startRunnerTask(request: StartRequest): Promise<TaskView>
  /** Continues a task that was started earlier, so it can be answered and replied to here. */
  openRunnerTask(key: string): Promise<TaskView>
  /** Ends the program a task runs in elsewhere (a terminal), and picks the task up here. */
  takeOverRunnerTask(key: string): Promise<TaskView>
  /**
   * What the person sends from Chat. An agent written to on its own screen takes words only once its turn has ended: sent while
   * it works, they wait (the task's `held`) and go in then.
   */
  sendToRunnerTask(key: string, text: string): Promise<void>
  /** What waits to go in to a task: sent now (if the agent takes words now), or taken back. */
  heldRunnerReply(key: string, action: 'send' | 'drop'): Promise<void>
  /** A picture in a task's conversation, by the key it came with, as a data: address; null when it is no longer kept. */
  runnerPicture(key: string, picture: string): Promise<string | null>
  /** Allows or refuses one command or edit a task waits to do. Allowing is once only. */
  answerRunnerTask(key: string, requestId: string, decision: Decision): Promise<void>
  replyRunnerTask(key: string, requestId: string, text: string): Promise<void>
  /**
   * Lets go of a task that is the agent's own screen here: its program ends, and the line to go on in a terminal comes back,
   * with what waited to go in from Chat (`held`), which does not go in now.
   */
  handBackRunnerTask(key: string): Promise<{ command: string; folder: string; held?: string }>
  /** What a task's reply box lists when "/" is typed: its agent's own commands and models. */
  runnerOffers(key: string): Promise<import('./runner').TaskOffers>
  /** A task's conversation as its agent keeps it (its last turns, or all with `all`), for the Chat view; null when the agent keeps none to read. */
  runnerHistory(key: string, all?: boolean): Promise<import('./runner').TaskHistory | null>
  /** What a step of that conversation holds, asked for when it is opened: what a command printed, or the words of a thought. Null when nothing is kept. */
  runnerStep(key: string, more: string): Promise<import('./runner').StepDetail | null>
  /** The first press: the task starts nothing new. */
  stopRunnerTask(key: string): Promise<void>
  /** The second press: ends the commands a stopped task still has running. How many. */
  endRunnerCommands(key: string): Promise<number>
  /** Lets go of a task Togle runs. It stays on this PC. */
  closeRunnerTask(key: string): Promise<void>
  pickRunnerFolder(): Promise<string | null>
  /** Something in the tasks changed: ask again for what is shown. */
  onRunnersChanged(cb: () => void): Unsubscribe
  /** Reach, part of Togle Studio: this device among the person's devices. Only in development runs until reviewed. */
  reachState(): Promise<import('./reach').ReachState>
  onReachChanged(cb: () => void): Unsubscribe
  /** The tasks the person's other devices share, by device. */
  reachRemoteTasks(): Promise<import('./reach').DeviceTasks[]>
  /** Emails a code to sign in to Togle Studio with. */
  reachSendCode(email: string): Promise<void>
  /** Signs in with the emailed code: this computer starts the person's devices, or is added from one of them. */
  reachSignIn(email: string, code: string): Promise<import('./reach').ReachState>
  /** The only computer was lost: this one starts the person's devices again, and the others are added again from it. */
  reachStartAgain(): Promise<import('./reach').ReachState>
  reachSignOut(): Promise<import('./reach').ReachState>
  /** Shows a code to type into a computer that is one of the person's devices. */
  reachShowCode(): Promise<import('./reach').ReachState>
  reachCancelCode(): Promise<import('./reach').ReachState>
  /** Adds a device by the code it shows: the exchange runs up to the person's yes. */
  reachAdd(code: string): Promise<import('./reach').ReachState>
  reachConfirmAdd(): Promise<import('./reach').ReachState>
  reachCancelAdd(): Promise<import('./reach').ReachState>
  reachRemove(device: string): Promise<import('./reach').ReachState>
  /** Whether other devices may act on this computer. */
  reachActOnThis(on: boolean): Promise<import('./reach').ReachState>
  /** Refuses a request or stops a task on another device. */
  reachAct(device: string, act: import('./reach').RemoteAct): Promise<void>
  /** The small notice window is told what to show: a task that waits or finished, or null for nothing. */
  onTaskNotice(cb: (notice: TaskNotice | null) => void): Unsubscribe
  /** The notice window is this tall, in pixels, so the window is no taller. */
  sizeTaskNotice(height: number): void
  /** Opens Togle on the task a notice is about. */
  openTaskFromNotice(key: string): void
  /** Closes a notice: it does not come back. */
  dismissTaskNotice(id: string): void
  /** Togle was opened on a task, from a notice or the tray: show it. */
  onShowTask(cb: (key: string) => void): Unsubscribe
  /** The task the window has on screen (Agents, with the task open), or none: a task that finished is not new once seen. */
  taskOnScreen(key: string | null): void
  /** The person's own arrangement of the Agents list: groups they made, names they gave, tasks they moved. */
  taskGroups(): Promise<import('./task-groups').TaskGroups>
  /** A change to it, kept: the arrangement as it is now comes back. */
  changeTaskGroups(change: import('./task-groups').GroupChange): Promise<import('./task-groups').TaskGroups>
  /** What the small strip shows while a call is written down and Togle's window is closed. Null when it is put away. */
  onCallStrip(cb: (state: import('./call-strip').CallStripState | null) => void): Unsubscribe
  /** A button of that strip. */
  callStripAction(action: import('./call-strip').CallStripAction): void
  /** A call started in another app: the notice in the corner offers to write it down. Null when it is put away. */
  onCallNotice(cb: (notice: { app: import('./call-apps').CallApp; name: string } | null) => void): Unsubscribe
  /** The answer to that notice: write the call down, not now, or always for this app. */
  answerCallNotice(choice: 'write' | 'later' | 'always'): void
  /** What the call notice shows now, asked by its page when it loads (the first notice can come before it listens). */
  callNoticeNow(): Promise<{ app: import('./call-apps').CallApp; name: string } | null>
  /** The one-time offer to change Togle's keys, when one of them was pressed in a code editor that uses it too. */
  onKeysNotice(cb: (offer: import('./types').KeysOffer | null) => void): Unsubscribe
  /** What the keys notice shows now, asked by its page when it loads. */
  keysNoticeNow(): Promise<import('./types').KeysOffer | null>
  /** The answer to that offer: open Settings at the keys, or keep them. */
  answerKeysNotice(choice: 'change' | 'keep'): void
  /** The box opened, with what it was opened with (a saved call, a to-do item, an agent and a folder), or null. */
  onTaskBoxShown(cb: (opening: import('./runner').TaskBoxOpen | null) => void): Unsubscribe
  /** Opens the task box: every way of giving work to an agent does, from a to-do item with its words, or empty. */
  openTaskBox(opening: import('./runner').TaskBoxOpen): Promise<void>
  /** What the task box is open with now, asked by its page when it loads. */
  taskBoxOpening(): Promise<import('./runner').TaskBoxOpen | null>
  /** Puts the task box away. */
  closeTaskBox(): void
  /** The task box's window, as tall as what is in it. */
  sizeTaskBox(height: number): void
  /** Asks for a folder for a task, in a dialog that belongs to the task box. Null when it is closed without a choice. */
  pickTaskBoxFolder(): Promise<string | null>
  /** F8 Show's overlay: the frozen screen to show (device pixels), or null for any other window. */
  showPicture(): Promise<{ dataUrl: string; width: number; height: number } | null>
  /** The picture made, as PNG bytes: it goes in with the words. */
  showDone(png: Uint8Array): void
  showCancel(): void

  /** The to-do list, kept in a plain text file on this PC. Each change answers with the whole list as it is after. */
  todoList(): Promise<TodoList>
  addTodo(text: string): Promise<TodoList>
  setTodoDone(item: TodoRef, done: boolean): Promise<TodoList>
  editTodo(item: TodoRef, text: string): Promise<TodoList>
  removeTodo(item: TodoRef): Promise<TodoList>
  /** Gives an item to an agent task (by its key), or takes it back (null). */
  linkTodo(item: TodoRef, task: string | null): Promise<TodoList>
  /** Shows the list's file in the file manager. */
  showTodoFile(): Promise<void>
  /** The file changed, in Togle or in an editor: ask for the list again. */
  onTodoChanged(cb: () => void): Unsubscribe

  listHotkeys(): Promise<HotkeyInfo[]>
  /** Gives a shortcut other keys (empty: turns it off); rejected with why, when they can't be its. */
  setHotkey(id: HotkeyId, keys: string): Promise<HotkeyInfo[]>
  /** While keys are pressed for one in Settings, none of the shortcuts does anything. */
  pauseHotkeys(paused: boolean): void
  onHotkeysChanged(cb: (hotkeys: HotkeyInfo[]) => void): Unsubscribe
  onHotkey(cb: (action: HotkeyAction) => void): Unsubscribe
  openExternal(url: string): void
  /** The system Togle runs on: "win32", "darwin" (macOS) or "linux". */
  platform: string
  minimize(): void
  /** Maximizes the window, or gives it back the size it had. */
  maximize(): void
  /** Whether the window is maximized now. */
  isMaximized(): Promise<boolean>
  /** The window was maximized, or given back its size (by its button, a double click on its bar, or the system). */
  onMaximized(cb: (maximized: boolean) => void): Unsubscribe
  /** Whether the window is hidden in the tray or minimized: told at once, then whenever that changes. */
  onAway(cb: (away: boolean) => void): Unsubscribe
  /** Closes Togle; during a call it asks first (onConfirmClose), unless `confirmed`. */
  close(confirmed?: boolean): void
  /** The window shows an error instead of the app: it can't ask before closing. */
  pageFailed(): void
  /** Closing was asked for during a call, or while tasks Togle runs have not finished: the window asks whether to. */
  onConfirmClose(cb: (warning: CloseWarning) => void): Unsubscribe
}

export type SettingsPatch = {
  [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> : Settings[K]
}
