import { useCallback, useEffect, useRef, useState } from 'react'
import type { SettingsPatch } from '@shared/api'
import type { AuthStatus, Settings as SettingsData, SttStatus } from '@shared/types'
import { needsYou } from '@shared/runner'
import { MANAGE_USAGE_URL } from '@shared/plan'
import { quitQuestion, type CloseWarning } from '@shared/close-warning'
import type { TogleMicrophoneStatus } from '@shared/microphone'
import { Icon } from './Icon'
import { FirstMinute } from './FirstMinute'
import { LiveCall } from './LiveCall'
import { MeetingsPage } from './MeetingsPage'
import { onOpenSettings, openSettings, type SettingsPart } from './open-settings'
import { onOpenTaskFrom } from './open-task'
import { SettingsPage } from './SettingsPage'
import { Tasks } from './Tasks'
import { Todo } from './Todo'
import { useCall } from './useCall'

const api = window.togle

type View = 'todo' | 'agents' | 'meetings' | 'settings'
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
  const [view, setView] = useState<View>('todo')
  // In Meetings: the call being written down, or the list (with a call opened from elsewhere).
  const [live, setLive] = useState(false)
  const [meetingFocus, setMeetingFocus] = useState<{ id: string; seq: number }>()
  // Meetings pressed in the sidebar: back to the list, from a call's page.
  const [meetingsHome, setMeetingsHome] = useState(0)
  const [taskFocus, setTaskFocus] = useState<{ key: string; seq: number; changes?: boolean }>({ key: '', seq: 0 })
  const [settingsAt, setSettingsAt] = useState<SettingsPart>()
  const [confirmClose, setConfirmClose] = useState<CloseWarning | null>(null)
  const [waiting, setWaiting] = useState(0)
  const keepGoing = useRef<HTMLButtonElement>(null)
  const call = useCall(settings)

  const changeSettings = useCallback(async (patch: SettingsPatch) => setSettings(await api.updateSettings(patch)), [])
  const openMeeting = useCallback((id: string) => { setLive(false); setMeetingFocus((previous) => ({ id, seq: (previous?.seq ?? 0) + 1 })); setView('meetings') }, [])
  const openTask = useCallback((key: string, changes?: boolean) => { setTaskFocus((previous) => ({ key, seq: previous.seq + 1, changes })); setView('agents') }, [])
  const showLive = useCallback(() => { setLive(true); setView('meetings') }, [])

  // Writing a call down needs speech recognition on this computer; without it, Settings shows how to get it.
  const writeDown = useCallback(async () => {
    if (call.listening) { showLive(); return }
    if (stt.state === 'missing') { openSettings('speech'); return }
    showLive()
    await call.start()
  }, [call, stt.state, showLive])

  useEffect(() => {
    void api.getSettings().then(setSettings)
    void api.authStatus().then(setAuth)
    void api.sttStatus().then(setStt)
    void api.microphoneStatus().then(setMicrophone, () => undefined)
    const subs = [
      api.onSettingsChanged(setSettings),
      api.onAuthChanged(setAuth),
      api.onSttStatus(setStt),
      api.onMicrophone(setMicrophone),
      api.onConfirmClose((warning) => setConfirmClose(warning)),
      // From a notice or the tray: Togle opens on the task that waits.
      api.onShowTask((key) => { setTaskFocus((previous) => ({ key, seq: previous.seq + 1 })); setView('agents') })
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
  // How many tasks wait for the person, on To-do in the sidebar.
  useEffect(() => {
    const count = (): void => { void api.runnerTasks().then((tasks) => setWaiting(Array.isArray(tasks) ? tasks.filter(needsYou).length : 0), () => undefined) }
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

  return (
    <div className={`app shell ${call.listening ? 'in-call' : ''}`}>
      <header className="titlebar">
        {/* As the design draws the window: its name, quiet. A call going on shows on Meetings in the rail. */}
        <div className="title">
          <span className="brand"><span className="brand-name">Togle</span></span>
        </div>
        <div className="window-buttons">
          <button className="icon" title="Minimize" aria-label="Minimize" onClick={() => api.minimize()}><Icon name="minimize" /></button>
          <button className="icon close" title="Close to tray · Togle keeps running" aria-label="Close to tray" onClick={() => api.close()}><Icon name="close" /></button>
        </div>
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

      <div className="shell-layout">
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
        <main className="shell-content">
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
          {view === 'settings' && settings && <SettingsPage settings={settings} stt={stt} at={settingsAt} onChange={setSettings} />}
        </main>
      </div>
    </div>
  )
}
