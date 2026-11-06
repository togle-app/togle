import { app, BrowserWindow, clipboard, desktopCapturer, dialog, globalShortcut, ipcMain, Menu, Notification, screen, session, shell } from 'electron'
import { AgentCalendars } from './calendar'
import { ApiConnections } from './auth/api-connections'
import { effectiveAI, effectiveSettings, validateAIProfile, validatePreferences } from '@shared/preferences'
import { routedProvider } from './providers/routed'
import type { AIProfile } from '@shared/types'
import { Dictation } from './dictation'
import { DictationSpeech, type DictationEngine } from './dictation-speech'
import { DictationHistoryStore, type DictationHistoryTicket } from './dictation-history'
import { DictationVocabularyStore } from './dictation-vocabulary'
import { correctSpeech, speechLesson, speechWords, withSpeechWord } from '@shared/speech-words'
import type { DictationVocabularyEdit } from '@shared/dictation'
import { DictationTargetBridge } from './dictation-target'
import { DictationWindow } from './dictation-window'
import { MicrophoneLink } from './microphone-link'
import { MICROPHONE_PRODUCT, microphonePage } from '@shared/microphone-link'
import { readNoiseReport, shouldSuggest } from '@shared/microphone'
import { TogleTray } from './tray'
import { HotkeyPress } from './hotkey-press'
import { dictationSource } from '@shared/dictation'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import koffi from 'koffi'
import type { SettingsPatch } from '@shared/api'
import type { SavedConversation } from '@shared/chat'
import {
  MEMORY_LIMIT,
  MIN_OPACITY,
  type AgentPatch,
  type Agent,
  type ApprovedAnswer,
  type AskedAgain,
  type AssistRequest,
  type CallAnswer,
  type CallView,
  type CallSession,
  type CallSessionInfo,
  type CallSessionSummary,
  type GivenExport,
  type HotkeyId,
  type HotkeyInfo,
  type Lessons,
  type LocalModelId,
  type PastCall,
  type SegmentKind,
  type ShareChoice,
  type SkillDraft,
  type Speaker,
  type SpeechApiId,
  type SttStatus,
  type TrainEvent,
  type TrainTurn
} from '@shared/types'
import { hotkeyProblem, sameKeys } from '@shared/hotkeys'
import { memoryChars } from '@shared/memory'
import { mergeSpeakers } from '@shared/speakers'
import { fetchHubAgent, hubName, hubSource, listHub, OFFICIAL_HUB, parseHub, publishUrl, TOGLE_HUB } from './agents/hub'
import { Installs } from './agents/installs'
import { setCodePage, setReaderScript, SUPPORTED_EXTENSIONS } from './agents/knowledge'
import { addExport, isChatAddress, setChatExports } from './agents/chat-exports'
import { findSessions, samePlace, sessionHomes } from './agents/sessions'
import { slug, unzipPackage, zipPackage } from './agents/package'
import { Conversations } from './agents/conversations'
import { PastCalls } from './agents/past-calls'
import { AgentStore } from './agents/store'
import { AGENT_TEMPLATES } from './agents/templates'
import { train, type TrainCall } from './agents/train'
import { ChatGPTAuth } from './auth/chatgpt'
import { ClaudeCodeAuth } from './auth/claude-code'
import { SubscriptionAccounts, accountChoice, defaultAccountId } from './auth/accounts'
import { ClaudeSpeechAccess } from './auth/claude-speech'
import { ClaudeSpeech } from './stt/claude-speech'
import { CallFile } from './call-file'
import { CallSessions, exportCall, legacySession, sessionSummary } from './call-sessions'
import { CallLearning } from './call-learning'
import { CallTitles } from './call-titles'
import { meetingForCall } from '@shared/meeting'
import { externalUrl } from '@shared/links'
import { MeetingNotes } from './meeting-notes'
import type { MeetingNoteTemplate } from '@shared/types'
import { SavedCallReader } from './saved-call-context'
import { CaptureProtection } from './capture-protection'
import { CodeBase } from './code'
import { Copilot } from './copilot'
import type { CallCard } from './prompts'
import { FrameStore, registerFrameScheme, serveFrames } from './frames'
import { hearing } from './hearing'
import { PerfLog } from './perf'
import type { UsageStatus } from './plan'
import { ChatGPTProvider } from './providers/chatgpt'
import { ClaudeProvider } from './providers/claude'
import { ClaudeSubscriptionProvider } from './providers/claude-subscription'
import { CompatProvider } from './providers/compat'
import type { LLMProvider, Usage } from './providers/types'
import { captureFrame, listCaptureSources, listScreens, resolveCaptureSource } from './screen'
import { ScreenMonitor } from './screen-monitor'
import { VoiceTracker, VOICE_MODEL } from './stt/voices'
import { VoiceMemory } from './stt/voice-memory'
import { getSettings, loadSettings, needsSpeechAccountMigration, savedBeforeSpeechChoice, updateSettings } from './settings'
import { migrateSpeechAccounts, speechLanguageCode } from '@shared/speech'
import { subscriptionRecognizer } from './stt/subscription'
import { LocalParakeet } from './stt/parakeet'
import { SpeechInstaller, speechHome } from './stt/install'
import { hearingStatus, OPENAI_MODEL, OPENAI_URL, SpeechApi } from './stt/speech-api'
import { LocalWhisper } from './stt/whisper'
import { keepPlace, lastPlace } from './window-place'

registerFrameScheme()

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
/** A speech API by the id the window names it with (anything else: none). */
const speechApi = (id: unknown): SpeechApi | undefined => (id === 'openai' || id === 'server' ? speechApis[id] : undefined)
const accountSpeech = new Map<string, SpeechApi>()
const remoteSpeech = new Map<string, SpeechApi>()
const claudeSpeechServices = new Map<string, ClaudeSpeech>()
function claudeSpeechService(id: string): ClaudeSpeech {
  const entry = accounts.get(id)
  if (entry.kind !== 'claude') throw new Error('Choose a Claude speech account.')
  let service = claudeSpeechServices.get(id)
  if (!service) { service = new ClaudeSpeech(new ClaudeSpeechAccess(entry.auth, () => entry.provider.listModels())); claudeSpeechServices.set(id, service) }
  return service
}
function speechAccount(agentId?: string) {
  const pinned = (!agentId || agentId === currentSession?.agentId) ? currentSession?.speechAccountId : undefined
  const settings = speechSettings(agentId), id = pinned || settings.accountId
  return id ? accounts.get(id) : settings.me === 'claude' ? selectedClaude(agentId) : callChatGPT(agentId)
}
function speechSettings(agentId?: string) {
  const current = (!agentId || agentId === currentSession?.agentId) ? currentSession : undefined
  if (current?.speechSettings) return current.speechSettings
  const owner = agentId || current?.agentId || getSettings().activeAgentId
  return effectiveSettings(getSettings(), agents.list().find(agent => agent.id === owner)).transcription
}
function callLanguage(agentId?: string): string {
  return (!agentId || agentId === currentSession?.agentId) && currentSession?.speechLanguage || speechSettings(agentId).language
}
function subscriptionSpeechFor(agentId?: string): SpeechApi {
  const entry = speechAccount(agentId), id = entry.metadata.id
  const inCall = currentSession?.speechAccountId === id && (!agentId || agentId === currentSession.agentId)
  const identity = inCall && callSpeechIdentity !== undefined ? callSpeechIdentity : entry.auth.identity()
  const language = callLanguage(agentId)
  const key = JSON.stringify([id, identity, language])
  let api = accountSpeech.get(key)
  if (!api) {
    api = subscriptionRecognizer(entry, () => claudeSpeechService(id), identity, () => language)
    api.onChange = () => send('stt:status', sttStatus())
    accountSpeech.set(key, api)
  }
  return api
}
/** The API picked to hear a side; null when this PC's models hear it. */
const speechApiFor = (speaker: Speaker, agentId?: string): SpeechApi | null => {
  const settings = speechSettings(agentId), source = settings[speaker]
  if (source === 'claude') return subscriptionSpeechFor(agentId)
  // Sign in with ChatGPT doesn't include transcription: a ChatGPT account's calls are heard by this PC.
  if (source === 'local' || source === 'chatgpt') return null
  const target = source === 'openai' ? { baseUrl: OPENAI_URL, model: settings.openaiModel || OPENAI_MODEL } : { baseUrl: settings.serverUrl, model: settings.serverModel }
  const call = !agentId || agentId === currentSession?.agentId ? currentSession?.id : undefined
  const key = JSON.stringify([source, target, call || 'defaults'])
  let api = remoteSpeech.get(key)
  if (!api) { api = speechApis[source].pinned(target); api.onChange = () => send('stt:status', sttStatus()); remoteSpeech.set(key, api) }
  return api
}

/** This PC's speech recognition: Parakeet when it's running, with Whisper behind it. */
function localSttStatus(): SttStatus {
  const status = whisper.status()
  if (!parakeet?.available) return status.state === 'ready' ? { ...status, detail: `Whisper ${status.detail}` } : status
  return { state: 'ready', detail: `Parakeet, with Whisper for unclear speech${status.state === 'ready' ? '' : ' (Whisper not ready)'}` }
}

/** Transcription status for the window: this PC's, and the API picked for a side, if one is. */
function sttStatus(agentId?: string): SttStatus {
  const status = { ...hearingStatus(localSttStatus(), { me: speechApiFor('me', agentId), them: speechApiFor('them', agentId) }), transcriptionLanguage: callLanguage(agentId), callId: !agentId || agentId === currentSession?.agentId ? currentSession?.id : undefined }
  const t = speechSettings(agentId)
  if (![t.me, t.them].some(source => source === 'claude')) return status
  const { id, provider, label, shared, email, signedIn } = accounts.identity(speechAccount(agentId).metadata.id)
  return { ...status, transcriptionAccount: { id, provider, label, shared, email, signedIn } }
}

const frameStore = new FrameStore()
let win: BrowserWindow | null = null
let protection: CaptureProtection | null = null
let recording = false
let tray: TogleTray | undefined
let quitting = false
/** Set by the window right before it opens the recorder stream: what getDisplayMedia should capture. */
let pendingRecordSource: string | null = null

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
  const id = copilot.isListening ? currentSession?.agentId : dictationAgentId
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
function selectedClaude(agentId?: string) {
  const entry = selectedAccount('claude', agentId)
  if (entry.kind !== 'claude') throw new Error('Choose a Claude subscription account.')
  return entry
}

/** Metadata-only discovery overlaps call setup; it never sends a model prompt. */
function warmWorkApps(agent: Agent): void {
  if (!agent.claudeConnections) return
  try { void selectedClaude(agent.id).provider.connections().catch(error => console.warn('[work apps] preparation:', (error as Error).message)) }
  catch { /* A missing route is explained when the agent requests its connected apps. */ }
}
function selectedChatGPT() {
  const entry = selectedAccount('chatgpt')
  if (entry.kind !== 'chatgpt') throw new Error('Choose a ChatGPT subscription account.')
  return entry
}
function callChatGPT(agentId?: string) {
  const agent = agents.list().find(agent => agent.id === (agentId || getSettings().activeAgentId))
  const pinnedCall = callAccountId && (!agentId || currentSession?.agentId === agentId) ? callAccountId : undefined
  const id = pinnedCall || accountChoice(getSettings(), agent?.subscriptionAccountId)
  const entry = id ? accounts.get(id) : undefined
  return entry?.kind === 'chatgpt' ? entry : selectedChatGPT()
}

