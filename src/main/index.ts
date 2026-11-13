import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, net, Notification, screen, session, shell, systemPreferences } from 'electron'
import { ApiConnections } from './auth/api-connections'
import { effectiveAI, effectiveSettings, validateAIProfile } from '@shared/preferences'
import { routedProvider } from './providers/routed'
import type { AIProfile, KeysOffer } from '@shared/types'
import { Dictation } from './dictation'
import { codeEditorOf, frontEditor } from './front-program'
import { DictationSpeech, type DictationEngine } from './dictation-speech'
import { DictationHistoryStore, type DictationHistoryTicket } from './dictation-history'
import { DictationVocabularyStore } from './dictation-vocabulary'
import { correctSpeech, speechLesson, speechWords, withSpeechWord } from '@shared/speech-words'
import type { DictationVocabularyEdit } from '@shared/dictation'
import { DictationTargetBridge } from './dictation-target'
import { Updates } from './updates'
import { RELEASE_KEY } from './release-key'
import type { HeldKeys } from './desktop-typing'
import { ShowWindow } from './show-window'
import { DictationWindow } from './dictation-window'
import { MicrophoneLink } from './microphone-link'
import type { CloseWarning } from '@shared/close-warning'
import { startChannel } from './channel/register'
import type { ChannelServer } from './channel/server'
import { NoticeWindow } from './notice-window'
import { TaskBoxWindow } from './task-box-window'
import { CallNoticeWindow, CornerNoticeWindow } from './call-notice-window'
import { CallStripWindow } from './call-strip-window'
import { isCallStripAction } from '@shared/call-strip'
import { tellOthersLine } from '@shared/meeting'
import { appRunning, CallDetector, readMicrophoneUse, readWindowTitles } from './call-detect'
import { callAppName, isCallApp, isCallAppMode, type CallApp } from '@shared/call-apps'
import { Attention } from './runners/attention'
import type { RunnerHub } from './runners/hub'
import type { Backend } from './runners/types'
import type { StartRequest, TaskBoxOpen, TaskView } from '@shared/runner'
import type { TodoFile } from './todo'
import { registerTodo } from './todo-register'
import { registerRunners } from './runners/register'
import { registerReach } from './reach/register'
import type { Reach } from './reach/reach'
import { StoredRecords, StoredTitles } from './runners/titles'
import { MICROPHONE_PRODUCT, microphonePage } from '@shared/microphone-link'
import { readNoiseReport, shouldSuggest } from '@shared/microphone'
import { TogleTray } from './tray'
import { HotkeyPress, virtualKey } from './hotkey-press'
import { voiceAccountId } from '@shared/dictation'
import { modelSourceId } from '@shared/model-selection'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import koffi from 'koffi'
import type { SettingsPatch } from '@shared/api'
import {
  type CallSession,
  type CallSessionInfo,
  type CallSessionSummary,
  type CurrentCall,
  type HotkeyId,
  type HotkeyInfo,
  type LocalModelId,
  type SegmentKind,
  type Speaker,
  type SttStatus
} from '@shared/types'
import { hotkeyProblem, sameKeys } from '@shared/hotkeys'
import { mergeSpeakers } from '@shared/speakers'
import { AgentStore } from './agent-store'
import { ChatGPTAuth } from './auth/chatgpt'
import { ClaudeCodeAuth } from './auth/claude-code'
import { SubscriptionAccounts, accountChoice, defaultAccountId } from './auth/accounts'
import { CallFile } from './call-file'
import { CallSessions, callForAgent, exportCall, exportName } from './call-sessions'
import { ConfirmSound } from './confirm-sound'
import { withRecent } from './recent-dictations'
import { confirmVoices, namesToConfirm, pruneConfirm, type CallConfirm } from '@shared/confirm-names'
import { myTodoItems, type CallOffer, type TodoOffer } from '@shared/call-todo'
import { FIRST_NAMES } from './names'
import { CallTitles } from './call-titles'
import { externalUrl } from '@shared/links'
import { MeetingNotes } from './meeting-notes'
import type { MeetingNoteTemplate } from '@shared/types'
import { CaptureProtection } from './capture-protection'
import { OngoingCall } from './ongoing-call'
import { hearing, switchedLanguage } from './hearing'
import { PerfLog } from './perf'
import type { UsageStatus } from './plan'
import { ChatGPTProvider } from './providers/chatgpt'
import { ClaudeProvider } from './providers/claude'
import { ClaudeSubscriptionProvider } from './providers/claude-subscription'
import { CompatProvider } from './providers/compat'
import type { LLMProvider, Usage } from './providers/types'
import { VoiceTracker, VOICE_MODEL } from './stt/voices'
import { VoiceMemory } from './stt/voice-memory'
import { getSettings, loadSettings, savedBeforeSpeechChoice, updateSettings, voiceAccountsMigrated, voiceAccountsToMigrate } from './settings'
import { migrateVoicePreferences, parakeetHears, speechLanguageCode, speechLanguageName } from '@shared/speech'
import { modelNameOf } from './stt/catalog'
import { LocalParakeet } from './stt/parakeet'
import { SpeechInstaller, speechHome } from './stt/install'
import { hearingStatus, OPENAI_MODEL, OPENAI_URL, SpeechApi } from './stt/speech-api'
import { LocalWhisper } from './stt/whisper'
import { keepPlace, lastPlace } from './window-place'

const auth = new ChatGPTAuth()
const chatgpt = new ChatGPTProvider(auth)
const claude = new ClaudeProvider()
const claudeAuth = new ClaudeCodeAuth()
const claudeSubscription = new ClaudeSubscriptionProvider(claudeAuth)
const accounts = new SubscriptionAccounts(auth, chatgpt, claudeAuth, claudeSubscription)
const compat = new CompatProvider()
// Timings of real calls (no words), for npm run perf.
const perf = new PerfLog(path.join(app.getPath('userData'), 'perf.jsonl'))
// What each request costs, and how much of its prompt the backend's cache covered.
function logRequest(u: Usage): void {
  perf.request(u)
  if (app.isPackaged) return
  console.log(
    `[usage] ${u.lane} ${u.model}${u.end === 'done' ? '' : ` (${u.end})`}: ${u.input} in (${u.cached} cached), ${u.output} out (${u.reasoning} thinking), ` +
      `first text ${u.firstTextMs === undefined ? '-' : Math.round(u.firstTextMs)} ms, ${Math.round(u.ms)} ms`
  )
}
chatgpt.onUsage = logRequest
claude.onUsage = logRequest
claudeSubscription.onUsage = logRequest
compat.onUsage = logRequest
accounts.onUsage = logRequest
const apiConnections = new ApiConnections(claude, compat)
apiConnections.onUsage = logRequest
apiConnections.onChange = () => send('connections:changed', undefined)
// How much of the ChatGPT plan's limits is used: shown in the window, and logged as it moves.
accounts.onPlan = (id, usage) => {
  if (id === accountChoice(getSettings())) send('plan:usage', usage)
  perf.plan(usage)
}
// Speech recognition on this PC: installed from Settings when it's picked, or the development copy (npm run
// setup:whisper). An installer made before Togle downloaded it had it beside the app, and that copy is used too. A
// check of the window that gives it a folder of its own (TOGLE_SPEECH_HOME) starts from nothing installed.
const devSpeech = app.isPackaged ? path.join(process.resourcesPath, 'whisper') : process.env.TOGLE_SPEECH_HOME ? null : path.join(app.getAppPath(), 'resources', 'whisper')
/**
 * Where this PC may have the same files as the install downloads, to take them from there: the development copy, and
 * a build run from its source folder (dist\win-unpacked) has the source's. A check of the window names its own
 * (TOGLE_SPEECH_SEEDS), or has none.
 */
function speechSeeds(): string[] {
  if (!app.isPackaged && process.env.TOGLE_SPEECH_HOME) return (process.env.TOGLE_SPEECH_SEEDS ?? '').split(path.delimiter).filter(Boolean)
  const besideSource = /-unpacked$/.test(path.basename(path.dirname(process.resourcesPath)))
    ? path.resolve(process.resourcesPath, '..', '..', '..', 'resources', 'whisper')
    : null
  return [...new Set([devSpeech, besideSource].filter((dir): dir is string => !!dir && existsSync(dir)))]
}
const speech = new SpeechInstaller(speechHome(), devSpeech && existsSync(devSpeech) ? devSpeech : null, {}, speechSeeds())
const whisper = new LocalWhisper(() => speech.local())
let parakeet: LocalParakeet | null = null

/** Starts this PC's recognizers with what's installed (Whisper says what's missing, if anything). */
function startLocalSpeech(): void {
  void whisper.start()
  const local = speech.local()
  if (local?.parakeetModel) {
    parakeet = new LocalParakeet(local, () => send('stt:status', sttStatus()))
    parakeet.start()
  }
}

function stopLocalSpeech(): void {
  whisper.stop()
  parakeet?.stop()
  parakeet = null
}
// What can hear a side of the call in place of this PC's models (Settings → Speech recognition): OpenAI's speech API, and any
// server that speaks it.
const speechApis: Record<'openai' | 'server', SpeechApi> = {
  openai: new SpeechApi('openai', 'openai-speech-key.bin', () => ({
    baseUrl: OPENAI_URL,
    model: getSettings().transcription.openaiModel.trim() || OPENAI_MODEL
  })),
  server: new SpeechApi('server', 'speech-server-key.bin', () => ({
    baseUrl: getSettings().transcription.serverUrl,
    model: getSettings().transcription.serverModel
  })),
}
const remoteSpeech = new Map<string, SpeechApi>()
function speechSettings(agentId?: string) {
  const current = (!agentId || agentId === currentSession?.agentId) ? currentSession : undefined
  if (current?.speechSettings) return current.speechSettings
  const owner = agentId || current?.agentId || getSettings().activeAgentId
  return effectiveSettings(getSettings(), agents.list().find(agent => agent.id === owner)).transcription
}
function callLanguage(agentId?: string): string {
  return (!agentId || agentId === currentSession?.agentId) && currentSession?.speechLanguage || speechSettings(agentId).language
}
/** The API picked to hear a side; null when this PC's models hear it. */
const speechApiFor = (speaker: Speaker, agentId?: string): SpeechApi | null => {
  const settings = speechSettings(agentId), source = settings[speaker]
  // Neither Sign in with ChatGPT nor a Claude sign-in includes transcription: a subscription's calls are heard by this PC.
  if (source === 'local' || source === 'chatgpt') return null
  const target = source === 'openai' ? { baseUrl: OPENAI_URL, model: settings.openaiModel || OPENAI_MODEL } : { baseUrl: settings.serverUrl, model: settings.serverModel }
  const call = !agentId || agentId === currentSession?.agentId ? currentSession?.id : undefined
  const key = JSON.stringify([source, target, call || 'defaults'])
  let api = remoteSpeech.get(key)
  if (!api) { api = speechApis[source].pinned(target); api.onChange = () => send('stt:status', sttStatus()); remoteSpeech.set(key, api) }
  return api
}

/**
 * This PC's speech recognition, by the models' names and where they run: Parakeet when it's running, with Whisper
 * behind it where that's installed (on a CPU, only for languages Parakeet doesn't hear).
 */
function localSttStatus(): SttStatus {
  const status = whisper.status()
  const local = speech.local()
  const where = local?.gpu ? 'graphics' : 'processor'
  const whisperName = local?.whisperModel ? modelNameOf(local.whisperModel) : null
  if (!parakeet?.available) return status.state === 'ready' ? { ...status, detail: `${whisperName ?? 'Whisper'} · ${where}` } : status
  const behind = !whisperName ? '' : status.state === 'ready'
    ? `, with ${whisperName} for ${local?.gpu ? 'unclear speech and other languages' : 'other languages'}`
    : ` (${whisperName} not ready)`
  return { state: 'ready', detail: `Parakeet${behind} · ${where}` }
}

/** Transcription status for the window: this PC's, and the API picked for a side, if one is. */
function sttStatus(agentId?: string): SttStatus {
  return { ...hearingStatus(localSttStatus(), { me: speechApiFor('me', agentId), them: speechApiFor('them', agentId) }), transcriptionLanguage: callLanguage(agentId), callId: !agentId || agentId === currentSession?.agentId ? currentSession?.id : undefined }
}

