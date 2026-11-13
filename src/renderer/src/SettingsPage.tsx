import { useEffect, useState } from 'react'
import type { SettingsPatch } from '@shared/api'
import type { AIProfile, ApiConnection, LocalModelId, LocalSpeechState, ModelOption, Settings, SttStatus, SubscriptionAccount } from '@shared/types'
import type { RunnerStatus } from '@shared/runner'
import { CALL_APPS, isCallAppMode, type CallApp, type CallAppMode } from '@shared/call-apps'
import { localModelsFor, PARAKEET_LANGUAGES, SPEECH_LANGUAGES, speechLanguageCode, speechLanguageName } from '@shared/speech'
import { voiceAccountId } from '@shared/dictation'
import type { UpdateState } from '@shared/updates'
import { modelSourceId } from '@shared/model-selection'
import { AI_TASKS } from '@shared/preferences'
import { MANAGE_USAGE_URL } from '@shared/plan'
import { isMicrophoneOn, microphoneNeedsSignIn, type TogleMicrophoneStatus } from '@shared/microphone'
import { useHotkeys } from './hotkeys'
import { Shortcut } from './Shortcut'
import { Row, Section, Toggle } from './Rows'
import { useAccounts } from './Accounts'
import { Menu } from './Menu'
import { VocabularyEditor } from './DictationVocabulary'
import { Devices, SignIn, useReach } from './Devices'
import { useRememberedVoices } from './VoiceMemory'
import type { SettingsPart } from './open-settings'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const platform = api.platform

interface Props {
  settings: Settings
  stt: SttStatus
  /** Opened to fix something: the part that does. */
  at?: SettingsPart
  onChange: (settings: Settings) => void
}

/**
 * Settings, on one screen as the design has it: five groups side by side (Keys, Voice, Meetings, Agents, Accounts), each a
 * few rows of a name and its value. Every setting has a default that works, so nobody has to come here. A row that opens
 * something to change (names and terms, a key, an agent to add) widens its group while it is open.
 */
