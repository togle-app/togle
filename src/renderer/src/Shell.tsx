import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { SettingsPatch } from '@shared/api'
import type { AuthStatus, Settings as SettingsData, SttStatus } from '@shared/types'
import { needsYou } from '@shared/runner'
import { MANAGE_USAGE_URL } from '@shared/plan'
import { quitQuestion, type CloseWarning } from '@shared/close-warning'
import type { TogleMicrophoneStatus } from '@shared/microphone'
import { Icon } from './Icon'
import { NAV_COLLAPSE_BELOW, NAV_DEFAULT, NAV_ICONS, NAV_MAX, NAV_WORDS_FROM, navPx, setPanes, usePanes } from './panes'
import { ResizeHandle } from './ResizeHandle'
import { BrandMark, WindowButtons } from './WindowBar'
import { FirstMinute } from './FirstMinute'
import { LiveCall } from './LiveCall'
import { MeetingsPage } from './MeetingsPage'
import { onOpenSettings, openSettings, type SettingsPart } from './open-settings'
import { onOpenTaskFrom } from './open-task'
import { SettingsPage } from './SettingsPage'
import { withPatch } from './settings-patch'
import { keepAnswer, TASKS_LISTED } from './kept'
import { Tasks } from './Tasks'
import { Todo } from './Todo'
import { useCall } from './useCall'

const api = window.togle

type View = 'todo' | 'agents' | 'meetings' | 'settings'

/**
 * Where the window was when its page last loaded: a page that loads again (it crashed, or a key reloaded it) comes back to the same
 * place, not to To-do. A new run starts at To-do.
 */
const PLACE = 'togle.place'
function placeBefore(): View {
  try {
    const place = sessionStorage.getItem(PLACE)
    return place === 'agents' || place === 'meetings' || place === 'settings' ? place : 'todo'
  } catch {
    return 'todo'
  }
}
/**
 * Where each place was scrolled to when the window left it. The window shows one place at a time, so a place drawn again is where it was left:
 * what it keeps itself (what is open, what is typed) comes back from kept.tsx, and how far it was scrolled from here.
 */
const placeScrolls = new Map<View, number>()
/** What the person does with a place once it is shown: they take over its scrolling from the moment they do any of it. */
const TAKES_OVER = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const
const PLACES: { id: View; label: string; icon: string; title: string }[] = [
  { id: 'todo', label: 'To-do', icon: 'todo', title: 'What needs you today' },
  { id: 'agents', label: 'Agents', icon: 'tasks', title: 'Every agent task on this computer' },
  { id: 'meetings', label: 'Meetings', icon: 'phone', title: 'The calls Togle wrote down' }
]

/**
 * The window: three places (To-do, Agents, Meetings) and Settings. To-do is home. A call being written down shows in
 * Meetings, and the title bar says so from anywhere.
 */