/** Plain completion with the active model, for background work like studying documents. */
async function complete(system: string, user: string, agentId?: string): Promise<string> {
  let out = ''
  await activeProvider(agentId).stream({ system, user, lane: 'background' }, { signal: AbortSignal.timeout(180_000), onDelta: (t) => (out += t) })
  return out.trim()
}
// Files a user teaches agents with are read in a worker with its own memory and time limits. Text that isn't
// Unicode is read in the code page this PC's programs save it in, unless its words say another.
setReaderScript(path.join(__dirname, 'reader-worker.js'))
// Their chats on claude.ai and ChatGPT come from the export of them they download (a check of the window gives its
// own Downloads folder, with TOGLE_DOWNLOADS: never the real one).
setChatExports({
  list: path.join(app.getPath('userData'), 'chat-exports.json'),
  downloads: !app.isPackaged && process.env.TOGLE_DOWNLOADS !== undefined ? process.env.TOGLE_DOWNLOADS || undefined : app.getPath('downloads')
})
try {
  setCodePage(koffi.load('kernel32.dll').func('uint32_t __stdcall GetACP()')() as number)
} catch {
  // Not Windows: the PC's language tells.
}
const agents = new AgentStore(complete)
// Agents others made, read and checked, waiting for Install.
const installs = new Installs()

/** The file a check of the window picks in place of the file dialogs: Togle run from source, with TOGLE_PICK_FILE set. */
const pickedForTest = (): string | undefined => (app.isPackaged ? undefined : process.env.TOGLE_PICK_FILE) || undefined

/** The hubs added in Settings (a hand-edited settings.json may hold anything there). */
const addedHubs = (): string[] => {
  const hubs: unknown = getSettings().hubs
  return Array.isArray(hubs) ? hubs.filter((h): h is string => typeof h === 'string' && !!h.trim()) : []
}
/** The hubs to browse: the agents that come with Togle, its hub on GitHub (once there is one), then the ones added. */
const hubsNow = (): string[] => [...new Set([TOGLE_HUB, OFFICIAL_HUB, ...addedHubs()].filter(Boolean))]
/** Togle's own: what comes with it, and its hub on GitHub. */
const officialHub = (name: string): boolean => name === TOGLE_HUB || name === OFFICIAL_HUB
/**
 * Documents whose studying failed for a reason that passes (not signed in yet, no connection, the plan's limit), tried
 * again: at startup and after signing in, as nothing else asks for it.
 */
function studyAgain(): void {
  for (const agent of agents.list()) {
    if (!agent.knowledge.some((d) => d.error && /sign|auth|401|403|5\d\d|overload|unavailable|respond|network|fetch|timed? ?out|limit|ECONN|ENOTFOUND/i.test(d.error))) continue
    void agents.restudy(agent.id).catch((err: Error) => console.warn('[agents] could not study again:', err.message))
  }
}
/** A call the review found taught the agent, written up as notes and kept as one of its documents. */
async function keepLesson(id: string): Promise<{ agentId: string; docId?: string; name: string }> {
  const { agentId, name, text } = await copilot.keepLesson(id)
  const had = agents.list().find((a) => a.id === agentId)
  if (!had) throw new Error('That agent was deleted.')
  const known = new Set(had.knowledge.map((d) => d.id))
  const agent = await agents.addText(agentId, name, text)
  return { agentId, docId: agent.knowledge.find((d) => !known.has(d.id))?.id, name }
}
/** The agent of mine installed from this same version of a package, if there is one. */
const installedAs = (hash: string): { id: string; name: string } | undefined => {
  const agent = agents.list().find((a) => a.source?.hash === hash)
  return agent && { id: agent.id, name: agent.name }
}
// Summaries of each agent's past calls, to recall on later calls with the same people (Settings: on unless turned off).
const pastCalls = new PastCalls()
// Each agent's conversation, kept across restarts.
const conversations = new Conversations()
pastCalls.on('changed', (agentId: string, calls: PastCall[]) => send('past-calls:changed', { agentId, calls }))
agents.on('changed', (agent) => {
  send('agents:changed', agent)
  pruneCodeBases()
  calendar.sync()
  if ((copilot.isListening ? currentSession?.agentId : dictationAgentId) === agent.id) refreshVoiceSettings()
})
agents.on('removed', async (id: string) => {
  // Move the call to another agent before the window hears about the removal.
  try {
    if (getSettings().activeAgentId === id) await updateSettings({ activeAgentId: agents.list()[0]?.id ?? '' })
  } catch (err) {
    console.error('[agents] could not switch away from the removed agent:', err)
  }
  send('agents:removed', id)
  calendar.sync()
  pruneCodeBases()
  // What it kept of its calls goes with it, and a review still running for it keeps nothing; so does its conversation.
  await pastCalls.forget(id).catch((err: Error) => console.warn('[past calls] could not delete them:', err.message))
  await conversations.forget(id).catch((err: Error) => console.warn('[conversations] could not delete it:', err.message))
})

// Work sessions on this PC the window lists to add, newest first (a search looks through more).
const SESSIONS_SHOWN = 40

// An agent tidies up its training at most this often, after a call review, once it has learned enough to overlap.
const TIDY_EVERY_MS = 7 * 24 * 3600_000
const TIDY_AFTER_CHANGES = 5
/**
 * Tidies up an agent's training in the background (as Hermes Agent's curator does, when idle): not during a call, at
 * most weekly, once it has grown (several skills learned from calls, many answers, or memory nearly full) and changed.
 */
function tidyLater(agentId: string): void {
  const agent = agents.list().find((a) => a.id === agentId)
  if (!agent || copilot.isListening) return
  if (agent.tidiedAt && Date.now() - agent.tidiedAt < TIDY_EVERY_MS) return
  const grown = agent.skills.filter((s) => s.origin === 'call').length >= 4 || agent.answers.length >= 20 || memoryChars(agent.memory) > MEMORY_LIMIT * 0.8
  const changed = agent.history.filter((h) => h.at > (agent.tidiedAt ?? 0) && h.origin !== 'tidy').length >= TIDY_AFTER_CHANGES
  if (!grown || !changed) return
  void agents.tidy(agentId).then(
    ({ changes }) => console.info(`[tidy] ${agent.name}: ${changes} change${changes === 1 ? '' : 's'}`),
    (err: Error) => console.warn('[tidy]', err.message)
  )
}
// One CodeBase per set of project folders, so its file list is shared between answers.
const codeBases = new Map<string, CodeBase>()
/** Forgets code bases no agent uses any more. */
function pruneCodeBases(): void {
  const used = new Set(agents.list().map((a) => a.codeFolders.join('|')))
  for (const key of codeBases.keys()) if (!used.has(key)) codeBases.delete(key)
}
function codeBaseFor(folders: string[]): CodeBase | undefined {
  if (!folders.length) return undefined
  const key = folders.join('|')
  let codeBase = codeBases.get(key)
  if (!codeBase) codeBases.set(key, (codeBase = new CodeBase(folders)))
  return codeBase
}