let win: BrowserWindow | null = null
let protection: CaptureProtection | null = null
let tray: TogleTray | undefined
let quitting = false
// The coding agents' tasks (Codex, Claude Code): the Tasks screen's side of the app.
let runners: RunnerHub | null = null
/** Reach, part of Togle Studio: only in development runs with a courier set, until an outside review. */
let reach: Reach | undefined
// The to-do list: a plain text file in Togle's folder.
let todo: TodoFile | null = null
// What Togle answers to the programs that talk to it: a hook of Claude Code asking about a command.
let localChannel: ChannelServer | null = null
// The box to start a task in, opened by its key from any app.
const taskBox = new TaskBoxWindow()
const callNotice = new CallNoticeWindow()
// Once, ever: one of Togle's keys was pressed in a code editor that uses it too. Change keys, or keep them.
const keysNotice = new CornerNoticeWindow<KeysOffer>(__dirname, { surface: 'keysnotice', title: 'Togle keys', slot: 1 })
const callStrip = new CallStripWindow()
/** While a call is written down and Togle's window is closed, a small strip keeps the call's controls in reach. */
function refreshCallStrip(): void {
  const closed = !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()
  const since = currentSession?.startedAt
  if (ongoing.isListening && closed && since) {
    const state = ongoing.callState()
    callStrip.show({ since, told: !!state.toldOthers, marks: state.marks?.length ?? 0 })
  } else callStrip.show(null)
}
/** A call started in another app: written down at once, offered in the corner, or left, as the person chose for that app. */
function callAppStarted(appId: CallApp): void {
  const choice = getSettings().meetings.apps[appId]
  const mode = isCallAppMode(choice) ? choice : 'ask'
  if (mode === 'never' || ongoing.isListening) return
  if (mode === 'always') send('hotkey', 'start-call-unseen')
  else callNotice.show({ app: appId, name: callAppName(appId) }, 60_000)
}
// A Mac tells the titles of other apps' windows only once screen recording is allowed, which the computer's sound for
// writing down a call asks for; before that, a call in a browser is not noticed there, and Write down now starts it.
async function macWindowTitles(): Promise<string[]> {
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') return []
  try {
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
    return sources.map((source) => source.name).filter(Boolean)
  } catch {
    return []
  }
}
// Looked for every few seconds while no call is being written down: which program uses the microphone, as Windows,
// Linux (PulseAudio, PipeWire) or a Mac (Core Audio, from macOS 14.2) tells it.
const callDetector = new CallDetector({
  read: readMicrophoneUse,
  running: appRunning,
  titles: process.platform === 'darwin' ? () => macWindowTitles() : readWindowTitles,
  active: () => (process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin') && !quitting && !ongoing.isListening && getSettings().meetings.notice && (app.isPackaged || process.env.TOGLE_CALL_DETECT !== '0'),
  onStart: callAppStarted,
  onEnd: (appId) => { if (callNotice.shown?.app === appId) callNotice.show(null) }
})
// The small notice in a corner of the screen, and what it tells: a task waits for the person, or one finished.
const noticeWindow = new NoticeWindow()
const attention = new Attention()

const send = (channel: string, payload: unknown): void => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}
const activeProvider = (agentId?: string): LLMProvider => {
  const profile = configuredAI(agentId)
  if (profile) return routedAI(profile)
  const id = accountChoice(getSettings(), agentId ? agents.get(agentId).subscriptionAccountId : undefined)
  if (id) return accounts.pinned(id)
  const { provider } = getSettings()
  return provider === 'chatgpt' ? chatgpt : provider === 'claude' ? getSettings().claude.auth === 'subscription' ? claudeSubscription : claude : compat
}
const isApiSource = (id: string): boolean => id.startsWith('api:') || id.startsWith('connection:')
function sourceProvider(id: string): string { return isApiSource(id) ? apiConnections.get(id).provider.id : accounts.get(id).kind }
function configuredAI(agentId?: string): AIProfile | undefined {
  const agent = agentId ? agents.get(agentId) : undefined
  return agent?.preferences?.ai || getSettings().ai ? effectiveAI(getSettings(), agent, sourceProvider) : undefined
}
function routedAI(profile: AIProfile): LLMProvider { return routedProvider(profile, id => isApiSource(id) ? apiConnections.pinned(id) : accounts.pinned(id)) }
function validateProfile(profile: AIProfile): void { for (const task of Object.values(validateAIProfile(profile).tasks)) sourceProvider(task.sourceId) }
let dictationAgentId: string | undefined
function voiceSettings() {
  const id = ongoing.isListening ? currentSession?.agentId : dictationAgentId
  return effectiveSettings(getSettings(), agents.list().find(agent => agent.id === id))
}
function selectedAccount(provider: 'claude' | 'chatgpt', agentId?: string) {
  const profile = configuredAI(agentId)
  if (profile) {
    const task = ['deep', 'background', 'vision', 'quick'].map(lane => profile.tasks[lane as keyof typeof profile.tasks]).find(task => { if (isApiSource(task.sourceId)) return false; try { return accounts.get(task.sourceId).kind === provider } catch { return false } })
    if (task) return accounts.get(task.sourceId)
    if (agentId && agents.get(agentId).preferences?.ai) throw new Error(`This agent has no ${provider === 'claude' ? 'Claude' : 'ChatGPT / Codex'} subscription task. Choose an account in its AI settings.`)
  }
  const override = agentId ? agents.get(agentId).subscriptionAccountId : undefined
  const chosen = accountChoice(getSettings(), override)
  const entry = chosen ? accounts.get(chosen) : undefined
  if (override && entry?.kind !== provider) throw new Error(`This agent uses ${entry?.kind === 'claude' ? 'Claude' : 'ChatGPT'}. Choose a Claude account to use Claude connected apps.`)
  return entry?.kind === provider ? entry : accounts.get(defaultAccountId(provider))
}
function selectedChatGPT() {
  const entry = selectedAccount('chatgpt')
  if (entry.kind !== 'chatgpt') throw new Error('Choose a ChatGPT subscription account.')
  return entry
}

// What calls belong to: one agent, with the words calls are heard with (agent-store.ts).
const agents = new AgentStore()
agents.on('changed', (agent) => {
  if ((ongoing.isListening ? currentSession?.agentId : dictationAgentId) === agent.id) refreshVoiceSettings()
})


// Worked out once a call starts (see session:listening): the AI that writes its notes, and the person's name.
let callRouted = false
let callAI: AIProfile | undefined
let callAccountId: string | undefined
let callUserName: string | undefined
const ongoing = new OngoingCall(send, () => callUserName, async (wording) => {
  const current = agents.list().find(item => item.id === getSettings().activeAgentId)
  if (current) await agents.update(current.id, { vocabulary: withSpeechWord(current.vocabulary, wording.heardAs, wording.word) })
})
const callSessions = new CallSessions()
const confirmSound = new ConfirmSound()
// Calls given to a coding agent are written here as plain text: removed with the call, or after two weeks.
const SHARED_CALLS = 'shared-calls'
const SHARED_CALLS_KEEP_MS = 14 * 24 * 3600_000
// The sound kept to confirm names is gone by then at the latest: the next day.
const CONFIRM_KEEP_MS = 24 * 3600_000
let currentSession: CallSessionInfo | undefined
let currentCallKey: string = randomUUID()
callSessions.on('changed', (id: string) => send('calls:changed', { id }))
// The call so far, saved as it goes: closing Togle or a crash doesn't lose it (call-file.ts). A call is something once
// it started, or once anything was said in it.
const callFile = new CallFile(() => {
  const state = ongoing.callState()
  return currentSession || state.transcript.length ? { frameSession: currentCallKey, state, session: currentSession } : null
}, async (saved) => {
  if (saved.session && getSettings().assist.rememberCalls !== false) {
    await callSessions.capture(saved.session, saved.frameSession, saved.state)
    if (saved.session.status !== 'live') { scheduleCallNotes(saved.session.id); scheduleCallTitle(saved.session.id) }
  }
})
ongoing.onChange = () => callFile.changed()
const voiceMemory = new VoiceMemory(VOICE_MODEL.sha256, () => send('voices:people-changed', undefined))
const voices = new VoiceTracker((segment, voice, person) => ongoing.identifyVoice(segment, voice, person), status => send('voices:status', status), {
  memory: voiceMemory, enabled: () => getSettings().assist.rememberVoices === true,
  remembered: (voice, person) => ongoing.rememberVoice(voice, person), revoked: segment => ongoing.forgetVoiceSegment(segment)
})
voices.keepClips = () => getSettings().meetings.confirmNames
const dictationTarget = new DictationTargetBridge(path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'dictation-windows.ps1'))
// Freeze the account, speech service and cleanup together for each recording.
const dictationVocabulary = new DictationVocabularyStore()
const dictationHistory = new DictationHistoryStore(accountId => send('dictation:history-changed', { accountId }))
const dictationHistoryRuns = new WeakMap<DictationEngine, Promise<DictationHistoryTicket | undefined>>()
/**
 * Dictation heard by this PC's speech recognition: Parakeet for its 25 languages when it's sure, Whisper otherwise.
 * Whisper re-checks Parakeet only where it's quick (a GPU's large-v3-turbo) or the language is detected; on a CPU,
 * where Whisper small is only for other languages, and without Whisper, Parakeet's text is kept.
 */
