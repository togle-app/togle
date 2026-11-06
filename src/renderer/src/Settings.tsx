import { useEffect, useState, type ReactNode } from 'react'
import type { SettingsPatch } from '@shared/api'
import type {
  AuthStatus,
  ClaudeAuthStatus,
  HotkeyInfo,
  LocalModelId,
  LocalSpeechState,
  Recognizer,
  Settings as SettingsData,
  SpeechApiId,
  SttStatus
} from '@shared/types'
import { useHotkeys } from './hotkeys'
import type { SettingsPart } from './open-settings'
import { Icon } from './Icon'
import { Row, Section, Toggle } from './Rows'
import { VoiceMemorySettings } from './VoiceMemory'
import { OpacitySlider } from './WindowControls'
import { DictationSettings } from './DictationSettings'
import { TogleMicrophoneSettings } from './TogleMicrophoneSettings'
import { Shortcut } from './Shortcut'
import { AISettings } from './AISettings'
import { accountLabel, useAccounts } from './Accounts'
import { SPEECH_LANGUAGES, speechLanguageProblem } from '@shared/speech'

const api = window.togle

// What turns the call into words, for my voice and theirs alike: this PC's models unless another is picked.
const RECOGNIZERS: { id: Recognizer; label: string }[] = [
  { id: 'local', label: 'On this device' },
  { id: 'openai', label: 'OpenAI API key' },
  { id: 'server', label: 'Custom speech server' }
]

/** How speech recognition is doing, beside its name: what hears each side, for a pointer that rests on it. */
function SpeechState({ stt }: { stt: SttStatus }) {
  const [label, kind] =
    stt.state === 'ready' ? ['Ready', 'ok'] : stt.state === 'starting' ? ['Getting ready…', ''] : stt.state === 'missing' ? ['Not ready', 'warn'] : ['Stopped', 'bad']
  return (
    <span className={`state ${kind}`} title={stt.state === 'ready' ? stt.detail : undefined}>
      Calls: {label}
    </span>
  )
}

const MODEL_NAMES: Record<LocalModelId, string> = { parakeet: 'Parakeet', 'whisper-turbo': 'Whisper large-v3-turbo', 'whisper-base': 'Whisper base' }

/** "574 MB", "1.9 GB". */
const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/**
 * Speech recognition on this PC, when a side is heard here: what's installed (removing it, or adding Parakeet for
 * English calls), an install under way, or installing it. It's downloaded when asked for, not with Togle: what suits
 * this PC is a click away, and which models folded under it (a Whisper model, and Parakeet for English).
 */