let callProvider: LLMProvider | undefined
let callAI: AIProfile | undefined
let callAccountId: string | undefined
let callSpeechIdentity: string | undefined
let callUserName: string | undefined
const liveProvider = (): LLMProvider => callProvider ?? activeProvider(getSettings().activeAgentId)
const screenMonitor = new ScreenMonitor(liveProvider, () => copilot.timelineNow())
let screenSelection = 0
function stopScreenMonitoring(end = false, id?: string): void {
  if (!id) screenSelection++
  screenMonitor.stop(id, end)
}
screenMonitor.on('changed', status => send('screen-monitor:status', status))
screenMonitor.on('refresh', id => send('screen-monitor:refresh', id))
const copilot = new Copilot(
  send,
  liveProvider,
  {
    monitor: screenMonitor,
    snapshot: async (display) => {
      const { image, thumb } = await captureFrame(win, protection?.isHiddenFromCapture() ?? false, display)
      return frameStore.add('snapshot', Date.now(), image, thumb)
    },
    dataUrl: (frame, maxWidth) => frameStore.dataUrl(frame, maxWidth),
    miniature: (frame) => frameStore.miniature(frame),
    reset: () => frameStore.reset()
  },
  {
    active: () => agents.get(getSettings().activeAgentId),
    learnWords: async (agent, correction) => {
      const current = agents.list().find(item => item.id === agent.id)
      if (!current) return
      await agents.update(current.id, { vocabulary: withSpeechWord(current.vocabulary, correction.heardAs, correction.word) }, 'train')
    },
    get: (id) => agents.get(id),
    knowledgeFor: (agent, query, seen) => agents.knowledgeFor(agent, query, seen),
    search: (agent, query, seen, firstNumber) => agents.search(agent, query, seen, firstNumber),
    facts: (agent, question) => agents.factsFor(agent, question),
    code: (agent) => codeBaseFor(agent.codeFolders),
    noteUse: (agent, used) => agents.noteUse(agent.id, used),
    // What I told the agent in its conversation lately: my preparation goes with every answer of the call.
    talk: (agent) => conversations.talk(agent.id),
    pastCalls: {
      // Turned off, earlier calls kept before still aren't brought into answers.
      recall: async (agent, context) => (getSettings().assist.rememberCalls === false ? [] : pastCalls.recall(agent.id, context)),
      search: (agent, query) => pastCalls.search(agent.id, query),
      recent: async (agent, since) => getSettings().assist.rememberCalls === false ? [] : (await pastCalls.list(agent.id)).filter(call => call.at >= since && call.at <= Date.now() && call.callId !== currentCallKey)
    }
  },
  (timing) => perf.answer(timing),
  () => callUserName,
  activeProvider
)
// The call so far, saved as it goes: closing Togle or a crash doesn't lose it (call-file.ts).
// A call is something once anything is in it: what was said or shown, its brief written beforehand, an answer
// approved, or a card (a question typed before anyone spoke).
const callSessions = new CallSessions()
let currentSession: CallSessionInfo | undefined
let currentCallKey = frameStore.sessionId
const legacyCalls = new Map<string, CallSession>()
callSessions.on('changed', (id: string) => send('calls:changed', { id }))
const callFile = new CallFile((hasCards) => {
  const state = copilot.callState()
  const something = currentSession || state.transcript.length || state.frames.length || state.brief || state.callAnswers.length || hasCards
  return something ? { frameSession: frameStore.sessionId, state, session: currentSession } : null
}, async (saved) => {
  if (saved.session && getSettings().assist.rememberCalls !== false) {
    await callSessions.capture(saved.session, saved.frameSession, saved.state, saved.view)
    if (saved.session.status !== 'live') { scheduleCallReview(saved.session.id); scheduleCallTitle(saved.session.id) }
  }
})
copilot.onChange = () => callFile.changed()
const voiceMemory = new VoiceMemory(VOICE_MODEL.sha256, () => send('voices:people-changed', undefined))
const voices = new VoiceTracker((segment, voice, person) => copilot.identifyVoice(segment, voice, person), status => send('voices:status', status), {
  memory: voiceMemory, enabled: () => getSettings().assist.rememberVoices !== false,
  remembered: (voice, person) => copilot.rememberVoice(voice, person), revoked: segment => copilot.forgetVoiceSegment(segment)
})
const dictationTarget = new DictationTargetBridge(path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources'), 'dictation-windows.ps1'))
// Freeze the account, speech service and cleanup together for each recording.
const dictationVocabulary = new DictationVocabularyStore()
const dictationHistory = new DictationHistoryStore(accountId => send('dictation:history-changed', { accountId }))
const dictationHistoryRuns = new WeakMap<DictationEngine, Promise<DictationHistoryTicket | undefined>>()
/** Dictation heard by this PC's speech recognition: Parakeet for English when it's sure, Whisper otherwise. */
async function localDictation(pcm: Float32Array, language: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (localSttStatus().state !== 'ready') throw new Error("Dictation with a ChatGPT account is heard by this PC's speech recognition. Set it up in Settings → Speech to text.")
  if (parakeet?.available && speechLanguageCode(language) === 'en') {
    const heard = await parakeet.transcribe(pcm, { partial: false, stream: 'dictation' }).catch(() => null)
    if (heard?.text && heard.confidence >= 0.6) return heard.text
  }
  return (await whisper.transcribe(pcm, { language, partial: false, stream: 'dictation', dictation: true })).text
}
function createDictationSpeech(): DictationSpeech {
  meetingNotes.pauseAutomatic()
  callTitles.pause()
  const settings = structuredClone(voiceSettings()), source = dictationSource(settings)
  const speechId = settings.dictation.accountId || settings.transcription.accountId
  const entry = speechId ? accounts.get(speechId) : source ? selectedAccount(source) : undefined
  if (!entry) throw new Error('Choose a Claude or ChatGPT subscription account for dictation in Settings.')
  settings.provider = entry.kind; settings.claude.auth = 'subscription'; settings.dictation.speech = entry.kind
  const openai = entry.kind === 'chatgpt' ? entry : undefined, anthropic = entry.kind === 'claude' ? entry : undefined
  const provider = accounts.pinned(entry.metadata.id, false)
  const identity = entry.auth.identity()
  const api = subscriptionRecognizer(entry, () => claudeSpeechService(entry.metadata.id), identity, () => settings.transcription.language)
  if (anthropic) claudeSpeechService(entry.metadata.id)
  const scopedSpeechWords = speechWords(agents.get(copilot.isListening ? currentSession?.agentId || getSettings().activeAgentId : dictationAgentId || getSettings().activeAgentId).vocabulary)
  const speech = new DictationSpeech({
    vocabulary: dictationVocabulary.get(entry.metadata.id).then(vocabulary => {
      const scoped = scopedSpeechWords
      const aliases = new Set(scoped.map(item => item.heardAs.toLocaleLowerCase()))
      return { ...vocabulary, words: [...vocabulary.words.filter(item => !aliases.has(item.heardAs.toLocaleLowerCase())), ...scoped] }
    }),
    settings: () => settings, chatgpt: provider, claude: provider,
    chatgptAccount: () => openai?.auth.status() ?? { signedIn: false },
    claudeAccount: () => anthropic?.auth.status() ?? Promise.resolve({ signedIn: false }),
    // A ChatGPT account's dictation is heard by this PC (Sign in with ChatGPT doesn't include transcription); ChatGPT
    // still cleans it up, when that's on.
    remote: (pcm, language, signal) => openai ? localDictation(pcm, language, signal) : api.transcribe(pcm, { language, vocabulary: '', signal, dictation: true }),
    claudeSpeech: (language, email, signal) => claudeSpeechServices.get(entry.metadata.id)!.prepare(language, email, signal),
    claudeStream: entry.kind === 'claude' ? (language, email, signal) => claudeSpeechServices.get(entry.metadata.id)!.open(language, email, signal) : undefined
  })
  dictationHistoryRuns.set(speech, dictationHistory.begin(entry.metadata.id).catch(error => { console.warn('[dictation history]', (error as Error).message); return undefined }))
  return speech
}
const dictationWindow = new DictationWindow(() => dictation.cancel())
// Togle Microphone, the separate app that cleans the microphone for every call app, when it's on this computer.
// Test runs look in a folder of their own, never at the real one.
const microphoneLink = new MicrophoneLink({
  folder: !app.isPackaged && process.env.TOGLE_MICROPHONE_FOLDER ? process.env.TOGLE_MICROPHONE_FOLDER : path.join(app.getPath('appData'), MICROPHONE_PRODUCT),
  client: { name: 'togle', version: app.getVersion() },
  open: url => shell.openExternal(url)
})
const microphoneLinkOn = (): boolean => app.isPackaged || process.env.TOGLE_HEADLESS !== '1' || !!process.env.TOGLE_MICROPHONE_FOLDER
let microphoneNoticeShown = false
microphoneLink.on('changed', status => {
  send('microphone:changed', status)
  // Togle turned it on for this call and it stopped: the call may be silent.
  if (status.forCall && status.state?.phase === 'error' && !microphoneNoticeShown && !quitting && !win?.isVisible() && Notification.isSupported()) {
    microphoneNoticeShown = true
    const notice = new Notification({ title: 'Togle Microphone stopped', body: 'Your call may be silent. Open Togle Microphone to reconnect, or choose your microphone in the call app.' })
    notice.on('click', () => void microphoneLink.show().catch(() => openWindow()))
    notice.show()
  }
  if (status.state?.phase !== 'error') microphoneNoticeShown = false
})
const dictation = new Dictation({
  target: dictationTarget, speech: createDictationSpeech,
  inCall: () => copilot.isListening,
  microphone: () => voiceSettings().dictation.microphoneId,
  completed: (receipt, speech) => { void dictationHistoryRuns.get(speech)?.then(ticket => dictationHistory.record(ticket, receipt)).catch(error => console.warn('[dictation history]', (error as Error).message)) },
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
function refreshTray(): void {
  const shortcut = hotkeyStatus.find(item => item.id === 'dictate')
  tray?.update(dictation.status(), shortcut?.ok ? shortcut.keys : '', voiceSettings().dictation.showBar, copilot.isListening)
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
  const id = copilot.isListening ? currentSession?.agentId : dictationAgentId, agent = agents.list().find(agent => agent.id === id)
  if (agent?.preferences?.dictation) await agents.update(agent.id, { preferences: { ...agent.preferences, dictation: { ...agent.preferences.dictation, showBar: visible } } })
  else { const settings = await updateSettings({ dictation: { showBar: visible } }); send('settings:changed', settings) }
  refreshVoiceSettings()
}
async function requestQuit(confirmed = false): Promise<void> {
  if (quitting) return
  if (!confirmed && !pageDown && !pageFailed && (copilot.isListening || recording || dictation.active)) {
    openWindow(); send('window:confirm-close', true); return
  }
  quitting = true; closeConfirmed = true
  dictation.dispose(); voices.stop()
  // What Togle turned on for the call goes off with it; Togle Microphone itself keeps running.
  await Promise.race([microphoneLink.endCall(), new Promise(resolve => setTimeout(resolve, 1500))])
  microphoneLink.stop()
  try { await Promise.all([meetingNotes.stop(), callTitles.stop()]); await voices.flush(); await callFile.flush(); await dictationHistory.flush() }
  catch (error) { console.warn('[quit] could not finish saving:', (error as Error).message) }
  finally { app.quit() }
}
function dictationEscape(): void {
  if (dictation.active && dictation.status().phase !== 'inserting' && !hotkeysOff) {
    if (!globalShortcut.isRegistered('Escape')) tryKeys('Escape', () => dictation.cancel())
  } else globalShortcut.unregister('Escape')
}
const calendar = new AgentCalendars(() => agents.list(), (id, agentId) => {
  const entry = accounts.get(id)
  if (entry.kind !== 'claude') throw new Error('Choose a Claude subscription for this agent’s calendar.')
  const expected = agents.list().find(agent => agent.id === agentId)?.calendar?.accountEmail
  if (expected && entry.auth.cachedStatus().email?.toLowerCase() !== expected.toLowerCase()) throw new Error('The calendar account changed. Select the intended Claude account in this agent’s reminders.')
  return { connections: async refresh => { const catalog = await entry.provider.connections(refresh); if (expected && catalog.account.toLowerCase() !== expected.toLowerCase()) throw new Error('The calendar identity changed. Select the intended Claude account in this agent’s reminders.'); return catalog }, stream: (input, options) => accounts.pinned(id, false).stream(input, options) }
}, () => copilot.isListening,
  status => send('calendar:status', status), event => {
    if (Notification.isSupported()) {
      const notice = new Notification({ title: `Togle · ${event.agentName}`, body: `${event.title}. Open Togle to start assistance.`, silent: true })
      notice.on('click', () => { win?.show(); win?.focus(); send('calendar:status', calendar.status()) })
      notice.show()
    }
  })
const currentCall = () => ({ ...copilot.currentCall(), session: currentSession, view: { cards: [], reviewedLines: 0, ...callFile.view, key: currentCallKey }, restoredFrom })
const callLearning = new CallLearning(callSessions, {
  agent: id => {
    const agent = agents.list().find(agent => agent.id === id)
    if (!agent) throw new Error('This call’s agent was deleted.')
    return agent
  },
  apply: (id, lessons, auto, source) => agents.applyLessons(id, lessons, auto, source),
  review: async (record) => {
    if (record.id === currentCallKey && record.agentId === getSettings().activeAgentId) return copilot.learn((callFile.view?.cards ?? []) as CallCard[], record.frameSession)
    const provider = record.ai ? routedAI(record.ai) : record.accountId ? accounts.pinned(record.accountId) : activeProvider(record.agentId)
    const archived = new Copilot(() => {}, () => provider, {
      snapshot: async () => { throw new Error('Archived calls cannot capture the screen.') }, dataUrl: async () => '', reset: async () => {}
    }, {
      active: () => agents.get(record.agentId), get: id => agents.get(id),
      knowledgeFor: (agent, query, seen) => agents.knowledgeFor(agent, query, seen), search: (agent, query, seen, first) => agents.search(agent, query, seen, first), facts: (agent, query) => agents.factsFor(agent, query), code: () => undefined
    })
    archived.restore({ transcript: record.transcript, frames: [], notes: record.notes, notesUntil: 0, answeredUntil: 0, callAnswers: record.callAnswers.map(answer => ({ ...answer, reviewed: false })), brief: record.brief, group: record.group })
    return archived.learn(record.suggestions as CallCard[], record.frameSession)
  },
  summary: async (_record, review) => {
    if (review.record && getSettings().assist.rememberCalls !== false) await pastCalls.add(review.agentId, review.record)
  }
})
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
  if (copilot.isListening || dictation.active) { armCallTitles(15000); return }
  const id = titleQueue.values().next().value
  if (!id) return
  titleQueue.delete(id); namingCall = true
  let delay = 1500
  try {
    const record = await callSessions.get(id)
    if (record?.minutes?.state === 'generating' || callLearning.isBusy(id)) { titleQueue.add(id); delay = 15000 }
    else {
      const named = await callTitles.generate(id)
      if (named?.titleRetryAt && named.titleRetryAt > Date.now()) delay = 60000
    }
    if (copilot.isListening || dictation.active) titleQueue.add(id)
  } catch (error) { console.warn('[call naming]', (error as Error).message) }
  finally { namingCall = false; armCallTitles(delay) }
}

// History, agent learning and chat can refresh together. Share one snapshot and one recovery flush.
let listingCalls: Promise<CallSessionSummary[]> | undefined
function listCallSessions(): Promise<CallSessionSummary[]> {
  if (listingCalls) return listingCalls
  const task = (async () => {
    await callFile.flush()
    const saved = await callSessions.list()
    for (const record of saved) if (!record.customTitle && record.titleSource === 'fallback' && record.status !== 'live' && (!record.titleKey || record.titleRetryAt && record.titleRetryAt <= Date.now())) scheduleCallTitle(record.id)
    const ids = new Set(saved.map(record => record.id))
    const frames = new Set(saved.map(record => record.frameSession).filter(Boolean))
    const groups = await Promise.all(agents.list().map(async agent => ({ agent, calls: await pastCalls.list(agent.id) })))
    legacyCalls.clear()
    for (const { agent, calls } of groups) for (const past of calls) {
      const id = `legacy-${past.id}`
      if (ids.has(id) || (past.callId && frames.has(past.callId))) continue
      legacyCalls.set(id, legacySession(past, agent.name))
    }
    return [...saved, ...[...legacyCalls.values()].map(sessionSummary)].sort((a, b) => b.startedAt - a.startedAt)
  })()
  listingCalls = task
  void task.then(() => { if (listingCalls === task) listingCalls = undefined }, () => { if (listingCalls === task) listingCalls = undefined })
  return task
}

async function getCallSession(id: string): Promise<CallSession | null> {
  return await callSessions.get(id) ?? legacyCalls.get(id) ?? null
}
const savedCalls = new SavedCallReader({ list: listCallSessions, get: async id => {
  if (id.startsWith('legacy-')) await listCallSessions()
  return getCallSession(id)
} })
async function storedCallSession(id: string): Promise<CallSession> {
  const stored = await callSessions.get(id)
  if (stored) return stored
  const legacy = legacyCalls.get(id)
  if (!legacy) throw new Error('This call is no longer available.')
  return callSessions.put(legacy)
}
const automaticReviews = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleCallReview(id: string, delay = 1500): void {
  const before = automaticReviews.get(id)
  if (before) clearTimeout(before)
  const timer = setTimeout(() => {
    automaticReviews.delete(id)
    void (async () => {
      if (quitting || getSettings().assist.rememberCalls === false || callLearning.isBusy(id)) return
      const record = await callSessions.get(id)
      const owner = record && agents.list().find(agent => agent.id === record.agentId)
      if (!record || !owner || record.status === 'live' || (!record.transcript.length && !record.callAnswers.length)) return
      if (copilot.isListening || dictation.active) { scheduleCallReview(id, 15000); return }
      if (record.transcript.length && getSettings().assist.autoNotes !== false) {
        const notes = await meetingNotes.generate(id, undefined, undefined, true).catch(error => { console.warn('[meeting notes]', (error as Error).message); return undefined })
        if (notes?.minutes?.state === 'idle') { scheduleCallReview(id, 15000); return }
      }
      if (quitting || getSettings().assist.rememberCalls === false) return
      if (copilot.isListening || dictation.active) { scheduleCallReview(id, 15000); return }
      if (owner.learning !== 'off' && (record.transcript.length >= 2 || record.callAnswers.length)) await callLearning.review(id)
    })().catch(error => console.warn('[call learning]', (error as Error).message))
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
 * (Windows leaves it out of screenshots, screen sharing and recordings). While recording it's always
 * hidden, so Togle never records (or reacts to) its own window.
 */
function applyWindowSettings(): void {
  if (!win || win.isDestroyed()) return
  const { alwaysOnTop, opacity, hideFromCapture } = getSettings().window
  if (win.isAlwaysOnTop() !== alwaysOnTop) win.setAlwaysOnTop(alwaysOnTop, 'floating')
  win.setOpacity(Math.min(1, Math.max(MIN_OPACITY, opacity || 1)))
  protection?.set(recording || hideFromCapture)
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
    if (!closeConfirmed && !pageDown && !pageFailed && (copilot.isListening || recording)) {
      e.preventDefault()
      win?.show()
      send('window:confirm-close', true)
      return
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
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

/**
 * The window's page is gone or loaded again (Reload after an error): the listening and the recording ran in it,
 * and stopped with it. Otherwise closing would ask about a call that isn't running, and the window would stay
 * hidden from capture for a recording that isn't.
 */
function pageStopped(): void {
  stopScreenMonitoring(true)
  if (copilot.isListening) copilot.setListening(false)
  if (recording) {
    recording = false
    applyWindowSettings()
  }
}

function setupMediaAccess(): void {
  const allowed = new Set(['media', 'display-capture', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission))
  // getDisplayMedia() in the renderer is answered without a picker. With audio it's the listener: WASAPI
  // loopback gives us everything the PC plays, the other side of the call (its video track is unused).
  // Without audio it's the screen recorder, which captures the source the window asked for.
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    let streams: Electron.Streams | null = null
    try {
      if (!request.audioRequested) {
        const requested = pendingRecordSource
        pendingRecordSource = null
        const source = requested ? await resolveCaptureSource(requested) : undefined
        if (source) streams = { video: source }
      } else {
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

// Global shortcuts steal the combination from every other app, so Togle's own avoid Ctrl+Shift+letter (editor
// shortcuts) and Ctrl+Alt+letter (AltGr characters on many European layouts), and keys picked in Settings are checked
// the same way (hotkeyProblem). The last two have no keys until they're given some.
const HOTKEYS: { id: HotkeyId; keys: string; label: string; run: () => void }[] = [
  { id: 'dictate', keys: 'F9', label: 'Dictation', run: () => void dictation.toggle() },
  { id: 'suggest', keys: 'Ctrl+Alt+Space', label: 'Suggest', run: () => void copilot.assist({ kind: 'suggest' }) },
  { id: 'suggest-screen', keys: 'Ctrl+Alt+Enter', label: 'Suggest from the screen', run: () => void copilot.assist({ kind: 'suggest', withScreen: true }) },
  { id: 'deeper', keys: 'Ctrl+Alt+Shift+D', label: 'Think deeper', run: () => copilot.deeper() },
  { id: 'listen', keys: 'Ctrl+Alt+Shift+L', label: 'Start or end a call', run: () => send('hotkey', 'toggle-listening') },
  { id: 'snapshot', keys: 'Ctrl+Alt+Shift+S', label: 'Save a picture of the screen for the call', run: () => send('hotkey', 'snapshot') },
  { id: 'record', keys: 'Ctrl+Alt+Shift+R', label: 'Watch the screen, or stop', run: () => send('hotkey', 'toggle-recording') },
  // Minimized counts as hidden: the hotkey brings it back.
  { id: 'show', keys: 'Ctrl+Alt+Shift+H', label: 'Show or hide Togle', run: () => (win?.isVisible() && !win.isMinimized() ? win.hide() : win?.showInactive()) },
  {
    id: 'ask',
    keys: '',
    label: 'Bring Togle up, ready to type',
    run: () => {
      win?.show()
      win?.focus()
      send('hotkey', 'ask')
    }
  },
  { id: 'copy', keys: '', label: 'Copy the newest suggestion', run: () => send('hotkey', 'copy') }
]
let hotkeyStatus: HotkeyInfo[] = []
const keyDown = process.platform === 'win32' ? koffi.load('user32.dll').func('int16_t __stdcall GetAsyncKeyState(int)') : undefined
const dictationPress = new HotkeyPress(key => !!keyDown && !!((keyDown(key) as number) & 0x8000))
let heldDictation: string | undefined
function dictateShortcut(keys: string): void {
  if (voiceSettings().dictation.mode !== 'hold' || !keyDown) { dictationPress.run(keys, () => void dictation.toggle()); return }
  dictationPress.run(keys, () => {
    if (dictation.active) return
    void dictation.start(true)
    heldDictation = dictation.status().id
  }, () => {
    const id = heldDictation; heldDictation = undefined
    if (id && dictation.status().id === id) dictation.stop()
  })
}
// What a test run copied (dev only): there, it's kept here rather than put on the PC's clipboard.
let testClipboard: string | undefined
// Off while keys are pressed for one in Settings (else pressing one of them would do it); back after this long anyway.
let hotkeysOff: ReturnType<typeof setTimeout> | undefined
const HOTKEYS_OFF_MS = 30_000

/** A shortcut's keys now: the ones picked in Settings (none: turned off), else its own. */
const keysOf = (h: (typeof HOTKEYS)[number]): string => getSettings().hotkeys[h.id] ?? h.keys

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
    const ok = !keys || tryKeys(keys, () => h.id === 'dictate' ? dictateShortcut(keys) : h.run())
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
  ipcMain.handle('microphone:status', () => microphoneLinkOn() ? microphoneLink.refresh() : microphoneLink.status())
  ipcMain.handle('microphone:prepare-call', () => microphoneLinkOn() ? microphoneLink.prepareCall(getSettings().microphone) : microphoneLink.status())
  ipcMain.handle('microphone:turn-on', () => microphoneLink.turnOn('user'))
  ipcMain.handle('microphone:turn-off', () => microphoneLink.turnOff())
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
  ipcMain.handle('dictation:history-correct', (_event, accountId: string, id: string, revision: string, text: string) => { accounts.get(accountId); return dictationHistory.correct(accountId, id, revision, text) })
  ipcMain.handle('dictation:history-remove', (_event, accountId: string, id?: string) => { accounts.get(accountId); if (id !== undefined && typeof id !== 'string') throw new Error('Choose a recent dictation.'); return dictationHistory.remove(accountId, id) })
  ipcMain.on('dictation:expand', (event, expanded: boolean, explicit: boolean) => {
    if (dictationWindow.owns(event.sender) && typeof expanded === 'boolean') dictationWindow.setExpanded(expanded, explicit === true)
  })
  ipcMain.on('dictation:drag', (event, action: string, x: number, y: number) => { if (dictationWindow.owns(event.sender)) dictationWindow.drag(action, x, y) })
  ipcMain.handle('dictation:toggle', () => dictation.toggle())
  ipcMain.handle('dictation:cancel', () => dictation.cancel())
  ipcMain.handle('dictation:original', (_event, id: string) => { if (typeof id === 'string') dictation.useOriginal(id) })
  ipcMain.on('dictation:audio', (event, id: string, pcm: Float32Array) => { if (dictationWindow.owns(event.sender)) dictation.push(id, pcm) })
  ipcMain.handle('dictation:finish', (event, id: string) => { if (dictationWindow.owns(event.sender)) return dictation.finish(id) })
  ipcMain.on('dictation:failed', (event, id: string, message: string) => { if (dictationWindow.owns(event.sender)) dictation.failed(id, typeof message === 'string' ? message.slice(0, 500) : 'Microphone unavailable.') })
  ipcMain.handle('dictation:copy', copyLastDictation)
  ipcMain.handle('dictation:settings', openDictationSettings)
  ipcMain.handle('dictation:agent', (_e, id?: string) => { if (id) agents.get(id); dictationAgentId = id; refreshVoiceSettings() })
  ipcMain.handle('calendar:status', (_e, id?: string) => calendar.status(id))
  ipcMain.handle('calendar:refresh', (_e, id?: string) => calendar.refresh(id))
  ipcMain.handle('calendar:dismiss', (_e, id: string) => { if (typeof id === 'string') calendar.dismiss(id) })
  ipcMain.handle('settings:get', event => event.sender && dictationWindow.owns(event.sender) ? voiceSettings() : getSettings())
  ipcMain.handle('settings:update', (_e, patch: SettingsPatch) => {
    if ((copilot.isListening || currentSession) && patch?.activeAgentId && patch.activeAgentId !== getSettings().activeAgentId) throw new Error('Start a new call before changing its agent.')
    const previousAgent = getSettings().activeAgentId
    if (patch.ai) validateProfile(patch.ai as AIProfile)
    if ((patch.provider || patch.subscriptionAccountId !== undefined) && patch.ai === undefined) patch = { ...patch, ai: null }
    if (patch.dictation?.accountId) accounts.get(patch.dictation.accountId)
    if (patch.transcription?.accountId) accounts.get(patch.transcription.accountId)
    if (patch.subscriptionAccountId) {
      const entry = accounts.get(patch.subscriptionAccountId)
      patch = { ...patch, provider: entry.kind, ...(entry.kind === 'claude' ? { claude: { ...patch.claude, auth: 'subscription' } } : {}) }
    } else if (patch.provider && patch.provider !== getSettings().provider) patch = { ...patch, subscriptionAccountId: '' }
    const saved = updateSettings(patch)
    void saved.then(settings => send('settings:changed', settings))
    if (patch.subscriptionAccountId !== undefined || patch.provider || patch.claude?.auth) {
      send('auth:changed', selectedChatGPT().auth.status())
      void selectedClaude().auth.status().then(status => send('claude:auth-changed', status))
    }
    if (patch?.assist?.calendarReminders !== undefined) { calendar.cancel(); void calendar.refresh() }
    if (patch?.assist?.voiceLabels !== undefined && copilot.isListening) { if (patch.assist.voiceLabels) void voices.start(); else voices.stop() }
    if (patch?.assist?.rememberVoices !== undefined) void voices.memoryChanged()
    if (patch?.assist?.autoNotes === false || patch?.assist?.rememberCalls === false) meetingNotes.pauseAutomatic()
    if (patch?.assist?.rememberCalls === false) { callTitles.pause(); titleQueue.clear() }
    if (getSettings().activeAgentId !== previousAgent) void copilot.refreshAgent()
    // Right away, not after the save: dragging the opacity slider should feel live.
    applyWindowSettings()
    if (patch?.dictation) refreshVoiceSettings()
    // Saving near the plan's limit may have been turned on or off.
    selectedChatGPT().provider.plan.update()
    // What hears each side may be another now: why the one before didn't hear a line isn't this one's problem.
    if (patch?.transcription) {
      for (const api of [...Object.values(speechApis), ...accountSpeech.values()]) api.reset()
      send('stt:status', sttStatus())
    }
    return saved
  })

  ipcMain.handle('accounts:list', (_e, refresh?: boolean) => accounts.list(refresh === true))
  ipcMain.handle('connections:list', () => apiConnections.list())
  ipcMain.handle('connections:add', (_e, input) => apiConnections.add(input))
  ipcMain.handle('connections:update', (_e, id, input) => apiConnections.update(id, input))
  ipcMain.handle('connections:remove', (_e, id: string) => {
    const used = [getSettings().ai, currentSession?.ai, ...agents.list().map(agent => agent.preferences?.ai)].some(profile => profile && Object.values(profile.tasks).some(task => task.sourceId === id))
    if (used) throw new Error('This connection is used by AI settings or the current call. Choose another connection there first.')
    return apiConnections.remove(id)
  })
  ipcMain.handle('accounts:add', (_e, provider, label) => accounts.add(provider, label))
  ipcMain.handle('accounts:sign-in', (_e, id: string, device?: boolean) => accounts.signIn(id, device === true))
  ipcMain.handle('accounts:cancel', (_e, id: string) => accounts.cancel(id))
  ipcMain.handle('accounts:sign-out', (_e, id: string) => accounts.signOut(id))
  ipcMain.handle('auth:status', () => selectedChatGPT().auth.status())
  ipcMain.handle('auth:browser', async () => { await accounts.signIn(selectedChatGPT().metadata.id); return selectedChatGPT().auth.status() })
  ipcMain.handle('auth:device', async () => { await accounts.signIn(selectedChatGPT().metadata.id, true); return selectedChatGPT().auth.status() })
  ipcMain.handle('auth:cancel', () => accounts.cancel(selectedChatGPT().metadata.id))
  ipcMain.handle('auth:sign-out', async () => { await accounts.signOut(selectedChatGPT().metadata.id); return selectedChatGPT().auth.status() })
  auth.on('changed', (status) => {
    send('auth:changed', status)
    send('stt:status', sttStatus())
    if (status.signedIn) {
      void chatgpt.refreshUsage()
      studyAgain()
    } else chatgpt.plan.clear()
  })
  // How much of the ChatGPT plan's limits is used; asking the backend costs nothing, and happens at most once a minute.
  ipcMain.handle('plan:usage', () => (getSettings().provider === 'chatgpt' && selectedChatGPT().auth.status().signedIn ? selectedChatGPT().provider.refreshUsage() : null))

  ipcMain.handle('compat:has-key', () => compat.hasApiKey())
  ipcMain.handle('compat:set-key', (_e, key: string) => compat.setApiKey(key))
  ipcMain.handle('claude:has-key', () => claude.hasApiKey())
  ipcMain.handle('claude:set-key', (_e, key: string) => claude.setApiKey(key))
  ipcMain.handle('claude:auth-status', () => selectedClaude().auth.status(true))
  ipcMain.handle('claude:connections', (_e, refresh?: boolean, agentId?: string) => selectedClaude(agentId).provider.connections(refresh === true))
  ipcMain.handle('agents:claude-connections', async (_e, id: string, servers: string[]) => {
    if (!agents.list().some(agent => agent.id === id)) throw new Error('Agent not found')
    if (!Array.isArray(servers) || servers.length > 30 || servers.some(name => typeof name !== 'string')) throw new Error('Choose apps from your Claude connections.')
    if (!servers.length) return agents.update(id, { claudeConnections: undefined }, 'manual')
    const catalog = await selectedClaude(id).provider.connections()
    const names = [...new Set(servers)]
    if (names.some(name => !catalog.apps.some(app => app.name === name && app.status === 'connected' && app.readTools > 0))) throw new Error('An app is no longer connected. Refresh the list and try again.')
    return agents.update(id, { claudeConnections: { account: catalog.account, servers: names } }, 'manual')
  })
  ipcMain.handle('claude:sign-in', async () => { await accounts.signIn(selectedClaude().metadata.id); return selectedClaude().auth.status() })
  ipcMain.handle('claude:cancel-sign-in', () => accounts.cancel(selectedClaude().metadata.id))
  ipcMain.handle('claude:sign-out', async () => { await accounts.signOut(selectedClaude().metadata.id); return selectedClaude().auth.status() })
  let connectedClaudeAccount = ''
  const calendarIdentities = new Map<string, string | undefined>()
  accounts.onChange = (status) => {
    if (quitting) return
    send('accounts:changed', undefined)
    if (status.provider === 'claude') { const identity = accounts.get(status.id).auth.identity(); if (calendarIdentities.get(status.id) !== identity) calendar.clear(status.id); calendarIdentities.set(status.id, identity) }
    for (const [key, speech] of accountSpeech) if ((JSON.parse(key) as string[])[0] === status.id) speech.reset()
    if (status.signedIn) studyAgain()
    if (status.id !== selectedAccount(status.provider).metadata.id) return
    if (status.provider === 'chatgpt') {
      send('auth:changed', status); send('stt:status', sttStatus())
      if (status.signedIn) studyAgain()
      return
    }
    const account = status.signedIn ? status.email ?? '' : ''
    if (account !== connectedClaudeAccount) { claudeSubscription.clearConnections(); connectedClaudeAccount = account }
    send('claude:auth-changed', status)
    if (status.signedIn && getSettings().provider === 'claude' && getSettings().claude.auth === 'subscription') studyAgain()
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
  ipcMain.handle('speech:has-key', (_e, id: SpeechApiId) => speechApi(id)?.hasKey() ?? false)
  ipcMain.handle('speech:set-key', async (_e, id: SpeechApiId, key: string) => { await speechApi(id)?.setKey(String(key ?? '')); for (const cacheKey of remoteSpeech.keys()) if (!(JSON.parse(cacheKey) as unknown[])[2] || (JSON.parse(cacheKey) as unknown[])[2] === 'defaults') remoteSpeech.delete(cacheKey); send('stt:status', sttStatus()) })
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
  ipcMain.handle('speech:remove', async () => {
    stopLocalSpeech()
    await speech.remove()
    startLocalSpeech()
  })
  let callAudioPaused = false
  const audioEpoch = { me: 0, them: 0 }
  const routedFinals: Record<Speaker, Promise<void>> = { me: Promise.resolve(), them: Promise.resolve() }
  const onSegment = hearing({
    normalize: text => speechLesson(text) ? text : correctSpeech(text, speechWords(agents.get(currentSession?.agentId || getSettings().activeAgentId).vocabulary)),
    parakeet: () => parakeet,
    whisper,
    api: (speaker) => {
      const api = speechApiFor(speaker)
      return api?.canHear() ? api : null
    },
    language: () => callLanguage(),
    // The user's own names last: Whisper keeps the end of a prompt too long for it, and in a group call they're how
    // Togle tells a question is theirs.
    vocabulary: async () => {
      const agent = agents.get(currentSession?.agentId || getSettings().activeAgentId)
      warmWorkApps(agent)
      // With the names I wrote to it lately: who the calls to come are with.
      const words = await agents.vocabularyFor(agent, await conversations.talk(agent.id).catch(() => []))
      const names = getSettings().assist.names?.trim()
      return names ? `${words ? `${words.replace(/\.$/, '')}, ` : ''}${names}.` : words
    },
    copilot,
    caption: (caption) => send('transcript:partial', { ...caption, ...(caption.speaker === 'them' ? copilot.speakerForSegment(caption.segmentId) : {}) }),
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
      else if (copilot.isListening && getSettings().assist.voiceLabels !== false) void voices.start()
    }
  })
  ipcMain.on('audio:segment', (_e, speaker: Speaker, pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind) => {
    if (!['me', 'them'].includes(speaker) || !(pcm instanceof Float32Array) || pcm.length > 30 * 16000 || !pcm.every(Number.isFinite) || !Number.isFinite(startedAt) || typeof segmentId !== 'string' || segmentId.length > 160 || !['partial', 'pause', 'final'].includes(kind)) return
    if (speaker === 'me' && pcm instanceof Float32Array && dictation.overlaps(startedAt, startedAt + pcm.length / 16)) return
    if (copilot.isListening && speaker === 'them' && !callAudioPaused && kind === 'final' && pcm.length) {
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
          if (currentCallKey === call && audioEpoch.them === epoch) { copilot.forgetVoiceSegment(segmentId); void onSegment(speaker, pcm, startedAt, segmentId, kind) }
          console.warn('[speaker routing]', (error as Error).message)
        } finally { delivered() }
      })()
      return
    }
    if (copilot.isListening && speaker === 'them' && !callAudioPaused && kind !== 'final') voices.hear(segmentId, pcm, startedAt, true)
    void onSegment(speaker, pcm, startedAt, segmentId, kind)
  })

  ipcMain.handle('session:listening', async (_e, value: boolean, meetingId?: string) => {
    if (meetingId !== undefined && (typeof meetingId !== 'string' || meetingId.length > 500)) throw new Error('Choose a valid calendar meeting.')
    if (value) { meetingNotes.pauseAutomatic(); callTitles.pause() }
    if (value) calendar.cancel()
    if (value && !callAudioPaused && getSettings().assist.voiceLabels !== false && (app.isPackaged || process.env.TOGLE_SILENT_AUDIO !== '1')) void voices.start()
    else if (!value) await voices.finish()
    else voices.stop()
    if (!value) {
      stopScreenMonitoring(true)
      recording = false
      applyWindowSettings()
    }
    if (value) {
      const agent = agents.get(getSettings().activeAgentId)
      if (currentSession && currentSession.agentId !== agent.id) throw new Error('Start a new call before choosing a different agent.')
      if (!callProvider) {
        const profile = currentSession?.ai || configuredAI(agent.id)
        callAccountId = currentSession?.accountId ?? (profile ? !isApiSource(profile.tasks.deep.sourceId) ? profile.tasks.deep.sourceId : undefined : accountChoice(getSettings(), agent.subscriptionAccountId))
        callProvider = profile ? routedAI(profile) : callAccountId ? accounts.pinned(callAccountId) : activeProvider(agent.id)
        callUserName = callAccountId ? accounts.identity(callAccountId).name : undefined
        callAI = profile
      }
      const speechAccountId = currentSession?.speechAccountId || speechAccount(agent.id).metadata.id
      if (!currentSession || callSpeechIdentity === undefined) callSpeechIdentity = accounts.get(speechAccountId).auth.identity()
      const meeting = currentSession?.meeting ?? (!currentSession ? meetingForCall(calendar.status(agent.id), agent.id, Date.now(), meetingId) : undefined)
      currentSession = { ...currentSession, id: currentCallKey, agentId: agent.id, agentName: agent.name, accountId: callAccountId, ai: currentSession?.ai || callAI, speechAccountId, speechSettings: currentSession?.speechSettings || structuredClone(speechSettings(agent.id)), speechLanguage: currentSession?.speechLanguage || speechSettings(agent.id).language, meeting: meeting && { id: meeting.id, title: meeting.title, start: meeting.start, end: meeting.end }, startedAt: currentSession?.startedAt ?? Date.now(), endedAt: undefined, status: 'live' }
    } else if (currentSession) currentSession = { ...currentSession, status: 'ended', endedAt: Date.now() }
    if (!value) void microphoneLink.endCall()
    copilot.setListening(value)
    refreshVoiceSettings()
    callFile.changed()
    await callFile.flush()
    // The work sessions the call's agent has, as they are now: worked on since they were added, they're read again.
    if (value) void agents.refreshSessions(getSettings().activeAgentId).catch((err: Error) => console.warn('[agents] work sessions not read again:', err.message))
    // What the call used of the agent's training is written once it's over, not while it goes on.
    if (!value) void agents.saveUses().catch((err: Error) => console.warn('[agents] uses not written:', err.message))
    // The call's share of the plan's limit counts from here.
    const usedAccounts = currentSession?.ai ? [...new Set(Object.values(currentSession.ai.tasks).map(task => task.sourceId).filter(id => !isApiSource(id)))] : callAccountId ? [callAccountId] : []
    for (const id of usedAccounts) { const entry = accounts.get(id); if (value && entry.kind === 'chatgpt' && entry.auth.status().signedIn) { entry.provider.plan.callStarted(); void entry.provider.refreshUsage() } }
    return currentSession
  })
  const clearCurrentCall = async (notify = false) => {
    voices.reset()
    stopScreenMonitoring(true)
    await callFile.flush()
    onSegment.reset()
    callAudioPaused = false
    audioEpoch.me++; audioEpoch.them++
    routedFinals.me = routedFinals.them = Promise.resolve()
    currentSession = undefined
    restoredFrom = undefined
    // A call the user cleared mustn't come back: deleting a long call's pictures takes a while (and can fail on a
    // busy file), and the saved call is deleted meanwhile.
    await callFile.clear(() => copilot.clear())
    callProvider = undefined; callAI = undefined; callAccountId = undefined; callSpeechIdentity = undefined; callUserName = undefined
    remoteSpeech.clear()
    currentCallKey = frameStore.sessionId
    // A new call while listening: its share of the plan counts from here, as when listening starts.
    if (copilot.isListening && getSettings().provider === 'chatgpt' && auth.status().signedIn) {
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
    copilot.renameVoice(id, name)
    return voices.remember(id, name, identity)
  })
  ipcMain.handle('voices:status', () => voices.status())
  ipcMain.handle('voices:merge', async (_e, from: string, into: string) => {
    if (typeof from !== 'string' || typeof into !== 'string') throw new Error('Choose two speakers.')
    const name = copilot.mergeVoices(from, into)
    await voices.merge(from, into, name)
  })
  ipcMain.handle('calls:speaker', async (_e, callId: string, voiceId: string, name: string) => {
    if (typeof name !== 'string' || typeof voiceId !== 'string') throw new Error('Enter a speaker name.')
    const value = name.replace(/[\r\n\[\]<>]/g, '').trim().slice(0, 60)
    if (!value) throw new Error('Enter a speaker name.')
    await storedCallSession(callId)
    if (callId === currentSession?.id) { copilot.renameVoice(voiceId, value); await callFile.flush() }
    return callSessions.update(callId, record => {
      if (!record.transcript.some(line => line.voiceId === voiceId)) throw new Error('That speaker is no longer in this call.')
      return { ...record, transcript: record.transcript.map(line => line.voiceId === voiceId ? { ...line, voiceName: value, voiceNamedBy: 'user' as const, voiceIdentityId: line.voiceName === value ? line.voiceIdentityId : undefined } : line) }
    })
  })
  ipcMain.on('call:view', (_e, view: CallView) => { if (view?.key === currentCallKey) callFile.setView(view) })
  ipcMain.handle('calls:merge-speakers', async (_e, callId: string, from: string, into: string) => {
    if (typeof from !== 'string' || typeof into !== 'string') throw new Error('Choose two speakers.')
    const record = await storedCallSession(callId)
    mergeSpeakers(record.transcript, from, into)
    if (callId === currentSession?.id) {
      const name = copilot.mergeVoices(from, into); await voices.merge(from, into, name); await callFile.flush()
      const stored = await storedCallSession(callId)
      // If history was turned off mid-call, flushing updates only the recovery file.
      if (!stored.transcript.some(line => line.voiceId === from)) return stored
    }
    return callSessions.update(callId, saved => ({ ...saved, transcript: mergeSpeakers(saved.transcript, from, into) }))
  })
  ipcMain.on('call:brief', (_e, text: string) => copilot.setBrief(String(text ?? '')))
  ipcMain.on('call:group', (_e, group: boolean) => copilot.setGroup(!!group))

  ipcMain.handle('calls:list', listCallSessions)
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
    if (id === currentCallKey && copilot.isListening) throw new Error('End the call before deleting it.')
    if (callLearning.isBusy(id)) throw new Error('Wait for this learning review to finish before deleting the call.')
    const record = await getCallSession(id)
    if (!record) return
    meetingNotes.cancel(id)
    callTitles.cancel(id); titleQueue.delete(id)
    if (id === currentCallKey) await clearCurrentCall(true)
    await callSessions.remove(id)
    legacyCalls.delete(id)
    const summaries = await pastCalls.list(record.agentId)
    for (const summary of summaries) if (summary.id === record.legacy?.id || (summary.callId && summary.callId === record.frameSession)) await pastCalls.remove(record.agentId, summary.id)
  })
  ipcMain.handle('calls:export', async (_e, id: string) => {
    const record = await getCallSession(id)
    if (!record) throw new Error('This call is no longer available.')
    const chosen = await dialog.showSaveDialog(win!, { title: 'Export call', defaultPath: path.join(app.getPath('documents'), `${slug(record.title, 'call')}.md`), filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (chosen.canceled || !chosen.filePath) return null
    await fs.writeFile(chosen.filePath, exportCall(record), 'utf8')
    return chosen.filePath
  })
  ipcMain.handle('calls:review', async (_e, id: string) => { await storedCallSession(id); return callLearning.review(id) })
  ipcMain.handle('calls:approve', (_e, id: string, reviewId: string, selected: string[]) => callLearning.approve(id, reviewId, Array.isArray(selected) ? selected : []))
  ipcMain.handle('calls:dismiss', (_e, id: string, reviewId: string) => callLearning.dismiss(id, reviewId))

  ipcMain.handle('record:sources', (_e, previews?: boolean) => listCaptureSources(previews === true))
  ipcMain.handle('screen-monitor:status', () => screenMonitor.status())
  ipcMain.handle('screen-monitor:start', async (_e, sourceId: string) => {
    const call = currentCallKey
    const selection = ++screenSelection
    if (!copilot.isListening) throw new Error('Start the call before watching its screen.')
    if (!liveProvider().supportsTools) throw new Error('This AI does not support automatic screen context. Choose an AI with tool support or use snapshots.')
    if (typeof sourceId !== 'string' || sourceId === 'cursor') throw new Error('Choose a specific screen or call window.')
    const source = await resolveCaptureSource(sourceId)
    if (selection !== screenSelection) throw new Error('A newer screen selection replaced this request.')
    if (!source) throw new Error('That screen or window is no longer available. Choose another source.')
    if (!copilot.isListening || call !== currentCallKey) throw new Error('Start the call before watching its screen.')
    return screenMonitor.start({ id: source.id, name: source.name, kind: source.id.startsWith('screen') ? 'screen' : 'window' })
  })
  ipcMain.handle('screen-monitor:stop', (_e, id?: string) => stopScreenMonitoring(false, id))
  ipcMain.handle('screen-monitor:frame', async (_e, id: string, at: number, image: Uint8Array, change?: { thumb: Uint8Array; content: boolean }) => {
    const now = Date.now()
    // Reject delayed encodes before clock normalization: an old frame is not a system-clock correction.
    if (!copilot.isListening || screenMonitor.status().id !== id || !Number.isFinite(at) || at < now - 5000 || at > now + 2000) return false
    const timestamp = copilot.screenTimestamp(at)
    const accepted = screenMonitor.add(id, timestamp, image)
    if (accepted && change?.thumb instanceof Uint8Array && change.thumb.byteLength <= 200_000) {
      const frame = await frameStore.add('recorded', timestamp, Buffer.from(image), Buffer.from(change.thumb))
      if (copilot.isListening && screenMonitor.status().id === id) { frame.content = change.content === true; copilot.addFrame(frame, false) }
    }
    return accepted
  })
  ipcMain.handle('record:prepare', (_e, sourceId: string) => {
    pendingRecordSource = sourceId
  })
  ipcMain.handle('record:state', (_e, value: boolean) => {
    recording = value
    applyWindowSettings()
  })
  ipcMain.handle('frames:add', async (_e, at: number, image: Uint8Array, thumb: Uint8Array, content?: boolean) => {
    const frame = await frameStore.add('recorded', at, Buffer.from(image), Buffer.from(thumb))
    if (content) frame.content = true
    copilot.addFrame(frame)
    return frame
  })
  ipcMain.handle('frames:screens', () => listScreens(win))
  ipcMain.handle('frames:snapshot', (_e, display?: number) => copilot.snapshot(display))
  ipcMain.on('assist:run', (_e, request: AssistRequest) => void copilot.assist(request))
  ipcMain.on('assist:cancel', (_e, id?: string) => copilot.cancel(id))
  ipcMain.handle('call:note-answer', (_e, entry: CallAnswer) => copilot.noteAnswer(entry))
  ipcMain.on('assist:deeper', (_e, id?: string) => copilot.deeper(id))

  ipcMain.handle('agents:list', () => agents.list())
  ipcMain.handle('agents:templates', () => AGENT_TEMPLATES)
  // Named apart from one I have already ("New agent 2").
  ipcMain.handle('agents:create', (_e, templateId: string) => {
    const template = AGENT_TEMPLATES.find((t) => t.id === templateId) ?? AGENT_TEMPLATES[0]
    return agents.create(templateId, { name: agents.freeName(template.name) })
  })
  ipcMain.handle('agents:update', (_e, id: string, patch: AgentPatch) => {
    if (patch.preferences) {
      const preferences = validatePreferences(patch.preferences)
      if (preferences.ai) validateProfile(preferences.ai)
      if (preferences.transcription?.accountId) accounts.get(preferences.transcription.accountId)
      if (preferences.dictation?.accountId) accounts.get(preferences.dictation.accountId)
      patch = { ...patch, preferences }
    }
    if (patch.calendar) {
      if (typeof patch.calendar.enabled !== 'boolean' || typeof patch.calendar.accountId !== 'string') throw new Error('Choose a Claude account for reminders.')
      if (patch.calendar.enabled && accounts.get(patch.calendar.accountId).kind !== 'claude') throw new Error('Calendar reminders require a Claude subscription account.')
      patch = { ...patch, calendar: { ...patch.calendar, accountEmail: patch.calendar.accountId ? accounts.identity(patch.calendar.accountId).email : undefined } }
    }
    if (patch.subscriptionAccountId) accounts.get(patch.subscriptionAccountId)
    const saved = agents.update(id, patch, 'manual')
    if (patch.calendar) void saved.then(() => calendar.refresh(id)).catch(error => console.warn('[calendar]', (error as Error).message))
    return saved
  })
  ipcMain.handle('agents:remove', (_e, id: string) => {
    if (id === currentSession?.agentId || (copilot.isListening && id === getSettings().activeAgentId)) throw new Error('Start a new call before deleting the current call’s agent.')
    return agents.remove(id)
  })
  ipcMain.handle('agents:vocabulary', async (_e, id: string) => agents.vocabularyFor(agents.get(id), await conversations.talk(id).catch(() => [])))
  ipcMain.handle('agents:add-text', (_e, id: string, name: string, text: string) => agents.addText(id, name, text))
  ipcMain.handle('agents:draft', (_e, description: string) => agents.draft(description))
  ipcMain.handle('agents:import-files', async (_e, id: string) => {
    const picked = pickedForTest()
    const { filePaths } = picked
      ? { filePaths: [picked] }
      : await dialog.showOpenDialog(win!, {
          title: 'Teach this agent',
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Documents', extensions: SUPPORTED_EXTENSIONS }]
        })
    return agents.addFiles(id, filePaths)
  })
  // Attached in the conversation: what's picked (files, a folder, a project's code), then added.
  ipcMain.handle('agents:pick', async (_e, kind: 'files' | 'folder' | 'code') => {
    // A check of the window picks the file it set, or (for a folder) the folder it's in.
    const picked = pickedForTest()
    if (picked) return [kind === 'files' ? picked : path.dirname(picked)]
    const { filePaths } = await dialog.showOpenDialog(
      win!,
      kind === 'files'
        ? { title: 'Teach this agent', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: SUPPORTED_EXTENSIONS }] }
        : { title: kind === 'code' ? 'Project folder this agent can read' : 'Teach this agent a whole folder', properties: ['openDirectory'] }
    )
    return filePaths
  })
  ipcMain.handle('agents:add-paths', async (_e, id: string, paths: string[]) => {
    const errors: string[] = []
    const unchanged: string[] = []
    const exports: GivenExport[] = []
    const dropped = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)) : []
    // The files of an unpacked export dropped in, not its folder: its conversations first, and what's beside them goes
    // in with them (chat.html holds every chat, with nothing taken out; user.json, their phone and email).
    const conversations = (p: string): boolean => /(?:^|[\\/])conversations(?:-\d+)?\.json$/i.test(p)
    const exportFolders = new Set<string>()
    for (const at of [...dropped.filter(conversations), ...dropped.filter((p) => !conversations(p))]) {
      if (exportFolders.has(path.dirname(at).toLowerCase())) continue
      const stat = await fs.stat(at).catch(() => null)
      if (!stat) {
        errors.push(`${path.basename(at)}: not found`)
        continue
      }
      // An export of their chats on claude.ai or ChatGPT: its chats are theirs to pick from, not a document.
      const given = stat.isDirectory() || /\.(?:zip|json)$/i.test(at) ? await addExport(at).catch((err: Error) => err) : null
      if (given instanceof Error) errors.push(`${path.basename(at)}: ${given.message}`)
      else if (given) {
        exports.push(given)
        if (conversations(at)) exportFolders.add(path.dirname(at).toLowerCase())
      } else {
        const read = await (stat.isDirectory() ? agents.addFolder(id, at) : agents.addFiles(id, [at]))
        errors.push(...read.errors)
        unchanged.push(...read.unchanged)
      }
    }
    return { agent: agents.get(id), errors, unchanged, exports }
  })
  ipcMain.handle('agents:import-folder', async (_e, id: string) => {
    const { filePaths } = await dialog.showOpenDialog(win!, { title: 'Teach this agent a whole folder', properties: ['openDirectory'] })
    return filePaths[0] ? agents.addFolder(id, filePaths[0]) : { agent: agents.get(id), errors: [], unchanged: [] }
  })
  ipcMain.handle('agents:add-code-folder', async (_e, id: string) => {
    const { filePaths } = await dialog.showOpenDialog(win!, { title: 'Project folder this agent can read', properties: ['openDirectory'] })
    const agent = agents.get(id)
    if (!filePaths[0] || agent.codeFolders.includes(filePaths[0])) return agent
    return agents.update(id, { codeFolders: [...agent.codeFolders, filePaths[0]] })
  })
  ipcMain.handle('agents:code-info', async (_e, folders: string[]) => (await codeBaseFor(folders)?.files())?.length ?? 0)
  ipcMain.handle('agents:import-website', (_e, id: string, url: string, followLinks: boolean, maxPages: number) =>
    agents.addWebsite(id, url, { followLinks, maxPages: Math.max(1, Math.min(100, maxPages)) }, (pages) =>
      send('agents:progress', { agentId: id, text: `Read ${pages} page${pages === 1 ? '' : 's'}…` })
    )
  )
  ipcMain.handle('sessions:find', (_e, query?: string, agentId?: string) => {
    const own = typeof agentId === 'string' ? agents.list().find((a) => a.id === agentId)?.workHomes : undefined
    return findSessions(typeof query === 'string' ? query : '', SESSIONS_SHOWN, own?.map((h) => h.dir))
  })
  ipcMain.handle('sessions:homes', () => sessionHomes())
  // Only folders of theirs Togle found: what's searched for sessions is never just any folder.
  ipcMain.handle('agents:set-session-homes', async (_e, id: string, dirs: string[]) => {
    const homes = await sessionHomes()
    const picked = Array.isArray(dirs) ? homes.filter((h) => dirs.some((dir) => typeof dir === 'string' && samePlace(dir, h.dir))) : []
    return agents.update(id, { workHomes: picked }, 'manual')
  })
  // An export of their chats picked in the list of work sessions: its chats join the list.
  ipcMain.handle('sessions:pick-export', async () => {
    const picked =
      pickedForTest() ??
      (
        await dialog.showOpenDialog(win!, {
          title: 'Your export from claude.ai or ChatGPT',
          properties: ['openFile'],
          filters: [{ name: 'Export of your chats', extensions: ['zip', 'json'] }]
        })
      ).filePaths[0]
    if (!picked) return null
    const given = await addExport(picked)
    if (!given) throw new Error("That isn't an export of your chats from claude.ai or ChatGPT.")
    return given
  })
  ipcMain.handle('agents:add-session', (_e, id: string, file: string) => {
    if (typeof file !== 'string' || !(path.isAbsolute(file) || isChatAddress(file))) throw new Error('No such session.')
    return agents.addSession(id, file)
  })
  ipcMain.handle('agents:remove-doc', (_e, id: string, docId: string) => agents.removeDocument(id, docId))
  ipcMain.handle('agents:restudy', (_e, id: string) => agents.restudy(id))
  ipcMain.handle('agents:add-answer', (_e, id: string, question: string, answer: string, origin: ApprovedAnswer['origin']) =>
    agents.addAnswer(id, question, answer, origin)
  )
  ipcMain.handle('agents:save-fact', (_e, id: string, text: string, before?: string) => agents.saveFact(id, text, before))
  ipcMain.handle('agents:remove-fact', (_e, id: string, text: string) => agents.removeFact(id, text))
  ipcMain.handle('agents:save-skill', async (_e, id: string, skill: SkillDraft, skillId?: string, before?: SkillDraft) => (await agents.saveSkill(id, skill, 'manual', skillId, before)).agent)
  ipcMain.handle('agents:remove-skill', (_e, id: string, skillId: string, before: SkillDraft) => agents.removeSkill(id, skillId, before))
  ipcMain.on('agents:test', (_e, id: string, question: string, again?: AskedAgain | { tag: string }) => void copilot.test(id, question, again))
  ipcMain.handle('agents:learn', async () => {
    await callFile.flush()
    if (currentSession && getSettings().assist.rememberCalls !== false && await callSessions.get(currentCallKey)) return callLearning.review(currentCallKey)
    // Set beside what I said: the cards as the window last saved them. The call is named before the review runs: a
    // new call started meanwhile is another one.
    const review = await copilot.learn((callFile.view?.cards ?? []) as CallCard[], frameStore.sessionId)
    if (!review.record) return review
    // The call itself, kept to recall later (unless that's off); the same call reviewed again updates what was kept.
    if (getSettings().assist.rememberCalls === false || !agents.list().some((a) => a.id === review.agentId)) return { ...review, record: undefined }
    try {
      const kept = await pastCalls.add(review.agentId, review.record)
      return kept ? review : { ...review, record: undefined }
    } catch (err) {
      console.warn('[past calls] not kept:', (err as Error).message)
      return { ...review, record: undefined }
    }
  })
  // A call that taught the agent, written up as notes into its documents (the review card's Keep as a document).
  ipcMain.handle('agents:keep-lesson', (_e, id: string) => keepLesson(id))
  // ---- Sharing agents, and installing others' (a .togle file, or a hub) ----
  ipcMain.handle('agents:export', async (_e, id: string, choice: ShareChoice) => {
    const agent = agents.list().find((a) => a.id === id)
    if (!agent) throw new Error('That agent was deleted.')
    const picked = pickedForTest()
    const { canceled, filePath } = picked
      ? { canceled: false, filePath: picked }
      : await dialog.showSaveDialog(win!, {
          title: `Share ${agent.name}`,
          defaultPath: path.join(app.getPath('documents'), `${slug(agent.name, 'agent')}.togle`),
          filters: [{ name: 'Togle agent', extensions: ['togle'] }]
        })
    if (canceled || !filePath) return null
    await fs.writeFile(filePath, await zipPackage(await agents.pack(id, choice)))
    return filePath
  })
  ipcMain.handle('agents:open-package', async () => {
    const picked = pickedForTest()
    const { filePaths } = picked
      ? { filePaths: [picked] }
      : await dialog.showOpenDialog(win!, {
          title: 'Install an agent',
          properties: ['openFile'],
          filters: [{ name: 'Togle agent', extensions: ['togle', 'zip'] }]
        })
    if (!filePaths[0]) return null
    const name = path.basename(filePaths[0])
    return installs.preview(await unzipPackage(await fs.readFile(filePaths[0])), { kind: 'file', ref: name, label: name }, 'community', installedAs)
  })
  ipcMain.handle('agents:install', (_e, previewId: string) => {
    const { pkg, source } = installs.take(previewId)
    return agents.install(pkg, source)
  })
  // All hubs, or Togle's own ('own': on this PC, at once), or one added hub: the market shows each as it answers.
  ipcMain.handle('hub:list', async (_e, which?: string) =>
    Promise.all(
      hubsNow()
        .filter((name) => which === undefined || (which === 'own' ? officialHub(name) : name === which))
        .map(async (name) => {
          try {
            return { hub: name, official: officialHub(name), entries: await listHub(hubSource(name)) }
          } catch (err) {
            return { hub: name, official: officialHub(name), entries: [], error: (err as Error).message }
          }
        })
    )
  )
  ipcMain.handle('hub:preview', async (_e, name: string, slugName: string) => {
    if (!hubsNow().includes(name)) throw new Error('That hub was removed.')
    const hub = hubSource(name)
    const entry = (await listHub(hub)).find((e) => e.slug === slugName)
    if (!entry) throw new Error('That agent is no longer in the hub.')
    const ref = `${name}/agents/${entry.slug}`
    return installs.preview(await fetchHubAgent(hub, entry), { kind: 'hub', ref, label: name }, officialHub(name) ? 'official' : 'community', installedAs)
  })
  // The hubs an agent can be published to: GitHub's (what comes with Togle is read-only).
  ipcMain.handle('hub:names', () => hubsNow().filter((name) => name !== TOGLE_HUB))
  ipcMain.handle('hub:add', async (_e, text: string) => {
    const name = hubName(parseHub(text))
    await listHub(parseHub(name))
    // The same hub in other letters (GitHub names ignore case) is the one already there.
    const hubs = addedHubs().some((h) => h.toLowerCase() === name.toLowerCase()) ? addedHubs() : [...addedHubs(), name]
    return (await updateSettings({ hubs })).hubs ?? []
  })
  ipcMain.handle('hub:remove', async (_e, name: string) => (await updateSettings({ hubs: addedHubs().filter((h) => h !== name) })).hubs ?? [])
  // Publishing: the agent's folder, written out, and the hub's page for adding it (a pull request its keepers review).
  ipcMain.handle('hub:publish', async (_e, id: string, choice: ShareChoice, name: string) => {
    const agent = agents.list().find((a) => a.id === id)
    if (!agent) throw new Error('That agent was deleted.')
    const folder = path.join(app.getPath('documents'), 'Togle agents', slug(agent.name, 'agent'))
    await fs.rm(folder, { recursive: true, force: true })
    for (const [file, text] of Object.entries(await agents.pack(id, choice))) {
      await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true })
      await fs.writeFile(path.join(folder, file), text, 'utf8')
    }
    const url = publishUrl(parseHub(name), slug(agent.name, 'agent'))
    void shell.openPath(folder)
    void shell.openExternal(url)
    return { folder, url }
  })
  ipcMain.handle('agents:remember', async (_e, id: string, lessons: Lessons, auto?: boolean) => {
    const agent = await agents.applyLessons(id, lessons, !!auto)
    tidyLater(id)
    return agent
  })
  ipcMain.handle('agents:undo', (_e, id: string, changeId: string) => agents.undo(id, changeId))
  ipcMain.handle('agents:tidy', (_e, id: string) => agents.tidy(id))
  ipcMain.handle('conversation:load', (_e, agentId: string) => conversations.load(agentId))
  ipcMain.on('conversation:save', (_e, agentId: string, conversation: SavedConversation) =>
    void conversations.save(agentId, conversation).catch((err: Error) => console.warn('[conversations] not saved:', err.message))
  )
  ipcMain.handle('past-calls:list', (_e, agentId: string) => pastCalls.list(agentId))
  ipcMain.handle('past-calls:remove', (_e, agentId: string, id: string) => pastCalls.remove(agentId, id))
  ipcMain.handle('past-calls:clear', (_e, agentId: string) => pastCalls.clear(agentId))

  // Train replies in progress, so Stop can end one.
  const trainings = new Map<string, AbortController>()
  ipcMain.on('agents:train', async (_e, id: string, turnId: string, history: TrainTurn[], message: string, callId?: string) => {
    const reply = (event: TrainEvent): void => send('agent-train', event)
    const controller = new AbortController()
    trainings.set(turnId, controller)
    try {
      const selected = callId ? await savedCalls.owned(id, callId) : undefined
      await train(agents, activeProvider(id), id, history, message, controller.signal, {
        onDelta: (text) => reply({ type: 'delta', id: turnId, text }),
        onChange: (text) => reply({ type: 'change', id: turnId, text }),
        // The call as the window shows it: its cards as it last saved them.
        call: () => {
          if (id !== getSettings().activeAgentId) return { transcript: [], frames: [], brief: '', cards: [], corrections: [] }
          return { ...copilot.callForTraining(), cards: (callFile.view?.cards ?? []) as TrainCall['cards'] }
        },
        // Off in Settings, earlier calls aren't looked through either.
        selectedCall: selected ? { id: selected.id, title: selected.title } : undefined,
        pastCalls: getSettings().assist.rememberCalls === false ? undefined : (query, offset) => savedCalls.search(id, query, offset, controller.signal),
        savedCall: (callId, query, fromLine) => {
          if (!selected && getSettings().assist.rememberCalls === false) throw new Error('Call history is off. Open a saved call explicitly to ask about it.')
          if (getSettings().assist.rememberCalls === false && selected?.id !== callId) throw new Error('Only the selected saved call is available while call history is off.')
          return savedCalls.read(id, callId, query, fromLine)
        },
        // What it was told about the call, for the call, and the earlier calls it brings back.
        brief: async (text, group) => {
          if (id !== getSettings().activeAgentId || copilot.isListening) throw new Error('Add notes in Calls. Agent setup cannot replace the context of a live call or another agent’s call.')
          if (group !== undefined) copilot.setGroup(group)
          const found = await copilot.setBrief(text)
          const call = copilot.currentCall()
          send('call:briefed', { brief: call.brief, group: call.group })
          return found
        },
        keepNotes: async () => {
          const offer = copilot.lessonFor(id)
          if (!offer) throw new Error('No call that taught it is waiting to be written up (only the latest few are kept, until Togle closes).')
          return (await keepLesson(offer.id)).name
        },
        // Who a call was with, as the review named them, or its brief: "Northwind" finds "Northwind Health".
        forgetCalls: async (who) => {
          const named = who.toLowerCase()
          const matches = (name: string): boolean => name.length >= 3 && (name.toLowerCase().includes(named) || named.includes(name.toLowerCase()))
          const calls = (await pastCalls.list(id)).filter((c) => c.with.some(matches) || c.brief.toLowerCase().includes(named))
          for (const call of calls) await pastCalls.remove(id, call.id)
          return calls.map((c) => `${new Date(c.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${c.brief ? `, ${c.brief}` : ''}`)
        }
      })
      reply({ type: 'done', id: turnId })
    } catch (err) {
      // Stopped on purpose: what it said and changed so far stays.
      if (controller.signal.aborted) reply({ type: 'done', id: turnId })
      else {
        const timedOut = (err as Error).name === 'TimeoutError'
        reply({ type: 'error', id: turnId, message: timedOut ? 'That took too long. Try one change at a time.' : (err as Error).message })
      }
    } finally {
      trainings.delete(turnId)
    }
  })
  ipcMain.on('agents:train-stop', (_e, turnId: string) => trainings.get(turnId)?.abort())

  if (!app.isPackaged && process.env.TOGLE_DEBUG_PORT) {
    // A line said; with the id of the live caption it ends, as speech recognition gives it.
    ipcMain.handle('dev:transcript', (_e, speaker: Speaker, text: string, segmentId?: string, voiceId?: string) => {
      const at = Date.now()
      copilot.add(speaker, text, at, at, segmentId)
      if (segmentId && voiceId && speaker === 'them') copilot.identifyVoice(segmentId, voiceId)
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
    ipcMain.handle('dev:hotkey', (_e, id: HotkeyId) => HOTKEYS.find((h) => h.id === id)?.run())
    testClipboard = ''
    ipcMain.handle('dev:clipboard', () => testClipboard)
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
  // What the window copies when it isn't the one in front (a shortcut pressed in the call's app).
  ipcMain.on('clipboard:write', (_e, text: string) => {
    if (typeof text !== 'string' || !text) return
    // A test run's copy stays in Togle: what's on the PC's clipboard isn't the test's to replace.
    if (testClipboard !== undefined) testClipboard = text
    else clipboard.writeText(text)
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
}

// Dev only: lets scripts drive the UI over the Chrome DevTools Protocol.
if (!app.isPackaged && process.env.TOGLE_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.TOGLE_DEBUG_PORT)
}

if (!app.requestSingleInstanceLock()) {
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
    await accounts.list()
    // Before the speech model was a choice, this PC heard every call: a Togle from then that has its speech recognition
    // keeps it (quicker, and the audio stays here); one without starts on the ChatGPT plan, as a new one does.
    if (savedBeforeSpeechChoice() && speech.local()) await updateSettings({ transcription: { me: 'local', them: 'local' } })
    started.settings = Date.now()
    // Apply text retention on startup, including accounts whose history screen is not opened.
    void accounts.list().then(list => Promise.all(list.map(account => dictationHistory.get(account.id)))).catch(error => console.warn('[dictation history] retention:', (error as Error).message))
    await agents.load(getSettings().assist.context)
    started.agents = Date.now()
    if (!agents.list().some((a) => a.id === getSettings().activeAgentId)) {
      await updateSettings({ activeAgentId: agents.list()[0].id })
    }
    warmWorkApps(agents.get(getSettings().activeAgentId))
    if (getSettings().assist.calendarReminders) {
      const owner = agents.list().find(agent => agent.id === getSettings().assist.calendarAgentId) || agents.get(getSettings().activeAgentId)
      if (!owner.calendar) { const id = selectedClaude().metadata.id; await agents.update(owner.id, { calendar: { enabled: true, accountId: id, accountEmail: accounts.identity(id).email } }) }
      await updateSettings({ assist: { calendarReminders: false, calendarAgentId: '' } })
    }
    if (needsSpeechAccountMigration()) {
      const settings = getSettings(), source = dictationSource(settings)
      const voice = settings.dictation.accountId || (source ? selectedAccount(source).metadata.id : undefined)
      const sides = [settings.transcription.me, settings.transcription.them]
      const call = sides.includes('chatgpt') ? callChatGPT().metadata.id : sides.includes('claude') ? selectedClaude().metadata.id : undefined
      await updateSettings(migrateSpeechAccounts(settings, call, voice))
    }
    studyAgain()
    serveFrames()
    // The call that was open when Togle last closed goes on, with its pictures.
    const saved = await callFile.load()
    if (saved) {
      frameStore.resume(saved.frameSession, Math.max(0, ...saved.state.frames.map((f) => f.n)))
      currentCallKey = saved.view?.key ?? saved.frameSession
      currentSession = saved.session ? { ...saved.session, status: saved.session.status === 'live' ? 'interrupted' : saved.session.status, endedAt: saved.session.endedAt ?? saved.savedAt } : saved.state.transcript.length ? {
        id: currentCallKey, agentId: getSettings().activeAgentId, agentName: agents.get(getSettings().activeAgentId).name, startedAt: saved.state.transcript[0].at, endedAt: saved.savedAt, status: 'interrupted'
      } : undefined
      if (currentSession && agents.list().some(agent => agent.id === currentSession!.agentId)) await updateSettings({ activeAgentId: currentSession.agentId })
      copilot.restore(saved.state)
      restoredFrom = saved.savedAt
      if (currentSession && getSettings().assist.rememberCalls !== false) {
        try {
          await callSessions.capture(currentSession, saved.frameSession, saved.state, saved.view)
          scheduleCallReview(currentSession.id)
        } catch (error) { console.warn('[call history] recovery could not be archived:', (error as Error).message) }
      }
    }
    void FrameStore.cleanup(saved?.frameSession)
    setupMediaAccess()
    registerIpc()
    started.window = Date.now()
    createWindow()
    calendar.start()
    registerHotkeys()
    if (app.isPackaged || process.env.TOGLE_HEADLESS !== '1' || process.env.TOGLE_TEST_TRAY === '1') {
      try {
        tray = new TogleTray(path.join(app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'build'), process.platform === 'win32' ? 'icon.ico' : 'icon.png'), {
          open: openWindow, settings: openDictationSettings, toggle: () => void dictation.toggle(), cancel: () => dictation.cancel(), copy: () => { void copyLastDictation().catch(() => {}) },
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
      if (getSettings().claude.auth === 'subscription') void selectedClaude().auth.status()
      else if (claude.hasApiKey()) void claude.listModels().catch(() => undefined)
    }
  })

  app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void requestQuit() } })
  app.on('window-all-closed', () => { if (!tray?.available) void requestQuit(true) })
  app.on('will-quit', () => {
    quitting = true
    dictationWindow.close()
    microphoneLink.stop()
    dictation.dispose()
    tray?.close()
    dictationTarget.stop()
    calendar.stop()
    voices.stop()
    stopScreenMonitoring(true)
    for (const timer of automaticReviews.values()) clearTimeout(timer)
    clearTimeout(titleTimer); callTitles.pause()
    accounts.close()
    globalShortcut.unregisterAll()
    dictationPress.reset()
    speech.cancel()
    stopLocalSpeech()
  })
}