async function localDictation(pcm: Float32Array, language: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (localSttStatus().state !== 'ready') throw new Error("Voice typing is heard by this computer's speech recognition. Set it up in Settings → Speech.")
  const whisperReady = whisper.status().state === 'ready'
  const recheck = whisperReady && (!!speech.local()?.gpu || speechLanguageCode(language) === 'auto')
  let heard: { text: string; confidence: number } | null = null
  if (parakeet?.available && (parakeetHears(language) || !whisperReady)) {
    heard = await parakeet.transcribe(pcm, { partial: false, stream: 'dictation' }).catch(() => null)
    if (heard?.text && heard.confidence >= 0.6 && !switchedLanguage(heard.text, language)) return heard.text
    if (heard?.text && !recheck) return heard.text
  }
  if (!whisperReady) {
    if (heard?.text) return heard.text
    const what = speechLanguageCode(language) === 'auto' ? 'Detecting the language' : speechLanguageName(language)
    throw new Error(`${what} needs one more download on this computer: add it in Settings → Speech.`)
  }
  return (await whisper.transcribe(pcm, { language, partial: false, stream: 'dictation', dictation: true })).text
}
function createDictationSpeech(): DictationSpeech {
  meetingNotes.pauseAutomatic()
  callTitles.pause()
  const settings = structuredClone(voiceSettings())
  // Voice typing's own account, or (automatic) the AI's: one setting, in Settings → Voice typing.
  let entry: ReturnType<typeof accounts.get>
  try { entry = accounts.get(voiceAccountId(settings, accounts.known())) }
  catch { throw new Error('Your voice typing account is unavailable. Choose another in Settings → Voice typing.') }
  settings.provider = entry.kind; settings.claude.auth = 'subscription'; settings.dictation.speech = entry.kind
  const openai = entry.kind === 'chatgpt' ? entry : undefined, anthropic = entry.kind === 'claude' ? entry : undefined
  // Without a ChatGPT plan signed in, the key the person gave instead (the one that writes the notes) cleans up what
  // they say too, with the model it uses for quick jobs. With neither, the words go in as heard.
  const keySource = modelSourceId(getSettings())
  const key = !settings.dictation.accountId && openai && !openai.auth.status().signedIn && isApiSource(keySource)
    ? (() => { try { return { provider: apiConnections.pinned(keySource), model: getSettings().ai?.tasks.quick.model } } catch { return undefined } })()
    : undefined
  const provider = accounts.pinned(entry.metadata.id, false)
  const scopedSpeechWords = speechWords(agents.get(ongoing.isListening ? currentSession?.agentId || getSettings().activeAgentId : dictationAgentId || getSettings().activeAgentId).vocabulary)
  const speech = new DictationSpeech({
    vocabulary: dictationVocabulary.get(entry.metadata.id).then(vocabulary => {
      const scoped = scopedSpeechWords
      const aliases = new Set(scoped.map(item => item.heardAs.toLocaleLowerCase()))
      return { ...vocabulary, words: [...vocabulary.words.filter(item => !aliases.has(item.heardAs.toLocaleLowerCase())), ...scoped] }
    }),
    settings: () => settings, chatgpt: provider, claude: provider, key,
    chatgptAccount: () => openai?.auth.status() ?? { signedIn: false },
    claudeAccount: () => anthropic?.auth.status() ?? Promise.resolve({ signedIn: false }),
    // Every account's dictation is heard by this PC: neither sign-in includes transcription. The account cleans it up,
    // when that's on.
    remote: (pcm, language, signal) => localDictation(pcm, language, signal)
  })
  dictationHistoryRuns.set(speech, dictationHistory.begin(entry.metadata.id).catch(error => { console.warn('[dictation history]', (error as Error).message); return undefined }))
  return speech
}
const dictationWindow = new DictationWindow(() => dictation.cancel())
// Togle Studio, the separate app that cleans the microphone for every call app, when it's on this computer.
// Test runs look in a folder of their own, never at the real one.
const microphoneLink = new MicrophoneLink({
  folder: !app.isPackaged && process.env.TOGLE_MICROPHONE_FOLDER ? process.env.TOGLE_MICROPHONE_FOLDER : path.join(app.getPath('appData'), MICROPHONE_PRODUCT),
  client: { name: 'togle', version: app.getVersion() },
  open: url => shell.openExternal(url),
  // From source, Togle can start the microphone app's development build too (its link file names Electron and its folder).
  development: !app.isPackaged,
  // Before release Togle Studio was called Togle Microphone: its old link file can still start it, once.
  previousFolder: !app.isPackaged && process.env.TOGLE_MICROPHONE_FOLDER ? undefined : path.join(app.getPath('appData'), 'Togle Microphone')
})
const microphoneLinkOn = (): boolean => app.isPackaged || process.env.TOGLE_HEADLESS !== '1' || !!process.env.TOGLE_MICROPHONE_FOLDER
let microphoneNoticeShown = false
microphoneLink.on('changed', status => {
  send('microphone:changed', status)
  // Togle turned it on for this call and it stopped: the call may be silent.
  if (status.forCall && status.state?.phase === 'error' && !microphoneNoticeShown && !quitting && !win?.isVisible() && Notification.isSupported()) {
    microphoneNoticeShown = true
    const notice = new Notification({ title: 'Togle Studio stopped', body: 'Your call may be silent. Open Togle Studio to reconnect, or choose your microphone in the call app.' })
    notice.on('click', () => void microphoneLink.show().catch(() => openWindow()))
    notice.show()
  }
  if (status.state?.phase !== 'error') microphoneNoticeShown = false
})
const dictation = new Dictation({
  target: dictationTarget, speech: createDictationSpeech,
  inCall: () => ongoing.isListening,
  microphone: () => voiceSettings().dictation.microphoneId,
  completed: (receipt, speech) => { void dictationHistoryRuns.get(speech)?.then(ticket => dictationHistory.record(ticket, receipt)).catch(error => console.warn('[dictation history]', (error as Error).message)) },
  // A window that runs as administrator takes no typing from Togle: the words go on the clipboard for the person to paste.
  copy: text => { if (!app.isPackaged && process.env.TOGLE_TEST_CLIPBOARD) testClipboard = text; else clipboard.writeText(text) },
  changed: state => { send('dictation:state', state); dictationWindow.update(state); dictationEscape(); refreshTray() }
})
function openWindow(): void {
  if (win?.isMinimized()) win.restore()
  win?.show(); win?.focus()
  dictationWindow.keepAbove()
}
function openDictationSettings(): void { openWindow(); send('hotkey', 'dictation-settings') }
async function copyLastDictation(): Promise<void> {
  const state = dictation.status(), text = ['ready', 'error'].includes(state.phase) ? state.text || state.lastText : state.lastText
  if (!text) throw new Error('No dictation text is available to copy yet.')
  try {
    if (!app.isPackaged && process.env.TOGLE_TEST_CLIPBOARD) testClipboard = text
    else await clipboard.writeText(text)
  } catch (error) { dictation.copyFailed(state.id, text); throw error }
  dictation.copied(state.id, text)
}
// The last dictations, newest first, in memory only: the tray offers them to copy.
let recentDictations: string[] = []
function refreshTray(): void {
  const shortcut = hotkeyStatus.find(item => item.id === 'dictate')
  const state = dictation.status()
  // A dictation counts once its words are final: not the raw words before they are cleaned up.
  if (state.lastText && !['starting', 'recording', 'finishing', 'polishing'].includes(state.phase)) recentDictations = withRecent(recentDictations, state.lastText)
  tray?.update(state, shortcut?.ok ? shortcut.keys : '', voiceSettings().dictation.showBar, ongoing.isListening, recentDictations)
}
function refreshVoiceSettings(): void {
  const settings = voiceSettings()
  dictationWindow.setIndicator(settings.dictation.showBar)
  dictationWindow.keepAbove()
  const window = dictationWindow.window
  if (window && !window.isDestroyed()) window.webContents.send('settings:changed', settings)
  refreshTray()
}
async function setVoiceBar(visible: boolean): Promise<void> {
  const id = ongoing.isListening ? currentSession?.agentId : dictationAgentId, agent = agents.list().find(agent => agent.id === id)
  if (agent?.preferences?.dictation) await agents.update(agent.id, { preferences: { ...agent.preferences, dictation: { ...agent.preferences.dictation, showBar: visible } } })
  else { const settings = await updateSettings({ dictation: { showBar: visible } }); send('settings:changed', settings) }
  refreshVoiceSettings()
}
/** Whether Togle's own window is in front: it shows everything a notice would say. */
function mainWindowActive(): boolean {
  return !!win && !win.isDestroyed() && win.isVisible() && !win.isMinimized() && win.isFocused()
}
/** Tells the person what waits for them: a small notice while Togle's window is not in front, and a dot on the tray. */
// A task that finished while a call was written down: said once the call is over.
let finishedDuringCall: ReturnType<Attention['look']>['finished'][number] | undefined
function refreshNotices(): void {
  if (quitting || !runners) return
  const look = attention.look(runners.attention())
  tray?.setWaiting(look.waiting)
  // During a call, notices wait: the tray still counts, and what finished meanwhile is kept to say after.
  if (ongoing.isListening) {
    if (look.finished.length) finishedDuringCall = look.finished[look.finished.length - 1]
    if (noticeWindow.shown) noticeWindow.show(null)
    return
  }
  const finishedNews = look.finished.length ? look.finished[look.finished.length - 1] : finishedDuringCall
  finishedDuringCall = undefined
  if (mainWindowActive()) { noticeWindow.show(null); return }
  // Settings → Coding agents can turn either notice off; the tray's dot stays.
  const { notices, finished } = getSettings().tasks
  const first = notices ? look.notices[0] : undefined
  if (first) noticeWindow.show(first)
  // Nothing waits any more. A task that finished is only news, shown a few seconds (and it takes the place of the notice that was answered).
  else if (finished && finishedNews) noticeWindow.show(finishedNews, 8000)
  else if (noticeWindow.shown?.kind === 'waiting') noticeWindow.show(null)
}
/** Opens Togle on its Tasks screen, on one task when there is one to show. */
function showTask(key: string): void {
  openWindow()
  send('tasks:show', key)
}
/** What quitting would stop: a call or dictation, and the tasks Togle runs that have not finished. */
function closeWarning(): CloseWarning {
  return { call: ongoing.isListening || dictation.active, tasks: runners?.busy().map(task => task.title) ?? [] }
}
// Updates: the latest release, checked against the release key before anything is installed (updates.ts). A test run
// can give a key and a release list of its own.
const updates = new Updates({
  current: app.getVersion(),
  key: !app.isPackaged && process.env.TOGLE_TEST_RELEASE_KEY ? process.env.TOGLE_TEST_RELEASE_KEY : app.isPackaged ? RELEASE_KEY : '',
  folder: path.join(app.getPath('userData'), 'updates'),
  releases: (!app.isPackaged && process.env.TOGLE_TEST_RELEASES) || 'https://api.github.com/repos/togle-app/togle/releases/latest',
  fetch: (url, init) => net.fetch(url, init),
  changed: (state) => send('updates:changed', state)
})
/** A checked installer to run once Togle has quit (Windows). */
let installAfterQuit: { file: string; args: string[] } | undefined
async function installUpdate(): Promise<'quitting' | 'shown'> {
  const next = await updates.install()
  if (next.after === 'show') { shell.showItemInFolder(next.file); return 'shown' }
  if (next.after === 'quit-and-run') installAfterQuit = { file: next.file, args: next.args }
  else app.relaunch()
  void requestQuit()
  return 'quitting'
}

async function requestQuit(confirmed = false): Promise<void> {
  if (quitting) return
  if (!confirmed && !pageDown && !pageFailed) {
    const warning = closeWarning()
    if (warning.call || warning.tasks.length) { openWindow(); send('window:confirm-close', warning); return }
  }
  quitting = true; closeConfirmed = true
  dictation.dispose(); voices.stop()
  // What Togle turned on for the call goes off with it; Togle Studio itself keeps running.
  await Promise.race([microphoneLink.endCall(), new Promise(resolve => setTimeout(resolve, 1500))])
  microphoneLink.stop()
  // The agents' programs are ended here, where it can be waited for: left to the last moment of the quit, a task in the middle of its turn would be left running.
  const agentsEnded = Promise.race([runners?.dispose(), new Promise(resolve => setTimeout(resolve, 5000))])
  try { await Promise.all([meetingNotes.stop(), callTitles.stop()]); await voices.flush(); await callFile.flush(); await dictationHistory.flush() }
  catch (error) { console.warn('[quit] could not finish saving:', (error as Error).message) }
  finally { await agentsEnded; app.quit() }
}
function dictationEscape(): void {
  if (dictation.active && dictation.status().phase !== 'inserting' && !hotkeysOff) {
    if (!globalShortcut.isRegistered('Escape')) tryKeys('Escape', () => dictation.cancel())
  } else globalShortcut.unregister('Escape')
}
const currentCall = (): CurrentCall => ({ ...ongoing.current(), session: currentSession, key: currentCallKey, restoredFrom })
const meetingNotes = new MeetingNotes(callSessions, record => record.ai ? routedAI(record.ai) : record.accountId ? accounts.pinned(record.accountId) : activeProvider(record.agentId))
const callTitles = new CallTitles(callSessions, record => record.ai ? routedAI(record.ai) : record.accountId ? accounts.pinned(record.accountId) : activeProvider(record.agentId))
const titleQueue = new Set<string>()
let titleTimer: ReturnType<typeof setTimeout> | undefined, namingCall = false
function scheduleCallTitle(id: string): void {
  if (titleQueue.size < 50) titleQueue.add(id)
  armCallTitles()
}
function armCallTitles(delay = 10000): void {
  if (titleTimer || namingCall || !titleQueue.size || quitting) return
  titleTimer = setTimeout(() => { titleTimer = undefined; void nameNextCall() }, delay)
  titleTimer.unref()
}
async function nameNextCall(): Promise<void> {
  if (quitting || getSettings().assist.rememberCalls === false) return
  if (ongoing.isListening || dictation.active) { armCallTitles(15000); return }
  const id = titleQueue.values().next().value
  if (!id) return
  titleQueue.delete(id); namingCall = true
  let delay = 1500
  try {
    const record = await callSessions.get(id)
    if (record?.minutes?.state === 'generating') { titleQueue.add(id); delay = 15000 }
    else {
      const named = await callTitles.generate(id)
      if (named?.titleRetryAt && named.titleRetryAt > Date.now()) delay = 60000
    }
    if (ongoing.isListening || dictation.active) titleQueue.add(id)
  } catch (error) { console.warn('[call naming]', (error as Error).message) }
  finally { namingCall = false; armCallTitles(delay) }
}

// Meetings and the to-do list can ask together: they share one list and one save of the call first.
let listingCalls: Promise<CallSessionSummary[]> | undefined
function listCallSessions(): Promise<CallSessionSummary[]> {
  if (listingCalls) return listingCalls
  const task = (async () => {
    await callFile.flush()
    const saved = await callSessions.list()
    for (const record of saved) if (!record.customTitle && record.titleSource === 'fallback' && record.status !== 'live' && (!record.titleKey || record.titleRetryAt && record.titleRetryAt <= Date.now())) scheduleCallTitle(record.id)
    return saved.sort((a, b) => b.startedAt - a.startedAt)
  })()
  listingCalls = task
  void task.then(() => { if (listingCalls === task) listingCalls = undefined }, () => { if (listingCalls === task) listingCalls = undefined })
  return task
}

async function getCallSession(id: string): Promise<CallSession | null> {
  return callSessions.get(id)
}
async function storedCallSession(id: string): Promise<CallSession> {
  const stored = await callSessions.get(id)
  if (!stored) throw new Error('This call is no longer available.')
  return stored
}
const automaticReviews = new Map<string, ReturnType<typeof setTimeout>>()
/**
 * After a call: the voices worth asking about, each with a guess and what says so, and a short clip of each to play.
 * The clips are the only sound Togle keeps of a call. They are encrypted, and deleted when the names are confirmed or
 * skipped, or by the next day.
 */
