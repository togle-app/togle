import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsPatch } from '@shared/api'
import { callReadiness } from '@shared/workspace'
import { useConnections } from './Connections'
import { effectiveAI } from '@shared/preferences'
import {
  type Agent,
  type AuthStatus,
  type ClaudeAuthStatus,
  type CurrentCall,
  type CaptureSource,
  type Frame,
  type Lessons,
  type PastCall,
  type PlanUsage,
  type ScreenOption,
  type ScreenMonitorStatus,
  type Settings as SettingsData,
  type SttStatus,
  type TranscriptEntry,
  type WorkSessionInfo
} from '@shared/types'
import { Agents, type AgentsRequest } from './Agents'
import { AgentInspector } from './AgentInspector'
import { AgentSidebar, type SidebarPage } from './AgentSidebar'
import { Avatar } from './Avatar'
import { applyAnswerEvent, isStreaming, reloadedCards, restoredCards, toSay, type AnswerItem } from './AnswerCard'
import { AskAgain } from './AskAgain'
import { CallCapture, warmUpAudio, type CaptureInputs } from './audio/capture'
import togleIcon from '../../../build/icon.svg'
import { CallStrip } from './CallStrip'
import { MicrophoneSuggestion, type NoiseFinding } from './MicrophoneSuggestion'
import { isMicrophoneOn, type TogleMicrophoneStatus } from '@shared/microphone'
import { CallPeople } from './CallPeople'
import { CallToggle } from './CallToggle'
import { CallHistory } from './CallHistory'
import { useChats, type LessonOffer, type Review, type ReviewEntry } from './chats'
import { Conversation } from './Conversation'
import { useHotkey, withKeys } from './hotkeys'
import { Icon } from './Icon'
import { Menu, type MenuItem } from './Menu'
import { MonitorPicker } from './MonitorPicker'
import { MeetingNotice } from './Meetings'
import { onOpenSettings, openSettings, type SettingsPart } from './open-settings'
import { PlanMeter, PlanNotice } from './Plan'
import { MANAGE_USAGE_URL } from '@shared/plan'
import { ScreenPicker } from './ScreenPicker'
import { ScreenTiming } from './ScreenTiming'
import { SessionPicker } from './SessionPicker'
import { Settings } from './Settings'
import { ScreenRecorder } from './video/recorder'

const api = window.togle

/** What a picture of the screen is for: the timeline, or a suggestion that looks at it. */
type ScreenUse = 'snapshot' | 'suggest'
type CallDraft = { agentId: string; brief: string; group: boolean; fresh: boolean; meetingId?: string }
const AGENT_TABS = ['chat', 'live', 'calls'] as const
const CONFIG_TABS = ['settings', 'knowledge', 'skills', 'learning'] as const

const NO_LESSONS: Lessons = {
  facts: [],
  answers: [],
  skills: [],
  updates: [],
  forget: []
}
const anyLessons = (lessons: Lessons): boolean => Object.values(lessons).some((list) => list.length > 0)
const joinLessons = (a: Lessons, b: Lessons): Lessons => ({
  facts: [...a.facts, ...b.facts],
  answers: [...a.answers, ...b.answers],
  skills: [...a.skills, ...b.skills],
  updates: [...a.updates, ...b.updates],
  forget: [...a.forget, ...b.forget]
})

// Stopping listening after at least this many new lines of the call runs the review on its own.
const LEARN_AFTER_LINES = 2
// The last utterance is still being transcribed when listening stops.
const LEARN_DELAY_MS = 1500

const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Why a file couldn't be read ("name: why"), in plain words where the reader of its kind says it its own way. */
function unreadable(error: string): string {
  const at = error.indexOf(': ')
  if (at < 0) return error
  const why = error.slice(at + 2)
  const kind = /^unsupported file type (\.\w+)/i.exec(why)?.[1]
  const plain = /central directory|is this a zip file/i.test(why)
    ? "it isn't a Word or PowerPoint file I can open (it may be damaged)"
    : /Invalid PDF|PDF structure|bad XRef/i.test(why)
      ? 'the PDF is damaged'
      : /no text layer/i.test(why)
        ? "it's a scan, with no text in it to read"
        : /^no readable text/i.test(why)
          ? "there's no text in it"
          : kind
            ? `I can't read ${kind} files`
            : why
  return `${error.slice(0, at)}: ${plain}`
}