function LocalSpeechPanel({ english }: { english: boolean }) {
  const [state, setState] = useState<LocalSpeechState | null>(null)
  const [whisper, setWhisper] = useState<LocalModelId | null>(null)
  // Parakeet hears only English: picked for English calls, unless turned off.
  const [parakeet, setParakeet] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.localSpeech().then(setState)
    return api.onLocalSpeech(setState)
  }, [])
  if (!state || state.dev) return null
  const { offer, installing } = state
  const install = async (models: LocalModelId[]): Promise<void> => {
    setError('')
    try {
      await api.installLocalSpeech(models)
    } catch (err) {
      if (!/Stopped/.test(errorText(err))) setError(errorText(err))
    }
  }
  const failed = (error || state.error) && <p className="error">{error || state.error}</p>
  if (installing) {
    return (
      <div className="setting local-speech">
        <span className="name">{installing.here ? `Taking ${installing.what} from this PC` : `Downloading ${installing.what}`}</span>
        <span className="note">
          {installing.here ? 'Checking it: nothing to download.' : `${size(installing.received)} of ${size(installing.total)}`}
        </span>
        <span className="control">
          <button className="ghost" onClick={() => void api.cancelLocalSpeech()}>
            Stop
          </button>
        </span>
        <progress value={installing.received} max={installing.total || 1} />
      </div>
    )
  }
  const parakeetModel = offer?.models.find((m) => m.id === 'parakeet')
  if (state.installed.length) {
    const addParakeet = english && parakeetModel && !state.installed.includes('parakeet')
    return (
      <details className="more local-speech">
        <summary>Installed speech models</summary>
        <Row
          label={false}
          className="local-speech"
          name="On this PC"
          note={
            <>
              {/* Whisper first, as the install says them, whichever went in first. */}
              {[...state.installed]
                .sort((a, b) => Number(a === 'parakeet') - Number(b === 'parakeet'))
                .map((m) => MODEL_NAMES[m])
                .join(' and ')}
              .
              {addParakeet && (
                <>
                  {' '}
                  <button className="link" onClick={() => void install(['parakeet'])}>
                    Add Parakeet
                  </button>
                  , which hears English best ({size(parakeetModel.bytes)}).
                </>
              )}
            </>
          }
        >
          <button className="link" onClick={() => void api.removeLocalSpeech()}>
            Remove
          </button>
        </Row>
        {failed}
      </details>
    )
  }
  if (!offer) return <p className="error">There's no speech recognition to install for this system: pick OpenAI or a speech server above.</p>
  const whispers = offer.models.filter((m) => m.id !== 'parakeet')
  const picked = whisper ?? whispers.find((m) => m.recommended)?.id ?? whispers[0].id
  const withParakeet = !!parakeetModel && (parakeet ?? english)
  const chosen: LocalModelId[] = [picked, ...(withParakeet ? (['parakeet'] as const) : [])]
  // What's on this PC already isn't downloaded: it's taken from where it is.
  const total = offer.engine + offer.models.filter((m) => chosen.includes(m.id) && !m.here).reduce((sum, m) => sum + m.bytes, 0)
  const sized = (m: { bytes: number; here?: boolean }): string => (m.here ? 'on this PC' : size(m.bytes))
  return (
    <>
      {total ? (
        <Row
          label={false}
          className="local-speech"
          name="Not installed yet"
          note={offer.models.some((m) => chosen.includes(m.id) && m.here) ? 'Some of it is on this PC already; the rest is a one-time download.' : 'A one-time download, kept on this PC.'}
        >
          <button className="primary" onClick={() => void install(chosen)}>
            Install ({size(total)})
          </button>
        </Row>
      ) : (
        <Row label={false} className="local-speech" name="Already on this PC" note={`${chosen.map((m) => MODEL_NAMES[m]).join(' and ')}: nothing to download.`}>
          <button className="primary" onClick={() => void install(chosen)}>
            Use them
          </button>
        </Row>
      )}
      <details className="more local-speech">
        <summary>Choose models</summary>
        <Row stacked name="Whisper">
          <select value={picked} onChange={(e) => setWhisper(e.target.value as LocalModelId)}>
            {whispers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({sized(m)}){m.recommended ? (offer.gpu ? ', for this GPU' : ', for this CPU') : ''}
              </option>
            ))}
          </select>
        </Row>
        {parakeetModel && (
          <Toggle name="Parakeet" note={`Hears English calls best (${sized(parakeetModel)}).`} checked={withParakeet} onChange={setParakeet} />
        )}
      </details>
      {failed}
    </>
  )
}

/** The speech APIs that take a key of their own. */
type KeyedApi = Exclude<SpeechApiId, 'chatgpt' | 'claude'>

interface HearingProps {
  transcription: SettingsData['transcription']
  voiceAccountId: string
  /** Whether Togle is signed in with ChatGPT, which the plan's dictation goes with. */
  signedIn: boolean
  stt: SttStatus
  save: (patch: SettingsPatch) => Promise<void>
}

/**
 * Speech recognition's settings: the calls' language, what hears each side of the call, and what the one picked needs
 * (this PC's, installing; OpenAI's, a key and its model; another server's, its address and model, and a key if it
 * takes one); then what keeps it from hearing, if anything.
 */