async function prepareConfirm(id: string | undefined): Promise<void> {
  // Taken either way, so the call's sound is not held in memory after it.
  const clips = voices.takeClips()
  try {
    if (!id || quitting || getSettings().assist.rememberCalls === false || getSettings().assist.voiceLabels === false) return
    const record = await callSessions.get(id)
    if (!record || record.status === 'live' || !record.transcript.length) return
    const files: { name: string; pcm: Float32Array }[] = []
    const kept = new Map<string, { name: string; at: number; end: number }>()
    // Turned off during the call: the clips taken before are dropped, and the names are still asked about from the text.
    for (const [voice, clip] of getSettings().meetings.confirmNames ? clips : []) {
      if (files.length >= 20 || !record.transcript.some(line => line.voiceId === voice)) continue
      const name = 'v' + files.length
      files.push({ name, pcm: clip.pcm }); kept.set(voice, { name, at: clip.at, end: clip.end })
    }
    const asked = confirmVoices(record.transcript, FIRST_NAMES, kept)
    if (!asked.length) { await confirmSound.remove(id); if (record.confirm) await callSessions.update(id, saved => ({ ...saved, confirm: undefined })); return }
    await confirmSound.save(id, files.filter(file => asked.some(voice => voice.clip === file.name)))
    const confirm: CallConfirm = { until: Date.now() + CONFIRM_KEEP_MS, voices: asked }
    await callSessions.update(id, saved => ({ ...saved, confirm }))
  } catch (error) {
    console.warn('[confirm names]', (error as Error).message)
    // A call deleted while its clips were being kept leaves nothing that points at them.
    if (id) await confirmSound.remove(id).catch(() => undefined)
  }
}
/** Removes the plain text copies of calls given to an agent, once they are two weeks old. */
async function sweepSharedCalls(): Promise<void> {
  try {
    const folder = path.join(app.getPath('userData'), SHARED_CALLS)
    for (const name of await fs.readdir(folder).catch(() => [] as string[])) {
      const file = path.join(folder, name)
      const stat = await fs.stat(file).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > SHARED_CALLS_KEEP_MS) await fs.rm(file, { force: true })
    }
  } catch (error) { console.warn('[shared calls]', (error as Error).message) }
}
/** Deletes the clips of calls whose names were confirmed, skipped or expired, or that are gone. */
async function sweepConfirmSound(): Promise<void> {
  try {
    const waiting = new Set((await callSessions.list()).filter(call => call.confirm && !call.confirm.closed && call.confirm.until > Date.now()).map(call => call.id))
    await confirmSound.sweep(id => waiting.has(id))
  } catch (error) { console.warn('[confirm names]', (error as Error).message) }
}
/** After a call, its notes: written by the AI the person set up, once nothing else is going on. */
function scheduleCallNotes(id: string, delay = 1500): void {
  const before = automaticReviews.get(id)
  if (before) clearTimeout(before)
  const timer = setTimeout(() => {
    automaticReviews.delete(id)
    void (async () => {
      if (quitting || getSettings().assist.rememberCalls === false) return
      const record = await callSessions.get(id)
      const owner = record && agents.list().find(agent => agent.id === record.agentId)
      if (!record || !owner || record.status === 'live' || !record.transcript.length) return
      if (ongoing.isListening || dictation.active) { scheduleCallNotes(id, 15000); return }
      if (record.transcript.length && getSettings().assist.autoNotes !== false) {
        const notes = await meetingNotes.generate(id, undefined, undefined, true).catch(error => { console.warn('[meeting notes]', (error as Error).message); return undefined })
        if (notes?.minutes?.state === 'idle') { scheduleCallNotes(id, 15000); return }
      }
      // Nothing else goes to the AI after a call: the plan writes its notes, and only that (the product design).
    })().catch(error => console.warn('[meeting notes]', (error as Error).message))
  }, delay)
  timer.unref()
  automaticReviews.set(id, timer)
}
/**
 * When the call picked up as Togle started was last saved: the window's first page says so (however often it asks,
 * as React's development mode does), and a page that loads again after it is past that.
 */
let restoredFrom: number | undefined
let pageLoads = 0
/** Closing while in a call was confirmed (or Windows is shutting down). */
let closeConfirmed = false
/** The window's page can't ask before closing: it crashed or hangs. */
let pageDown = false
/** It shows an error instead of the app, until it loads again. */
let pageFailed = false
/** When the page was loaded again after it crashed: a few times a minute at most. */
let reloads: number[] = []
const RELOADS = 3
const RELOAD_WINDOW_MS = 60_000
/** When each step of starting was reached (epoch ms), for timing the start in test runs. */
const started: Record<string, number> = {}

/**
 * Keeps the window as the settings say. Hidden from captures, only the person at this PC sees it
 * (Windows leaves it out of screenshots, screen sharing and recordings).
 */
function applyWindowSettings(): void {
  if (!win || win.isDestroyed()) return
  // An ordinary window, as the design has it: it no longer floats over other apps or fades, as the call assistant's did.
  // During a call the strip is the part that stays in sight.
  const { hideFromCapture } = getSettings().window
  if (win.isAlwaysOnTop()) win.setAlwaysOnTop(false)
  win.setOpacity(1)
  protection?.set(hideFromCapture)
}

function createWindow(): void {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(960, workArea.width - 40)
  const height = Math.min(820, workArea.height - 40)
  const min = { width: 400, height: 420 }
  // Where it was left last time; the first time, at the top right of the main screen.
  const place = lastPlace(min) ?? { width, height, x: workArea.x + workArea.width - width - 20, y: workArea.y + 20 }
  win = new BrowserWindow({
    ...place,
    minWidth: min.width,
    minHeight: min.height,
    frame: false,
    backgroundColor: '#0f1115',
    title: 'Togle',
    icon: path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build'), process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    show: false,
    webPreferences: {
      offscreen: !app.isPackaged && process.env.TOGLE_HEADLESS === '1',
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      // Togle mostly runs minimized or behind the call window; Chromium would otherwise throttle it.
      backgroundThrottling: false
    }
  })
  protection = new CaptureProtection(win)
  win.on('focus', () => dictationWindow.keepAbove())
  keepPlace(win)
  // Before it's shown, so it never appears in a capture.
  applyWindowSettings()
  // Dev only: test runs show it without taking the keyboard from whoever is using the PC.
  win.once('ready-to-show', () => {
    started.shown ??= Date.now()
    if (!app.isPackaged && process.env.TOGLE_HEADLESS === '1') return
    if (!app.isPackaged && process.env.TOGLE_NO_FOCUS) win?.showInactive()
    else win?.show()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    const target = externalUrl(url)
    if (target) void shell.openExternal(target)
    return { action: 'deny' }
  })
  // Nothing but Togle loads here (reloading it, as the dev server does, is fine): another page would get window.togle.
  win.webContents.on('will-navigate', (e) => {
    if (e.url !== win?.webContents.getURL()) e.preventDefault()
  })
  if (!app.isPackaged) {
    win.webContents.on('console-message', (e) => console.log(`[renderer:${e.level}] ${e.message}`))
  }
  // During a call, closing asks first, in the window; either way, what isn't saved yet is saved before it closes.
  // The window's page can't ask (it crashed, hangs, or shows an error): closing mustn't wait for an answer that
  // won't come.
  win.webContents.on('render-process-gone', (_e, details) => {
    pageDown = true
    pageStopped()
    // A page that crashed loads again (the call is saved, and the new page picks it up): a frameless window left
    // empty has nothing to click, not even to close it. Not over and over: a page that keeps crashing stays down.
    if (details.reason === 'clean-exit' || !win || win.isDestroyed()) return
    const now = Date.now()
    reloads = reloads.filter((at) => now - at < RELOAD_WINDOW_MS)
    if (reloads.length >= RELOADS) return
    reloads.push(now)
    win.webContents.reload()
  })
  let savedForClose = false
  win.webContents.on('did-start-loading', () => {
    if (pageLoads++) restoredFrom = undefined
  })
  win.on('unresponsive', () => (pageDown = true))
  win.on('responsive', () => (pageDown = false))
  // What waits for the person is told by a notice only while Togle's own window is not in front.
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) win.on(event as 'focus', refreshNotices)
  win.webContents.on('did-finish-load', () => {
    pageDown = false
    pageFailed = false
    pageStopped()
  })
  win.on('close', (e) => {
    // Closing the main window leaves calls, the voice bar, and global dictation available.
    if (!quitting && !closeConfirmed && tray?.available && !pageDown && !pageFailed) {
      e.preventDefault(); win?.hide(); return
    }
    if (!closeConfirmed && !pageDown && !pageFailed) {
      const warning = closeWarning()
      if (ongoing.isListening || warning.tasks.length) {
        e.preventDefault()
        win?.show()
        send('window:confirm-close', warning)
        return
      }
    }
    // Once: a save that keeps failing (a full disk) doesn't keep Togle from closing.
    if ((callFile.pending || voices.pending) && !savedForClose) {
      e.preventDefault()
      savedForClose = true
      voices.stop()
      // Preventing this close also cancels app.quit(). Resume the whole quit after
      // a late save; closing only the window would strand the menu-bar icon.
      void voices.flush().then(() => callFile.flush()).finally(() => { if (quitting) app.quit(); else win?.close() })
    }
  })
  // Windows is shutting down or signing out: no questions, and no waiting.
  win.on('session-end', () => {
    quitting = true
    closeConfirmed = true
    callFile.flushSync()
  })
  win.on('closed', () => { win = null; dictationWindow.close(); dictation.dispose(); if (!quitting) void requestQuit(true) })
  if (process.env.TOGLE_AUTOSTART) {
    win.webContents.once('did-finish-load', () => setTimeout(() => send('hotkey', 'toggle-listening'), 1500))
  }
  // Only a development run loads its page from the dev server; a packaged Togle ignores the variable.
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/**
 * The window's page is gone or loaded again (Reload after an error): the listening ran in it, and stopped with it.
 * Otherwise closing would ask about a call that isn't running.
 */
function pageStopped(): void {
  if (ongoing.isListening) ongoing.setListening(false)
}

function setupMediaAccess(): void {
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  // getDisplayMedia() in the renderer is answered without a picker, and only for the call's sound: WASAPI loopback
  // gives us everything the PC plays, the other side of the call (its video track is unused). Asked without sound,
  // it is refused: Togle takes no pictures of the screen during a call.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let streams: Electron.Streams | null = null
    try {
      if (request.audioRequested) {
        const [source] = await desktopCapturer.getSources({ types: ['screen'] })
        if (source) streams = { video: source, audio: 'loopback' }
      }
    } catch (error) {
      console.warn('[capture] could not resolve the selected source:', (error as Error).message)
    }
    // null denies access. An empty object throws in Electron when video was requested.
    try { callback(streams) } catch (error) { console.warn('[capture] request ended before access was granted:', (error as Error).message) }
  })
}

// Global shortcuts steal the keys from every other app, so Togle has only the design's three: Talk, Show and Task. Keys
// picked in Settings are checked the same way (hotkeyProblem).
const HOTKEYS: { id: HotkeyId; keys: string; label: string; run: () => void }[] = [
  { id: 'dictate', keys: 'F9', label: 'Talk', run: () => void dictation.toggle() },
  // Part of the screen, drawn on while talking: the picture and the words land together.
  { id: 'show', keys: 'F8', label: 'Show', run: () => void showPart() },
  // The box to start a coding agent's task in, over whatever is on screen.
  { id: 'task', keys: 'F10', label: 'Task', run: () => taskBox.toggle() }
]
let hotkeyStatus: HotkeyInfo[] = []
const user32 = process.platform === 'win32' ? koffi.load('user32.dll') : undefined
const keyDown = user32?.func('int16_t __stdcall GetAsyncKeyState(int)')
const setForeground = user32?.func('int __stdcall SetForegroundWindow(intptr_t hwnd)')

const showWindow = new ShowWindow()
/**
 * F8 Show. Dictation starts first, so it notes the box the person is in before the frozen screen takes the keyboard, and
 * hears what they say meanwhile. Enter: the picture is saved (Togle's pictures folder; an agent in a terminal reads it from
 * there), that box is put in front again, and the picture goes in, then the words. Esc: nothing goes in.
 */
// The offer to change keys, when F8 was pressed in a code editor, waits until the picture is done: only the press that
// took a picture gives it then. A press during one (a held F8 repeats) takes none, and gives nothing.
let showing = false
async function showPart(): Promise<void> {
  if (showWindow.open || dictation.active) {
    if (!showing) giveKeysOffer()
    return
  }
  showing = true
  try {
    await showPartNow()
  } finally {
    showing = false
    giveKeysOffer()
  }
}
function giveKeysOffer(): void {
  const offer = afterShow
  afterShow = undefined
  offer?.()
}
async function showPartNow(): Promise<void> {
  await dictation.start(false)
  if (dictation.status().phase !== 'recording') return
  let png: Buffer | null = null
  try { png = await showWindow.show() }
  catch (error) { console.warn('[show]', (error as Error).message) }
  if (!png) { dictation.cancel(); return }
  const folder = path.join(app.getPath('userData'), 'pictures')
  const file = path.join(folder, `show-${new Date().toISOString().replace(/[:.]/g, '-')}.png`)
  try {
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(file, png, { mode: 0o600 })
  } catch (error) {
    console.warn('[show] the picture was not saved:', (error as Error).message)
    dictation.cancel()
    return
  }
  const handle = dictation.noted()?.windowHandle
  if (handle && setForeground) try { setForeground(BigInt(handle)) } catch { /* The check before pasting says when the app changed. */ }
  dictation.attachPicture(file)
  dictation.stop()
}
// Whether the hold key is down: Windows reads it through user32, a Mac and Linux on X11 through DesktopTyping.
const heldKeys: HeldKeys | undefined = keyDown
  ? { down: (key) => !!((keyDown(key) as number) & 0x8000), codeOf: virtualKey }
  : dictationTarget.heldKeys()