export function Shell() {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [auth, setAuth] = useState<AuthStatus>({ signedIn: false })
  const [stt, setStt] = useState<SttStatus>({ state: 'starting' } as SttStatus)
  const [microphone, setMicrophone] = useState<TogleMicrophoneStatus>()
  const [view, setView] = useState<View>(placeBefore)
  // In Meetings: the call being written down, or the list (with a call opened from elsewhere).
  const [live, setLive] = useState(false)
  const [meetingFocus, setMeetingFocus] = useState<{ id: string; seq: number }>()
  // Meetings pressed in the sidebar: back to the list, from a call's page.
  const [meetingsHome, setMeetingsHome] = useState(0)
  const [taskFocus, setTaskFocus] = useState<{ key: string; seq: number }>({ key: '', seq: 0 })
  const [settingsAt, setSettingsAt] = useState<SettingsPart>()
  const [confirmClose, setConfirmClose] = useState<CloseWarning | null>(null)
  const [waiting, setWaiting] = useState(0)
  const keepGoing = useRef<HTMLButtonElement>(null)
  const call = useCall(settings)
  useEffect(() => {
    try {
      sessionStorage.setItem(PLACE, view)
    } catch {
      /* kept for this run only */
    }
  }, [view])
  // A place is shown scrolled to where it was left. One that reads before it has its whole length (a list that fills in) is gone back to as it
  // grows, for a couple of seconds or until the person scrolls it themselves; what it holds while that goes on is not taken for a place left.
  const content = useRef<HTMLElement>(null)
  const restoring = useRef(false)
  useLayoutEffect(() => {
    const box = content.current
    if (!box) return
    const want = placeScrolls.get(view) ?? 0
    box.scrollTop = want
    if (want <= 0 || box.scrollTop >= want - 1) return
    restoring.current = true
    let tries = 0
    const stop = (): void => {
      restoring.current = false
      clearInterval(timer)
      for (const name of TAKES_OVER) box.removeEventListener(name, stop)
    }
    const timer = setInterval(() => {
      box.scrollTop = want
      if (box.scrollTop >= want - 1 || ++tries > 25) stop()
    }, 80)
    for (const name of TAKES_OVER) box.addEventListener(name, stop, { passive: true })
    return stop
  }, [view])

  // Settings as main last sent them, with the changes asked for and not saved yet laid over them: a switch moves when it is
  // pressed, and word from main about something else does not move it back. A change main refuses is gone again, and the
  // promise fails with why.
  const fromMain = useRef<SettingsData | null>(null)
  const unsaved = useRef<{ patch: SettingsPatch }[]>([])
  const take = useCallback((value: SettingsData) => {
    fromMain.current = value
    setSettings(unsaved.current.reduce((laid, change) => withPatch(laid, change.patch), value))
  }, [])
  const changeSettings = useCallback(async (patch: SettingsPatch): Promise<void> => {
    const change = { patch }
    unsaved.current = [...unsaved.current, change]
    if (fromMain.current) take(fromMain.current)
    try {
      const saved = await api.updateSettings(patch)
      unsaved.current = unsaved.current.filter((one) => one !== change)
      take(saved)
    } catch (error) {
      unsaved.current = unsaved.current.filter((one) => one !== change)
      const now = await api.getSettings().catch(() => fromMain.current)
      if (now) take(now)
      throw error
    }
  }, [take])
  const openMeeting = useCallback((id: string) => { setLive(false); setMeetingFocus((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 })); setView('meetings') }, [])
  const openTask = useCallback((key: string) => { setTaskFocus((previous) => ({ key, seq: previous.seq + 1 })); setView('agents') }, [])
  const showLive = useCallback(() => { setLive(true); setView('meetings') }, [])

  // Writing a call down needs speech recognition on this computer; without it, Settings shows how to get it.
  const writeDown = useCallback(async () => {
    if (call.listening) { showLive(); return }
    if (stt.state === 'missing') { openSettings('speech'); return }
    showLive()
    await call.start()
  }, [call, stt.state, showLive])

  useEffect(() => {
    void api.getSettings().then(take)
    void api.authStatus().then(setAuth)
    void api.sttStatus().then(setStt)
    void api.microphoneStatus().then(setMicrophone, () => undefined)
    const subs = [
      api.onSettingsChanged(take),
      api.onAuthChanged(setAuth),
      api.onSttStatus(setStt),
      api.onMicrophone(setMicrophone),
      api.onConfirmClose((warning) => setConfirmClose(warning)),
      // From a notice or the tray: Togle opens on the task that waits.
      api.onShowTask((key) => { setTaskFocus((previous) => ({ key, seq: previous.seq + 1 })); setView('agents') }),
      // Hidden or minimized, nothing on the page moves (design.css).
      api.onAway((away) => document.documentElement.toggleAttribute('data-away', away))
    ]
    return () => { for (const stop of subs) stop() }
  }, [])
  // Voice typing follows the settings of the one agent the call part keeps.
  useEffect(() => { if (settings?.activeAgentId) void api.setDictationAgent(settings.activeAgentId).catch(() => undefined) }, [settings?.activeAgentId])
  useEffect(() => onOpenSettings((at) => { setSettingsAt(at); setView('settings') }), [])
  // A task asked for from elsewhere in the window: the answer to a question put to it on a call.
  useEffect(() => onOpenTaskFrom((key) => openTask(key)), [openTask])
  useEffect(() => api.onHotkey((action) => {
    if (action === 'dictation-settings') openSettings('dictation')
    // "Change keys" on the one-time offer when a key was pressed in a code editor.
    if (action === 'keys-settings') openSettings('keys')
    // The call shortcut, and a call app's notice ("Write it down"): a call starts, or the one going on stops.
    if (action === 'toggle-listening' || action === 'start-call-unseen') void (call.listening ? call.stop() : writeDown())
  }), [call, writeDown])
  // A call that ends opens on its notes, and on who spoke when names wait.
  const wasListening = useRef(false)
  useEffect(() => {
    if (wasListening.current && !call.listening && call.callKey) openMeeting(call.callKey)
    wasListening.current = call.listening
  }, [call.listening, call.callKey, openMeeting])
  // How many tasks wait for the person, on To-do in the sidebar. The list read for it is kept too: Agents opens with it.
  useEffect(() => {
    const count = (): void => {
      void api.runnerTasks().then((tasks) => {
        const list = Array.isArray(tasks) ? tasks : []
        keepAnswer(TASKS_LISTED, list)
        setWaiting(list.filter(needsYou).length)
      }, () => undefined)
    }
    count()
    const stop = api.onRunnersChanged(count)
    const timer = setInterval(count, 4000)
    return () => { stop(); clearInterval(timer) }
  }, [])
  // Asked whether to quit: Keep going has the keys (Enter keeps going), and Escape is Keep going too.
  useEffect(() => {
    if (!confirmClose) return
    keepGoing.current?.focus()
    const keep = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      setConfirmClose(null)
    }
    window.addEventListener('keydown', keep, true)
    return () => window.removeEventListener('keydown', keep, true)
  }, [confirmClose])

  // The navigation's width (its icons only when narrowed past its words), which the person drags or hides.
  const kept = usePanes()
  const nav = navPx(kept)
  const iconsOnly = nav <= NAV_ICONS
  return (
    <div className={`app shell ${call.listening ? 'in-call' : ''}`}>
      <header className="titlebar">
        {/* Its mark and its name, quiet. A call going on shows on Meetings in the rail. */}
        <div className="title">
          <span className="brand"><BrandMark /><span className="brand-name">Togle</span></span>
        </div>
        <WindowButtons closeTitle="Close to tray · Togle keeps running" closeLabel="Close to tray" onClose={() => api.close()} />
      </header>

      {/* Once, after the first sign-in with ChatGPT: what Togle uses counts toward the plan, and where to see it. */}
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

      <div className={`shell-layout${iconsOnly ? ' nav-icons' : ''}`} style={{ '--nav-width': `${nav}px` } as CSSProperties}>
        <nav className="shell-nav workspace-nav" aria-label="Places">
          {PLACES.map((place) => (
            <button key={place.id} aria-label={place.label} title={place.title} aria-current={view === place.id ? 'page' : undefined} onClick={() => { if (place.id === 'meetings') { setLive(call.listening); setMeetingsHome((count) => count + 1) } setView(place.id) }}>
              <Icon name={place.icon as 'todo'} size={16} /><span>{place.label}</span>
              {place.id === 'todo' && waiting > 0 && <span className="nav-count" aria-label={`${waiting} waiting for you`}>{waiting}</span>}
              {place.id === 'meetings' && call.listening && <span className="dot live" role="img" aria-label="A call is being written down" />}
            </button>
          ))}
          <span className="spacer" />
          <button className="shell-settings" aria-label="Settings" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => { setSettingsAt(undefined); setView('settings') }}><Icon name="settings" size={16} /><span>Settings</span></button>
        </nav>
        <ResizeHandle
          label="Resize the navigation"
          className="nav-handle"
          at={nav}
          size={() => ({ width: nav, min: NAV_WORDS_FROM, max: NAV_MAX })}
          // Squeezed past what its words need it is its icons only, and dragged out again the words are back: it has no button for it.
          collapseBelow={NAV_COLLAPSE_BELOW}
          onSize={(width) => setPanes({ nav: width })}
          step={NAV_WORDS_FROM - NAV_ICONS}
          collapsed={iconsOnly}
          onCollapsed={(icons) => setPanes({ nav: icons ? NAV_ICONS : NAV_DEFAULT })}
        />
        <main className="shell-content" ref={content} onScroll={(event) => { if (!restoring.current) placeScrolls.set(view, event.currentTarget.scrollTop) }}>
          {confirmClose && (
            <div className="notice ask" role="alert" aria-label="Confirm quit Togle">
              <span>{quitQuestion(confirmClose)}</span>
              <div className="row">
                <button ref={keepGoing} className="ghost" onClick={() => setConfirmClose(null)}>Keep going</button>
                <button className="primary stop" onClick={() => api.close(true)}>Quit Togle</button>
              </div>
            </div>
          )}
          {call.warning && (
            <div className="notice" role="alert"><span>{call.warning}</span><button className="dismiss" aria-label="Dismiss" title="Dismiss" onClick={call.clearWarning}><Icon name="close" size={12} /></button></div>
          )}
          {/* Once, on a Togle that has never run: the first minute, then the to-do list. */}
          {view === 'todo' && settings && !settings.firstMinute?.done && <FirstMinute settings={settings} stt={stt} onDone={() => void changeSettings({ firstMinute: { done: true } })} />}
          {view === 'todo' && settings?.firstMinute?.done && <Todo onOpenTask={openTask} onOpenCall={openMeeting} />}
          {view === 'agents' && <Tasks focus={taskFocus} />}
          {view === 'meetings' && settings && (live && call.listening
            ? <LiveCall settings={settings} title={call.title} since={call.since} transcript={call.transcript} flags={call.flags} inputs={call.inputs} levels={call.levels} callKey={call.callKey}
                onMark={() => void api.markCall().catch(() => undefined)} onStop={() => void call.stop()} onReconnect={() => void call.reconnect()} onFirstCallSeen={() => void changeSettings({ meetings: { ...settings.meetings, introSeen: true } })} />
            : <div className="settings meetings-page"><MeetingsPage agents={[]} callKey={call.callKey} liveId={call.listening ? call.callKey : undefined} onOpenLive={showLive} onWriteDown={() => void writeDown()} focus={meetingFocus} home={meetingsHome} noise={call.noise && !call.listening ? { callId: call.callKey, finding: call.noise } : undefined} microphone={microphone} /></div>)}
          {view === 'settings' && settings && <SettingsPage settings={settings} stt={stt} at={settingsAt} onSave={changeSettings} />}
        </main>
      </div>
    </div>
  )
}