export function SettingsPage({ settings, stt, at, onChange }: Props) {
  const [saveError, setSaveError] = useState('')
  const save = async (patch: SettingsPatch): Promise<void> => {
    setSaveError('')
    try { onChange(await api.updateSettings(patch)) } catch (error) { setSaveError(`Could not save: ${errorText(error)}`) }
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
        <Update />
        <div className="sets">
          <Keys />
          <Voice settings={settings} stt={stt} save={save} />
          <Meetings settings={settings} save={save} />
          <Agents />
          <Accounts settings={settings} save={save} />
          <Devices />
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
      <Row name="Microphone" note={problem || undefined}>
        <select aria-label="Microphone" value={chosen} onChange={(event) => void save({ dictation: { microphoneId: event.target.value } })}>
          <option value="">System default</option>
          {chosen && !microphones.some((device) => device.deviceId === chosen) && <option value={chosen}>Saved microphone (not listed)</option>}
          {microphones.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
        </select>
      </Row>
      <Row name="Language">
        <select aria-label="Language" value={settings.transcription.language} onChange={(event) => void save({ transcription: { language: event.target.value } })}>
          {SPEECH_LANGUAGES.map(([code, name]) => <option key={code} value={code}>{code === 'auto' ? 'Detected' : name}</option>)}
        </select>
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
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number>()
  useEffect(() => {
    if (open) return
    let current = true
    void api.dictationVocabulary(accountId).then((value) => { if (current) setCount(value.words.length + value.snippets.length) }, () => undefined)
    return () => { current = false }
  }, [accountId, open])
  return (
    <>
      <Row label={false} name="Names and terms">
        <button className="value-button" aria-expanded={open} title="Names and terms spelled your way, and phrases that type a longer text" onClick={() => setOpen(!open)}>{count === undefined ? '…' : count ? `${count} ${count === 1 ? 'entry' : 'entries'}` : 'None'}</button>
      </Row>
      {open && <div className="setting-detail"><VocabularyEditor accountId={accountId} /><div className="row"><button className="ghost small" onClick={() => setOpen(false)}>Done</button></div></div>}
    </>
  )
}

/** The call apps the design names in Settings; another shows once it is set to something other than Ask. */
const MAIN_CALL_APPS: CallApp[] = ['zoom', 'meet', 'teams']

function Meetings({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const apps = settings.meetings.apps
  const modeOf = (id: CallApp): CallAppMode => (isCallAppMode(apps[id]) ? apps[id]! : 'ask')
  const notices = platform === 'win32' || platform === 'linux' || platform === 'darwin'
  // Zoom, Meet and Teams always; another call app once it is set to something other than Ask (from a call's notice).
  const shown = CALL_APPS.filter((app) => MAIN_CALL_APPS.includes(app.id) || modeOf(app.id) !== 'ask')
  const groups = (['always', 'ask', 'never'] as CallAppMode[]).map((mode) => ({ mode, apps: shown.filter((app) => modeOf(app.id) === mode) })).filter((group) => group.apps.length)
  return (
    <Section id="settings-meetings" title="Meetings">
      {notices
        ? groups.map(({ mode, apps: inGroup }) => {
          const names = inGroup.map((app) => app.name).join(', ')
          return (
            <Row key={mode} name={names}>
              <select aria-label={`When a call starts in ${names}`} value={mode} onChange={(event) => void save({ meetings: { ...settings.meetings, notice: true, apps: { ...apps, ...Object.fromEntries(inGroup.map((app) => [app.id, event.target.value as CallAppMode])) } } })}>
                <option value="ask">Ask</option>
                <option value="always">Always write down</option>
                {mode === 'never' && <option value="never">Never</option>}
              </select>
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
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  return (
    <>
      <Row label={false} name="Remembered voices">
        <button className="value-button" aria-expanded={open} onClick={() => setOpen(!open)}>{people.length ? `${people.length} ${people.length === 1 ? 'person' : 'people'}` : 'None'}</button>
      </Row>
      {open && (
        <div className="setting-detail remembered-people">
          <Toggle name="Remember the voices I name" note="Then Togle knows them in later calls. A voice is a person's, so ask them first. Togle keeps a voice profile, encrypted on this computer, never a recording." checked={settings.assist.rememberVoices === true} onChange={(rememberVoices) => void save({ assist: { rememberVoices } })} />
          {people.map((person) => (
            <Row key={person.id} label={false} name={person.name} note={`Remembered ${new Date(person.createdAt).toLocaleDateString()}`}>
              <button className="ghost small" aria-label={`Forget ${person.name}'s voice`} disabled={!!busy} onClick={async () => {
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

/** An agent's letter, as the design marks each agent: C for Claude Code, X for Codex, H for Hermes. */
const agentLetter = (agent: RunnerStatus): string => (agent.runner === 'codex' ? 'X' : agent.name.trim().charAt(0).toUpperCase() || '?')

/** The coding agents Togle found on this computer, and the ones the person added: any agent that speaks ACP. */
function Agents() {
  const [found, setFound] = useState<RunnerStatus[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let current = true
    void api.runnerStatus().then((list) => { if (current) setFound(list) }, () => { if (current) setFound([]) })
    return () => { current = false }
  }, [])
  const remove = async (agent: RunnerStatus): Promise<void> => {
    setBusy(agent.runner); setError('')
    try { setFound(await api.removeCodingAgent(agent.runner)) } catch (failure) { setError(errorText(failure)) } finally { setBusy('') }
  }
  return (
    <Section id="settings-agents" title="Agents">
      {found === null ? <Row label={false} name="Looking…" /> : !found.length ? <Row label={false} name="No agent found" /> : found.map((agent) => (
        <Row key={agent.runner} label={false} name={<span className="agent-name"><span className="av" aria-hidden="true">{agentLetter(agent)}</span><span className="agent-label">{agent.name}</span></span>}>
          <span className={`setting-value ${agent.installed ? 'found' : ''}`}>{agent.installed ? (agent.added ? 'Added' : 'Found') : 'Not found'}</span>
          {agent.added && <button className="ghost small" aria-label={`Remove ${agent.name}`} disabled={!!busy} onClick={() => void remove(agent)}>{busy === agent.runner ? 'Removing…' : 'Remove'}</button>}
        </Row>
      ))}
      {adding ? <AddAgent onAdded={(list) => { setFound(list); setAdding(false) }} onCancel={() => setAdding(false)} /> : (
        <div className="setting add-row"><button className="small" title="Any other agent: one that speaks ACP, or any that runs in a terminal" onClick={() => { setError(''); setAdding(true) }}>Add an agent</button></div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </Section>
  )
}

/**
 * The name an agent is shown by, how it runs (it speaks ACP, or it runs in a terminal of Togle's own), and the command
 * that starts it, as its own docs give it.
 */
function AddAgent({ onAdded, onCancel }: { onAdded: (agents: RunnerStatus[]) => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [how, setHow] = useState<'acp' | 'terminal'>('acp')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form className="setting-detail add-agent" aria-label="Add an agent" onSubmit={(event) => {
      event.preventDefault()
      setBusy(true); setError('')
      void api.addCodingAgent(name, command, how).then(onAdded, (failure) => setError(errorText(failure))).finally(() => setBusy(false))
    }}>
      <Row stacked name="Name"><input aria-label="Agent name" required maxLength={40} autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></Row>
      <Row stacked name="How it runs">
        <div className="segmented" role="radiogroup" aria-label="How it runs">
          <button type="button" role="radio" aria-checked={how === 'acp'} className={how === 'acp' ? 'on' : ''} disabled={busy} onClick={() => setHow('acp')}>It speaks ACP</button>
          <button type="button" role="radio" aria-checked={how === 'terminal'} className={how === 'terminal' ? 'on' : ''} disabled={busy} onClick={() => setHow('terminal')}>In a terminal</button>
        </div>
      </Row>
      <Row stacked name="Command" note={how === 'acp'
        ? 'The command that starts it for ACP, as its own docs give it. Togle runs it on this computer, the way a terminal would.'
        : "The command that starts it in a terminal. Togle runs it in a terminal of its own, in the task's folder, where you see it and answer it. Put {task} where the task's words go, as in: cursor-agent {task}. Without {task}, you type them in."}>
        <input aria-label="Command" required maxLength={500} spellCheck={false} value={command} disabled={busy} onChange={(event) => setCommand(event.target.value)} />
      </Row>
      <div className="row">
        <button className="primary" disabled={busy || !name.trim() || !command.trim()}>{busy ? 'Adding…' : 'Add'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
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

function useKeyConnections(): ApiConnection[] {
  const [connections, setConnections] = useState<ApiConnection[]>([])
  useEffect(() => {
    let current = true
    const refresh = (): void => { void api.apiConnections().then((list) => { if (current) setConnections(list) }, () => undefined) }
    refresh()
    const off = api.onApiConnectionsChanged(refresh)
    return () => { current = false; off() }
  }, [])
  return connections
}

/** The services a key can come from, at their OpenAI-compatible addresses. */
const KEY_SERVICES = [
  { id: 'gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'grok', name: 'Grok', baseUrl: 'https://api.x.ai/v1' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1' },
  { id: 'other', name: 'Another service', baseUrl: '' }
] as const

/** A model for every job from a key's list: a quick, cheap one, not one that only embeds, draws or speaks. */
export function pickKeyModel(models: ModelOption[]): string | undefined {
  const usable = models.filter((model) => !/embed|image|imagen|tts|audio|speech|transcri|realtime|moderation|veo|aqa/i.test(model.id))
  return (usable.find((model) => /flash(?!-lite)|mini|fast|turbo/i.test(model.id)) ?? usable[0])?.id
}

/** Every job on one model of the key's service. */
const keyProfile = (sourceId: string, model: string): AIProfile => ({ tasks: Object.fromEntries(AI_TASKS.map(({ lane }) => [lane, { sourceId, model, effort: 'low' as const }])) as AIProfile['tasks'] })

function Accounts({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  return (
    <Section id="settings-accounts" title="Accounts">
      <AIPlan settings={settings} save={save} />
      <StudioRow />
      <Toggle name="Mention Togle Studio" checked={settings.microphone.suggestions} onChange={(suggestions) => void save({ microphone: { suggestions, ...(suggestions ? { dismissals: 0 } : {}) } })} />
    </Section>
  )
}

function AIPlan({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const { accounts } = useAccounts()
  const ai = useAI(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [keyForm, setKeyForm] = useState(false)
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
              <Menu className="value-button" label={`${ai.account.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} · signed in`} ariaLabel="Manage the AI plan" align="right" items={[
                ...(ai.account.provider === 'chatgpt' ? [{ label: 'Manage usage', onSelect: () => api.openExternal(MANAGE_USAGE_URL) }] : []),
                { label: 'Sign out', disabled: busy, onSelect: () => void run(() => api.signOutAccount(ai.account.id)) }
              ]} />
            </span>
          </>
        ) : ai.kind === 'key' ? (
          <>
            <span className="control">
              <Menu className="value-button" label={`${ai.connection.label} · key`} ariaLabel="Manage the AI key" align="right" items={[
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
      {ai.kind === 'none' && !waiting && !keyForm && (
        <p className="hint ai-plan-other">No ChatGPT plan? <button className="link" onClick={() => setKeyForm(true)}>Use a key</button> from Gemini, Grok, Kimi or any other.</p>
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
    <Row name="Model">
      <select aria-label="Model" value={current} onChange={(event) => void save({ ai: keyProfile(connection.id, event.target.value), provider: 'compat', subscriptionAccountId: '' })}>
        {current && !models.some((model) => model.id === current) && <option value={current}>{current}</option>}
        {models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      </select>
    </Row>
  )
}

/** A key from another service, instead of a plan: saved encrypted, checked by listing its models, then used for every job. */
function KeyForm({ save, replacing, onClose }: { save: (patch: SettingsPatch) => Promise<void>; replacing?: ApiConnection; onClose: () => void }) {
  const [service, setService] = useState<(typeof KEY_SERVICES)[number]['id']>('gemini')
  const [address, setAddress] = useState('')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = KEY_SERVICES.find((item) => item.id === service)!
  const submit = async (): Promise<void> => {
    setBusy(true); setError('')
    let added: ApiConnection | undefined
    try {
      added = await api.addApiConnection({ kind: 'compatible', label: chosen.id === 'other' ? (safeHost(address) || 'My service') : chosen.name, baseUrl: chosen.baseUrl || address.trim(), model: '', key: key.trim() })
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
    <form className="setting-detail ai-key-form" aria-label="Use a key" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <Row name="Service">
        <select aria-label="Service" value={service} disabled={busy} onChange={(event) => setService(event.target.value as typeof service)}>
          {KEY_SERVICES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </Row>
      {service === 'other' && (
        <Row stacked name="Address" note="An OpenAI-compatible service, such as OpenRouter, Groq, or a model on this computer with Ollama.">
          <input aria-label="Address" type="url" required placeholder="https://openrouter.ai/api/v1" value={address} disabled={busy} onChange={(event) => setAddress(event.target.value)} />
        </Row>
      )}
      <Row stacked name="Key" note="Saved encrypted on this computer. The service bills you for what Togle uses.">
        <input aria-label="Key" type="password" autoComplete="off" required={service !== 'other'} value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} />
      </Row>
      <div className="row">
        <button className="primary" disabled={busy || (service !== 'other' && !key.trim()) || (service === 'other' && !address.trim())}>{busy ? 'Checking the key…' : 'Use this key'}</button>
        <button type="button" className="ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </form>
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

/**
 * Togle Studio under Accounts. While Reach is in this Togle, it is Studio's sign-in, as the design has it: the first
 * computer you sign in on starts your devices. Otherwise it is the Studio app that cleans the microphone: where it stands,
 * and the one thing to do next.
 */
function StudioRow() {
  const reach = useReach()
  const [signingIn, setSigningIn] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  if (reach?.available) {
    const run = async (what: string, work: () => Promise<unknown>): Promise<void> => {
      setBusy(what); setError('')
      try { await work() } catch (failure) { setError(errorText(failure)) } finally { setBusy('') }
    }
    return (
      <>
        <Row label={false} name="Togle Studio" className="studio-row">
          {reach.account
            ? <Menu className="value-button" label={reach.account.email} ariaLabel="Togle Studio account" align="right" items={[{ label: 'Sign out', onSelect: () => void run('out', () => api.reachSignOut()) }]} />
            : <button className="small" aria-expanded={signingIn} onClick={() => setSigningIn(!signingIn)}>Sign in</button>}
        </Row>
        {signingIn && !reach.account && <div className="setting-detail"><SignIn busy={busy} run={run} /></div>}
        {error && <p className="error" role="alert">{error}</p>}
      </>
    )
  }
  return <StudioApp />
}

function StudioApp() {
  const [status, setStatus] = useState<TogleMicrophoneStatus>()
  useEffect(() => {
    void api.microphoneStatus().then(setStatus, () => undefined)
    return api.onMicrophone(setStatus)
  }, [])
  return (
    <Row label={false} name="Togle Studio" className="studio-row">
      {/* Not there yet: just the one button, as the design's row has it. */}
      {status?.installed && <span className="setting-value microphone-status">{studioSummary(status)}</span>}
      {!status?.installed
        ? <button className="small" onClick={() => void api.openMicrophonePage('settings')}>See Togle Studio</button>
        : microphoneNeedsSignIn(status)
          ? <button className="primary small" onClick={() => void api.showMicrophone()}>Sign in</button>
          : <button className="ghost small" onClick={() => void api.showMicrophone()}>Open</button>}
    </Row>
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