const dictationPress = new HotkeyPress(heldKeys?.down ?? (() => false), heldKeys?.codeOf)
let heldDictation: string | undefined
let heldSince = 0
let tapped: string | undefined
// Off Windows a key's state may not be readable (a Mac may read every key as up without Input Monitoring): a press that
// lets go at once leaves dictation on, and the next press stops it.
const TAP_MS = 300
function dictateShortcut(keys: string): void {
  if (voiceSettings().dictation.mode !== 'hold' || !heldKeys) { dictationPress.run(keys, () => void dictation.toggle()); return }
  dictationPress.run(keys, () => {
    if (dictation.active) {
      if (tapped && dictation.status().id === tapped) { tapped = undefined; dictation.stop() }
      return
    }
    tapped = undefined
    void dictation.start(true)
    heldDictation = dictation.status().id
    heldSince = Date.now()
  }, () => {
    const id = heldDictation; heldDictation = undefined
    if (!id || dictation.status().id !== id) return
    if (process.platform !== 'win32' && Date.now() - heldSince < TAP_MS) { tapped = id; dictation.keepOn(id); return }
    dictation.stop()
  })
}
// What a test run copied (dev only): there, it's kept here rather than put on the PC's clipboard.
let testClipboard: string | undefined
// Off while keys are pressed for one in Settings (else pressing one of them would do it); back after this long anyway.
let hotkeysOff: ReturnType<typeof setTimeout> | undefined
const HOTKEYS_OFF_MS = 30_000

/** A shortcut's keys now: the ones picked in Settings (none: turned off), else its own. */
const keysOf = (h: (typeof HOTKEYS)[number]): string => getSettings().hotkeys[h.id] ?? h.keys

// F9, F8 and F10 are a code editor's own keys too (its debugger's, in VS Code, Visual Studio and JetBrains). The first
// time one of them is pressed with such an editor in front, Togle offers once to change its keys; the press still does
// what it does in Togle. After F8 the offer waits until the picture is done, so it does not sit over it.
let keysOffered = false
let afterShow: (() => void) | undefined
function offerKeys(id: HotkeyId, keys: string): void {
  if (keysOffered || getSettings().keysOffer.shown || !/^F(8|9|10)$/.test(keys) || callNotice.shown) return
  // A test stands in for the program in front by its file; the app reads which one is (Windows, a Mac and Linux).
  const forced = !app.isPackaged && process.env.TOGLE_TEST_FRONT_PROGRAM
  const editor = forced ? codeEditorOf(forced) : frontEditor()
  if (!editor) return
  keysOffered = true
  void updateSettings({ keysOffer: { shown: true } }).catch((error) => console.warn('[keys]', (error as Error).message))
  const offer = (): void => keysNotice.show({ key: keys, editor }, 60_000)
  if (id === 'show') afterShow = offer
  else offer()
}

/** Tries keys for a shortcut: whether they're its now (another app, or Windows, may have them). */
function tryKeys(keys: string, run: () => void): boolean {
  try {
    return globalShortcut.register(keys, run)
  } catch {
    return false
  }
}

function registerHotkeys(): void {
  dictationPress.reset()
  if (heldDictation && dictation.status().id === heldDictation) dictation.cancel()
  heldDictation = undefined
  clearTimeout(hotkeysOff)
  hotkeysOff = undefined
  globalShortcut.unregisterAll()
  hotkeyStatus = HOTKEYS.map((h) => {
    const keys = keysOf(h)
    const ok = !keys || tryKeys(keys, () => {
      offerKeys(h.id, keys)
      if (h.id === 'dictate') dictateShortcut(keys)
      else h.run()
    })
    if (!ok) console.warn(`[hotkeys] ${keys} is taken by another app`)
    return { id: h.id, keys, defaultKeys: h.keys, label: h.label, ok }
  })
  send('hotkeys:changed', hotkeyStatus)
  dictationWindow.window?.webContents.send('hotkeys:changed', hotkeyStatus)
  refreshTray()
  dictationEscape()
}

/** Gives a shortcut other keys (none: turns it off), after checking they can be its; says why not when they can't. */
async function setHotkey(id: HotkeyId, keys: string): Promise<HotkeyInfo[]> {
  const hotkey = HOTKEYS.find((h) => h.id === id)
  if (!hotkey || typeof keys !== 'string') throw new Error('No such shortcut.')
  const wanted = keys.trim()
  if (wanted) {
    const problem = hotkeyProblem(wanted)
    if (problem) throw new Error(problem)
    const other = HOTKEYS.find((h) => h.id !== id && sameKeys(keysOf(h), wanted))
    if (other) throw new Error(`${wanted} is already the shortcut for "${other.label}".`)
    // Tried before it's kept: keys another app has can't be had, and its old keys stay.
    registerHotkeys()
    const had = keysOf(hotkey)
    if (had) globalShortcut.unregister(had)
    const free = tryKeys(wanted, hotkey.run)
    if (!free) {
      registerHotkeys()
      throw new Error(`Windows or another app uses ${wanted} already: pick other keys.`)
    }
  }
  await updateSettings({ hotkeys: { [id]: wanted } })
  registerHotkeys()
  return hotkeyStatus
}

