import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import type { SettingsPatch } from '@shared/api'
import { AgentUsage } from './AgentUsage'
import type { AIProfile, ApiConnection, LocalModelId, LocalSpeechState, ModelOption, Settings, SttStatus, SubscriptionAccount } from '@shared/types'
import { runsInTerminal, type AgentCatalog, type AgentChoice, type RunnerStatus } from '@shared/runner'
import { CALL_APPS, type CallApp } from '@shared/call-apps'
import { localModelsFor, PARAKEET_LANGUAGES, SPEECH_LANGUAGES, speechLanguageCode, speechLanguageName } from '@shared/speech'
import { voiceAccountId } from '@shared/dictation'
import type { UpdateState } from '@shared/updates'
import { modelSourceId } from '@shared/model-selection'
import { AI_TASKS } from '@shared/preferences'
import { MANAGE_USAGE_URL } from '@shared/plan'
import { isMicrophoneOn, microphoneNeedsSignIn, type TogleMicrophoneStatus } from '@shared/microphone'
import { DEFAULT_THEME, isThemeChoice, THEME_CHOICES, type ThemeChoice } from '@shared/theme'
import { AgentAvatar } from './AgentMark'
import { useHotkeys } from './hotkeys'
import { Shortcut } from './Shortcut'
import { Field, FormOver, openedInView, Row, Section, Toggle, useOneOpen } from './Rows'
import { useAccounts, useKeyConnections } from './Accounts'
import { Menu } from './Menu'
import { Choice, Opens } from './Choice'
import { VocabularyEditor } from './DictationVocabulary'
import { Devices } from './Devices'
import { TogleAccountRow } from './TogleAccount'
import { useRememberedVoices } from './VoiceMemory'
import type { SettingsPart } from './open-settings'
import { AGENT_CATALOG, AGENTS_FOUND, keepAnswer, keptAnswer, useFoldPreference } from './kept'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const platform = api.platform

interface Props {
  settings: Settings
  stt: SttStatus
  /** Opened to fix something: the part that does. */
  at?: SettingsPart
  /** Saves a change: the window shows it at once, and the promise fails when Togle refused it. */
  onSave: (patch: SettingsPatch) => Promise<void>
}

/**
 * Settings, on one screen as the design has it: five groups side by side (Keys, Voice, Meetings, Agents, Accounts), each a
 * few rows of a name and its value. Every setting has a default that works, so nobody has to come here. A row that opens
 * something to change (names and terms, a key, an agent to add) widens its group while it is open.
 */
export function SettingsPage({ settings, stt, at, onSave }: Props) {
  const [saveError, setSaveError] = useState('')
  const save = async (patch: SettingsPatch): Promise<void> => {
    setSaveError('')
    try { await onSave(patch) } catch (error) { setSaveError(`Could not save: ${errorText(error)}`) }
  }
  // Opened to fix something: at the part that does, ready to use.
  useEffect(() => {
    if (!at) return
    const target = document.getElementById(at === 'speech' ? 'settings-speech' : at === 'ai' ? 'settings-accounts' : at === 'keys' ? 'settings-keys' : at === 'devices' ? 'settings-devices' : 'settings-voice')
    target?.scrollIntoView({ block: 'start' })
    ;(target?.tabIndex === -1 ? target : target?.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true })
  }, [at])
  return (
    <div className="settings settings-one">
      <div className="settings-content">
        {saveError && <p className="error" role="alert">{saveError}</p>}
        {/* Columns, each its own: a list or a question that opens in a group pushes down only what is under it in its column,
            and nothing jumps to the other side. (A form to type in is laid over the page: see FormOver.) Two columns as the
            design draws them; on a wide window the stylesheet makes three of their four parts (the two middle parts share a
            column), and in a narrow one the second column goes under the first. In every shape the groups are read, and
            reached with Tab, in the order they are here. */}
        <div className="sets">
          <div className="sets-col">
            <div className="sets-part">
              {/* An update to tell of is the first group, a group like the others: it is not there otherwise. */}
              <Update />
              <Keys />
              <Meetings settings={settings} save={save} />
            </div>
            <div className="sets-part">
              <Accounts settings={settings} save={save} />
            </div>
          </div>
          <div className="sets-col">
            <div className="sets-part">
              <Voice settings={settings} stt={stt} save={save} />
            </div>
            <div className="sets-part">
              <Agents settings={settings} save={save} />
              <Devices />
              <Appearance settings={settings} save={save} />
              <Updates settings={settings} save={save} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Togle's own update, once there is one to tell of: ready (checked against the release key), refused (it wasn't signed
 * by it, so it was deleted) or failed. Until a release key is set, Togle doesn't look, and this stays away.
 */
