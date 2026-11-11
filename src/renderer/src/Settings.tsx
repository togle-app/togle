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
import { TerminalAnswers } from './Tasks'
import { AISettings } from './AISettings'
import { accountLabel, useAccounts } from './Accounts'
import { localModelsFor, PARAKEET_LANGUAGES, SPEECH_LANGUAGES, speechLanguageCode, speechLanguageName } from '@shared/speech'
import { voiceAccountId } from '@shared/dictation'

const api = window.togle

// What turns the call into words, for my voice and theirs alike: this computer's models unless another is picked.
const RECOGNIZERS: { id: Recognizer; label: string }[] = [
  { id: 'local', label: 'On this computer' },
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

const MODEL_NAMES: Record<LocalModelId, string> = {
  parakeet: 'Parakeet',
  'whisper-turbo': 'Whisper large-v3-turbo',
  'whisper-small': 'Whisper small',
  'whisper-base': 'Whisper base'
}
// The Whisper that runs when more than one is installed: the most accurate.
const WHISPERS: LocalModelId[] = ['whisper-turbo', 'whisper-small', 'whisper-base']

/** "574 MB", "1.9 GB". */
const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/**
 * What hears the call's language with these models, in a sentence: which model, on what, and what's behind it
 * (`gpu`: they run on a GPU, or a Mac's own graphics; otherwise on the processor).
 */
/**
 * What works with these models, outcome first (the models' names are under the fold): now, or (`installed` false, the
 * models only chosen) once they're installed.
 */
function speechPlan(language: string, models: LocalModelId[], gpu: boolean, installed = true): string {
  const code = speechLanguageCode(language)
  const whisper = WHISPERS.find((m) => models.includes(m))
  const parakeet = models.includes('parakeet')
  const slow = gpu ? '' : ', a few seconds a sentence'
  const works = installed ? 'Works now' : 'Once installed'
  if (code === 'auto') {
    if (parakeet && whisper) return gpu ? `${works}: every language, quickly.` : `${works}: every language. 25 European languages are quick; the others take a few seconds a sentence.`
    if (parakeet) return `${works}: 25 European languages, quickly. Other languages need one more download.`
    return whisper ? `${works}: every language${slow}.` : ''
  }
  const name = speechLanguageName(code)
  if (parakeet && PARAKEET_LANGUAGES.has(code)) return `${works}: ${name}, quickly.`
  if (whisper) return `${works}: ${name}${slow}.`
  return parakeet ? `${name} needs one more download.` : ''
}

/**
 * Speech recognition on this computer, when a side is heard here: what hears the call's language and on what, what's
 * installed (removing it, or adding what the language needs), an install under way, or installing it. It's downloaded
 * when asked for, not with Togle: Parakeet for its 25 languages, with Whisper behind it, on a GPU always and on a CPU
 * only for the other languages (localModelsFor).
 */
function LocalSpeechPanel({ language }: { language: string }) {
  const [state, setState] = useState<LocalSpeechState | null>(null)
  // What "Choose models" changed, over what suits the language.
  const [whisper, setWhisper] = useState<LocalModelId | 'none' | null>(null)
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
        <span className="name">{installing.here ? `Taking ${installing.what} from this computer` : `Downloading ${installing.what}`}</span>
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
  const gpu = offer?.gpu ?? false
  const offered = (id: LocalModelId) => offer?.models.find((m) => m.id === id)
  // What the call's language needs here, of what this computer can install.
  const needs = localModelsFor(language, gpu).filter((id) => offered(id))
  if (state.installed.length) {
    const missing = needs.filter((id) => !state.installed.includes(id))
    const missingBytes = missing.reduce((sum, id) => sum + (offered(id)?.here ? 0 : offered(id)?.bytes ?? 0), 0)
    // Detecting the language, Whisper is for the languages Parakeet doesn't hear.
    const name = speechLanguageCode(language) === 'auto' ? 'other languages' : speechLanguageName(language)
    return (
      <>
        <p className="hint local-speech-plan">{speechPlan(language, state.installed, gpu)}</p>
        {missing.length > 0 && (
          <Row
            label={false}
            className="local-speech"
            name={speechLanguageCode(language) === 'auto' ? 'Add the other languages' : `Add ${name}`}
            note={
              missing.includes('parakeet') || gpu
                ? 'A one-time download, kept on this computer.'
                : 'A one-time download, kept on this computer. A few seconds a sentence on this processor.'
            }
          >
            <button className="ghost" onClick={() => void install(missing)}>
              {missingBytes ? `Add (${size(missingBytes)})` : 'Add'}
            </button>
          </Row>
        )}
        <details className="more local-speech">
          <summary>Speech models</summary>
          <Row
            label={false}
            className="local-speech"
            name="On this computer"
            note={`${[...state.installed]
              .sort((a, b) => Number(b === 'parakeet') - Number(a === 'parakeet'))
              .map((m) => MODEL_NAMES[m])
              .join(' and ')}, on ${gpu ? 'the graphics' : 'the processor'}.`}
          >
            <button className="link" onClick={() => void api.removeLocalSpeech()}>
              Remove
            </button>
          </Row>
        </details>
        {failed}
      </>
    )
  }
  if (!offer) return <p className="error">There's no speech recognition to install for this system: pick OpenAI or a speech server above.</p>
  const parakeetModel = offered('parakeet')
  const whispers = offer.models.filter((m) => m.id !== 'parakeet')
  const withParakeet = !!parakeetModel && (parakeet ?? needs.includes('parakeet'))
  const recommendedWhisper = whispers.find((m) => m.recommended)?.id ?? whispers[0]?.id
  let pickedWhisper: LocalModelId | 'none' = whisper ?? needs.find((id) => id !== 'parakeet') ?? 'none'
  // Without Parakeet, a Whisper is needed after all.
  if (pickedWhisper === 'none' && !withParakeet) pickedWhisper = recommendedWhisper ?? 'none'
  const chosen: LocalModelId[] = [...(pickedWhisper !== 'none' ? [pickedWhisper] : []), ...(withParakeet ? (['parakeet'] as const) : [])]
  // What's on this computer already isn't downloaded: it's taken from where it is.
  const total = offer.engine + offer.models.filter((m) => chosen.includes(m.id) && !m.here).reduce((sum, m) => sum + m.bytes, 0)
  const sized = (m: { bytes: number; here?: boolean }): string => (m.here ? 'on this computer' : size(m.bytes))
  return (
    <>
      {chosen.length > 0 && <p className="hint local-speech-plan">{speechPlan(language, chosen, gpu, false)}</p>}
      {!chosen.length ? (
        <p className="error">Choose a model below.</p>
      ) : total ? (
        <Row
          label={false}
          className="local-speech"
          name="Not installed yet"
          note={offer.models.some((m) => chosen.includes(m.id) && m.here) ? 'Some of it is on this computer already; the rest is a one-time download.' : 'A one-time download, kept on this computer.'}
        >
          <button className="primary" onClick={() => void install(chosen)}>
            Install ({size(total)})
          </button>
        </Row>
      ) : (
        <Row label={false} className="local-speech" name="Already on this computer" note={`${chosen.map((m) => MODEL_NAMES[m]).join(' and ')}: nothing to download.`}>
          <button className="primary" onClick={() => void install(chosen)}>
            Use them
          </button>
        </Row>
      )}
      <details className="more local-speech">
        <summary>Choose models</summary>
        {parakeetModel && (
          <Toggle name="Parakeet" note={`Hears 25 European languages, quickly (${sized(parakeetModel)}).`} checked={withParakeet} onChange={setParakeet} />
        )}
        <Row stacked name="Whisper">
          <select value={pickedWhisper} onChange={(e) => setWhisper(e.target.value as LocalModelId | 'none')}>
            {withParakeet && <option value="none">None: Parakeet alone</option>}
            {whispers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({sized(m)}){m.recommended ? (gpu ? ', for this graphics card' : ', for this processor') : ''}
              </option>
            ))}
          </select>
        </Row>
      </details>
      {failed}
    </>
  )
}