/** How long the call has been going on. It ticks by itself: the window isn't drawn again every second. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(hours ? 2 : 1, '0')
  return (
    <>
      {hours ? `${hours}:` : ''}
      {minutes}:{String(seconds % 60).padStart(2, '0')}
    </>
  )
}

export default function App() {
  const [view, setView] = useState<'main' | 'settings' | 'archive' | 'agents' | 'agent'>('agent')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  const openCurrentCall = useCallback(() => { setSidebarOpen(false); setView('main') }, [])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 560px)')
    const resize = (): void => { if (!media.matches) setSidebarOpen(false) }
    media.addEventListener('change', resize)
    return () => media.removeEventListener('change', resize)
  }, [])
  const workspaceReturn = useRef<'main' | 'agent'>('agent')
  useEffect(() => { if (view === 'main' || view === 'agent') workspaceReturn.current = view }, [view])
  const [chatAgentId, setChatAgentId] = useState<string>()
  const [agentTab, setAgentTab] = useState<'chat' | 'live' | 'calls' | 'settings' | 'knowledge' | 'skills' | 'learning'>('chat')
  const [selectedCallId, setSelectedCallId] = useState<string>()
  const showHistory = (id?: string): void => { setSelectedCallId(id); setAgentTab('calls'); setView('agent') }
  // What the agents page shows as it opens: an agent's page, or the list of them.
  const [agentsRequest, setAgentsRequest] = useState<AgentsRequest>({ seq: 0 })
  const [agentsSection, setAgentsSection] = useState<'agents' | 'new' | 'share'>('agents')
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  // For a review started by a timer, which sees the state from when it was set.
  const agentsNow = useRef(agents)
  agentsNow.current = agents
  // After the review trained the agent: the call's last questions, to ask it again (once asked to: `shown`).
  const [askAgain, setAskAgain] = useState<{
    key: number
    reviewId: string
    agentId: string
    agentName: string
    asked: AnswerItem[]
    shown?: boolean
  } | null>(null)
  const [auth, setAuth] = useState<AuthStatus>({ signedIn: false })
  const [signingIn, setSigningIn] = useState(false)
  // Whether a Claude API key is saved, for the setup card: asked when Claude is picked, and on coming back from Settings.
  const [claudeKey, setClaudeKey] = useState(false)
  const [claudeAuth, setClaudeAuth] = useState<ClaudeAuthStatus>({ available: true, signedIn: false })
  // The group call's note about my name, dismissed for this run.
  const [groupSeen, setGroupSeen] = useState(false)
  // Settings opened to fix something: the part that does.
  const [settingsAt, setSettingsAt] = useState<SettingsPart | undefined>()
  // The earlier calls with the people of this one that answers draw on.
  const [recalled, setRecalled] = useState<PastCall[]>([])
  // How much of the ChatGPT plan's limits is used, and the plan notice last dismissed.
  const [plan, setPlan] = useState<PlanUsage | null>(null)
  const [planDismissed, setPlanDismissed] = useState<string[]>([])
  const [stt, setStt] = useState<SttStatus>({ state: 'starting' })
  const [listening, setListening] = useState(false)
  // When listening started: the call's clock in the title bar.
  const [listeningSince, setListeningSince] = useState(0)
  const [warnings, setWarnings] = useState<string[]>([])
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [assists, setAssists] = useState<AnswerItem[]>([])
  const assistsNow = useRef(assists)
  assistsNow.current = assists
  // The shortcuts' keys as they are now, for the tips and menus that say them.
  const keys = {
    suggest: useHotkey('suggest'),
    screen: useHotkey('suggest-screen'),
    snapshot: useHotkey('snapshot'),
    record: useHotkey('record'),
    listen: useHotkey('listen')
  }
  // What this call is, in the user's words (told to the agent), and whether several people are on it.
  const [brief, setBrief] = useState('')
  const [group, setGroup] = useState(false)
  const [frames, setFrames] = useState<Frame[]>([])
  const [recording, setRecording] = useState(false)
  const [monitorStatus, setMonitorStatus] = useState<ScreenMonitorStatus>({ state: 'off', ready: false, reads: 0, imagesSent: 0 })
  const [monitorPick, setMonitorPick] = useState<'start' | 'change' | null>(null)
  const [callDraft, setCallDraft] = useState<CallDraft | null>(null)
  const [loadingSources, setLoadingSources] = useState(false)
  const [sourceError, setSourceError] = useState('')
  const sourceRequest = useRef(0)
  const [sources, setSources] = useState<CaptureSource[]>([])
  const [screenPick, setScreenPick] = useState<{
    use: ScreenUse
    screens: ScreenOption[]
  } | null>(null)
  // Picking a work session (Claude Code, Codex) to give the agent, above the box to write in.
  const [sessionPick, setSessionPick] = useState(false)
  // What was said and shown, unfolded above the call strip (during the call, or after it, asked for on its stretch).
  const [timelineOpen, setTimelineOpen] = useState(false)
  // Closing waits for a yes while in a call.
  const [confirmClose, setConfirmClose] = useState(false)
  const keepGoing = useRef<HTMLButtonElement>(null)
  // Until the call so far is back in the window, an empty window mustn't be saved over it.
  const callLoaded = useRef(false)
  // Offered first the next time.
  const lastScreen = useRef<number | undefined>(undefined)
  const listingScreens = useRef(false)

  const closeMonitorPick = useCallback(() => { sourceRequest.current++; setMonitorPick(null) }, [])
  const chooseMonitor = useCallback(async (intent: 'start' | 'change') => {
    const request = ++sourceRequest.current
    setMonitorPick(intent); setLoadingSources(true); setSources([]); setSourceError('')
    try {
      const available = await api.listCaptureSources(true)
      if (sourceRequest.current === request) setSources(available)
    } catch (error) { if (sourceRequest.current === request) setSourceError(errorText(error)) }
    finally { if (sourceRequest.current === request) setLoadingSources(false) }
  }, [])

  const [starting, setStarting] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [choosingAgent, setChoosingAgent] = useState(false)
  const choosingAgentNow = useRef(false)
  const resetting = useRef(false)
  const [audioInputs, setAudioInputs] = useState<CaptureInputs>({ me: { state: 'off' }, them: { state: 'off' } })
  const pausedInputs = useRef({ me: false, them: false })
  const inputPauseEpoch = useRef({ me: 0, them: 0 })
  const pauseInput = async (speaker: 'me' | 'them'): Promise<void> => {
    const session = capture.current
    if (!session) return
    const paused = !pausedInputs.current[speaker]
    const epoch = ++inputPauseEpoch.current[speaker]
    pausedInputs.current[speaker] = paused
    try {
      await session.setPaused(speaker, paused)
      if (epoch !== inputPauseEpoch.current[speaker] || capture.current !== session) return
      await api.pauseCallInput(speaker, paused)
    } catch (error) {
      if (epoch !== inputPauseEpoch.current[speaker] || capture.current !== session) return
      await session.setPaused(speaker, true)
      pausedInputs.current[speaker] = true
      setWarnings(previous => [...previous, errorText(error)])
    }
  }
  const capture = useRef<CallCapture | null>(null)
  // Togle Microphone, when it's on this computer; and what the microphone picked up in a noisy call, to show after it.
  const [microphone, setMicrophone] = useState<TogleMicrophoneStatus>()
  const [noiseFinding, setNoiseFinding] = useState<NoiseFinding | null>(null)
  useEffect(() => {
    void api.microphoneStatus().then(setMicrophone, () => undefined)
    return api.onMicrophone(setMicrophone)
  }, [])
  const recorder = useRef<ScreenRecorder | null>(null)
  const busy = useRef(false)
  const monitorRequest = useRef(0)
  // How long the call's transcript is, and how much of it the review has gone through already.
  const lines = useRef(0)
  const reviewed = useRef(0)
  // Answers approved or corrected on cards since the last review (a call picked up from before): they wait for it.
  const noted = useRef(0)
  // Calls cleared: a review that fails gives its lines back only to the call it was of.
  const clears = useRef(0)
  // A review is running (also one started by a timer, which sees the state from when it was set).
  const [reviewing, setReviewing] = useState(false)
  // Listening stopped after enough of a call: the review is about to start on its own.
  const [reviewSoon, setReviewSoon] = useState(false)
  const reviewingNow = useRef(false)
  const wasListening = useRef(false)
  // Which call this is (a key kept with the call, so it's the same call after Togle starts again), as the
  // conversation's call stretches say.
  const [callKey, setCallKey] = useState<string>(() => crypto.randomUUID())
  const callNow = useRef(callKey)
  callNow.current = callKey
  // The cards of calls before this one, still shown (folded) in the conversation.
  const earlierCards = useRef(new Map<string, AnswerItem>())
  // The call picked up as Togle started (or the window loaded again), shown in the conversation once its agent is known.
  const [pickedUp, setPickedUp] = useState<{
    cards: AnswerItem[]
    at: number
    restoredFrom?: number
  } | null>(null)

  // Only if it's newer than the copy already there (say, reading a website ends after studying updated it).
  const replaceAgent = useCallback(
    (agent: Agent) => setAgents((prev) => prev.map((a) => (a.id === agent.id && agent.updatedAt >= a.updatedAt ? agent : a))),
    []
  )
  const settingsNow = useRef(settings)
  settingsNow.current = settings
  const chats = useChats({
    onSaved: replaceAgent,
    // What a review held back, kept as asked: the call's questions can be asked again, to see what changed.
    onKept: (agent, review) => askAgainFor(agent, review.id),
    cardOf: (id) => cardNow.current(id),
    // Calls aren't kept when summaries of past calls are off: nor are their suggestions in the conversation.
    keepCalls: () => settingsNow.current?.assist.rememberCalls !== false
  })
  const chatsNow = useRef(chats)
  chatsNow.current = chats
  useEffect(() => {
    const tries = new Map<string, { agentId: string; entryId: string }>()
    return api.onAgentTest((event) => {
      if (event.type === 'start' && event.again?.startsWith('try-')) tries.set(event.id, { agentId: event.agentId, entryId: event.again.slice(4) })
      const tried = tries.get(event.id)
      if (tried) chatsNow.current.tryEvent(tried.agentId, tried.entryId, event)
    })
  }, [])

  useEffect(() => {
    lines.current = transcript.length
  }, [transcript])

  // The answer cards and how far the review went are saved with the call: at once, or while a card streams its
  // answer (which changes them all the time) a second later at most.
  const latestCards = useRef(assists)
  latestCards.current = assists
  const viewSave = useRef<ReturnType<typeof setTimeout> | null>(null)
  // What the window was given as it opened: shown again unchanged, it's no change to the call (or picking a call up
  // would date it from then).
  const openedWith = useRef<{
    cards: AnswerItem[]
    reviewedLines: number
  } | null>(null)
  useEffect(() => {
    if (!callLoaded.current) return
    const save = (): void => {
      viewSave.current = null
      if (resetting.current) return
      const cards = latestCards.current
      if (cards === openedWith.current?.cards && reviewed.current === openedWith.current.reviewedLines) return
      // Those picked up from disk stay marked restored, also after the window loads again.
      api.saveCallView({
        cards,
        reviewedLines: reviewed.current,
        key: callNow.current
      })
    }
    if (!assists.some(isStreaming)) {
      if (viewSave.current) clearTimeout(viewSave.current)
      save()
    } else viewSave.current ??= setTimeout(save, 1000)
  }, [assists, reviewing])

  const activeAgent = agents.find((a) => a.id === settings?.activeAgentId) ?? agents[0]
  const shownAgent = view === 'agent' ? agents.find((a) => a.id === chatAgentId) ?? activeAgent : activeAgent
  const subscriptionAccounts = useConnections()
  const overrideAccount = shownAgent?.subscriptionAccountId ? subscriptionAccounts.accounts.find(account => account.id === shownAgent.subscriptionAccountId) ?? null : undefined
  const routedProfile = settings && (settings.ai || shownAgent?.preferences?.ai) ? effectiveAI(settings, shownAgent, id => subscriptionAccounts.sources.find(source => source.id === id)?.provider || settings.provider) : undefined
  const readiness = callReadiness(settings, { chatgpt: auth.signedIn, claudeSubscription: claudeAuth.signedIn, claudeKey }, stt, overrideAccount, { profile: routedProfile, sources: subscriptionAccounts.sources })
  const { needsAI, noSpeech, setup: callSetup } = readiness
  const knownUserName = transcript.find(line => line.speaker === 'me' && line.voiceName)?.voiceName || overrideAccount?.name || (settings?.provider === 'claude' ? claudeAuth.name : auth.name)
  useEffect(() => {
    let current = true
    void api.sttStatus(shownAgent?.id).then(value => { if (current) setStt(value) }).catch(() => {})
    return () => { current = false }
  }, [shownAgent?.id, shownAgent?.subscriptionAccountId, shownAgent?.preferences?.transcription, settings?.subscriptionAccountId, subscriptionAccounts.accounts])
  const voiceAgentId = view === 'main' ? activeAgent?.id : chatAgentId || activeAgent?.id
  useEffect(() => { void api.setDictationAgent(voiceAgentId).catch(() => {}) }, [voiceAgentId])
  const activeNow = useRef(activeAgent)
  activeNow.current = activeAgent
  const resetCall = useCallback((call?: CurrentCall | void) => {
    inputPauseEpoch.current.me++; inputPauseEpoch.current.them++
    pausedInputs.current = { me: false, them: false }
    closeMonitorPick()
    setAskAgain(null)
    for (const card of assistsNow.current) earlierCards.current.set(card.id, card)
    setRecalled([])
    setBrief('')
    setGroup(false)
    lines.current = 0
    assistsNow.current = []
    setTranscript([])
    setAssists([])
    setFrames([])
    setTimelineOpen(false)
    setListeningSince(0)
    setPickedUp(null)
    reviewed.current = 0
    noted.current = 0
    clears.current++
    const key = call?.view?.key ?? crypto.randomUUID()
    callNow.current = key
    setCallKey(key)
    setWarnings([])
  }, [])

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.listAgents().then(setAgents)
    warmUpAudio().catch((err) => console.warn('[capture] warm-up failed:', (err as Error).message))
    void api.authStatus().then(setAuth)
    void api.sttStatus().then(setStt)
    // The call so far: after a reload, or the one that was open when Togle last closed.
    void api.currentCall().then((call) => {
      setTranscript(call.transcript)
      setFrames(call.frames)
      setBrief(call.brief)
      setGroup(call.group)
      setRecalled(call.recalled ?? [])
      setListeningSince(call.session?.startedAt ?? 0)
      let cards: AnswerItem[] = []
      if (call.view) {
        // Picked up from disk, its cards' answers ended with Togle; after the window loads again, they go on.
        cards = call.restoredFrom ? restoredCards(call.view.cards) : reloadedCards(call.view.cards, call.answering)
        setAssists(cards)
        reviewed.current = call.view.reviewedLines
        openedWith.current = { cards, reviewedLines: call.view.reviewedLines }
        // The same call: its stretches of the conversation are its own.
        if (call.view.key) {
          callNow.current = call.view.key
          setCallKey(call.view.key)
        }
      }
      noted.current = call.unreviewedAnswers
      if (call.transcript.length || call.frames.length || cards.length) {
        const first = Math.min(...call.transcript.map((e) => e.at), ...cards.map((c) => c.at), Date.now())
        setPickedUp({
          cards: [...cards].reverse(),
          at: first,
          restoredFrom: call.restoredFrom
        })
      }
      callLoaded.current = true
    })
    void api.screenMonitorStatus().then(setMonitorStatus)
    const subs = [
      api.onScreenMonitor(status => {
        setMonitorStatus(status)
        if (status.state === 'off') { monitorRequest.current++; recorder.current?.stop(); setRecording(false) }
      }),
      api.onScreenRefresh(id => recorder.current?.captureNow(id)),
      // The question shows in the main view: Settings or Agents may be open.
      api.onConfirmClose(() => setConfirmClose(true)),
      api.onAuthChanged(setAuth),
      api.onSettingsChanged(setSettings),
      api.onClaudeAuthChanged(setClaudeAuth),
      api.onRecall(setRecalled),
      api.onCallReset(resetCall),
      // The agent set what the call is, as it was told in the conversation.
      api.onBrief((call) => {
        setBrief(call.brief)
        setGroup(call.group)
      }),
      api.onPlanUsage(setPlan),
      api.onSttStatus(setStt),
      api.onTranscript((entry) => {
        // The call's first words open its stretch of the conversation, if nothing has yet.
        const agent = activeNow.current
        if (agent) chatsNow.current.callSaid(agent.id, entry.at, callNow.current, !!capture.current)
        // In time order: a line that ends after a later one began comes in later, and goes before it.
        setTranscript((prev) => (!prev.length || prev[prev.length - 1].at <= entry.at ? [...prev, entry] : [...prev, entry].sort((a, b) => a.at - b.at)))
      }),
      api.onTranscriptRemoved((ids) => setTranscript((prev) => prev.filter((e) => !ids.includes(e.id)))),
      api.onTranscriptUpdated(entries => setTranscript(previous => {
        const byId = new Map(entries.map(entry => [entry.id, entry]))
        return previous.map(entry => byId.get(entry.id) ?? entry)
      })),
      api.onAssist((event) => {
        // A new suggestion goes into the call's stretch in the conversation of the agent on the call.
        const agent = activeNow.current
        if (event.type === 'start' && agent) chatsNow.current.cardStarted(agent.id, event.id, event.at, callNow.current)
        setAssists((prev) => {
          const next = applyAnswerEvent(prev, event)
          // A long call's oldest cards leave the list the call works with, not the conversation: they're kept with the
          // cards of calls before, which its stretch and the kept conversation find them in.
          if (event.type === 'start') for (const gone of prev.slice(next.length - 1)) earlierCards.current.set(gone.id, gone)
          return next
        })
      }),
      // Studying and other training changes arrive in the background.
      api.onAgentChanged((agent) =>
        setAgents((prev) => (prev.some((a) => a.id === agent.id) ? prev.map((a) => (a.id === agent.id ? agent : a)) : [...prev, agent]))
      ),
      api.onAgentRemoved((id) => {
        setAgents((prev) => prev.filter((a) => a.id !== id))
        setChatAgentId(previous => previous === id ? undefined : previous)
        // Removing the active agent moves the call to another one.
        void api.getSettings().then(setSettings)
      }),
      // New frames, and frames whose description arrived later.
      api.onFrame((frame) => setFrames((prev) => (prev.some((f) => f.id === frame.id) ? prev.map((f) => (f.id === frame.id ? frame : f)) : [...prev, frame])))
    ]
    return () => subs.forEach((unsub) => unsub())
  }, [])

  // The conversation of the agent I talk to, as it was kept (once).
  useEffect(() => {
    if (activeAgent) chats.load(activeAgent.id)
  }, [activeAgent?.id])
  useEffect(() => {
    if (shownAgent) chats.load(shownAgent.id)
  }, [shownAgent?.id])

  // The call picked up as Togle started, once the conversation of the agent on it is back: the stretch it already has
  // there says so, or (from before calls were kept with it) it gets one.
  const conversationBack = !!activeAgent && chats.loaded(activeAgent.id)
  useEffect(() => {
    if (!pickedUp || !activeAgent || !conversationBack) return
    setPickedUp(null)
    const stretch = chats.of(activeAgent.id).entries.findLast((e) => e.role === 'call' && e.call === callNow.current)
    if (stretch) {
      if (pickedUp.restoredFrom) chats.update(activeAgent.id, stretch.id, (e) => (e.role === 'call' ? { ...e, restoredFrom: pickedUp.restoredFrom } : e))
      return
    }
    chats.add(activeAgent.id, {
      id: crypto.randomUUID(),
      role: 'call',
      call: callNow.current,
      startedAt: pickedUp.at,
      endedAt: pickedUp.restoredFrom ?? Date.now(),
      cards: pickedUp.cards.map((c) => c.id),
      restoredFrom: pickedUp.restoredFrom
    })
  }, [activeAgent?.id, pickedUp, conversationBack])

  // Asked for once signed in to ChatGPT; after that every answer keeps it up to date.
  useEffect(() => {
    void api.planUsage().then(setPlan)
  }, [auth.signedIn, settings?.provider])

  // The call ended: closing doesn't need asking any more.
  useEffect(() => {
    if (!listening && !recording) setConfirmClose(false)
  }, [listening, recording])

  const startMonitoring = useCallback(async (source: CaptureSource) => {
    if (!capture.current) return
    const request = ++monitorRequest.current
    try {
      recorder.current?.stop()
      setRecording(false)
      recorder.current ??= new ScreenRecorder()
      recorder.current.onEnded = () => { monitorRequest.current++; setRecording(false) }
      await recorder.current.start(source.id, true)
      if (request === monitorRequest.current) setRecording(recorder.current.active)
    } catch (error) {
      if (request === monitorRequest.current) {
        setRecording(false)
        if (capture.current) setWarnings([`Screen context could not start: ${errorText(error)}. The call is still listening.`])
      }
    }
  }, [])

  const toggleListening = useCallback(async (source?: CaptureSource | null, draft?: CallDraft | null) => {
    // Ignore clicks and hotkeys while capture is still opening devices.
    if (busy.current || resetting.current || choosingAgentNow.current) return
    closeSidebar()
    if (!capture.current && callSetup) {
      if (callSetup === 'ai' && (shownAgent?.subscriptionAccountId || shownAgent?.preferences?.ai)) { setAgentTab('settings'); setView('agent') }
      else openSettings(callSetup)
      return
    }
    if (!capture.current && source === undefined) {
      const agentId = shownAgent?.id
      if (!agentId) return
      const fresh = view !== 'main'
      setCallDraft(previous => previous?.agentId === agentId && previous.fresh === fresh ? previous : { agentId, fresh, brief: fresh ? '' : brief, group: fresh ? false : group })
      await chooseMonitor('start')
      return
    }
    closeMonitorPick()
    busy.current = true
    try {
      if (capture.current) {
        monitorRequest.current++
        recorder.current?.stop()
        setRecording(false)
        capture.current.stop()
        const noise = capture.current.takeNoiseReport()
        capture.current = null
        // A noisy call: what the microphone picked up, shown once the call is over (main decides whether it's time).
        if (noise && noise.verdict === 'noisy') {
          const { sample, ...report } = noise
          void api.noiseMeasured(report).then(show => { if (show) setNoiseFinding({ report, sample }) }, () => undefined)
        }
        setListening(false)
        chatsNow.current.callEnded(Date.now())
        await api.setListening(false).catch((err) => setWarnings([errorText(err)]))
        return
      }
      setStarting(true)
      if (draft) {
        const owner = agentsNow.current.find(agent => agent.id === draft.agentId)
        if (!owner) throw new Error('This agent is no longer available. Choose another agent.')
        if (draft.fresh) {
          resetting.current = true; setClearing(true)
          if (viewSave.current) clearTimeout(viewSave.current)
          viewSave.current = null
          try { resetCall(await api.clearTranscript()) }
          finally { resetting.current = false; setClearing(false) }
        }
        if (activeNow.current?.id !== owner.id) {
          choosingAgentNow.current = true; setChoosingAgent(true)
          try { setSettings(await api.updateSettings({ activeAgentId: owner.id })); activeNow.current = owner }
          finally { choosingAgentNow.current = false; setChoosingAgent(false) }
        }
        setChatAgentId(owner.id)
        setBrief(draft.brief); setGroup(draft.group)
        api.setBrief(draft.brief); api.setGroupCall(draft.group)
        setCallDraft(null)
      }
      setView('main')
      // Resume keeps the same context; starting from an agent chat creates a separate call.
      const resumed = !draft?.fresh && (lines.current > 0 || assistsNow.current.length > 0)
      const session = new CallCapture()
      session.onState = setAudioInputs
      setNoiseFinding(null)
      try {
        for (const speaker of ['me', 'them'] as const) await api.pauseCallInput(speaker, pausedInputs.current[speaker])
        // Togle Microphone first, when it's installed and Settings say so: the call then hears the clean microphone.
        const cleanMic = await api.prepareCallMicrophone().catch(() => undefined)
        const measureNoise = settingsNow.current?.microphone?.suggestions !== false && !isMicrophoneOn(cleanMic)
        await session.start((speaker, pcm, startedAt, segmentId, kind) => api.pushAudio(speaker, pcm, startedAt, segmentId, kind), (['me', 'them'] as const).filter(speaker => pausedInputs.current[speaker]), { measureNoise })
        const info = await api.setListening(true, draft?.meetingId)
        capture.current = session
        setWarnings([])
        setListening(true)
        setListeningSince(info?.startedAt ?? Date.now())
        const agent = activeNow.current
        if (agent) chatsNow.current.callStarted(agent.id, Date.now(), callNow.current, resumed)
        if (source) void startMonitoring(source)
        console.info(`[capture] listening to ${Object.keys(session.levels).join(' + ')}`)
      } catch (err) {
        session.stop()
        capture.current = null
        setListening(false)
        await api.setListening(false).catch(() => undefined)
        setWarnings([errorText(err)])
        console.warn('[capture] failed to start:', (err as Error).message)
      }
    } catch (err) {
      setWarnings([`Could not start the call: ${errorText(err)}`])
    } finally {
      busy.current = false
      setStarting(false)
    }
  }, [callSetup, chooseMonitor, closeMonitorPick, startMonitoring, shownAgent?.id, view, brief, group, resetCall, closeSidebar])

  /** The hotkey pauses watching or asks for a source. It never silently switches to another screen. */
  const toggleRecording = useCallback(
    async () => {
      if (recorder.current?.active || monitorStatus.state === 'watching' || monitorStatus.state === 'reading') {
        monitorRequest.current++
        recorder.current?.stop()
        setRecording(false)
        return
      }
      if (!capture.current) await toggleListening()
      else await chooseMonitor('change')
    },
    [toggleListening, chooseMonitor, monitorStatus.state]
  )

  const snapshot = useCallback(async (screen?: number) => {
    try {
      await api.snapshot(screen)
    } catch (err) {
      setWarnings([`Snapshot failed: ${errorText(err)}`])
    }
  }, [])

  const takeScreen = (use: ScreenUse, screen?: number): void => {
    if (use === 'snapshot') void snapshot(screen)
    else api.assist({ kind: 'suggest', withScreen: true, screen })
  }

  /**
   * The Screen menu asks which screen when there's more than one: as it's clicked, the mouse is on Togle's own
   * screen. The hotkeys take the screen under the mouse, so pointing at one picks it.
   */
  const chooseScreen = async (use: ScreenUse): Promise<void> => {
    // While it's open, the same choice closes it and the other one switches what it's for.
    if (screenPick) return setScreenPick(screenPick.use === use ? null : { ...screenPick, use })
    if (listingScreens.current) return
    listingScreens.current = true
    try {
      const screens = await api.listScreens().catch(() => [])
      if (screens.length > 1) setScreenPick({ use, screens })
      else takeScreen(use)
    } finally {
      listingScreens.current = false
    }
  }

  const closeScreenPick = useCallback(() => setScreenPick(null), [])
  const closeSessionPick = useCallback(() => setSessionPick(false), [])
  useEffect(() => { setSessionPick(false); setScreenPick(null) }, [view, chatAgentId, agentTab])

  useEffect(
    () =>
      api.onHotkey((action) => {
        if (action === 'dictation-settings') openSettings('dictation')
        if (action === 'toggle-listening') void toggleListening()
        if (action === 'toggle-recording') void toggleRecording()
        if (action === 'snapshot') void snapshot()
        // Togle came up (the shortcut brought it): the box to write in, ready to type, in the conversation.
        if (action === 'ask') {
          closeSidebar()
          setView(capture.current || lines.current || assistsNow.current.length ? 'main' : 'agent')
          setTimeout(() => document.querySelector<HTMLTextAreaElement>('.main form.composer textarea')?.focus(), 50)
        }
        // What the newest suggestion says to say, as its Copy would copy it (from the call's app, so Togle copies it).
        if (action === 'copy') {
          const newest = assistsNow.current.find((a) => a.kind !== 'summary' && toSay(a))
          if (newest) api.copyText(toSay(newest))
        }
      }),
    [toggleListening, toggleRecording, snapshot, closeSidebar]
  )

  // Settings opened from anywhere (a card's error, the setup card, the call strip), at the part that fixes it; opened
  // as itself (its button), at its top.
  useEffect(() => onOpenSettings((at) => {
    closeSidebar()
    setSettingsAt(at)
    setView('settings')
  }), [closeSidebar])
  useEffect(() => {
    if (view !== 'settings') setSettingsAt(undefined)
  }, [view])
  useEffect(() => {
    if (settings?.provider !== 'claude') return
    if (settings.claude.auth === 'subscription') void api.claudeAuthStatus().then(setClaudeAuth)
    else void api.hasClaudeKey().then(setClaudeKey)
  }, [settings?.provider, settings?.claude.auth, view])
  // Asked whether to close during a call: Keep going has the keys (Enter keeps going), and Escape is Keep going too.
  useEffect(() => {
    if (!confirmClose) return
    keepGoing.current?.focus()
    const keep = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setConfirmClose(false)
    }
    window.addEventListener('keydown', keep, true)
    return () => window.removeEventListener('keydown', keep, true)
  }, [confirmClose])

  // Escape leaves Settings for the conversation; a field being edited is saved first, as it is when Done is clicked.
  useEffect(() => {
    if (view !== 'settings') return
    const leave = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const editing = document.activeElement
      if (editing instanceof HTMLElement) editing.blur()
      setView(workspaceReturn.current)
    }
    window.addEventListener('keydown', leave)
    return () => window.removeEventListener('keydown', leave)
  }, [view])

  // Back in the conversation from a page (Escape, Back): the box to write in has the keys, as after the shortcut that
  // brings Togle up.
  const viewBefore = useRef(view)
  useEffect(() => {
    if ((view === 'main' || view === 'agent') && viewBefore.current !== view) document.querySelector<HTMLTextAreaElement>('.main form.composer textarea')?.focus()
    viewBefore.current = view
  }, [view])

  const changeSettings = useCallback(async (patch: SettingsPatch) => setSettings(await api.updateSettings(patch)), [])
  const [changingAuto, setChangingAuto] = useState(false)
  const autoBusy = useRef(false)
  const toggleAuto = async (): Promise<void> => {
    if (autoBusy.current || !settings) return
    autoBusy.current = true
    setChangingAuto(true)
    try {
      await changeSettings({ assist: { auto: !settings.assist.auto } })
    } catch (err) {
      setWarnings([`Could not change automatic replies: ${errorText(err)}`])
    } finally {
      autoBusy.current = false
      setChangingAuto(false)
    }
  }


  // The same from one render to the next, so the agents page (memoized) isn't drawn again with every caption.
  const talkTo = useCallback((id: string) => {
    setSidebarOpen(false)
    setChatAgentId(id)
    setAgentTab('chat')
    setSelectedCallId(undefined)
    setView(capture.current && activeNow.current?.id === id ? 'main' : 'agent')
  }, [])
  const agentsDone = useCallback(() => {
    // Deleting the active agent moves settings to another one; refresh to match.
    void api.getSettings().then(setSettings)
    setView(workspaceReturn.current)
  }, [])
  // A new agent set up from a description: it's the one on calls now, and its conversation starts with what it made.
  const agentDrafted = useCallback((agent: Agent, said: string) => {
    chatsNow.current.greet(agent, said)
    setChatAgentId(agent.id)
    setAgentTab('chat')
    setView('agent')
  }, [])

  /** Opens the list of agents, or sharing one. */
  const openAgents = (ask: { share?: string } = {}) => {
    setAgentsRequest((r) => ({ ...ask, seq: r.seq + 1 }))
    setView('agents')
  }
  const navigateSidebar = useCallback((page: SidebarPage) => {
    setSidebarOpen(false)
    if (page === 'settings') { setSettingsAt(undefined); setView('settings') }
    else { setAgentsRequest(previous => ({ seq: previous.seq + 1, create: page === 'new' })); setView('agents') }
  }, [])

  /** A question tried as if someone on a call asked it: what the agent would suggest comes into the conversation. */
  const tryQuestion = (agent: Agent, question: string): void => {
    const entryId = chatsNow.current.tried(agent.id, question)
    api.testAgent(agent.id, question, { tag: `try-${entryId}` })
  }

  /** Deletes an agent with everything it learned and its conversation, once I say so. The same each time: Agents is memoized. */
  const deleteAgent = useCallback(async (agent: Agent) => {
    if (!window.confirm(`Delete "${agent.name}" with everything it learned, and your conversation with it? Saved calls remain available in Settings under Calls from removed agents.`)) return
    try {
      await api.removeAgent(agent.id)
      setAgentTab('chat')
      setSelectedCallId(undefined)
    } catch (err) {
      setWarnings([errorText(err)])
    }
  }, [])

  /**
   * Files, a folder, or a project's code attached in the conversation (picked with the paperclip, or dropped in): the
   * agent says what went in, each with Undo, while long documents are studied in the background.
   */
  const attach = async (agent: Agent, kind: 'files' | 'folder' | 'code', dropped?: string[]) => {
    const paths = dropped ?? (await api.pickToAttach(kind))
    if (!paths.length) return
    if (kind === 'code') {
      const folders = paths.filter((p) => !agent.codeFolders.includes(p))
      // The same folder again: it says so, rather than nothing happening.
      if (!folders.length) {
        chatsNow.current.add(agent.id, {
          id: crypto.randomUUID(),
          role: 'agent',
          text: `I read the code in ${paths.length === 1 ? paths[0] : 'those folders'} already.`,
          changes: [],
          at: Date.now(),
          status: 'done'
        })
        return
      }
      replaceAgent(
        await api.updateAgent(agent.id, {
          codeFolders: [...agent.codeFolders, ...folders]
        })
      )
      chatsNow.current.add(agent.id, {
        id: crypto.randomUUID(),
        role: 'agent',
        text: "On calls about code, I'll search and read it before answering.",
        changes: folders.map((f) => `Reads the code in: ${f}`),
        at: Date.now(),
        status: 'done'
      })
      return
    }
    const id = crypto.randomUUID()
    const reading = {
      id,
      role: 'agent' as const,
      text: '',
      changes: [],
      at: Date.now(),
      status: 'streaming' as const,
      activity: 'Reading it…'
    }
    chatsNow.current.add(agent.id, reading)
    const known = new Set(agent.knowledge.map((d) => d.id))
    try {
      const { agent: after, errors, unchanged = [], exports = [] } = await api.addAgentPaths(agent.id, paths)
      replaceAgent(after)
      const added = after.knowledge.filter((d) => !known.has(d.id))
      // An export of their chats: they pick the ones for this agent from the list, which opens with them in it.
      const found = exports.map((e) =>
        e.chats
          ? `Your chats from ${e.home} are here: ${e.chats} of them, the newest from ${new Date(e.newest).toLocaleDateString([], { month: 'short', day: 'numeric' })}.${e.newer ? ' A newer export of that account is in Downloads, and I read that one.' : ''}`
          : `That export from ${e.home} holds no chats.`
      )
      if (exports.some((e) => e.chats)) {
        found.push('Pick the ones for me in the list, or tell me which.')
        setSessionPick(true)
      }
      // What it has already, as it is, is said; what it couldn't read is listed, each with why.
      const failed = errors.map(unreadable)
      chatsNow.current.update(agent.id, id, () => ({
        ...reading,
        activity: undefined,
        status: added.length || exports.length || unchanged.length || !errors.length ? 'done' : 'error',
        text: [
          found.join(' '),
          unchanged.length === 1 ? `I have ${unchanged[0]} already, as it is.` : unchanged.length ? `I have ${unchanged.length} of them already, as they are.` : '',
          added.some((d) => d.status === 'studying') ? "I'll study the long ones in the background; you can ask about them already." : '',
          failed.length === 1 && !failed[0].includes(': ')
            ? failed[0]
            : failed.length
              ? `I couldn't read ${failed.length === 1 ? 'one' : failed.length} of them:\n${failed.map((line) => `- ${line}`).join('\n')}`
              : ''
        ]
          .filter(Boolean)
          .join('\n\n'),
        changes: added.map((d) => `Added to Knowledge: ${d.name}`)
      }))
    } catch (err) {
      chatsNow.current.update(agent.id, id, () => ({
        ...reading,
        activity: undefined,
        status: 'error',
        error: errorText(err)
      }))
    }
  }

  /**
   * A work session picked to give the agent (Claude Code, Codex): it says it went in, with Undo, and once it has read
   * it, where the work stands (under that line). Worked on since it was added, it's read again.
   */
  const attachSession = async (agent: Agent, session: WorkSessionInfo) => {
    setSessionPick(false)
    const id = crypto.randomUUID()
    const reading = {
      id,
      role: 'agent' as const,
      text: '',
      changes: [],
      at: Date.now(),
      status: 'streaming' as const,
      activity: 'Reading the session…'
    }
    chatsNow.current.add(agent.id, reading)
    try {
      const { agent: after, doc, done } = await api.addWorkSession(agent.id, session.file)
      replaceAgent(after)
      const text =
        done === 'unchanged'
          ? 'I have it already, as it is now.'
          : done === 'busy'
            ? "I'm reading it in already."
            : session.tool === 'claude-ai' || session.tool === 'chatgpt'
              ? "I'll use it on your calls. It's as of your last export: one you make later brings it up to date."
              : "I'll use it on your calls, and read it again before each call if you've worked on it since."
      const changes = doc && (done === 'added' || done === 'updated') ? [`Added to Knowledge: ${doc.name}`] : []
      chatsNow.current.update(agent.id, id, () => ({
        ...reading,
        activity: undefined,
        status: 'done',
        text,
        changes
      }))
    } catch (err) {
      chatsNow.current.update(agent.id, id, () => ({
        ...reading,
        activity: undefined,
        status: 'error',
        error: errorText(err)
      }))
    }
  }

  const signIn = async () => {
    setSigningIn(true)
    try {
      await api.signInWithBrowser()
    } finally {
      setSigningIn(false)
    }
  }

  /** After the review trained the agent: the call's last answered questions (cards are newest first), to see what changed. */
  const askAgainFor = (agent: Agent, reviewId: string) => {
    const asked = assistsNow.current
      .filter((a) => a.kind !== 'summary' && a.question.trim() && (a.text || a.match))
      .slice(0, 3)
      .reverse()
    // A new review's questions start afresh, even with the last one's still open.
    if (asked.length)
      setAskAgain({
        key: Date.now(),
        reviewId,
        agentId: agent.id,
        agentName: agent.name,
        asked
      })
  }

  /**
   * The call review, told in the conversation of the agent on the call: by default it keeps what it found at once, as
   * Hermes Agent does, and says so with Undo; what changes what it knows, or says an amount or a deal heard on the call,
   * it asks about. Set to ask first, it asks about all of it.
   */
  const teach = async () => {
    // One review at a time: asking again while it runs doesn't start another.
    if (reviewingNow.current) return
    const asked = activeNow.current
    if (!asked) return
    reviewingNow.current = true
    setReviewing(true)
    const before = {
      lines: reviewed.current,
      noted: noted.current,
      call: clears.current
    }
    reviewed.current = lines.current
    noted.current = 0
    const id = crypto.randomUUID()
    chatsNow.current.add(asked.id, {
      id,
      role: 'review',
      agentId: asked.id,
      at: Date.now(),
      review: { state: 'loading' }
    })
    const show = (review: Review): void => chatsNow.current.update(asked.id, id, (e) => (e.role === 'review' ? { ...e, review } : e))
    try {
      const result = await api.learnFromCall()
      if (result.session && result.agent) {
        const { learning, id: sessionId, summary } = result.session
        const updated = result.agent
        replaceAgent(updated)
        if (learning.changes.length && clears.current === before.call) askAgainFor(updated, id)
        show({ state: 'learned', changes: learning.changes.map(change => change.id), left: [], remembered: !!summary,
          sessionId, reviewId: learning.reviewId,
          ...(anyLessons(learning.pending) ? { held: learning.pending, asking: updated.learning !== 'auto' } : {}) })
        return
      }
      const { agentId, record, check = NO_LESSONS, lesson: taught, ...lessons } = result
      const remembered = !!record
      // A call that taught it: it offers to keep its notes as a document, whatever else it found.
      const lesson: LessonOffer | undefined = taught && {
        ...taught,
        state: 'offer'
      }
      const agent = agentsNow.current.find((a) => a.id === agentId)
      const found = joinLessons(lessons, check)
      if (agent?.learning !== 'auto') {
        return show({
          state: 'learned',
          changes: [],
          left: [],
          remembered,
          lesson,
          ...(anyLessons(found) ? { held: found, asking: true } : {})
        })
      }
      const kept = lessons, left: string[] = []
      const known = new Set(agent.history.map((h) => h.id))
      let changes: string[] = []
      if (anyLessons(kept)) {
        try {
          const updated = await api.remember(agentId, kept, true)
          changes = updated.history.filter((h) => h.origin === 'auto' && !known.has(h.id)).map((h) => h.id)
          setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
          askAgainFor(updated, id)
        } catch (err) {
          // Not kept after all: it asks about all of it.
          return show({
            state: 'learned',
            changes: [],
            left: [],
            remembered,
            lesson,
            held: found,
            asking: true,
            error: errorText(err)
          })
        }
      }
      show({
        state: 'learned',
        changes,
        left,
        remembered,
        lesson,
        ...(anyLessons(check) ? { held: check } : {})
      })
    } catch (err) {
      // Nothing was reviewed: the call has as much to teach as before, for the next review (unless it was cleared).
      if (clears.current === before.call) {
        reviewed.current = before.lines
        noted.current += before.noted
      }
      show({ state: 'error', message: errorText(err) })
    } finally {
      reviewingNow.current = false
      setReviewing(false)
    }
  }
  // For Start, which may look back at the call before it first.
  const teachRef = useRef(teach)
  teachRef.current = teach

  // The end of a call is when it has the most to teach: the review runs then by itself (unless the agent is set not to
  // review calls; asked to, it still does).
  useEffect(() => {
    const stopped = wasListening.current && !listening
    wasListening.current = listening
    const enough = (): boolean => lines.current - reviewed.current >= LEARN_AFTER_LINES || noted.current > 0
    if (!stopped || reviewingNow.current || !enough() || activeAgent?.learning === 'off') return
    // Checked again when it fires: a new call meanwhile leaves nothing to learn from. Meanwhile it's about to look
    // back at the call: Learn from this call isn't offered for those moments.
    setReviewSoon(true)
    const timer = setTimeout(() => {
      setReviewSoon(false)
      if (enough() && activeNow.current?.learning !== 'off') void teach()
    }, LEARN_DELAY_MS)
    return () => {
      clearTimeout(timer)
      setReviewSoon(false)
    }
  }, [listening])

  const deeper = useCallback((item: AnswerItem) => api.thinkDeeper(item.id), [])
  const stop = useCallback((item: AnswerItem) => api.cancelAssist(item.id), [])
  // A card that failed, asked again: the same question (its own words, so what they said since doesn't change it).
  const again = useCallback(
    (item: AnswerItem) => void api.assist({ kind: item.kind, question: item.kind === 'summary' ? undefined : item.question.trim() || undefined, withScreen: item.withScreen }),
    []
  )
  // This call's suggestions, those of calls before it this session, and those kept with the conversation.
  const cardOf = (id: string): AnswerItem | undefined => assists.find((a) => a.id === id) ?? earlierCards.current.get(id) ?? chats.keptCard(id)
  const cardNow = useRef(cardOf)
  cardNow.current = cardOf

  /** What's written below the conversation: during the call, a question about it; otherwise, said to the agent. */
  const send = (text: string): void => {
    if (view === 'agent' && shownAgent) chats.teach(shownAgent, text)
    else api.assist({ kind: 'ask', question: text })
  }

  // The call heard with the ChatGPT plan (as it is unless another is picked), not signed in yet: it hears once signed in.
  const hearsOnSignIn = !!settings && (settings.transcription.me === 'chatgpt' || settings.transcription.them === 'chatgpt') && !auth.signedIn
  // ChatGPT answering and hearing alike: signing in is all a first call needs.
  const signInOnly = !routedProfile && !shownAgent?.subscriptionAccountId && !!settings && settings.provider === 'chatgpt' && needsAI && (!noSpeech || hearsOnSignIn)
  const useLocalSpeech = async () => {
    try {
      await changeSettings({ transcription: { me: 'local', them: 'local' } })
      openSettings('speech')
    } catch (err) {
      setWarnings((prev) => [...prev, (err as Error).message])
    }
  }
  const useClaude = async (): Promise<void> => {
    try {
      const speech = subscriptionAccounts.accounts.find(account => account.id === settings?.transcription.accountId)
      const connectSpeech = !speech?.signedIn && ['chatgpt', 'claude'].includes(settings?.transcription.me || '')
      const claudeId = subscriptionAccounts.accounts.find(account => account.id === settings?.subscriptionAccountId && account.provider === 'claude')?.id || 'claude-default'
      await changeSettings({ provider: 'claude', claude: { auth: 'subscription' }, ...(connectSpeech ? { transcription: { accountId: claudeId, me: 'claude' as const, them: 'claude' as const } } : {}) })
      openSettings('ai')
    } catch (err) { setWarnings([errorText(err)]) }
  }
  const signInRow = (primary: boolean) => (
    <>
      <div className="row">
        <button className={primary ? 'primary' : 'ghost'} disabled={signingIn} onClick={() => void signIn()}>
          {signingIn ? 'Waiting for browser…' : 'Sign in with ChatGPT'}
        </button>
        {signingIn ? (
          <button className="ghost" onClick={() => void api.cancelSignIn()}>
            Cancel
          </button>
        ) : (
          primary && (
            <button className="ghost" onClick={() => void useClaude()}>
              Use Claude
            </button>
          )
        )}
      </div>
      {auth.error && <p className="error">{auth.error}</p>}
    </>
  )
  // What a first call needs, in one card in the conversation, each part ticked once it's there: an AI for the
  // suggestions, and speech recognition to hear the call (with ChatGPT, one sign-in for both). During a call, the call
  // strip says what's missing instead.
  const setup =
    !listening &&
    !!settings &&
    (needsAI || noSpeech) &&
    (signInOnly ? (
      <article className="assist connect setup">
        <p className="setup-title">Connect your AI plan</p>
        <p className="hint">Use a plan you already have. Transcription can also run on this PC.</p>
        {signInRow(true)}
      </article>
    ) : (
      <article className="assist connect setup">
        <p className="setup-title">Finish call setup</p>
        <div className={`setup-step ${needsAI ? '' : 'done'}`}>
          <span className="step-mark">{needsAI ? '1' : <Icon name="check" size={12} />}</span>
          <div className="step-body">
            <p>AI for answers</p>
            {!needsAI ? (
              <p className="hint">Using {readiness.answers}</p>
            ) : shownAgent?.subscriptionAccountId || shownAgent?.preferences?.ai ? (
              <button className="primary" onClick={() => { setAgentTab('settings'); setView('agent') }}>Connect this agent’s account</button>
            ) : routedProfile ? (
              <button className="primary" onClick={() => openSettings('ai')}>Check AI connections</button>
            ) : settings.provider === 'chatgpt' ? (
              <>
                <p className="hint">Uses your ChatGPT plan. Its usage limits apply.</p>
                {signInRow(true)}
              </>
            ) : (
              <div className="row">
                <button className="primary" onClick={() => openSettings('ai')}>
                  {settings.provider === 'claude' ? settings.claude.auth === 'subscription' ? 'Sign in with Claude' : 'Add your Anthropic API key' : 'Pick a model'}
                </button>
              </div>
            )}
          </div>
        </div>
        <div className={`setup-step ${noSpeech ? '' : 'done'}`}>
          <span className="step-mark">{noSpeech ? '2' : <Icon name="check" size={12} />}</span>
          <div className="step-body">
            <p>Speech to text</p>
            {noSpeech && hearsOnSignIn ? (
              <>
                <p className="hint">Transcribe on this PC, or use a ChatGPT plan.</p>
                <div className="row">
                  <button className="primary" onClick={() => void useLocalSpeech()}>
                    Set up on this PC
                  </button>
                  <button className="ghost" disabled={signingIn} onClick={() => void signIn()}>
                    {signingIn ? 'Waiting for browser…' : 'Use ChatGPT'}
                  </button>
                </div>
                {signingIn && <button className="link" onClick={() => void api.cancelSignIn()}>Cancel sign-in</button>}
                {auth.error && <p className="error">{auth.error}</p>}
              </>
            ) : noSpeech ? (
              <>
                {stt.needs && <p className="hint">With {stt.needs} in Settings, or installed on this PC.</p>}
                <div className="row">
                  <button className={needsAI ? 'ghost' : 'primary'} onClick={() => openSettings('speech')}>
                    {stt.needs ? 'Set it up…' : 'Install…'}
                  </button>
                </div>
              </>
            ) : (
              <p className="hint">{stt.state === 'starting' ? 'Getting ready…' : 'Ready'}</p>
            )}
          </div>
        </div>
      </article>
    ))
  const planShown = settings?.provider === 'chatgpt' && auth.signedIn ? plan : null
  const windowSettings = settings?.window
  const recordName = monitorStatus.source?.name ?? 'the selected source'
  const hasCall = listeningSince > 0 || transcript.length > 0 || assists.length > 0 || frames.length > 0
  const answerConnection = readiness.answers
  const canLearn = !reviewing && !reviewSoon && (transcript.length - reviewed.current > 0 || noted.current > 0)
  // Only Windows can reliably exclude the window from modern screen-capture APIs.
  const hidden = api.platform === 'win32' && (recording || !!windowSettings?.hideFromCapture)
  const learn = useCallback(() => void teachRef.current(), [])
  const summarize = useCallback(() => api.assist({ kind: 'summary' }), [])
  const showTranscript = useCallback(() => setTimelineOpen(true), [])

  const screenItems: MenuItem[] = [
    { label: 'Suggest from the screen', onSelect: () => void chooseScreen('suggest') },
    { label: 'Save a picture of it for the call', onSelect: () => void chooseScreen('snapshot') }
  ]

  // During the call: what to ask for, the screen, recording, and how much of the plan is used.
  const stripTools = (listening || recording) && (
    <>
      <div className="strip-row tools">
        <button className="suggest-reply" title={withKeys('Suggest a reply', keys.suggest)} onClick={() => api.assist({ kind: 'suggest' })}>
          Suggest reply
        </button>
        <CallToggle
          label="Auto" accessibleLabel="Automatic replies" checked={!!settings?.assist.auto}
          disabled={changingAuto}
          title={settings?.assist.auto ? 'Pause automatic replies. Suggest reply stays available.' : 'Suggest replies automatically when you need to answer.'}
          onToggle={() => void toggleAuto()}
        />
        <CallToggle label="Group" accessibleLabel="Group call" checked={group}
          title={group ? 'Group mode is on. Focus on questions addressed to you.' : 'Turn on group mode for calls with several people.'}
          onToggle={() => { setGroup(!group); api.setGroupCall(!group) }} />
        <Menu
          className="call-tools"
          title="Summary and screen options"
          ariaLabel="Call tools"
          direction="up"
          label={<>Tools <Icon name="chevron" size={12} /></>}
          items={[
            { label: 'Summarize call', disabled: !hasCall, onSelect: summarize },
            'divider',
            { heading: 'Screen' },
            ...screenItems
          ]}
        />
        {screenPick && (
          <ScreenPicker
            title={screenPick.use === 'snapshot' ? 'Which screen to snapshot?' : 'Which screen to look at?'}
            screens={screenPick.screens}
            last={lastScreen.current}
            onPick={(id) => {
              lastScreen.current = id
              setScreenPick(null)
              takeScreen(screenPick.use, id)
            }}
            onClose={closeScreenPick}
          />
        )}
        <span className="spacer" />
        {planShown && <PlanMeter plan={planShown} listening={listening} onOpen={() => setView('settings')} />}
      </div>
      <CallPeople key={callKey} transcript={transcript} group={group} onGroup={value => { setGroup(value); api.setGroupCall(value) }} auto={!!settings?.assist.auto} onAuto={() => void toggleAuto()} remember={settings?.assist.rememberVoices !== false} />
      {listening && <div className={`screen-context-status ${recording ? 'on' : ''}`} aria-label="Screen context">
        <span className="screen-context-label"><Icon name="monitor" /><strong>{monitorStatus.state === 'reading' ? 'Reading screen…' : recording ? `Watching ${recordName}` : monitorStatus.state === 'watching' ? 'Connecting screen…' : monitorStatus.state === 'paused' ? 'Screen paused' : 'Audio only'}</strong></span>
        <span className="spacer" />
        {recording || monitorStatus.id ? <button className="link" title={withKeys('Pause screen context', keys.record)} onClick={() => void toggleRecording()}>Pause screen</button> : monitorStatus.source ? <button className="link" onClick={() => void startMonitoring(monitorStatus.source!)}>Resume screen</button> : null}
        <button className="link" onClick={() => void chooseMonitor('change')}>{monitorStatus.source ? 'Change' : 'Add screen'}</button>
        {monitorStatus.error && <span className="screen-context-detail" role="status">{monitorStatus.error}</span>}
        <ScreenTiming status={monitorStatus} />
      </div>}
    </>
  )

  const callStrip = (listening || recording || timelineOpen) && (
    <CallStrip
      key={callKey}
      listening={listening}
      capture={capture}
      inputs={audioInputs}
      onPauseInput={speaker => void pauseInput(speaker)}
      onRetryAudio={() => void capture.current?.retryMissing()}
      microphone={microphone}
      transcript={transcript}
      frames={frames}
      open={timelineOpen}
      onOpen={setTimelineOpen}
      tools={stripTools || undefined}
      deaf={
        noSpeech
          ? hearsOnSignIn
            ? "Can't hear the call: sign in with ChatGPT first."
            : stt.needs
              ? `Can't hear the call: add ${stt.needs} in Settings first.`
              : "Can't hear the call: speech recognition isn't installed."
          : stt.state === 'error'
            ? "Can't hear the call: speech recognition stopped."
            : undefined
      }
    />
  )

  const attachMenu = shownAgent && (
    <>
      <Menu
        className="attach-menu icon"
        ariaLabel="Add context"
        title={`Give ${shownAgent.name} documents to reuse across calls, a work session, or a project's code to read`}
        direction="up"
        label={<Icon name="paperclip" />}
        items={[
          {
            label: 'Files…',
            onSelect: () => void attach(shownAgent, 'files')
          },
          {
            label: 'A folder…',
            onSelect: () => void attach(shownAgent, 'folder')
          },
          {
            label: 'Import an AI chat…',
            note: 'Claude Code, Codex, claude.ai, ChatGPT',
            onSelect: () => setSessionPick(true)
          },
          {
            label: "A project's code…",
            onSelect: () => void attach(shownAgent, 'code')
          }
        ]}
      />
      {sessionPick && (
        <SessionPicker agent={shownAgent} onPick={(session) => void attachSession(shownAgent, session)} onAgent={replaceAgent} onClose={closeSessionPick} />
      )}
    </>
  )

  const configuring = view === 'agent' && (agentTab === 'settings' || agentTab === 'knowledge' || agentTab === 'skills' || agentTab === 'learning')
  const workspaceTabs: readonly (typeof agentTab)[] = configuring ? CONFIG_TABS : AGENT_TABS
  const selectedAgentTab = view === 'main' ? 'live' : agentTab
  const selectAgentTab = (tab: typeof agentTab): void => {
    if (shownAgent) setChatAgentId(shownAgent.id)
    setSelectedCallId(undefined)
    setAgentTab(tab)
    setView(tab === 'live' && hasCall && shownAgent?.id === activeAgent?.id ? 'main' : 'agent')
  }

  const callButton = view === 'agent' && listening ? undefined : (
    // Beside the box to write in, in its form: a click starts or stops the call, it doesn't send what's written.
    <button
      type="button"
      className={`primary listen ${listening && view !== 'agent' ? 'stop' : ''}`}
      disabled={starting || clearing || choosingAgent || !settings}
      title={withKeys(listening ? 'End the call' : callSetup ? 'Connect AI and transcription before starting' : `Start a call with ${shownAgent?.name}`, keys.listen)}
      onClick={() => void toggleListening()}
    >
      <Icon name={listening && view !== 'agent' ? 'stop' : callSetup ? 'settings' : 'phone'} size={13} />
      {starting ? 'Starting…' : listening ? view === 'agent' ? 'Return to call' : 'End call' : callSetup ? 'Set up call' : view === 'main' && hasCall ? 'Resume call' : 'Start call'}
    </button>
  )

  return (
    <div className={`app ${listening ? 'in-call' : ''}`}>
      <header className="titlebar" inert={!!monitorPick}>
        <div className="title">
          <button className="icon sidebar-toggle" aria-label="Toggle agents" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(previous => !previous)}><Icon name="sidebar" size={17} /></button>
          <span className="brand"><img src={togleIcon} width={20} height={20} alt="" /><span className="brand-name">Togle</span></span>
          {listening && (view === 'main' ? <span className="live" role="timer" aria-label="Call duration"><span className="dot live" /><Elapsed since={listeningSince} />{hidden && <Icon name="eyeOff" size={12} />}</span> : (
            <button className="live live-call-link" aria-label={`Return to call with ${activeAgent?.name}`} onClick={openCurrentCall} title={hidden ? "Listening. Only you can see Togle: screen shares and recordings show what's behind it." : 'Return to the running call'}>
              <span className="dot live" />
              <span>Return to live call</span><Elapsed since={listeningSince} />
              {hidden && <Icon name="eyeOff" size={12} />}
            </button>
          ))}
        </div>
        <div className="window-buttons">
          <button className="icon" title="Minimize" aria-label="Minimize" onClick={() => api.minimize()}>
            <Icon name="minimize" />
          </button>
          <button className="icon close" title="Close to tray · Togle keeps running" aria-label="Close to tray" onClick={() => api.close()}>
            <Icon name="close" />
          </button>
        </div>
      </header>

      {/* Once, after the first sign-in with ChatGPT: answers use the plan, and where to manage that (OpenAI's guidelines). */}
      {settings && auth.signedIn && !settings.chatgpt.planIntroSeen && (
        <div className="monitor-picker-backdrop plan-intro-backdrop">
          <div className="monitor-picker plan-intro" role="dialog" aria-modal="true" aria-labelledby="plan-intro-title">
            <h2 id="plan-intro-title">You're using your ChatGPT plan</h2>
            <p className="hint">Eligible usage in Togle uses your ChatGPT plan. Manage usage in your ChatGPT settings.</p>
            <div className="row">
              <button className="link" onClick={() => api.openExternal(MANAGE_USAGE_URL)}>Manage usage</button>
              <span className="spacer" />
              <button className="primary" autoFocus onClick={() => void changeSettings({ chatgpt: { planIntroSeen: true } })}>Got it</button>
            </div>
          </div>
        </div>
      )}
      {monitorPick && <MonitorPicker sources={sources} loading={loadingSources} error={sourceError} startingCall={monitorPick === 'start'} onClose={closeMonitorPick}
        agentName={agents.find(agent => agent.id === callDraft?.agentId)?.name} brief={callDraft?.brief ?? ''} group={callDraft?.group ?? false}
        onPrepare={(brief, group) => setCallDraft(previous => previous ? { ...previous, brief, group } : previous)}
        onPick={source => { const intent = monitorPick; closeMonitorPick(); if (intent === 'start') void toggleListening(source, callDraft); else void startMonitoring(source) }}
        onAudioOnly={() => { const intent = monitorPick; closeMonitorPick(); if (intent === 'start') void toggleListening(null, callDraft); else { monitorRequest.current++; recorder.current?.stop(); setRecording(false) } }} />}

      <div className="workspace-layout" inert={!!monitorPick}>
        <AgentSidebar agents={agents} selectedId={view === 'main' ? activeAgent?.id : chatAgentId ?? activeAgent?.id} callingId={listening ? activeAgent?.id : undefined} page={view === 'agents' ? agentsSection : view === 'archive' ? 'settings' : view} expanded={sidebarOpen} onSelect={talkTo} onNavigate={navigateSidebar} onClose={closeSidebar} />
        {sidebarOpen && <button className="sidebar-backdrop" aria-label="Close agents" tabIndex={-1} onClick={closeSidebar} />}
        <div className="workspace-content" inert={sidebarOpen}>
        {confirmClose && (
          <div className="notice ask" role="alert" aria-label="Confirm quit Togle">
            <span>Quit Togle? Call assistance and dictation will stop. Your call is saved.</span>
            <div className="row">
              <button ref={keepGoing} className="ghost" onClick={() => setConfirmClose(false)}>
                Keep going
              </button>
              <button className="primary stop" onClick={() => api.close(true)}>
                Quit Togle
              </button>
            </div>
          </div>
        )}
          <MeetingNotice listening={listening} onStart={event => {
            const agentId = agents.find(agent => agent.id === event.agentId)?.id
            if (!agentId) return
            setCallDraft({ agentId, brief: event.title, group: event.attendees > 2, fresh: true, meetingId: event.id })
            void chooseMonitor('start')
          }} />
      {view === 'settings' && settings && (
        <Settings settings={settings} auth={auth} claudeAuth={claudeAuth} stt={stt} at={settingsAt} onChange={setSettings} onDone={() => setView(workspaceReturn.current)} onArchive={() => { setSelectedCallId(undefined); setView('archive') }} />
      )}
      {view === 'archive' && <div className="settings archived-calls"><CallHistory agents={agents} enabled={settings?.assist.rememberCalls !== false} selectedId={selectedCallId} onSelect={setSelectedCallId} onAgent={replaceAgent} onDone={() => setView('settings')} /></div>}
      {/* Kept while the conversation shows: an agent's page, and a reading of a website, are there to come back to. */}
      {settings && (
        <div className="page" hidden={view !== 'agents'}>
          <Agents
            agents={agents}
            request={agentsRequest}
            onChange={setAgents}
            onTalk={talkTo}
            onDrafted={agentDrafted}
            onDone={agentsDone}
            onSection={setAgentsSection}
            shown={view === 'agents'}
          />
        </div>
      )}
      {/* Kept while Settings or Agents is open: answers asked again keep coming in, and the call keeps its place. */}
      <main className="main" hidden={view === 'settings' || view === 'archive' || view === 'agents'}>
        {group && !settings?.assist.names?.trim() && !knownUserName && !groupSeen && (
          <div className="notice info">
            <span>
              In a group call Togle suggests when you're asked: by name, or right after you spoke. To know your name,{' '}
              <button className="link" onClick={() => setView('settings')}>
                add it in Settings
              </button>
              .
            </span>
            <button className="dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => setGroupSeen(true)}>
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        {/* What went wrong, it says; still loading, only once a call needs it. Not there at all is the setup card's to
            say, or, during a call, the call strip's. */}
        {stt.state !== 'ready' && stt.state !== 'missing' && (stt.state !== 'starting' || listening) && (
          <div className={`notice ${stt.state === 'starting' ? 'info' : ''}`} title={stt.detail}>
            <span>{stt.state === 'starting' ? 'Getting speech recognition ready: what they say shows in a moment.' : (stt.detail ?? 'Speech recognition is off.')}</span>
          </div>
        )}
        {/* The speech API picked for a side can't hear it, or missed a line: this PC hears it meanwhile, if it can. */}
        {stt.problem && listening && (
          <div className="notice">
            <span>{stt.problem}</span>
          </div>
        )}
        {planShown && settings && (
          <PlanNotice
            plan={planShown}
            dismissed={planDismissed}
            onDismiss={(key) => setPlanDismissed((keys) => [...keys, key])}
            apiModel={settings.compat.model || undefined}
            onUseApi={() => void changeSettings({ provider: 'compat' })}
            onKeepModels={() => void changeSettings({ chatgpt: { saveNearLimit: false } })}
          />
        )}
        {noiseFinding && !listening && (
          <MicrophoneSuggestion finding={noiseFinding} microphone={microphone} dismissals={settings?.microphone?.dismissals ?? 0} onClose={() => setNoiseFinding(null)} />
        )}
        {warnings.map((w) => (
          <div key={w} className="notice">
            <span>{w}</span>
            <button className="dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => setWarnings((prev) => prev.filter((x) => x !== w))}>
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}

        {shownAgent && <>
          <div className="workspace-head">
            {configuring && <button className="icon" aria-label="Back to chat" title="Back to chat" onClick={() => selectAgentTab('chat')}><Icon name="back" /></button>}
            <Avatar agent={shownAgent} size={32} />
            <div><h2 title={shownAgent.description}>{shownAgent.name}</h2><p className="connection-status" title={view === 'main' && brief ? brief : undefined}>{configuring ? 'Agent settings' : view === 'main' ? `${listening ? 'Live call' : 'Call ended'}${brief ? ` · ${brief.split('\n')[0]}` : ''}` : shownAgent.description || answerConnection}</p></div>
            {view === 'agent' && !configuring && <button className="ghost small agent-settings-button" onClick={() => selectAgentTab('settings')}><Icon name="settings" size={14} />Agent settings</button>}
            {configuring && <button className="ghost small" onClick={() => openAgents({ share: shownAgent.id })}>Share agent</button>}
          </div>
          <div className="agent-workspace-nav">
          <div className="tabs agent-detail-tabs" role="tablist" aria-label={configuring ? 'Agent settings' : 'Agent workspace'} onKeyDown={event => {
            const index = workspaceTabs.indexOf(selectedAgentTab)
            const next = event.key === 'ArrowRight' ? (index + 1) % workspaceTabs.length : event.key === 'ArrowLeft' ? (index + workspaceTabs.length - 1) % workspaceTabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? workspaceTabs.length - 1 : undefined
            if (next === undefined) return
            event.preventDefault()
            selectAgentTab(workspaceTabs[next])
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
          }}>
            {workspaceTabs.map(tab => <button key={tab} role="tab" id={`agent-tab-${tab}`} aria-controls="agent-panel" aria-selected={selectedAgentTab === tab} tabIndex={selectedAgentTab === tab ? 0 : -1} onClick={() => selectAgentTab(tab)}>{tab === 'live' ? <>{listening && shownAgent.id === activeAgent?.id && <span className="workspace-live-dot" aria-hidden="true" />}Live Call</> : tab === 'calls' ? 'Call History' : tab[0].toUpperCase() + tab.slice(1)}</button>)}
          </div>
          </div>
          <div className="workspace-body" id="agent-panel" role="tabpanel" aria-labelledby={`agent-tab-${selectedAgentTab}`}>
          {view !== 'agent' || agentTab === 'chat' ? (
          <Conversation
            key={view === 'agent' ? `agent-${shownAgent.id}` : 'call-workspace'}
            workspace={view === 'agent' ? 'agent' : 'call'}
            agent={shownAgent}
            chats={chats}
            onSaved={replaceAgent}
            card={cardOf}
            cards={assists}
            call={callKey}
            listening={view !== 'agent' && listening}
            autoReplies={!!settings?.assist.auto}
            recalled={recalled}
            heard={transcript.length > 0}
            deaf={noSpeech || stt.state === 'error'}
            banner={setup}
            callStrip={view === 'agent' ? undefined : callStrip}
            attach={view === 'agent' ? attachMenu : undefined}
            callButton={callButton}
            onSend={send}
            onDeeper={deeper}
            onAgain={again}
            onStop={stop}
            canLearn={canLearn}
            onLearn={learn}
            onSummary={summarize}
            onTranscript={showTranscript}
            onDropFiles={(paths) => void attach(shownAgent, 'files', paths)}
            onTry={(question) => tryQuestion(shownAgent, question)}
            canAskAgain={(review: ReviewEntry) => askAgain?.reviewId === review.id && !askAgain.shown}
            onAskAgain={() => askAgain && setAskAgain({ ...askAgain, shown: true })}
            after={(entry) =>
              askAgain?.shown && askAgain.reviewId === entry.id ? (
                <AskAgain
                  key={askAgain.key}
                  agentId={askAgain.agentId}
                  agentName={askAgain.agentName}
                  asked={askAgain.asked}
                  started
                  onClose={() => setAskAgain(null)}
                />
              ) : null
            }
          />
          ) : agentTab === 'live' ? <div className="live-call-empty">
            <Icon name="phone" size={25} />
            <h3>{listening ? `Call in progress with ${activeAgent?.name}` : 'No live call'}</h3>
            <p>{listening ? 'Your call keeps running while you browse other agents.' : `Start a call with ${shownAgent.name} for live suggestions, transcript and screen context.`}</p>
            {listening ? <button className="primary" onClick={openCurrentCall}>Return to live call</button> : callButton}
          </div> : agentTab === 'calls' ? <CallHistory key={shownAgent.id} ownerId={shownAgent.id} selectedId={selectedCallId} onSelect={setSelectedCallId} agents={agents} enabled={settings?.assist.rememberCalls !== false} currentCallId={hasCall && shownAgent.id === activeAgent?.id ? callKey : undefined} currentCallTitle={brief.split('\n')[0] || 'Current call'} onOpenCurrent={openCurrentCall} onAgent={replaceAgent} onDone={() => selectAgentTab('chat')} asking={!!chats.of(shownAgent.id).turn} onAsk={(call, question) => {
            if (call.agentId !== shownAgent.id || chats.of(shownAgent.id).turn) return
            selectAgentTab('chat')
            chats.teach(shownAgent, question, { id: call.id, title: call.title || 'Saved call' })
          }} />
            : <AgentInspector key={shownAgent.id} agent={shownAgent} tab={agentTab} onAgent={replaceAgent} onCall={showHistory} onChat={() => selectAgentTab('chat')} onDelete={() => void deleteAgent(shownAgent)} deleteReason={agents.length < 2 ? 'Keep at least one agent.' : (listening || hasCall) && shownAgent.id === activeAgent?.id ? 'This agent owns the current call. Start a new call with another agent before deleting it.' : undefined} />}
          </div>
        </>}
      </main>
        </div>
      </div>
    </div>
  )
}