function Update() {
  const [state, setState] = useState<UpdateState>({ phase: 'off' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  useEffect(() => {
    let live = true
    void api.updateStatus().then((value) => { if (live && value?.phase) setState(value) }).catch(() => {})
    const off = api.onUpdate((value) => { if (live && value?.phase) setState(value) })
    return () => { live = false; off() }
  }, [])
  if (!['ready', 'refused', 'failed'].includes(state.phase)) return null
  const install = (): void => {
    setBusy(true); setFailure('')
    void api.installUpdate().catch((error) => setFailure(errorText(error))).finally(() => setBusy(false))
  }
  return (
    <Section id="settings-update" title="Update">
      {state.phase === 'ready'
        ? <Row label={false} name={`Togle ${state.version} is ready`} note="Checked against Togle's release key. Togle closes and opens again.">
          <button className="primary" disabled={busy} onClick={install}>Restart to update</button>
        </Row>
        : <Row label={false} name={state.phase === 'refused' ? 'An update was refused' : 'Togle couldn’t check for an update'} note={state.message} />}
      {failure && <p className="error" role="alert">{failure}</p>}
    </Section>
  )
}

const THEME_WORDS: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

/**
 * How the window looks: a light one, a dark one (until chosen, as the product is drawn) or whichever the system has. A switch of
 * three, the kind Settings uses for two; Togle's main process tells every page, and they change at once.
 */
function Appearance({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const theme = isThemeChoice(settings.appearance?.theme) ? settings.appearance.theme : DEFAULT_THEME
  return (
    <Section id="settings-appearance" title="Appearance">
      <Row label={false} name="Theme">
        <span className="segmented view-switch" role="radiogroup" aria-label="Theme" title="Light or dark, or whichever your system has. An agent’s own screen in Terminal follows it. What floats over other apps (the voice bar and the notices) stays dark.">
          {THEME_CHOICES.map((name) => {
            const on = theme === name
            return <button key={name} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => { if (!on) void save({ appearance: { theme: name } }) }}>{THEME_WORDS[name]}</button>
          })}
        </span>
      </Row>
      <Toggle name="Keep Togle out of screenshots and screen sharing" title={platform === 'win32' ? 'Asks Windows to hide Togle during screen capture and hides task details in new Windows notifications.' : "Asks your system to leave Togle's window out of screenshots, recordings and screen sharing. Some apps may still show it. The voice bar and the notices are always left out."} checked={settings.window?.keepOutOfCaptures === true} onChange={(keepOutOfCaptures) => void save({ window: { keepOutOfCaptures } })} />
    </Section>
  )
}

/**
 * How Togle's own updates go in: a signed update that has been downloaded waits for "Restart to update" (above), or goes in as Togle
 * closes, at a quit the person asked for, when they say so here. What is said under the switch is true of this build: until the
 * maintainer sets the release key, Togle does not look for updates at all.
 */
function Updates({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const [state, setState] = useState<UpdateState>({ phase: 'off' })
  useEffect(() => {
    let live = true
    void api.updateStatus().then((value) => { if (live && value?.phase) setState(value) }).catch(() => {})
    const off = api.onUpdate((value) => { if (live && value?.phase) setState(value) })
    return () => { live = false; off() }
  }, [])
  const on = settings.updates?.installOnQuit === true
  const at = state.checkedAt ? new Date(state.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  // The row's value, and what it means in more words.
  const [value, meaning] =
    state.phase === 'off' ? ['Not set up in this build', 'This build has no release key yet, so Togle does not look for updates. The switch counts once it does.']
    : state.phase === 'checking' ? ['Looking…', 'Looking for an update.']
    : state.phase === 'downloading' ? [`Downloading ${state.version ?? ''}`.trim(), 'An update was found. It is checked against the release key when it has arrived.']
    : state.phase === 'ready' ? [`${state.version} is ready`, on ? 'It goes in when you quit.' : 'It goes in when you press Restart to update.']
    : state.phase === 'none' ? [`Up to date${at ? ` · ${at}` : ''}`, 'The newest release is the one you have. Togle looks once a day.']
    : [state.phase === 'refused' ? 'An update was refused' : 'Could not look', state.message ?? '']
  return (
    <Section id="settings-updates" title="Updates">
      <Row name="Install updates when I quit">
        <input type="checkbox" role="switch" className="switch" title="An update that has been downloaded and checked against Togle's release key goes in as Togle closes, when you quit it. Togle never closes by itself for it, and does not open again after. Off, it waits until you press Restart to update."
          checked={on} onChange={(event) => void save({ updates: { installOnQuit: event.target.checked } })} />
      </Row>
      <Row label={false} name="Update check">
        <span className="setting-value" title={meaning}>{value}</span>
      </Row>
    </Section>
  )
}

/** Talk, Show and Task: the keys that work from any app. */
function Keys() {
  const keys = useHotkeys()
  const talk = keys.find((key) => key.id === 'dictate'), show = keys.find((key) => key.id === 'show'), task = keys.find((key) => key.id === 'task')
  return (
    <Section id="settings-keys" title="Keys">
      {talk && <Shortcut hotkey={talk} />}
      {show && <Shortcut hotkey={show} />}
      {task && <Shortcut hotkey={task} />}
    </Section>
  )
}

/** The microphones this computer has, as the system names them (their names come once one was allowed). */
function useMicrophones(): { microphones: MediaDeviceInfo[]; problem: string } {
  const [microphones, setMicrophones] = useState<MediaDeviceInfo[]>([])
  const [problem, setProblem] = useState('')
  useEffect(() => {
    let live = true, generation = 0
    const media = navigator.mediaDevices
    const refresh = async (): Promise<void> => {
      const request = ++generation
      try {
        const devices = await media.enumerateDevices()
        if (!live || request !== generation) return
        setMicrophones(devices.filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default'))
        setProblem('')
      } catch { if (live && request === generation) setProblem('Their names show after you first talk. The system default works anyway.') }
    }
    void refresh()
    media?.addEventListener('devicechange', refresh)
    window.addEventListener('focus', refresh)
    return () => { live = false; media?.removeEventListener('devicechange', refresh); window.removeEventListener('focus', refresh) }
  }, [])
  return { microphones, problem }
}

function Voice({ settings, stt, save }: { settings: Settings; stt: SttStatus; save: (patch: SettingsPatch) => Promise<void> }) {
  const { microphones, problem } = useMicrophones()
  const accounts = useAccounts()
  const chosen = settings.dictation.microphoneId
  return (
    <Section id="settings-voice" title="Voice">
      {/* Calls stay on the system's microphone: Togle Studio cleans the sound by being that microphone. */}
      <Row label={false} name="Microphone" note={problem || undefined}>
        <Choice label="Microphone" value={chosen} onChange={(microphoneId) => void save({ dictation: { microphoneId } })} options={[
          { value: '', label: 'System default' },
          ...(chosen && !microphones.some((device) => device.deviceId === chosen) ? [{ value: chosen, label: 'Saved microphone (not listed)' }] : []),
          ...microphones.map((device, index) => ({ value: device.deviceId, label: device.label || `Microphone ${index + 1}` }))
        ]} />
      </Row>
      <Row label={false} name="Language">
        <Choice label="Language" value={settings.transcription.language} onChange={(language) => void save({ transcription: { language } })}
          options={SPEECH_LANGUAGES.map(([code, name]) => ({ value: code, label: code === 'auto' ? 'Detected' : name }))} />
      </Row>
      <NamesAndTerms accountId={voiceAccountId(settings, accounts.accounts)} />
      <Toggle name="Clean up what I say" checked={settings.dictation.polish} onChange={(polish) => void save({ dictation: { polish } })} />
      <RecentDictations accountId={voiceAccountId(settings, accounts.accounts)} />
      {stt.state === 'missing' && (
        <div className="setting-detail speech-setup" id="settings-speech" tabIndex={-1}>
          <p className="hint">Speech is heard on this computer, so calls and dictation need it here first. It is a one-time download.</p>
          <SpeechModels language={settings.transcription.language} />
        </div>
      )}
      {stt.state !== 'missing' && <SpeechModels language={settings.transcription.language} onlyMissing />}
    </Section>
  )
}

/**
 * Recent dictations kept on this computer: an earlier version could turn that on. Shown only while it is on, so it can
 * be turned off; the tray's last ten dictations, in memory, are what Togle offers now.
 */
function RecentDictations({ accountId }: { accountId: string }) {
  const [on, setOn] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void api.dictationHistory(accountId).then((history) => { if (current) setOn(history.enabled) }, () => undefined)
    return () => { current = false }
  }, [accountId])
  if (!on) return null
  return (
    <>
      <Toggle name="Keep recent dictations" note="The last 50, for seven days, encrypted on this computer. Turned off, no new ones are kept." checked onChange={() => void api.keepDictationHistory(accountId, false).then(() => setOn(false), (failure) => setError(errorText(failure)))} />
      {error && <p className="error" role="alert">{error}</p>}
    </>
  )
}

/** Names and terms Togle spells right, and phrases that stand for a longer text: how many, and a way to change them. */
function NamesAndTerms({ accountId }: { accountId: string }) {
  // A row that is open stays open when the window goes to another place and back to Settings.
  const [open, setOpen] = useFoldPreference('settings.names')
  // The count read last shows at once while it is read again (see kept.tsx).
  const [count, setCount] = useState<number | undefined>(() => keptAnswer<number>(`vocabulary.${accountId}`))
  useEffect(() => {
    if (open) return
    let current = true
    void api.dictationVocabulary(accountId).then((value) => {
      const found = value.words.length + value.snippets.length
      keepAnswer(`vocabulary.${accountId}`, found)
      if (current) setCount(found)
    }, () => undefined)
    return () => { current = false }
  }, [accountId, open])
  return (
    <>
      <Row label={false} name="Names and terms">
        <button className="choice" aria-expanded={open} title="Names and terms spelled your way, and phrases that type a longer text" onClick={() => setOpen(!open)}><Opens>{count === undefined ? '…' : count ? `${count} ${count === 1 ? 'entry' : 'entries'}` : 'None'}</Opens></button>
      </Row>
      {open && <div ref={openedInView} className="setting-detail"><VocabularyEditor accountId={accountId} /><div className="row"><button className="ghost small" onClick={() => setOpen(false)}>Done</button></div></div>}
    </>
  )
}

const MAIN_CALL_APPS: CallApp[] = ['zoom', 'meet', 'teams', 'other']

function Meetings({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const apps = settings.meetings.apps
  const modeOf = (id: CallApp): 'ask' | 'never' => apps[id] === 'never' ? 'never' : 'ask'
  const notices = platform === 'win32' || platform === 'linux' || platform === 'darwin'
  const shown = CALL_APPS.filter(app => MAIN_CALL_APPS.includes(app.id) || apps[app.id] !== undefined)
  const groups = (['ask', 'never'] as const).map(mode => ({ mode, apps: shown.filter(app => modeOf(app.id) === mode) })).filter(group => group.apps.length)
  const [access, setAccess] = useState<boolean>()
  useEffect(() => {
    if (platform !== 'darwin') return
    let current = true
    const refresh = () => void api.meetingAccessibility().then(value => { if (current) setAccess(value) }, () => undefined)
    refresh()
    window.addEventListener('focus', refresh)
    return () => { current = false; window.removeEventListener('focus', refresh) }
  }, [])
  return (
    <Section id="settings-meetings" title="Meetings">
      {platform === 'darwin' && access === false && <Row label={false} name="Call detection" note="Allow Accessibility to follow when you join, mute, or leave.">
        <button className="choice" onClick={() => void api.meetingAccessibility(true).then(setAccess, () => undefined)}>Allow Accessibility</button>
      </Row>}
      {notices
        ? groups.map(({ mode, apps: inGroup }) => {
          const names = inGroup.map((app) => app.name).join(', ')
          return (
            <Row key={mode} label={false} name={names}>
              <Choice<'ask' | 'never'> label={`When a call starts in ${names}`} value={mode}
                onChange={(next) => void save({ meetings: { ...settings.meetings, notice: true, apps: { ...apps, ...Object.fromEntries(inGroup.map((app) => [app.id, next])) } } })}
                options={[{ value: 'ask', label: 'Remind me' }, { value: 'never', label: 'Never' }]} />
            </Row>
          )
        })
        : <Row label={false} name="Call apps"><span className="setting-value">Write down now, in Meetings</span></Row>}
      <RememberedVoices settings={settings} save={save} />
    </Section>
  )
}

/** Whose voices Togle knows from one call to the next: nobody's, until the person turns it on. */
function RememberedVoices({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const { people, error: loadError } = useRememberedVoices()
  const [open, setOpen] = useFoldPreference('settings.voices')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  return (
    <>
      <Row label={false} name="Remembered voices">
        <button className="choice" aria-expanded={open} onClick={() => setOpen(!open)}><Opens>{people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'None'}</Opens></button>
      </Row>
      {open && (
        <div ref={openedInView} className="setting-detail remembered-people">
          <Toggle name="Remember the voices I name" note="Then Togle knows them in later calls. A voice is a person's, so ask them first. Togle keeps a voice profile, encrypted on this computer, never a recording." checked={settings.assist.rememberVoices === true} onChange={(rememberVoices) => void save({ assist: { rememberVoices } })} />
          {people.map((person) => (
            <Row key={person.id} label={false} name={<span className="free-text">{person.name}</span>} note={`Remembered ${new Date(person.createdAt).toLocaleDateString()}`}>
              <button className="quiet-action" aria-label={`Forget ${person.name}'s voice`} disabled={!!busy} onClick={async () => {
                setBusy(person.id); setError('')
                try { await api.forgetVoice(person.id) } catch { setError('Could not forget this voice. Try again.') } finally { setBusy('') }
              }}>{busy === person.id ? 'Forgetting…' : 'Forget'}</button>
            </Row>
          ))}
          {(loadError || error) && <p className="error" role="status">{loadError || error}</p>}
          <div className="row"><button className="ghost small" onClick={() => setOpen(false)}>Done</button></div>
        </div>
      )}
    </>
  )
}

/** The coding agents Togle found on this computer, and the ones the person added: any agent that speaks ACP. */
function Agents({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  // The agents found last (here or on the Agents screen) show at once, and are looked for again behind them.
  const [found, setFound] = useState<RunnerStatus[] | null>(() => keptAnswer<RunnerStatus[]>(AGENTS_FOUND) ?? null)
  const take = (list: RunnerStatus[]): void => { keepAnswer(AGENTS_FOUND, list); setFound(list) }
  const [adding, setAdding] = useOneOpen()
  // The agent whose command is being edited, by its id.
  const [editing, setEditing] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void api.runnerStatus().then((list) => { if (current) take(list) }, () => { if (current) setFound((was) => was ?? []) })
    return () => { current = false }
  }, [])
  // An agent Togle finds by itself is asked about before it is taken off the lists; one the person added is forgotten at once.
  const [confirming, setConfirming] = useState('')
  const change = async (agent: RunnerStatus, work: () => Promise<RunnerStatus[]>): Promise<void> => {
    setBusy(agent.runner); setError(''); setConfirming('')
    try { take(await work()) } catch (failure) { setError(errorText(failure)) } finally { setBusy('') }
  }
  const remove = (agent: RunnerStatus): Promise<void> => change(agent, () => api.removeCodingAgent(agent.runner))
  const restore = (agent: RunnerStatus): Promise<void> => change(agent, () => api.restoreCodingAgent(agent.runner))
  return (
    <Section id="settings-agents" title="Agents">
      {found === null ? <Row label={false} name="Looking…" /> : !found.length ? <Row label={false} name="No agent found" /> : found.map((agent) => (
        <Fragment key={agent.runner}>
          <Row label={false} className="agent-row" name={
            <span className="agent-name">
              <AgentAvatar runner={agent.runner} name={agent.name} />
              <span className="agent-label">{agent.name}</span>
            </span>
          }>
            {agent.installed && !agent.removed && <AgentUsage runner={agent.runner} hideUnavailable />}
            {(agent.removed || !agent.installed || !agent.added) && <span className="setting-value">{agent.removed ? 'Removed' : agent.installed ? 'Found' : 'Not found'}</span>}
            {/* Quiet, as the design draws the row (a name and how it stands): removing an agent is rare, and is not what the screen is about. */}
            {agent.removed
              ? <button className="quiet-action" aria-label={`Add back ${agent.name}`} disabled={!!busy} onClick={() => void restore(agent)}>{busy === agent.runner ? 'Adding…' : 'Add back'}</button>
              : <>
                  {/* An agent that was added can have its command changed later: a command from a list can be wrong for this computer. */}
                  {agent.added && <button className="quiet-action" aria-label={`Edit ${agent.name}`} disabled={!!busy} onClick={() => { setError(''); setEditing(agent.runner) }}>Edit</button>}
                  <button className="quiet-action" aria-label={`Remove ${agent.name}`} disabled={!!busy} onClick={() => { if (agent.added) void remove(agent); else setConfirming(agent.runner) }}>{busy === agent.runner ? 'Removing…' : 'Remove'}</button>
                </>}
          </Row>
          {editing === agent.runner && <EditAgent agent={agent} onSaved={(list) => { take(list); setEditing('') }} onCancel={() => setEditing('')} />}
          {confirming === agent.runner && (
            <div ref={openedInView} className="setting-detail" role="group" aria-label={`Remove ${agent.name} from Togle?`}>
              <p className="hint">Togle stops showing {agent.name}’s tasks. They keep running in {agent.name}, which stays installed, and you can add it back here.</p>
              <div className="row">
                <button className="primary small" onClick={() => void remove(agent)}>Remove</button>
                <button className="ghost small" onClick={() => setConfirming('')}>Keep</button>
              </div>
            </div>
          )}
        </Fragment>
      ))}
      {/* Where tasks open: a switch of two, the same one a task has on its own line, so that the two read as one thing.
          Terminal is the agent's own screen, Chat the conversation with a card for what it asks. */}
      <Row label={false} name="Tasks open in">
        <span className="segmented view-switch" role="radiogroup" aria-label="Tasks open in" title="Terminal is the agent’s own screen. Chat is the conversation, a card for what the agent asks, and a reply box. A switch on a task changes it for that task.">
          {(['cards', 'session'] as const).map((name) => {
            const on = (settings.tasks.view === 'cards' ? 'cards' : 'session') === name
            return <button key={name} type="button" role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => { if (!on) void save({ tasks: { view: name } }) }}>{name === 'cards' ? 'Chat' : 'Terminal'}</button>
          })}
        </span>
      </Row>
      {platform === 'win32' && <Toggle name="Show task details in Windows notifications"
        title={settings.window.keepOutOfCaptures ? 'Previews are hidden while screen capture protection is on.' : 'New alerts include the task name and a short result or request.'}
        checked={settings.tasks.notificationPreviews && !settings.window.keepOutOfCaptures} disabled={settings.window.keepOutOfCaptures}
        onChange={notificationPreviews => void save({ tasks: { notificationPreviews } })} />}
      {/* Sorting uses the AI set in Accounts and explains which task details it reads. */}
      <Row name="Sort tasks by subject">
        <input type="checkbox" role="switch" className="switch" title="The AI set in Accounts reads the names of your tasks, the start of what you asked in each, and the names of their folders, and puts tasks about the same thing under one heading."
          checked={settings.tasks.sortBySubject === true} onChange={(event) => void save({ tasks: { sortBySubject: event.target.checked } })} />
      </Row>
      {/* The button stays where it is while its form is open under it, over the page. */}
      <div className="setting add-row"><button className="small" aria-expanded={adding} title="Pick an agent from a list, or add one by the command that starts it" onClick={() => { setError(''); setAdding(!adding) }}>Add another agent</button></div>
      {adding && <AddAgent onList={take} onClose={() => setAdding(false)} />}
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  )
}

/**
 * Add another agent: a list to pick from, so that nobody has to know a command. The agents found on this computer come first, then
 * more from the ACP registry (they start through npx or uvx, which fetch them the first time). Each has one Add button: Togle fills
 * in the command, and the main process decides how it runs. A command typed in is under a link, for an agent that is not listed.
 */
function AddAgent({ onList, onClose }: { onList: (agents: RunnerStatus[]) => void; onClose: () => void }) {
  // The list as it was last time shows at once, and the one that is asked for now replaces it: opening it again never waits.
  const [catalog, setCatalog] = useState<AgentCatalog | null>(() => keptAnswer<AgentCatalog>(AGENT_CATALOG) ?? null)
  const [byCommand, setByCommand] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const take = (value: AgentCatalog): void => { keepAnswer(AGENT_CATALOG, value); setCatalog(value) }
  useEffect(() => {
    let current = true
    void api.agentCatalog().then((value) => { if (current) take(value) }, () => { if (current) setCatalog((was) => was ?? { found: [], more: [], registry: false }) })
    return () => { current = false }
  }, [])
  if (byCommand) return <AddByCommand onAdded={(list) => { onList(list); onClose() }} onCancel={onClose} />
  // What was added leaves the list (and the kept one), and the list stays for the next one; the keys go back to the search, where the
  // button that was pressed has left.
  const add = (choice: AgentChoice): void => {
    setBusy(choice.id); setError('')
    void api.addCodingAgent(choice.name, choice.command).then(
      (list) => {
        onList(list)
        if (catalog) take({ ...catalog, found: catalog.found.filter((one) => one.id !== choice.id), more: catalog.more.filter((one) => one.id !== choice.id) })
        setQuery('')
        search.current?.focus({ preventScroll: true })
      },
      (failure) => setError(errorText(failure))
    ).finally(() => setBusy(''))
  }
  // A search is words that all appear in an agent's name or in the line about it, in any order.
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const wanted = (choice: AgentChoice): boolean => words.every((word) => `${choice.name} ${choice.description}`.toLowerCase().includes(word))
  const found = catalog ? catalog.found.filter(wanted) : []
  const more = catalog ? catalog.more.filter(wanted) : []
  const rows = (choices: AgentChoice[]): ReactNode =>
    choices.map((choice) => (
      <div key={choice.id} className="agent-choice">
        <AgentAvatar runner={choice.id} name={choice.name} />
        <span className="agent-choice-text"><b>{choice.name}</b><span className="cut">{choice.description}</span></span>
        <button type="button" className="small" aria-label={`Add ${choice.name}`} disabled={!!busy || !!choice.needs} title={choice.needs ? `Needs ${choice.needs === 'npx' ? 'Node.js (npx)' : 'uv (uvx)'} on this computer` : `Starts with: ${choice.command}`} onClick={() => add(choice)}>{busy === choice.id ? 'Adding…' : 'Add'}</button>
      </div>
    ))
  // Enter in the search adds the one agent it has narrowed the list to (when it can be added).
  const only = words.length ? [...found, ...more] : []
  const searching = words.length > 0
  return (
    <FormOver className="add-agent pick" label="Add another agent" busy={!!busy} onClose={onClose} onSubmit={() => { if (!busy && only.length === 1 && !only[0].needs) add(only[0]) }}>
      <span className="tasks-label">Add another agent</span>
      <Field name="Search"><input ref={search} type="search" aria-label="Search agents" placeholder="Name or what it does" spellCheck={false} maxLength={80} value={query} onChange={(event) => setQuery(event.target.value)} /></Field>
      {catalog === null ? <p className="hint">Looking for agents…</p> : (
        <>
          {(!searching || found.length > 0) && <span className="tasks-label">Found on this computer</span>}
          {found.length ? <div className="agent-choices">{rows(found)}</div> : !searching && <p className="hint">No other agent that Togle knows how to start was found here.</p>}
          {(!searching || more.length > 0 || !catalog.registry) && <span className="tasks-label">More agents</span>}
          {!catalog.registry
            ? <p className="hint">The list of more agents could not be loaded. Check the connection, or add one by its command.</p>
            : more.length
              ? <>
                  <div className="agent-choices">{rows(more)}</div>
                  <p className="hint">These start with npx or uvx, which fetch the agent the first time.</p>
                </>
              : !searching && <p className="hint">Nothing more to add from the list.</p>}
          {searching && !found.length && !more.length && <p className="hint">No agent matches “{query.trim()}”. Check the spelling, or add it by its command.</p>}
        </>
      )}
      <p className="hint">Something else? <button type="button" className="quiet-action" onClick={() => setByCommand(true)}>Add by command…</button></p>
      <div className="row"><button type="button" className="ghost" onClick={onClose}>Close</button></div>
      {error && <p className="error" role="alert">{error}</p>}
    </FormOver>
  )
}

/**
 * The name an agent is shown by and the command that starts it, as its own docs give it, and nothing else: a command for ACP
 * is talked to directly and any other runs in a terminal of Togle's own (the main process tells which).
 */
function AddByCommand({ onAdded, onCancel }: { onAdded: (agents: RunnerStatus[]) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <FormOver className="add-agent" label="Add an agent by its command" busy={busy} onClose={onCancel} onSubmit={() => {
      setBusy(true); setError('')
      void api.addCodingAgent(name, command).then(onAdded, (failure) => setError(errorText(failure))).finally(() => setBusy(false))
    }}>
      <span className="tasks-label">Add an agent by its command</span>
      <Field name="Name"><input aria-label="Agent name" required maxLength={40} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></Field>
      <Field name="Command"><input aria-label="Command" required maxLength={500} spellCheck={false} value={command} disabled={busy} onChange={(event) => setCommand(event.target.value)} /></Field>
      <p className="hint">Togle runs it in a terminal of its own, where you see it and answer it. {'{task}'} stands for the task's words. A command for ACP, such as gemini --acp, is talked to directly, and Togle shows its conversation.</p>
      <div className="row">
        <button className="primary" disabled={busy || !name.trim() || !command.trim()}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </FormOver>
  )
}

/**
 * Edit, on an agent that was added: its command, and nothing else. Its name stays, and so does how it runs (a conversation or a
 * terminal): a command that would run it the other way is refused, and the agent is added again. Its tasks that run stop.
 */
function EditAgent({ agent, onSaved, onCancel }: { agent: RunnerStatus; onSaved: (agents: RunnerStatus[]) => void; onCancel: () => void }) {
  const [command, setCommand] = useState(agent.command ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <FormOver className="add-agent edit-agent" label={`Edit ${agent.name}`} busy={busy} onClose={onCancel} onSubmit={() => {
      setBusy(true); setError('')
      void api.editCodingAgent(agent.runner, command).then(onSaved, (failure) => setError(errorText(failure))).finally(() => setBusy(false))
    }}>
      <span className="tasks-label">Edit {agent.name}</span>
      <Field name="Name"><span className="field-fixed">{agent.name}</span></Field>
      <Field name="Command"><input aria-label="Command" required maxLength={500} spellCheck={false} value={command} disabled={busy} onChange={(event) => setCommand(event.target.value)} /></Field>
      <p className="hint">Tasks open in {runsInTerminal(agent.runner) ? 'Terminal' : 'Chat'}. Saving a new command stops this agent’s running tasks.</p>
      <div className="row">
        <button className="primary" disabled={busy || !command.trim() || command.trim() === agent.command}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </FormOver>
  )
}

/** What the AI is: the ChatGPT plan, a key given instead, or nothing yet. */
function useAI(settings: Settings): { kind: 'plan'; account: SubscriptionAccount } | { kind: 'key'; connection: ApiConnection } | { kind: 'none' } {
  const { accounts } = useAccounts()
  const connections = useKeyConnections()
  const id = modelSourceId(settings)
  const account = accounts.find((item) => item.id === id && item.signedIn)
  if (account) return { kind: 'plan', account }
  const connection = connections.find((item) => item.id === id)
  if (connection) return { kind: 'key', connection }
  // The plan signed in without being chosen (a key chosen before was removed): it is the AI.
  const chatgpt = accounts.find((item) => item.provider === 'chatgpt' && item.signedIn)
  return chatgpt && settings.provider === 'chatgpt' ? { kind: 'plan', account: chatgpt } : { kind: 'none' }
}

/** The services a key can come from: Claude's own API, and the others at their OpenAI-compatible addresses. */
const KEY_SERVICES = [
  { id: 'claude', name: 'Claude', kind: 'anthropic', baseUrl: '' },
  { id: 'gemini', name: 'Gemini', kind: 'compatible', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'grok', name: 'Grok', kind: 'compatible', baseUrl: 'https://api.x.ai/v1' },
  { id: 'kimi', name: 'Kimi', kind: 'compatible', baseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'other', name: 'Another service', kind: 'compatible', baseUrl: '' }
] as const

/** A model for every job from a key's list: a quick, cheap one, not one that only embeds, draws or speaks. */
export function pickKeyModel(models: ModelOption[]): string | undefined {
  const usable = models.filter((model) => !/embed|image|imagen|tts|audio|speech|transcri|realtime|moderation|veo|aqa/i.test(model.id))
  return (usable.find((model) => /flash(?!-lite)|mini|fast|turbo|haiku/i.test(model.id)) ?? usable[0])?.id
}

/** Every job on one model of the key's service. */
const keyProfile = (sourceId: string, model: string): AIProfile => ({ tasks: Object.fromEntries(AI_TASKS.map(({ lane }) => [lane, { sourceId, model, effort: 'low' as const }])) as AIProfile['tasks'] })

function Accounts({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  return (
    <Section id="settings-accounts" title="Accounts">
      <AIPlan settings={settings} save={save} />
      <TogleAccountRow />
      <StudioApp />
      <Toggle name="Mention Togle Studio" checked={settings.microphone.suggestions} onChange={(suggestions) => void save({ microphone: { suggestions, ...(suggestions ? { dismissals: 0 } : {}) } })} />
    </Section>
  )
}

function AIPlan({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const { accounts } = useAccounts()
  const ai = useAI(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keyForm, setKeyForm] = useOneOpen()
  const chatgpt = accounts.find((account) => account.id === 'chatgpt-default') ?? accounts.find((account) => account.provider === 'chatgpt')
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setError('')
    try { await action() } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  // The plan becomes the AI again: no key's profile, ChatGPT's own account.
  const usePlan = (): Promise<void> => save({ ai: null, provider: 'chatgpt', subscriptionAccountId: '' })
  const waiting = chatgpt && (chatgpt.signingIn || chatgpt.pending)
  return (
    <>
      <div className="setting ai-plan">
        <span className="name">AI plan</span>
        {ai.kind === 'plan' ? (
          <>
            <span className="control">
              <Menu className="choice" label={<Opens>ChatGPT · signed in</Opens>} ariaLabel="Manage the AI plan" align="right" items={[
                { label: 'Manage usage', onSelect: () => api.openExternal(MANAGE_USAGE_URL) },
                { label: 'Sign out', disabled: busy, onSelect: () => void run(() => api.signOutAccount(ai.account.id)) }
              ]} />
            </span>
          </>
        ) : ai.kind === 'key' ? (
          <>
            <span className="control">
              <Menu className="choice" label={<Opens>{`${ai.connection.label} · key`}</Opens>} ariaLabel="Manage the AI key" align="right" items={[
                { label: 'Use a different key', disabled: busy, onSelect: () => setKeyForm(true) },
                ...(chatgpt ? [{ label: 'Sign in with ChatGPT instead', disabled: busy, onSelect: () => void run(async () => { await api.signInAccount(chatgpt.id); await usePlan() }) }] : []),
                { label: 'Remove the key', disabled: busy, onSelect: () => void run(async () => { await usePlan(); await api.removeApiConnection(ai.connection.id) }) }
              ]} />
            </span>
          </>
        ) : waiting ? (
          <>
            <span className="note">Finish signing in in your browser.{chatgpt?.url && <> <button className="link" onClick={() => api.openExternal(chatgpt.url!)}>Open the sign-in page</button></>}</span>
            <span className="control"><button className="ghost small" onClick={() => void run(() => api.cancelAccountSignIn(chatgpt!.id))}>Cancel</button></span>
          </>
        ) : (
          <span className="control">
            <button className="primary small continue-chatgpt" title="No key and no new bill. What Togle uses counts toward your plan's limit." disabled={busy || !chatgpt} onClick={() => void run(async () => { await usePlan(); await api.signInAccount(chatgpt!.id) })}>Sign in with ChatGPT</button>
          </span>
        )}
      </div>
      {/* The line stays where it is while the form it opens is under it, over the page. */}
      {ai.kind === 'none' && !waiting && (
        <p className="hint ai-plan-other">No ChatGPT plan? <button className="link" aria-expanded={keyForm} onClick={() => setKeyForm(!keyForm)}>Use a key</button> from Claude, Gemini, Grok, Kimi or any other.</p>
      )}
      {ai.kind === 'key' && <KeyModel settings={settings} connection={ai.connection} save={save} />}
      {keyForm && <KeyForm save={save} replacing={ai.kind === 'key' ? ai.connection : undefined} onClose={() => setKeyForm(false)} />}
      {(error || chatgpt?.error) && <p className="error" role="alert">{error || chatgpt?.error}</p>}
    </>
  )
}

/** The model a key's jobs use, from what its service lists. */
function KeyModel({ settings, connection, save }: { settings: Settings; connection: ApiConnection; save: (patch: SettingsPatch) => Promise<void> }) {
  const [models, setModels] = useState<ModelOption[]>([])
  const current = settings.ai?.tasks.deep.model ?? connection.model
  useEffect(() => {
    let live = true
    void api.listModels(connection.id).then((list) => { if (live) setModels(list) }, () => undefined)
    return () => { live = false }
  }, [connection.id, connection.revision])
  return (
    <Row label={false} name="Model">
      <Choice label="Model" value={current} onChange={(model) => void save({ ai: keyProfile(connection.id, model), provider: 'compat', subscriptionAccountId: '' })} options={[
        ...(current && !models.some((model) => model.id === current) ? [{ value: current, label: current }] : []),
        ...models.map((model) => ({ value: model.id, label: model.label }))
      ]} />
    </Row>
  )
}

/** A key from another service, instead of a plan: saved encrypted, checked by listing its models, then used for every job. */
function KeyForm({ save, replacing, onClose }: { save: (patch: SettingsPatch) => Promise<void>; replacing?: ApiConnection; onClose: () => void }) {
  const [service, setService] = useState<(typeof KEY_SERVICES)[number]['id']>('claude')
  const [address, setAddress] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = KEY_SERVICES.find((item) => item.id === service)!
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    let added: ApiConnection | undefined
    try {
      added = await api.addApiConnection({ kind: chosen.kind, label: chosen.id === 'other' ? (safeHost(address) || 'My service') : chosen.name, baseUrl: chosen.baseUrl || address.trim(), model: '', key: key.trim() })
      const model = pickKeyModel(await api.listModels(added.id))
      if (!model) throw new Error('This service lists no model Togle can use.')
      await save({ ai: keyProfile(added.id, model), provider: 'compat', subscriptionAccountId: '' })
      if (replacing) await api.removeApiConnection(replacing.id).catch(() => undefined)
      onClose()
    } catch (failure) {
      // A key that does not work is not kept.
      if (added) await api.removeApiConnection(added.id).catch(() => undefined)
      setError(`${chosen.id === 'other' ? 'The service' : chosen.name} did not take this key: ${errorText(failure)}`)
    } finally { setBusy(false) }
  }
  return (
    <FormOver className="ai-key-form" label="Use a key" busy={busy} onClose={onClose} onSubmit={() => void submit()}>
      <span className="tasks-label">Use a key</span>
      <Field choice name="Service">
        <Choice label="Service" value={service} disabled={busy} onChange={setService} options={KEY_SERVICES.map((item) => ({ value: item.id, label: item.name }))} />
      </Field>
      {service === 'other' && (
        <Field name="Address" note="An OpenAI-compatible service, such as OpenRouter, Groq, or a model on this computer with Ollama.">
          <input aria-label="Address" type="url" required placeholder="https://openrouter.ai/api/v1" value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)} />
        </Field>
      )}
      <Field name="Key" note="Saved encrypted on this computer. The service bills you for what Togle uses.">
        <input aria-label="Key" type="password" autoComplete="off" required={service !== 'other'} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} />
      </Field>
      <div className="row">
        <button className="primary" disabled={busy || (service !== 'other' && !key.trim()) || (service === 'other' && !address.trim())}>{busy ? 'Checking the key…' : 'Use this key'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </FormOver>
  )
}

const safeHost = (value: string): string => { try { return new URL(value).hostname } catch { return '' } }

/** How Togle Studio is doing, in a few words. */
function studioSummary(status: TogleMicrophoneStatus | undefined): string {
  if (!status?.installed) return 'Not installed'
  if (!status.running || !status.state) return 'Installed · not running'
  if (status.state.account === 'signed-out') return 'Signed out'
  if (status.state.setup === 'restart') return 'Restart your computer to finish installing it'
  if (status.state.setup === 'missing') return 'Its audio driver is missing: open it to repair'
  return isMicrophoneOn(status) ? `On${status.state.input ? ` · cleaning ${status.state.input}` : ''}` : 'Off'
}

function StudioApp() {
  const [status, setStatus] = useState<TogleMicrophoneStatus>()
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.microphoneStatus().then(setStatus, () => undefined)
    return api.onMicrophone(setStatus)
  }, [])
  // Opening its window starts the app when it is not running. When that cannot be done, the row says why.
  const open = async (): Promise<void> => {
    setOpening(true); setError('')
    try { await api.showMicrophone() } catch (failure) { setError(errorText(failure)) } finally { setOpening(false) }
  }
  return (
    <>
      <Row label={false} name="Togle Studio" className="studio-row">
        {/* Not there yet: just the one button, as the design's row has it. */}
        {status?.installed && <span className="setting-value microphone-status">{studioSummary(status)}</span>}
        {!status?.installed
          ? <button className="small" onClick={() => void api.openMicrophonePage('settings')}>See Togle Studio</button>
          : <button className={microphoneNeedsSignIn(status) ? 'primary small' : 'ghost small'} disabled={opening} onClick={() => void open()}>{opening ? 'Opening…' : 'Open Studio'}</button>}
      </Row>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  )
}