function registerIpc(): void {
  ipcMain.handle('updates:status', () => updates.status())
  ipcMain.handle('updates:install', () => installUpdate())
  ipcMain.handle('microphone:status', () => microphoneLinkOn() ? microphoneLink.refresh() : microphoneLink.status())
  ipcMain.handle('microphone:prepare-call', () => microphoneLinkOn() ? microphoneLink.prepareCall(getSettings().microphone) : microphoneLink.status())
  ipcMain.handle('microphone:turn-on', () => microphoneLink.turnOn('user'))
  ipcMain.handle('microphone:show', (_e, page?: string) => microphoneLink.show(page === 'calibrate' ? 'calibrate' : 'settings'))
  ipcMain.handle('microphone:page', async (_e, from: string) => {
    const place = (['after-call', 'settings', 'call-strip', 'microphone-check'] as const).find(item => item === from) ?? 'settings'
    // Opening the page is interest, not a "Not now": those count from zero again.
    if (getSettings().microphone.dismissals) void updateSettings({ microphone: { dismissals: 0 } }).then(settings => send('settings:changed', settings))
    await shell.openExternal(microphonePage(place))
  })
  // A call's noise measurement (levels only; the audio stays in the window): whether to show the suggestion now.
  ipcMain.handle('microphone:noise', (_e, value: unknown) => {
    const report = readNoiseReport(value)
    if (!report || !shouldSuggest(getSettings().microphone, microphoneLink.status(), report)) return false
    void updateSettings({ microphone: { suggestedAt: Date.now() } }).then(settings => send('settings:changed', settings))
    return true
  })
  ipcMain.handle('dictation:status', () => dictation.status())
  ipcMain.handle('dictation:vocabulary', (_event, accountId: string) => { accounts.get(accountId); return dictationVocabulary.get(accountId) })
  ipcMain.handle('dictation:vocabulary-edit', (_event, accountId: string, edit: DictationVocabularyEdit) => { accounts.get(accountId); return dictationVocabulary.edit(accountId, edit) })
  ipcMain.handle('dictation:history', (_event, accountId: string) => { accounts.get(accountId); return dictationHistory.get(accountId) })
  ipcMain.handle('dictation:history-keep', (_event, accountId: string, enabled: boolean) => { accounts.get(accountId); return dictationHistory.configure(accountId, enabled) })
  ipcMain.on('dictation:expand', (event, expanded: boolean, explicit: boolean) => {
    if (dictationWindow.owns(event.sender) && typeof expanded === 'boolean') dictationWindow.setExpanded(expanded, explicit === true)
  })
  ipcMain.on('dictation:drag', (event, action: string, x: number, y: number) => { if (dictationWindow.owns(event.sender)) dictationWindow.drag(action, x, y) })
  ipcMain.on('dictation:pill', (event, width: number, height: number) => { if (dictationWindow.owns(event.sender) && typeof width === 'number' && typeof height === 'number') dictationWindow.setPill(width, height) })
  ipcMain.handle('dictation:toggle', () => dictation.toggle())
  ipcMain.handle('dictation:cancel', () => dictation.cancel())
  ipcMain.on('dictation:audio', (event, id: string, pcm: Float32Array) => { if (dictationWindow.owns(event.sender)) dictation.push(id, pcm) })
  ipcMain.handle('dictation:finish', (event, id: string) => { if (dictationWindow.owns(event.sender)) return dictation.finish(id) })
  ipcMain.on('dictation:failed', (event, id: string, message: string) => { if (dictationWindow.owns(event.sender)) dictation.failed(id, typeof message === 'string' ? message.slice(0, 500) : 'Microphone unavailable.') })
  ipcMain.handle('dictation:copy', copyLastDictation)
  ipcMain.handle('dictation:settings', openDictationSettings)
  ipcMain.handle('dictation:agent', (_e, id?: string) => { if (id) agents.get(id); dictationAgentId = id; refreshVoiceSettings() })
  ipcMain.handle('settings:get', event => event.sender && dictationWindow.owns(event.sender) ? voiceSettings() : getSettings())
  ipcMain.handle('settings:update', (_e, patch: SettingsPatch) => {
    if ((ongoing.isListening || currentSession) && patch?.activeAgentId && patch.activeAgentId !== getSettings().activeAgentId) throw new Error('Start a new call before changing its agent.')
    if (patch.ai) validateProfile(patch.ai as AIProfile)
    if ((patch.provider || patch.subscriptionAccountId !== undefined) && patch.ai === undefined) patch = { ...patch, ai: null }
    if (patch.dictation?.accountId) accounts.get(patch.dictation.accountId)
    if (patch.subscriptionAccountId) {
      const entry = accounts.get(patch.subscriptionAccountId)
      patch = { ...patch, provider: entry.kind, ...(entry.kind === 'claude' ? { claude: { ...patch.claude, auth: 'subscription' } } : {}) }
    } else if (patch.provider && patch.provider !== getSettings().provider) patch = { ...patch, subscriptionAccountId: '' }
    const saved = updateSettings(patch)
    void saved.then(settings => send('settings:changed', settings))
    if (patch.subscriptionAccountId !== undefined || patch.provider || patch.claude?.auth) send('auth:changed', selectedChatGPT().auth.status())
    if (patch?.assist?.voiceLabels !== undefined && ongoing.isListening) { if (patch.assist.voiceLabels) void voices.start(); else voices.stop() }
    if (patch?.assist?.rememberVoices !== undefined) void voices.memoryChanged()
    if (patch?.tasks) refreshNotices()
    if (patch?.assist?.autoNotes === false || patch?.assist?.rememberCalls === false) meetingNotes.pauseAutomatic()
    if (patch?.assist?.rememberCalls === false) { callTitles.pause(); titleQueue.clear() }
    // Right away, not after the save: dragging the opacity slider should feel live.
    applyWindowSettings()
    if (patch?.dictation) refreshVoiceSettings()
    // Saving near the plan's limit may have been turned on or off.
    selectedChatGPT().provider.plan.update()
    // What hears each side may be another now: why the one before didn't hear a line isn't this one's problem.
    if (patch?.transcription) {
      for (const api of Object.values(speechApis)) api.reset()
      send('stt:status', sttStatus())
    }
    return saved
  })

  ipcMain.handle('accounts:list', (_e, refresh?: boolean) => accounts.list(refresh === true))
  ipcMain.handle('connections:list', () => apiConnections.list())
  ipcMain.handle('connections:add', (_e, input) => apiConnections.add(input))
  ipcMain.handle('connections:remove', (_e, id: string) => {
    const used = [getSettings().ai, currentSession?.ai, ...agents.list().map(agent => agent.preferences?.ai)].some(profile => profile && Object.values(profile.tasks).some(task => task.sourceId === id))
    if (used) throw new Error('This connection is used by AI settings or the current call. Choose another connection there first.')
    return apiConnections.remove(id)
  })
  ipcMain.handle('accounts:sign-in', (_e, id: string, device?: boolean) => accounts.signIn(id, device === true))
  ipcMain.handle('accounts:cancel', (_e, id: string) => accounts.cancel(id))
  ipcMain.handle('accounts:sign-out', (_e, id: string) => accounts.signOut(id))
  ipcMain.handle('auth:status', () => selectedChatGPT().auth.status())
  auth.on('changed', (status) => {
    send('auth:changed', status)
    send('stt:status', sttStatus())
    if (status.signedIn) {
      void chatgpt.refreshUsage()
    } else chatgpt.plan.clear()
  })

  accounts.onChange = (status) => {
    if (quitting) return
    send('accounts:changed', undefined)
    if (status.provider === 'chatgpt' && status.id === selectedAccount('chatgpt').metadata.id) { send('auth:changed', status); send('stt:status', sttStatus()) }
  }
  ipcMain.handle('models:list', (_event, sourceId?: string) => {
    if (sourceId === undefined) return activeProvider().listModels()
    if (typeof sourceId !== 'string') throw new Error('Choose an AI account.')
    if (isApiSource(sourceId)) return apiConnections.pinned(sourceId).listModels()
    return accounts.pinned(sourceId, false).listModels()
  })

  ipcMain.handle('stt:status', (_e, agentId?: string) => sttStatus(agentId))
  whisper.on('status', (status) => {
    if (!app.isPackaged) console.log(`[stt] ${status.state}: ${status.detail ?? ''}`)
    send('stt:status', sttStatus())
  })
  // A line an API didn't hear, or heard again after that: the window says so.
  for (const api of Object.values(speechApis)) api.onChange = () => send('stt:status', sttStatus())

  // Speech recognition on this PC: what's installed, installing it (it runs as soon as it's in), and removing it.
  ipcMain.handle('speech:local', () => speech.state())
  speech.on('change', (state) => send('speech:local', state))
  ipcMain.handle('speech:install', async (_e, models: LocalModelId[]) => {
    await speech.install(Array.isArray(models) ? models : [])
    stopLocalSpeech()
    startLocalSpeech()
  })
  ipcMain.handle('speech:cancel', () => speech.cancel())
  let callAudioPaused = false
  const audioEpoch = { me: 0, them: 0 }
  const routedFinals: Record<Speaker, Promise<void>> = { me: Promise.resolve(), them: Promise.resolve() }
  const onSegment = hearing({
    normalize: text => speechLesson(text) ? text : correctSpeech(text, speechWords(agents.get(currentSession?.agentId || getSettings().activeAgentId).vocabulary)),
    parakeet: () => parakeet,
    whisper,
    whisperReady: () => whisper.status().state === 'ready',
    whisperChecks: () => !!speech.local()?.gpu,
    api: (speaker) => {
      const api = speechApiFor(speaker)
      return api?.canHear() ? api : null
    },
    language: () => callLanguage(),
    // The user's own names last: Whisper keeps the end of a prompt too long for it, and in a group call they're how
    // Togle tells a question is theirs.
    vocabulary: async () => {
      const agent = agents.get(currentSession?.agentId || getSettings().activeAgentId)
      const words = agents.vocabularyFor(agent)
      const names = getSettings().assist.names?.trim()
      return names ? `${words ? `${words.replace(/\.$/, '')}, ` : ''}${names}.` : words
    },
    call: ongoing,
    caption: (caption) => send('transcript:partial', { ...caption, ...(caption.speaker === 'them' ? ongoing.speakerForSegment(caption.segmentId) : {}) }),
    log: app.isPackaged ? undefined : (line) => console.log(line),
    heard: (timing) => perf.heard(timing)
  })
  ipcMain.handle('session:audio-pause', (_event, speaker: Speaker, paused: boolean) => {
    if (!['me', 'them'].includes(speaker) || typeof paused !== 'boolean') throw new Error('Choose a valid call audio input.')
    onSegment.pause(speaker, paused)
    audioEpoch[speaker]++
    routedFinals[speaker] = Promise.resolve()
    if (speaker === 'them') {
      callAudioPaused = paused
      if (paused) voices.stop()
      else if (ongoing.isListening && getSettings().assist.voiceLabels !== false) void voices.start()
    }
  })
  ipcMain.on('audio:segment', (_e, speaker: Speaker, pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind) => {
    if (!['me', 'them'].includes(speaker) || !(pcm instanceof Float32Array) || pcm.length > 30 * 16000 || !pcm.every(Number.isFinite) || !Number.isFinite(startedAt) || typeof segmentId !== 'string' || segmentId.length > 160 || !['partial', 'pause', 'final'].includes(kind)) return
    if (speaker === 'me' && pcm instanceof Float32Array && dictation.overlaps(startedAt, startedAt + pcm.length / 16)) return
    if (ongoing.isListening && speaker === 'them' && !callAudioPaused && kind === 'final' && pcm.length) {
      const call = currentCallKey, epoch = audioEpoch.them, before = routedFinals.them
      let delivered!: () => void
      routedFinals.them = new Promise(resolve => { delivered = resolve })
      void (async () => {
        try {
          const turns = await voices.split(segmentId, pcm, startedAt)
          await before
          if (currentCallKey !== call || audioEpoch.them !== epoch) return
          if (turns.length) {
            void onSegment(speaker, new Float32Array(), startedAt, segmentId, 'final')
            for (const turn of turns) void onSegment(speaker, pcm.slice(turn.from, turn.to), startedAt + turn.from / 16, turn.id, 'final')
          } else void onSegment(speaker, pcm, startedAt, segmentId, kind)
        } catch (error) {
          if (currentCallKey === call && audioEpoch.them === epoch) { ongoing.forgetVoiceSegment(segmentId); void onSegment(speaker, pcm, startedAt, segmentId, kind) }
          console.warn('[speaker routing]', (error as Error).message)
        } finally { delivered() }
      })()
      return
    }
    if (ongoing.isListening && speaker === 'them' && !callAudioPaused && kind !== 'final') voices.hear(segmentId, pcm, startedAt, true)
    void onSegment(speaker, pcm, startedAt, segmentId, kind)
  })

  ipcMain.handle('session:listening', async (_e, value: boolean) => {
    if (typeof value !== 'boolean') throw new Error('Say whether to write the call down.')
    if (value) { meetingNotes.pauseAutomatic(); callTitles.pause() }
    if (value && !callAudioPaused && getSettings().assist.voiceLabels !== false && (app.isPackaged || process.env.TOGLE_SILENT_AUDIO !== '1')) void voices.start()
    else if (!value) await voices.finish()
    else voices.stop()
    if (value) {
      const agent = agents.get(getSettings().activeAgentId)
      if (currentSession && currentSession.agentId !== agent.id) throw new Error('Start a new call before choosing a different agent.')
      if (!callRouted) {
        const profile = currentSession?.ai || configuredAI(agent.id)
        callAccountId = currentSession?.accountId ?? (profile ? !isApiSource(profile.tasks.deep.sourceId) ? profile.tasks.deep.sourceId : undefined : accountChoice(getSettings(), agent.subscriptionAccountId))
        callUserName = callAccountId ? accounts.identity(callAccountId).name : undefined
        callAI = profile
        callRouted = true
      }
      currentSession = { ...currentSession, id: currentCallKey, agentId: agent.id, agentName: agent.name, accountId: callAccountId, ai: currentSession?.ai || callAI, speechSettings: currentSession?.speechSettings || structuredClone(speechSettings(agent.id)), speechLanguage: currentSession?.speechLanguage || speechSettings(agent.id).language, startedAt: currentSession?.startedAt ?? Date.now(), endedAt: undefined, status: 'live' }
    } else if (currentSession) currentSession = { ...currentSession, status: 'ended', endedAt: Date.now() }
    if (!value) void microphoneLink.endCall()
    ongoing.setListening(value)
    // Notices wait during a call, and come once it is over.
    refreshNotices()
    refreshVoiceSettings()
    callFile.changed()
    await callFile.flush()
    if (!value) void prepareConfirm(currentSession?.id)
    // The call's share of the plan's limit counts from here.
    const usedAccounts = currentSession?.ai ? [...new Set(Object.values(currentSession.ai.tasks).map(task => task.sourceId).filter(id => !isApiSource(id)))] : callAccountId ? [callAccountId] : []
    for (const id of usedAccounts) { const entry = accounts.get(id); if (value && entry.kind === 'chatgpt' && entry.auth.status().signedIn) { entry.provider.plan.callStarted(); void entry.provider.refreshUsage() } }
    return currentSession
  })
  const clearCurrentCall = async (notify = false) => {
    voices.reset()
    await callFile.flush()
    onSegment.reset()
    callAudioPaused = false
    audioEpoch.me++; audioEpoch.them++
    routedFinals.me = routedFinals.them = Promise.resolve()
    currentSession = undefined
    restoredFrom = undefined
    // A call the user cleared mustn't come back: the saved call is deleted too.
    await callFile.clear(async () => ongoing.clear())
    callRouted = false; callAI = undefined; callAccountId = undefined; callUserName = undefined
    remoteSpeech.clear()
    currentCallKey = randomUUID()
    // A new call while listening: its share of the plan counts from here, as when listening starts.
    if (ongoing.isListening && getSettings().provider === 'chatgpt' && auth.status().signedIn) {
      chatgpt.plan.callStarted()
      void chatgpt.refreshUsage()
    }
    if (notify) send('call:reset', currentCall())
    return currentCall()
  }
  ipcMain.handle('session:clear', () => clearCurrentCall())
  ipcMain.handle('call:current', currentCall)
  ipcMain.handle('voices:people', () => voiceMemory.list())
  ipcMain.handle('voices:forget', async (_e, identity: string) => {
    if (typeof identity !== 'string') throw new Error('Choose a remembered person.')
    await voices.flush()
    await voiceMemory.forget(identity); voices.forget(identity)
  })
  ipcMain.handle('voices:rename', async (_e, id: string, name: string, identity?: string) => {
    if (typeof id !== 'string' || typeof name !== 'string') throw new Error('Enter a speaker name.')
    if (identity !== undefined && typeof identity !== 'string') throw new Error('Choose a remembered person.')
    if (identity) { await voiceMemory.load(); const person = voiceMemory.get(identity); if (!person) throw new Error('This remembered person was removed.'); name = person.name }
    ongoing.renameVoice(id, name)
    return voices.remember(id, name, identity)
  })
  ipcMain.handle('voices:status', () => voices.status())
  ipcMain.handle('voices:merge', async (_e, from: string, into: string) => {
    if (typeof from !== 'string' || typeof into !== 'string') throw new Error('Choose two speakers.')
    const name = ongoing.mergeVoices(from, into)
    await voices.merge(from, into, name)
  })
  ipcMain.handle('calls:speaker', async (_e, callId: string, voiceId: string, name: string) => {
    if (typeof name !== 'string' || typeof voiceId !== 'string') throw new Error('Enter a speaker name.')
    const value = name.replace(/[\r\n\[\]<>]/g, '').trim().slice(0, 60)
    if (!value) throw new Error('Enter a speaker name.')
    await storedCallSession(callId)
    if (callId === currentSession?.id) { ongoing.renameVoice(voiceId, value); await callFile.flush() }
    return callSessions.update(callId, record => {
      if (!record.transcript.some(line => line.voiceId === voiceId)) throw new Error('That speaker is no longer in this call.')
      return { ...record, transcript: record.transcript.map(line => line.voiceId === voiceId ? { ...line, voiceName: value, voiceNamedBy: 'user' as const, voiceIdentityId: line.voiceName === value ? line.voiceIdentityId : undefined } : line) }
    })
  })
  // Confirm names, after a call: hear a voice, answer who it is, or skip the rest (which deletes the sound).
  ipcMain.handle('confirm:sound', async (_e, callId: string, clip: string) => {
    const confirm = (await callSessions.get(callId))?.confirm
    if (!confirm || confirm.closed || confirm.until <= Date.now() || !confirm.voices.some(voice => voice.clip === clip)) return null
    return confirmSound.pcm(callId, clip)
  })
  ipcMain.handle('confirm:answer', async (_e, callId: string, voiceId: string, name: unknown) => {
    if (typeof voiceId !== 'string') throw new Error('Choose a voice.')
    const before = await storedCallSession(callId)
    if (before.status === 'live') throw new Error('End the call first.')
    if (!before.confirm || before.confirm.closed || !before.confirm.voices.some(voice => voice.id === voiceId)) throw new Error('This voice is not waiting to be confirmed.')
    if (!before.transcript.some(line => line.voiceId === voiceId)) throw new Error('That speaker is no longer in this call.')
    const value = typeof name === 'string' ? name.replace(/[\r\n\[\]<>]/g, '').trim().slice(0, 60) : ''
    // The call that just ended is still the current call: its own copy of the names is corrected too, or the next save
    // of it (Start again, a change, reopening Togle) would bring the old names back.
    if (callId === currentSession?.id) {
      try { if (value) ongoing.renameVoice(voiceId, value); else ongoing.dropVoiceName(voiceId) } catch { throw new Error('That speaker is no longer in this call.') }
      await callFile.flush()
    }
    const saved = await callSessions.update(callId, record => {
      const current = record.confirm
      if (!current || current.closed) return record
      const transcript = record.transcript.map(line => line.voiceId !== voiceId ? line
        : value ? { ...line, voiceName: value, voiceNamedBy: 'user' as const, voiceIdentityId: line.voiceName === value ? line.voiceIdentityId : undefined }
        // Not them: the guess is taken off its lines.
        : line.voiceNamedBy === 'user' ? line : { ...line, voiceName: undefined, voiceNamedBy: undefined, voiceIdentityId: undefined })
      const confirm = pruneConfirm({ ...current, voices: current.voices.map(voice => voice.id === voiceId ? { ...voice, answered: value } : voice) }, transcript, Date.now())
      return { ...record, transcript, confirm }
    })
    if (saved.confirm?.closed) {
      await confirmSound.remove(callId)
      // The notes are corrected with the confirmed names: written again, unless the person edited them, turned automatic
      // notes off, keeps no calls, or a call is being written down.
      const settings = getSettings()
      if (settings.assist.autoNotes !== false && settings.assist.rememberCalls !== false && !ongoing.isListening) {
        void meetingNotes.generate(callId, undefined, undefined, true).catch(error => console.warn('[meeting notes]', (error as Error).message))
      }
    }
    return saved
  })
  ipcMain.handle('confirm:finish', async (_e, callId: string) => {
    await storedCallSession(callId)
    const saved = await callSessions.update(callId, record => record.confirm && !record.confirm.closed ? { ...record, confirm: { ...record.confirm, closed: Date.now() } } : record)
    await confirmSound.remove(callId)
    return saved
  })
  ipcMain.handle('calls:merge-speakers', async (_e, callId: string, from: string, into: string) => {
    if (typeof from !== 'string' || typeof into !== 'string') throw new Error('Choose two speakers.')
    const record = await storedCallSession(callId)
    mergeSpeakers(record.transcript, from, into)
    let merged: CallSession | undefined
    if (callId === currentSession?.id) {
      const name = ongoing.mergeVoices(from, into); await voices.merge(from, into, name); await callFile.flush()
      const stored = await storedCallSession(callId)
      // If history was turned off mid-call, flushing updates only the recovery file.
      if (!stored.transcript.some(line => line.voiceId === from)) merged = stored
    }
    merged ??= await callSessions.update(callId, saved => ({ ...saved, transcript: mergeSpeakers(saved.transcript, from, into) }))
    // A voice merged into another is no longer asked about after the call, and when none is left its sound is deleted.
    if (!merged.confirm || merged.confirm.closed) return merged
    const asked = await callSessions.update(callId, saved => saved.confirm ? { ...saved, confirm: pruneConfirm(saved.confirm, saved.transcript, Date.now()) } : saved)
    if (asked.confirm?.closed) await confirmSound.remove(callId)
    return asked
  })
  ipcMain.on('call:told-others', (_e, told: boolean) => ongoing.setToldOthers(!!told))
  // The answer to the notice that a call started in another app.
  // The buttons of the strip that shows while a call is written down and Togle's window is closed.
  ipcMain.on('callstrip:action', (event, action: unknown) => {
    if (!callStrip.owns(event.sender) || !isCallStripAction(action) || !ongoing.isListening) return
    if (action === 'mark') ongoing.mark()
    else if (action === 'told') ongoing.setToldOthers(true)
    else if (action === 'copy') clipboard.writeText(tellOthersLine(getSettings().transcription))
    else send('hotkey', 'start-call-unseen')
    refreshCallStrip()
  })
  ipcMain.on('callnotice:answer', (event, choice: unknown) => {
    if (!callNotice.owns(event.sender)) return
    const shown = callNotice.shown
    callNotice.show(null)
    if (!shown || !isCallApp(shown.app) || ongoing.isListening) return
    if (choice === 'always') void updateSettings({ meetings: { ...getSettings().meetings, apps: { ...getSettings().meetings.apps, [shown.app]: 'always' } } }).then(() => send('settings:changed', getSettings()))
    if (choice === 'write' || choice === 'always') send('hotkey', 'start-call-unseen')
  })
  // Asked by the corner notices' pages when they load: the first notice can be told before they listen.
  ipcMain.handle('callnotice:now', (event) => (callNotice.owns(event.sender) ? callNotice.shown : null))
  ipcMain.handle('keysnotice:now', (event) => (keysNotice.owns(event.sender) ? keysNotice.shown : null))
  // "Change keys" opens Togle at its keys; "Keep" leaves them. Either way the offer is not made again.
  ipcMain.on('keysnotice:answer', (event, choice: unknown) => {
    if (!keysNotice.owns(event.sender)) return
    keysNotice.show(null)
    if (choice !== 'change') return
    openWindow()
    send('hotkey', 'keys-settings')
  })
  ipcMain.handle('call:mark', () => ongoing.mark())

  ipcMain.handle('calls:list', listCallSessions)
  // What calls left for the person's day: names to confirm, notes that are ready, and the to-dos in them that are theirs.
  ipcMain.handle('meetings:offers', async (): Promise<{ calls: CallOffer[]; items: TodoOffer[] }> => {
    const settings = getSettings()
    const names = [...(settings.assist.names ?? '').split(',').map(name => name.trim()).filter(Boolean), ...(callUserName ? [callUserName] : [])]
    const midnight = new Date().setHours(0, 0, 0, 0)
    const calls: CallOffer[] = [], items: TodoOffer[] = []
    for (const call of await callSessions.list()) {
      if (call.status === 'live' || call.legacy) continue
      const toConfirm = namesToConfirm(call.confirm, Date.now())
      const notes = (call.endedAt ?? call.startedAt) >= midnight && call.minutes?.state === 'ready' && !!call.summary
      if (!toConfirm && !notes) continue
      calls.push({ id: call.id, title: call.title, startedAt: call.startedAt, notes, toConfirm })
      // The list holds only the start of the notes: the to-dos are read from the whole.
      if (notes) {
        const whole = await callSessions.get(call.id).catch(() => null)
        for (const text of myTodoItems(whole?.summary ?? call.summary, names)) items.push({ callId: call.id, title: call.title, startedAt: call.startedAt, text })
      }
    }
    return { calls: calls.slice(0, 6), items: items.slice(0, 12) }
  })
  ipcMain.handle('calls:search', (_e, query: unknown) => callSessions.search(typeof query === 'string' ? query.slice(0, 200) : ''))
  // A finished call given to a coding agent: written as a plain text file, and the task box opens with it attached.
  ipcMain.handle('calls:give', async (_e, id: string) => {
    const record = await getCallSession(id)
    if (!record) throw new Error('This call is no longer available.')
    if (record.status === 'live') throw new Error('End the call first.')
    const folder = path.join(app.getPath('userData'), SHARED_CALLS)
    await fs.mkdir(folder, { recursive: true })
    const file = path.join(folder, record.id + '.md')
    // Only the person can read it: it holds what other people said.
    await fs.writeFile(file, callForAgent(record), { encoding: 'utf8', mode: 0o600 })
    const title = Array.from(record.title).filter(letter => letter.charCodeAt(0) >= 32).join('').trim().slice(0, 140)
    taskBox.show({ attach: { title: title || 'A call', path: file } })
  })
  ipcMain.handle('calls:get', (_e, id: string) => getCallSession(id))
  ipcMain.handle('calls:notes-generate', async (_e, id: string, template: MeetingNoteTemplate, revision?: string) => {
    await storedCallSession(id)
    return meetingNotes.generate(id, template, revision)
  })
  ipcMain.handle('calls:notes-save', async (_e, id: string, revision: string | undefined, text: string) => {
    await storedCallSession(id)
    return meetingNotes.save(id, revision, text)
  })
  ipcMain.handle('calls:notes-personal', async (_e, id: string, before: string, text: string) => {
    await storedCallSession(id)
    return meetingNotes.savePersonal(id, before, text)
  })
  ipcMain.handle('calls:rename', async (_e, id: string, title: string) => {
    await storedCallSession(id)
    return callSessions.rename(id, title)
  })
  ipcMain.handle('calls:delete', async (_e, id: string) => {
    if (id === currentCallKey && ongoing.isListening) throw new Error('End the call before deleting it.')
    const record = await getCallSession(id)
    if (!record) return
    meetingNotes.cancel(id)
    callTitles.cancel(id); titleQueue.delete(id)
    if (id === currentCallKey) await clearCurrentCall(true)
    await callSessions.remove(id)
    await confirmSound.remove(id)
    await fs.rm(path.join(app.getPath('userData'), SHARED_CALLS, record.id + '.md'), { force: true }).catch(() => undefined)
  })
  ipcMain.handle('calls:export', async (_e, id: string) => {
    const record = await getCallSession(id)
    if (!record) throw new Error('This call is no longer available.')
    const chosen = await dialog.showSaveDialog(win!, { title: 'Export call', defaultPath: path.join(app.getPath('documents'), `${exportName(record.title)}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    await fs.writeFile(chosen.filePath, exportCall(record), 'utf8')
    return chosen.filePath
  })

  if (!app.isPackaged && process.env.TOGLE_DEBUG_PORT) {
    // A line said; with the id of the live caption it ends, as speech recognition gives it.
    ipcMain.handle('dev:transcript', (_e, speaker: Speaker, text: string, segmentId?: string, voiceId?: string, seconds?: number) => {
      const at = Date.now()
      ongoing.add(speaker, text, at, at + Math.max(0, Number(seconds) || 0) * 1000, segmentId)
      if (segmentId && voiceId && speaker === 'them') ongoing.identifyVoice(segmentId, voiceId)
    })
    // A live caption as speech recognition sends them, and when Togle started: for timing the window.
    ipcMain.handle('dev:caption', (_e, speaker: Speaker, text: string, segmentId: string) =>
      send('transcript:partial', { segmentId, speaker, text, at: Date.now() })
    )
    ipcMain.handle('dev:started', () => ({ process: process.getCreationTime(), ...started }))
    // Moves and sizes the window as dragging it would.
    ipcMain.handle('dev:place', (_e, bounds: Electron.Rectangle) => win?.setBounds(bounds))
    // The plan's usage as if the backend had said it: a usage status, or a request turned down (its body).
    ipcMain.handle('dev:plan-status', (_e, status: UsageStatus) => chatgpt.plan.status(status))
    ipcMain.handle('dev:plan-refused', (_e, body: string) => chatgpt.plan.refused(body))
    // A shortcut pressed, as if from another app (whether its keys are its, aside), and what's copied then.
    ipcMain.handle('dev:hotkey', (_e, id: HotkeyId) => {
      const hotkey = HOTKEYS.find((h) => h.id === id)
      if (!hotkey) return
      offerKeys(hotkey.id, keysOf(hotkey))
      return hotkey.run()
    })
    testClipboard = ''
    ipcMain.handle('dev:clipboard', () => testClipboard)
    // A dictation as if it had been said, for the tray's list of recent ones.
    ipcMain.handle('dev:dictated', (_e, text: string) => { recentDictations = withRecent(recentDictations, String(text)); refreshTray() })
  }

  ipcMain.handle('hotkeys:list', () => hotkeyStatus)
  ipcMain.handle('hotkeys:set', (_e, id: HotkeyId, keys: string) => setHotkey(id, keys))
  // Keys being pressed for a shortcut in Settings: none of them does anything meanwhile.
  ipcMain.on('hotkeys:pause', (_e, paused: boolean) => {
    if (!paused) return registerHotkeys()
    globalShortcut.unregisterAll()
    dictationPress.reset()
    clearTimeout(hotkeysOff)
    hotkeysOff = setTimeout(registerHotkeys, HOTKEYS_OFF_MS)
  })
  ipcMain.on('shell:open', (_e, url: string) => {
    const target = externalUrl(url)
    if (target) void shell.openExternal(target)
  })
  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:page-failed', () => (pageFailed = true))
  ipcMain.on('window:close', (_e, confirmed?: boolean) => {
    if (confirmed) { void requestQuit(true); return }
    win?.close()
  })
  // The notice window's own messages: how tall it is, open a task, close a notice. Nothing else may send them.
  ipcMain.on('notice:size', (event, height: unknown) => {
    if (noticeWindow.owns(event.sender) && typeof height === 'number') noticeWindow.resize(height)
  })
  ipcMain.on('notice:open', (event, key: unknown) => {
    if (!noticeWindow.owns(event.sender) || typeof key !== 'string' || !key) return
    noticeWindow.show(null)
    showTask(key)
  })
  ipcMain.on('notice:dismiss', (event, id: unknown) => {
    if (!noticeWindow.owns(event.sender) || typeof id !== 'string') return
    attention.dismiss(id)
    noticeWindow.show(null)
    refreshNotices()
  })
  // F8 Show's overlay: the frozen screen it shows, and the picture or the cancel it gives back.
  ipcMain.handle('show:picture', (event) => (showWindow.owns(event.sender) ? showWindow.picture() : null))
  ipcMain.on('show:done', (event, bytes: unknown) => {
    if (showWindow.owns(event.sender) && bytes instanceof Uint8Array) showWindow.done(bytes)
  })
  ipcMain.on('show:cancel', (event) => {
    if (showWindow.owns(event.sender)) showWindow.cancel()
  })
  // The task box's own messages: put it away, and ask for a folder with it as the dialog's parent.
  ipcMain.on('taskbox:close', (event) => {
    if (taskBox.owns(event.sender)) taskBox.hide()
  })
  ipcMain.on('taskbox:size', (event, height: unknown) => {
    if (taskBox.owns(event.sender) && typeof height === 'number' && Number.isFinite(height)) taskBox.resize(height)
  })
  ipcMain.handle('taskbox:pick-folder', (event) => {
    if (!taskBox.owns(event.sender)) throw new Error('That is not for this window.')
    return taskBox.pickFolder()
  })
  ipcMain.handle('taskbox:opening', (event) => (taskBox.owns(event.sender) ? taskBox.current : null))
  // Every way of giving work to an agent opens the same box: from a to-do item with its words, or empty.
  ipcMain.handle('taskbox:open', (_e, value: unknown) => taskBox.show(taskBoxOpening(value)))
}

/** What the window asks the task box to open with, checked: words, a to-do item, an agent and a folder. */
function taskBoxOpening(value: unknown): TaskBoxOpen {
  const given = (value ?? {}) as Record<string, unknown>
  const text = (key: string, longest: number): string | undefined => typeof given[key] === 'string' && given[key] ? (given[key] as string).slice(0, longest) : undefined
  const todo = given.todo as Record<string, unknown> | undefined
  return {
    ...(text('prompt', 20_000) ? { prompt: text('prompt', 20_000) } : {}),
    ...(todo && typeof todo.line === 'number' && Number.isInteger(todo.line) && todo.line >= 0 && typeof todo.text === 'string' ? { todo: { line: todo.line, text: todo.text } } : {}),
    ...(text('runner', 100) ? { runner: text('runner', 100) } : {}),
    ...(text('folder', 4000) ? { folder: text('folder', 4000) } : {})
  }
}

/** Every task given to an agent is on the to-do list: the item it was given from, or an item of its own, by its name. */
async function putOnTodo(task: TaskView, request: StartRequest): Promise<void> {
  if (!todo) return
  try {
    await todo.putTask(task.key, task.title || request.prompt, request.todo)
  } catch (error) {
    console.warn('[to-do] the task is not on the list:', (error as Error).message)
  }
}

// Dev only: lets scripts drive the UI over the Chrome DevTools Protocol.
if (!app.isPackaged && process.env.TOGLE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TOGLE_DEBUG_PORT)
}

// An entry an earlier Togle left in Claude Code's settings may still start Togle as `--togle-hook`: it ends at once and
// says nothing, so Claude Code asks in its terminal as it always did.
if (process.argv.includes('--togle-hook')) {
  app.exit(0)
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', openWindow)
  app.on('activate', openWindow)

  app.whenReady().then(async () => {
    started.ready = Date.now()
    app.setAppUserModelId('io.togle.app')
    // A native Edit menu supplies macOS text-editing shortcuts to every window, including sign-in and settings.
    // Quit still runs through before-quit, preserving the active call's confirmation and save flow.
    if (process.platform === 'darwin') Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { label: 'File', submenu: [{ role: 'close' }] },
      { id: 'togle-edit', role: 'editMenu' },
      { role: 'windowMenu' }
    ]))
    await Promise.all([loadSettings(), auth.load(), claude.load(), compat.load(), ...Object.values(speechApis).map((api) => api.load())])
    await accounts.load()
    await apiConnections.load()
    // Claude's sign-in is read by starting its runtime (claude auth status): a quarter of a second here, seconds on a
    // slow disk. The window doesn't wait for it; what needs it waits (accounts.list(), pinned requests).
    const accountsRead = accounts.list().catch(error => { console.warn('[accounts]', (error as Error).message); return [] })
    // Before the speech model was a choice, this PC heard every call: a Togle from then that has its speech recognition
    // keeps it (quicker, and the audio stays here); one without starts on the ChatGPT plan, as a new one does.
    if (savedBeforeSpeechChoice() && speech.local()) await updateSettings({ transcription: { me: 'local', them: 'local' } })
    started.settings = Date.now()
    // Apply text retention on startup, including accounts whose history screen is not opened.
    void accountsRead.then(list => Promise.all(list.map(account => dictationHistory.get(account.id)))).catch(error => console.warn('[dictation history] retention:', (error as Error).message))
    await agents.load()
    started.agents = Date.now()
    if (!agents.list().some((a) => a.id === getSettings().activeAgentId)) {
      await updateSettings({ activeAgentId: agents.list()[0].id })
    }
    // Voice typing's account became one setting (loadSettings): the agents' own choices carry over the same way.
    const oldVoiceAccounts = voiceAccountsToMigrate()
    if (oldVoiceAccounts) {
      for (const agent of agents.list()) {
        const preferences = migrateVoicePreferences(agent.preferences, oldVoiceAccounts)
        if (preferences) await agents.update(agent.id, { preferences }).catch(error => console.warn('[voice typing account]', agent.id, (error as Error).message))
      }
      await voiceAccountsMigrated()
    }
    // The call that was open when Togle last closed goes on.
    const saved = await callFile.load()
    if (saved) {
      currentCallKey = saved.view?.key ?? saved.frameSession
      currentSession = saved.session ? { ...saved.session, status: saved.session.status === 'live' ? 'interrupted' : saved.session.status, endedAt: saved.session.endedAt ?? saved.savedAt } : saved.state.transcript.length ? {
        id: currentCallKey, agentId: getSettings().activeAgentId, agentName: agents.get(getSettings().activeAgentId).name, startedAt: saved.state.transcript[0].at, endedAt: saved.savedAt, status: 'interrupted'
      } : undefined
      if (currentSession && agents.list().some(agent => agent.id === currentSession!.agentId)) await updateSettings({ activeAgentId: currentSession.agentId })
      ongoing.restore(saved.state)
      restoredFrom = saved.savedAt
      if (currentSession && getSettings().assist.rememberCalls !== false) {
        try {
          await callSessions.capture(currentSession, saved.frameSession, saved.state)
          scheduleCallNotes(currentSession.id)
        } catch (error) { console.warn('[call history] recovery could not be archived:', (error as Error).message) }
      }
    }
    // Pictures earlier versions took of the screen during calls: Togle takes none now, so they all go.
    void fs.rm(path.join(app.getPath('userData'), 'sessions'), { recursive: true, force: true }).catch(() => undefined)
    // The sound kept to confirm names is deleted once answered or expired; checked now and every hour.
    void sweepConfirmSound()
    void sweepSharedCalls()
    setInterval(() => { void sweepConfirmSound(); void sweepSharedCalls() }, 3600_000).unref()
    callDetector.start()
    // Togle's own updates: a minute after starting, then once a day (only with a release key; see updates.ts).
    setTimeout(() => void updates.check(), app.isPackaged ? 60_000 : 2_000).unref()
    setInterval(() => void updates.check(), 24 * 3600_000).unref()
    setInterval(refreshCallStrip, 1000).unref()
    setupMediaAccess()
    registerIpc()
    const runnerTitles = new StoredTitles()
    const runnerRecords = new StoredRecords()
    await Promise.all([runnerTitles.load(), runnerRecords.load()])
    // A test run can stand in for the agents with programs of its own. A packaged Togle never looks.
    const standIns = !app.isPackaged && process.env.TOGLE_TEST_RUNNERS ? await (require(process.env.TOGLE_TEST_RUNNERS) as { backends(): Promise<Backend[]> }).backends() : undefined
    todo = registerTodo({
      handle: (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args)),
      send,
      file: path.join(app.getPath('userData'), 'to-do.md'),
      reveal: file => shell.showItemInFolder(file)
    })
    void todo.watch()
    runners = registerRunners({
      backends: standIns,
      handle: (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args)),
      send,
      titles: runnerTitles,
      records: runnerRecords,
      changed: () => { refreshNotices(); reach?.tasksChanged() },
      pickFolder: async () => {
        const chosen = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] })
        return chosen.canceled ? null : (chosen.filePaths[0] ?? null)
      },
      version: app.getVersion(),
      // Agents added in Settings: kept with the other settings.
      added: () => getSettings().addedAgents,
      saveAdded: async (agents) => { await updateSettings({ addedAgents: agents }) },
      // A task in a terminal of Togle's own is seen and answered only there: Togle opens on it.
      started: (task, request) => { void putOnTodo(task, request); if (task.terminal) showTask(task.key) }
    })
    // Reach: this computer among the person's devices, its tasks shared with them, and Refuse and Stop from them.
    const hubForReach = runners
    reach = registerReach({
      handle: (channel, listener) => ipcMain.handle(channel, (_event, ...args) => listener(...args)),
      send,
      tasks: {
        list: () => hubForReach.list(),
        answer: (key, request, decision) => hubForReach.answer(key, request, decision),
        stop: (key) => hubForReach.stop(key),
        endCommands: (key) => hubForReach.endCommands(key)
      },
      acted: (what, by) => { if (Notification.isSupported()) new Notification({ title: `${by} acted on this computer`, body: what }).show() }
    })
    // The `togle` command reaches the running Togle on its local channel (togle run claude, togle tasks).
    startChannel({ dataFolder: app.getPath('userData'), hub: runners, openBox: opening => taskBox.show(opening) }).then(
      server => { if (quitting) void server.close(); else localChannel = server },
      error => console.warn('[channel] could not open:', (error as Error).message)
    )
    started.window = Date.now()
    createWindow()
    registerHotkeys()
    if (app.isPackaged || process.env.TOGLE_HEADLESS !== '1' || process.env.TOGLE_TEST_TRAY === '1') {
      try {
        tray = new TogleTray(path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build'), process.platform === 'win32' ? 'icon.ico' : 'icon.png'), {
          open: openWindow, tasks: () => showTask(runners?.attention().find(task => task.pending.length)?.key ?? ''), settings: openDictationSettings, toggle: () => void dictation.toggle(), cancel: () => dictation.cancel(), copy: () => { void copyLastDictation().catch(() => {}) },
          copyText: (text: string) => { if (testClipboard !== undefined) testClipboard = text; else clipboard.writeText(text) },
          indicator: visible => { void setVoiceBar(visible).catch(error => console.warn('[voice bar]', (error as Error).message)) },
          quit: () => void requestQuit()
        })
        refreshTray()
      } catch (error) { console.warn('[tray]', (error as Error).message) }
    }
    dictationAgentId = getSettings().activeAgentId
    dictationWindow.setIndicator(voiceSettings().dictation.showBar)
    if (microphoneLinkOn()) microphoneLink.start()
    startLocalSpeech()
    // No microphone or target reads until the shortcut. Warm only the text insertion helper.
    if (process.env.TOGLE_HEADLESS !== '1') void dictationTarget.start().catch(() => {})
    // Speech recognition that's on this PC already (the same files the install downloads): taken from there, and run.
    void speech
      .adopt()
      .then((took) => {
        if (!took) return
        stopLocalSpeech()
        startLocalSpeech()
      })
      .catch((err: Error) => console.warn('[stt] what is on this PC could not be taken:', err.message))
    // Fetch the model list now: it opens the connection the first answer will reuse, so that answer
    // doesn't pay for the handshake. And how much of the plan is used, before the first call.
    if (getSettings().provider === 'chatgpt' && selectedChatGPT().auth.status().signedIn) {
      void selectedChatGPT().provider.listModels()
      void selectedChatGPT().provider.refreshUsage()
    }
    // Claude's list says which efforts each model takes.
    if (getSettings().provider === 'claude') {
      if (getSettings().claude.auth !== 'subscription' && claude.hasApiKey()) void claude.listModels().catch(() => undefined)
    }
  })

  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit() } })
  app.on('window-all-closed', () => { if (!tray?.available) void requestQuit(true) })
  // A checked update's installer, started once Togle is gone, so it can replace Togle's files.
  app.on('quit', () => {
    if (installAfterQuit) spawn(installAfterQuit.file, installAfterQuit.args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  })
  app.on('will-quit', () => {
    quitting = true
    dictationWindow.close()
    noticeWindow.close()
    taskBox.close()
    callDetector.stop()
    callNotice.close()
    keysNotice.close()
    callStrip.close()
    // The sound kept to confirm names of a call a day old goes now, whether or not Togle runs again soon.
    confirmSound.sweepOld(CONFIRM_KEEP_MS)
    todo?.dispose()
    void localChannel?.close()
    microphoneLink.stop()
    dictation.dispose()
    tray?.close()
    dictationTarget.stop()
    voices.stop()
    for (const timer of automaticReviews.values()) clearTimeout(timer)
    clearTimeout(titleTimer); callTitles.pause()
    accounts.close()
    globalShortcut.unregisterAll()
    dictationPress.reset()
    speech.cancel()
    stopLocalSpeech()
    void runners?.dispose()
    reach?.stop()
  })
}