/** The speech APIs that take a key of their own. */
type KeyedApi = Exclude<SpeechApiId, 'chatgpt' | 'claude'>

interface HearingProps {
  /** The settings in force here (an agent's own, in its settings): what hears calls, and voice typing's account. */
  settings: SettingsData
  stt: SttStatus
  save: (patch: SettingsPatch) => Promise<void>
}

/**
 * Speech recognition's settings: the calls' language, what hears each side of the call, and what the one picked needs
 * (this computer's, installing; OpenAI's, a key and its model; another server's, its address and model, and a key if it
 * takes one); then what keeps it from hearing, if anything. Voice typing's account is voice typing's, in its section.
 */
function Hearing({ settings, stt, save }: HearingProps) {
  const t = settings.transcription
  const accounts = useAccounts()
  const typingAccount = accounts.accounts.find(account => account.id === voiceAccountId(settings, accounts.accounts))
  const [hasKey, setHasKey] = useState<Record<KeyedApi, boolean>>({ openai: false, server: false })
  const [keys, setKeys] = useState<Record<KeyedApi, string>>({ openai: '', server: '' })
  const [openaiModel, setOpenaiModel] = useState(t.openaiModel)
  const [serverUrl, setServerUrl] = useState(t.serverUrl)
  const [serverModel, setServerModel] = useState(t.serverModel)
  useEffect(() => {
    void Promise.all([api.hasSpeechKey('openai'), api.hasSpeechKey('server')]).then(([openai, server]) => setHasKey({ openai, server }))
  }, [])
  const uses = (id: SpeechApiId): boolean => t.me === id || t.them === id
  // No sign-in includes transcription (not ChatGPT's, not Claude's): this computer hears calls unless a speech API is picked.
  const sourceFor = (source: Recognizer): Recognizer => source === 'chatgpt' ? 'local' : source
  const mixedSources = sourceFor(t.me) !== sourceFor(t.them)
  const customCalls = mixedSources || sourceFor(t.me) !== 'local'
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
      {/* One line per job: where each is heard, and what cleans up voice typing (its account is in Voice typing). */}
      <ul className="speech-summary" role="status">
        <li><strong>Calls</strong> {customCalls ? `heard by ${mixedSources ? 'different services for each side' : RECOGNIZERS.find(source => source.id === sourceFor(t.me))?.label}` : 'heard on this computer, privately'}</li>
        <li><strong>Voice typing</strong> heard on this computer{settings.dictation.polish && typingAccount ? `, cleaned up by ${accountLabel(typingAccount)}` : ''}</li>
      </ul>
      <Row stacked name="Language" note="Automatic also handles language changes.">
        <select aria-label="Speech language" value={t.language} onChange={event => void save({ transcription: { language: event.target.value } })}>
          {SPEECH_LANGUAGES.map(([code, name]) => <option key={code} value={code}>{code === 'auto' ? 'Automatic' : name}</option>)}
        </select>
      </Row>
      {stt.callId && stt.transcriptionLanguage && stt.transcriptionLanguage !== t.language && <p className="hint speech-current-call">The current call keeps its original language. Changes apply to new recordings and calls.</p>}
      {/* Which model on this computer hears the language, and on what: right under the language, not in Advanced. */}
      {(t.me === 'local' || t.them === 'local') && <LocalSpeechPanel language={t.language} />}
      {customCalls && <div className="speech-exceptions" role="status">
        <span>Calls use {mixedSources ? 'different sources for each side' : RECOGNIZERS.find(source => source.id === sourceFor(t.me))?.label}.</span>
        <button className="link" onClick={() => void save({ transcription: { me: 'local', them: 'local' } })}>Undo</button>
      </div>}
      <details className="more speech-advanced" open={advanced} onToggle={event => setAdvanced(event.currentTarget.open)}><summary>Advanced speech settings</summary>
      <Row stacked name="Call transcription" note="Change only if you want calls heard by a speech API instead of this computer.">
        <select aria-label="Meeting speech recognition" value={mixedSources ? 'mixed' : sourceFor(t.me)} onChange={event => {
          const source = event.target.value as Recognizer
          void save({ transcription: { me: source, them: source } })
        }}>{mixedSources && <option value="mixed" disabled>Different sources for each side</option>}{RECOGNIZERS.map(source => <option key={source.id} value={source.id}>{source.label}</option>)}</select>
      </Row>
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
          <Row stacked name="Speech server" note="Any server with OpenAI's speech API: speaches, LocalAI or vLLM on this computer, or a service such as Groq.">
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
          {keyField('server', 'Its API key', 'Not needed for most servers on this computer')}
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

// The page's parts, a click away from its top: it's long (several screens in a narrow window), and the part you came
// for is often far down.
const PARTS: [id: string, label: string][] = [
  ['settings-ai', 'AI'],
  ['settings-calls', 'During calls'],
  ['settings-speech', 'Speech'],
  ['settings-dictation', 'Voice typing'],
  ['settings-privacy', 'Privacy'],
  ['settings-speakers', 'Speakers'],
  ['settings-microphone', 'Togle Studio'],
  ['settings-agents', 'Coding agents'],
  ['settings-window', 'Window & shortcuts']
]

/** Where the to-do list's file is, and a way to see it. */
function TodoFileRow() {
  const [file, setFile] = useState('')
  useEffect(() => {
    void api.todoList().then((list) => setFile(list.file), () => undefined)
  }, [])
  return (
    <Row label={false} name="To-do list" note={file ? <code>{file}</code> : 'A plain text file on this computer.'}>
      <button className="ghost" onClick={() => void api.showTodoFile()}>Show the file</button>
    </Row>
  )
}

/** Goes to a part of the page (unfolding it, if it's folded), its heading ready for the keyboard. */
function jumpTo(id: string): void {
  const target = document.getElementById(id)
  if (target instanceof HTMLDetailsElement) target.open = true
  target?.scrollIntoView({ block: 'start' })
  target?.querySelector<HTMLElement>('h3, summary')?.focus({ preventScroll: true })
}

export function SpeechSettings({ settings, save, stt, agent = false }: { settings: SettingsData; save: (patch: SettingsPatch) => Promise<void>; stt: SttStatus; agent?: boolean }) {
  return <Section id={agent ? 'agent-speech' : 'settings-speech'} title="Speech" state={<SpeechState stt={stt} />}>
    <Hearing settings={settings} stt={stt} save={save} />
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

  // Opened to fix something: at the part that does (asked for your name, at its field, ready to type).
  useEffect(() => {
    if (!at) return
    const target = document.getElementById(`settings-${at}`)
    target?.scrollIntoView({ block: at === 'name' ? 'center' : 'start' })
    ;(at === 'name' ? target : target?.querySelector<HTMLElement>('h3'))?.focus({ preventScroll: true })
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
        <h2>App settings</h2>
      </div>
      <p className="settings-intro">For every agent. An agent can change some of these for its own calls, in its settings.</p>
      <nav className="settings-jump" aria-label="Settings sections">
        {PARTS.map(([id, label]) => <button key={id} type="button" className="link" onClick={() => jumpTo(id)}>{label}</button>)}
      </nav>
      {saveError && <p className="error settings-save-error" role="alert">{saveError}</p>}

      <AISettings settings={settings} save={save} />

      <Section id="settings-calls" title="During calls">
        <Toggle
          name="Automatic suggestions"
          note={`A suggestion when you need to reply. ${suggestKeys ? `Press ${suggestKeys} anytime for one.` : 'Click Suggest reply anytime for one.'}`}
          checked={settings.assist.auto}
          onChange={(auto) => void save({ assist: { auto } })}
        />
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
        <Row name="Your name" note="In a group call, Togle suggests when someone says it.">
          <input
            id="settings-name"
            aria-label="Your name, as people say it"
            value={names}
            placeholder="e.g. Luka, Luke"
            onChange={(e) => setNames(e.target.value)}
            onBlur={() => void save({ assist: { names: names.trim() } })}
          />
        </Row>
        <Toggle name="Automatic meeting notes" note={settings.assist.rememberCalls === false ? 'Needs Remember calls, under Privacy and history.' : 'Written after a saved call ends, with the agent’s AI account. Uses your plan’s allowance.'} checked={settings.assist.autoNotes !== false} disabled={settings.assist.rememberCalls === false} onChange={autoNotes => void save({ assist: { autoNotes } })} />
      </Section>

      <SpeechSettings settings={settings} save={save} stt={stt} />
      <DictationSettings settings={settings} save={save} />

      <Section id="settings-privacy" title="Privacy and history">
        <Toggle
          name="Remember calls"
          note="Keep each agent’s calls (transcripts, suggestions and notes), encrypted on this computer. The current call also survives a crash. Audio is never saved."
          checked={settings.assist.rememberCalls !== false}
          onChange={(rememberCalls) => void save({ assist: { rememberCalls } })}
        />
        <Row label={false} name="Calls from removed agents" note="Calls kept after you deleted their agent."><button className="ghost" onClick={onArchive}>View calls</button></Row>
      </Section>

      <VoiceMemorySettings settings={settings} save={save} />
      <TogleMicrophoneSettings settings={settings} save={save} />

      <Section id="settings-agents" title="Coding agents" note="Claude Code, Codex and Hermes on this computer. Tasks and To-do are in the sidebar.">
        <Toggle
          name="Notice when a task waits"
          note="A small notice in the corner of the screen when a task waits for you and Togle is not in front. The dot on the tray stays either way."
          checked={settings.tasks.notices}
          onChange={(notices) => void save({ tasks: { notices } })}
        />
        <Toggle
          name="Notice when a task finishes"
          note="Shown for a few seconds, when the notice above is on."
          checked={settings.tasks.finished}
          disabled={!settings.tasks.notices}
          onChange={(finished) => void save({ tasks: { finished } })}
        />
        {hotkeys.filter((h) => h.id === 'task').map((h) => (
          <Shortcut key={h.id} hotkey={h} />
        ))}
        <Row label={false} name="Claude Code in a terminal" note="Answer its questions from here too."><TerminalAnswers compact /></Row>
        <TodoFileRow />
      </Section>

      <details className="settings-extra" id="settings-window">
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
            {hotkeys.filter((h) => h.id !== 'dictate' && h.id !== 'task' && !CALL_SHORTCUTS.includes(h.id)).map((h) => (
              <Shortcut key={h.id} hotkey={h} />
            ))}
          </details>
        </Section>
      </details>
      <p className="settings-saved">Changes save automatically.</p>
      <details className="settings-extra"><summary>About &amp; licenses</summary>
        <p className="hint">Togle is free and open source, under the MIT license. Togle Studio is a separate app with its own license.</p>
        <div className="row"><button className="link" onClick={() => api.openExternal('https://github.com/togle-app/togle')}>Source code</button><button className="link" onClick={() => api.openExternal('https://github.com/togle-app/togle/blob/main/LICENSE')}>License</button></div>
      </details>
      </div>
    </div>
  )
}