const MODEL_NAMES: Record<LocalModelId, string> = { parakeet: 'Parakeet', 'whisper-turbo': 'Whisper large-v3-turbo', 'whisper-small': 'Whisper small', 'whisper-base': 'Whisper base' }
/** "574 MB", "1.9 GB". */
const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/**
 * Speech recognition on this computer: installing it, or adding what the language needs. `onlyMissing`: nothing at all
 * while what the language needs is there.
 */
function SpeechModels({ language, onlyMissing }: { language: string; onlyMissing?: boolean }) {
  const [state, setState] = useState<LocalSpeechState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.localSpeech().then(setState)
    return api.onLocalSpeech(setState)
  }, [])
  if (!state || state.dev) return null
  const { offer, installing } = state
  const install = async (models: LocalModelId[]): Promise<void> => {
    setError('')
    try { await api.installLocalSpeech(models) } catch (failure) { if (!/Stopped/.test(errorText(failure))) setError(errorText(failure)) }
  }
  const failed = (error || state.error) && <p className="error">{error || state.error}</p>
  if (installing) {
    return (
      <div className="setting local-speech">
        <span className="name">{installing.here ? `Taking ${installing.what} from this computer` : `Downloading ${installing.what}`}</span>
        <span className="note">{installing.here ? 'Checking it: nothing to download.' : `${size(installing.received)} of ${size(installing.total)}`}</span>
        <span className="control"><button className="ghost" onClick={() => void api.cancelLocalSpeech()}>Stop</button></span>
        <progress value={installing.received} max={installing.total || 1} />
      </div>
    )
  }
  const gpu = offer?.gpu ?? false
  const offered = (id: LocalModelId) => offer?.models.find((model) => model.id === id)
  const needs = localModelsFor(language, gpu).filter((id) => offered(id))
  const missing = needs.filter((id) => !state.installed.includes(id))
  if (state.installed.length && !missing.length) return onlyMissing ? null : failed || null
  if (onlyMissing && !state.installed.length) return null
  if (!offer) return <p className="error">There's no speech recognition to install for this system.</p>
  const chosen = state.installed.length ? missing : needs
  const total = (state.installed.length ? 0 : offer.engine) + chosen.reduce((sum, id) => sum + (offered(id)?.here ? 0 : offered(id)?.bytes ?? 0), 0)
  const code = speechLanguageCode(language)
  const name = state.installed.length ? (code === 'auto' ? 'Add the other languages' : `Add ${speechLanguageName(code)}`) : 'Speech recognition'
  const note = `${chosen.map((id) => MODEL_NAMES[id]).join(' and ')}${code !== 'auto' && PARAKEET_LANGUAGES.has(code) && chosen.includes('parakeet') ? `, quick for ${speechLanguageName(code)}` : ''}. A one-time download, kept on this computer.`
  return (
    <>
      <Row label={false} className="local-speech" name={name} note={note}>
        <button className={state.installed.length ? 'ghost' : 'primary'} onClick={() => void install(chosen)}>{total ? `${state.installed.length ? 'Add' : 'Install'} (${size(total)})` : 'Use it'}</button>
      </Row>
      {failed}
    </>
  )
}