function Hearing({ transcription: t, voiceAccountId, signedIn, stt, save }: HearingProps) {
  const accounts = useAccounts()
  const sharedAccount = accounts.accounts.find(account => account.id === t.accountId) || (stt.transcriptionAccount?.id === t.accountId ? stt.transcriptionAccount : undefined)
  const languageProblem = sharedAccount ? speechLanguageProblem(sharedAccount.provider, t.language) : undefined
  const speechAccount = stt.transcriptionAccount
  const voiceAccount = accounts.accounts.find(account => account.id === voiceAccountId)
  const voiceLanguageProblem = voiceAccount && voiceAccountId !== t.accountId ? speechLanguageProblem(voiceAccount.provider, t.language) : undefined
  const [hasKey, setHasKey] = useState<Record<KeyedApi, boolean>>({ openai: false, server: false })
  const [keys, setKeys] = useState<Record<KeyedApi, string>>({ openai: '', server: '' })
  const [openaiModel, setOpenaiModel] = useState(t.openaiModel)
  const [serverUrl, setServerUrl] = useState(t.serverUrl)
  const [serverModel, setServerModel] = useState(t.serverModel)
  useEffect(() => {
    void Promise.all([api.hasSpeechKey('openai'), api.hasSpeechKey('server')]).then(([openai, server]) => setHasKey({ openai, server }))
  }, [])
  const uses = (id: SpeechApiId): boolean => t.me === id || t.them === id
  // A ChatGPT account's speech is heard by this PC: Sign in with ChatGPT doesn't include transcription.
  const accountSource = (provider?: 'claude' | 'chatgpt'): Recognizer => provider === 'claude' ? 'claude' : 'local'
  const sourceFor = (source: Recognizer): string => source === 'claude' || source === accountSource(sharedAccount?.provider) ? 'account' : source
  const mixedSources = sourceFor(t.me) !== sourceFor(t.them)
  const customCalls = mixedSources || sourceFor(t.me) !== 'account'
  const customVoice = !!voiceAccountId && voiceAccountId !== t.accountId
  const [advanced, setAdvanced] = useState(customCalls && stt.state !== 'ready')
  const keyField = (id: KeyedApi, label: string, placeholder: string, note?: ReactNode) => (
    <Row stacked name={label} note={note}>
      <input
        type="password"
        value={keys[id]}
        placeholder={hasKey[id] ? 'Saved. Paste a new key to replace it' : placeholder}
        onChange={(e) => setKeys({ ...keys, [id]: e.target.value })}
      />
      <button
        disabled={!keys[id].trim()}
        onClick={async () => {
          await api.setSpeechKey(id, keys[id])
          setKeys((k) => ({ ...k, [id]: '' }))
          setHasKey((h) => ({ ...h, [id]: true }))
        }}
      >
        Save
      </button>
    </Row>
  )
  return (
    <>
      <Row stacked name="Account" note="Recognizes speech for both calls and voice typing.">
        <select aria-label="Shared speech account" value={t.accountId || sharedAccount?.id || ''} onChange={event => {
          const account = accounts.accounts.find(account => account.id === event.target.value)
          if (account) void save({ transcription: { accountId: account.id, me: accountSource(account.provider), them: accountSource(account.provider) } })
        }}>
          <option value="" disabled>Choose a subscription account</option>
          {t.accountId && !accounts.accounts.some(account => account.id === t.accountId) && <option value={t.accountId}>Account unavailable — choose another</option>}
          {accounts.accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
        </select>
      </Row>
      {sharedAccount?.provider === 'chatgpt' && <p className="hint">ChatGPT accounts don't include transcription: Togle hears your calls and voice typing on this PC, and nothing is sent to transcribe.</p>}
      <Row stacked name="Language" note={sharedAccount?.provider === 'claude' ? "Choose a supported language. Automatic needs this PC's speech recognition." : 'Automatic also handles language changes.'}>
        <select aria-label="Speech language" value={t.language} onChange={event => void save({ transcription: { language: event.target.value } })}>
          {SPEECH_LANGUAGES.filter(([code]) => sharedAccount?.provider !== 'claude' || code === t.language || !speechLanguageProblem('claude', code)).map(([code, name]) => <option key={code} value={code} disabled={sharedAccount?.provider === 'claude' && !!speechLanguageProblem('claude', code)}>{code === 'auto' ? 'Automatic' : name}</option>)}
        </select>
      </Row>
      {languageProblem && <p className="error" role="status">{languageProblem}</p>}
      {voiceLanguageProblem && <p className="error" role="status">Voice typing: {voiceLanguageProblem}</p>}
      {stt.callId && speechAccount && (speechAccount.id !== sharedAccount?.id || stt.transcriptionLanguage && stt.transcriptionLanguage !== t.language) && <p className="hint speech-current-call">The current call keeps {accountLabel(speechAccount)} and its original language. Changes apply to new recordings and calls.</p>}
      {(customCalls || customVoice) && <div className="speech-exceptions" role="status">
        {customCalls && <span>Calls use {mixedSources ? 'different sources for each side' : RECOGNIZERS.find(source => source.id === t.me)?.label}.</span>}
        {customVoice && <span>Voice typing uses {voiceAccount ? accountLabel(voiceAccount) : 'an unavailable account'}.</span>}
        <button className="link" disabled={!sharedAccount} onClick={() => void save({ transcription: { me: accountSource(sharedAccount?.provider), them: accountSource(sharedAccount?.provider) }, dictation: { accountId: '', speech: 'auto' } })}>Use this account for both</button>
      </div>}
      <details className="more speech-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>Advanced speech settings</summary>
      <Row stacked name="Call transcription" note="Change only if you want calls to use local recognition or a separate speech API.">
        <select aria-label="Meeting speech recognition" value={mixedSources ? 'mixed' : sourceFor(t.me)} onChange={event => {
          const source = event.target.value === 'account' ? accountSource(sharedAccount?.provider) : event.target.value as Recognizer
          void save({ transcription: { me: source, them: source } })
        }}>{mixedSources && <option value="mixed" disabled>Different sources for each side</option>}<option value="account">Use account above</option>{RECOGNIZERS.filter(source => source.id !== accountSource(sharedAccount?.provider)).map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select>
      </Row>
      <Row stacked name="Voice typing account" note="Change only to keep voice typing on another work or personal account.">
        <select aria-label="Voice typing account" value={voiceAccountId} onChange={event => void save({ dictation: { accountId: event.target.value, speech: 'auto' } })}>
          <option value="">Use account above</option>
          {voiceAccountId && !voiceAccount && <option value={voiceAccountId}>Account unavailable</option>}
          {accounts.accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
        </select>
      </Row>
      {(t.me === 'local' || t.them === 'local') && <LocalSpeechPanel english={t.language === 'en'} />}
      {uses('openai') && (
        <>
          {keyField(
            'openai',
            'OpenAI API key',
            'sk-…',
            !hasKey.openai && (
              <>
                Create one at{' '}
                <button className="link" onClick={() => api.openExternal('https://platform.openai.com/api-keys')}>
                  platform.openai.com
                </button>
                . It's billed by the minute of speech, apart from the ChatGPT plan.
              </>
            )
          )}
          <Row stacked name="OpenAI model">
            <input
              list="openai-speech-models"
              value={openaiModel}
              placeholder="gpt-transcribe"
              onChange={(e) => setOpenaiModel(e.target.value)}
              onBlur={() => {
                if (openaiModel.trim() !== t.openaiModel) void save({ transcription: { openaiModel: openaiModel.trim() } })
              }}
            />
            <datalist id="openai-speech-models">
              <option value="gpt-transcribe" />
            </datalist>
          </Row>
        </>
      )}
      {uses('server') && (
        <>
          <Row stacked name="Speech server" note="Any server with OpenAI's speech API: speaches, LocalAI or vLLM on this PC, or a service such as Groq.">
            <input
              value={serverUrl}
              placeholder="http://localhost:8000/v1"
              onChange={(e) => setServerUrl(e.target.value)}
              onBlur={() => {
                if (serverUrl.trim() !== t.serverUrl) void save({ transcription: { serverUrl: serverUrl.trim() } })
              }}
            />
          </Row>
          <Row stacked name="Its model">
            <input
              value={serverModel}
              placeholder="e.g. whisper-large-v3-turbo"
              onChange={(e) => setServerModel(e.target.value)}
              onBlur={() => {
                if (serverModel.trim() !== t.serverModel) void save({ transcription: { serverModel: serverModel.trim() } })
              }}
            />
          </Row>
          {keyField('server', 'Its API key', 'Not needed for most servers on this PC')}
        </>
      )}
      </details>
      {stt.state === 'error' && <p className="error">{stt.detail ?? 'Speech recognition stopped.'}</p>}
      {stt.problem && <p className="error">{stt.problem}</p>}
    </>
  )
}

// The shortcuts a call uses, shown first; the others are folded under them.
const CALL_SHORTCUTS: HotkeyInfo['id'][] = ['suggest', 'suggest-screen', 'deeper', 'listen']

export function SpeechSettings({ settings, save, stt, agent = false }: { settings: SettingsData; save: (patch: SettingsPatch) => Promise<void>; stt: SttStatus; agent?: boolean }) {
  return <Section id={agent ? 'agent-speech' : 'settings-speech'} title="Speech" state={<SpeechState stt={stt} />}>
    <Hearing transcription={settings.transcription} voiceAccountId={settings.dictation.accountId} signedIn={false} stt={stt} save={save} />
  </Section>
}

const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
interface Props {
  settings: SettingsData
  auth: AuthStatus
  claudeAuth: ClaudeAuthStatus
  stt: SttStatus
  /** The part to open at: the one that fixes what the window said was wrong. */
  at?: SettingsPart
  onChange: (settings: SettingsData) => void
  onDone: () => void
  onArchive: () => void
}

/**
 * Settings, in parts: the AI that answers, how the call is heard, when suggestions come, what stays private, the
 * window, and the shortcuts. Each setting is a row, its control on the right; the ones few people change are folded.
 */
export function Settings({ settings, auth, claudeAuth, stt, at, onChange, onDone, onArchive }: Props) {
  const [names, setNames] = useState(settings.assist.names ?? '')
  const hotkeys = useHotkeys()
  const [saveError, setSaveError] = useState('')

  const save = async (patch: SettingsPatch): Promise<void> => {
    setSaveError('')
    try { onChange(await api.updateSettings(patch)) }
    catch (error) { setSaveError(`Could not save settings: ${errorText(error)}`) }
  }

  // Opened to fix something: at the part that does.
  useEffect(() => {
    if (!at) return
    const section = document.getElementById(`settings-${at}`)
    section?.scrollIntoView({ block: 'start' })
    section?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true })
  }, [at])

  const suggest = hotkeys.find((h) => h.id === 'suggest')
  // Its keys, when they work: another app may hold them.
  const suggestKeys = suggest?.ok ? suggest.keys : ''
  const hidden = settings.window.hideFromCapture

  return (
    <div className="settings">
      <div className="settings-content">
      <div className="page-head">
        <button className="icon" title="Back" aria-label="Back" onClick={onDone}>
          <Icon name="back" />
        </button>
        <h2>General settings</h2>
      </div>
      <p className="settings-intro">Accounts, speech and meeting preferences.</p>
      {saveError && <p className="error settings-save-error" role="alert">{saveError}</p>}

      <AISettings settings={settings} save={save} />

      <SpeechSettings settings={settings} save={save} stt={stt} />
      <DictationSettings settings={settings} save={save} />
      <TogleMicrophoneSettings settings={settings} save={save} />

      <VoiceMemorySettings settings={settings} save={save} />
      <Section title="Suggestions">
        <Toggle
          name="Automatic suggestions"
          note={`Helps when you need to reply. ${suggestKeys ? `Press ${suggestKeys} anytime.` : 'Click Suggest reply anytime.'}`}
          checked={settings.assist.auto}
          onChange={(auto) => void save({ assist: { auto } })}
        />
        <details className="more">
          <summary>Group calls</summary>
          <Row name="Your name" note="Used to recognize questions addressed to you.">
            <input
              aria-label="Your name, as people say it"
              value={names}
              placeholder="e.g. Luka, Luke"
              onChange={(e) => setNames(e.target.value)}
              onBlur={() => void save({ assist: { names: names.trim() } })}
            />
          </Row>
        </details>
      </Section>

      <Section title="Privacy">
        {api.platform === 'linux' ? (
          // X11 and Wayland have no way for a window to keep out of captures.
          <Toggle name="Hide from screen sharing" note="Linux can't keep a window out of screenshots and screen shares." checked={false} disabled onChange={() => {}} />
        ) : (
          <Toggle
            name="Hide from screen sharing"
            note={api.platform === 'darwin' ? 'macOS screen sharing can still show Togle. Share a specific app window to keep Togle out of your call.' : hidden ? "Screenshots and screen shares show what's behind Togle." : 'People you share your screen with see Togle.'}
            checked={hidden}
            onChange={(hideFromCapture) => void save({ window: { hideFromCapture } })}
          />
        )}
        <Toggle
          name="Remember calls"
          note="Keep each agent’s calls: transcripts, replies, and summaries encrypted on this PC. The current call also has crash recovery. Audio recordings are not saved."
          checked={settings.assist.rememberCalls !== false}
          onChange={(rememberCalls) => void save({ assist: { rememberCalls } })}
        />
        <Row label={false} name="Calls from removed agents" note="Inspect records kept after deleting an agent."><button className="ghost" onClick={onArchive}>View calls</button></Row>
        <Toggle name="Automatic meeting notes" note="Generate notes after a saved call ends using its AI account. Uses your plan’s allowance and works when agent learning is off." checked={settings.assist.autoNotes !== false} disabled={settings.assist.rememberCalls === false} onChange={autoNotes => void save({ assist: { autoNotes } })} />
      </Section>

      <details className="settings-extra">
        <summary>Window &amp; shortcuts</summary>
        <Section title="Window">
          <Toggle name="Always on top" checked={settings.window.alwaysOnTop} onChange={(alwaysOnTop) => void save({ window: { alwaysOnTop } })} />
          <Row name="Opacity">
            <OpacitySlider value={settings.window.opacity} onChange={(opacity) => void save({ window: { opacity } })} />
          </Row>
        </Section>

        <Section title="Shortcuts" note="They work from any app. Click one to give it other keys.">
          {hotkeys.filter((h) => CALL_SHORTCUTS.includes(h.id)).map((h) => (
            <Shortcut key={h.id} hotkey={h} />
          ))}
          <details className="more">
            <summary>More shortcuts</summary>
            {hotkeys.filter((h) => h.id !== 'dictate' && !CALL_SHORTCUTS.includes(h.id)).map((h) => (
              <Shortcut key={h.id} hotkey={h} />
            ))}
          </details>
        </Section>
      </details>
      <p className="settings-saved">Changes save automatically.</p>
      <details className="settings-extra"><summary>About &amp; licenses</summary>
        <p className="hint">Togle is free and open source, under the MIT license. Togle Microphone is a separate app with its own license.</p>
        <div className="row"><button className="link" onClick={() => api.openExternal('https://github.com/togle-app/togle')}>Source code</button><button className="link" onClick={() => api.openExternal('https://github.com/togle-app/togle/blob/main/LICENSE')}>License</button></div>
      </details>
      </div>
    </div>
  )
}
