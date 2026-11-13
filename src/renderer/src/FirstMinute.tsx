import { useEffect, useState } from 'react'
import type { LocalSpeechState, Settings, SttStatus } from '@shared/types'
import type { RunnerStatus, TaskView } from '@shared/runner'
import { localModelsFor } from '@shared/speech'
import { useAccounts } from './Accounts'
import { useHotkeys } from './hotkeys'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** "574 MB", "1.9 GB". */
const size = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`)

/** What a step not done becomes on the to-do list, on day one. */
export const DAY_ONE = {
  talk: 'Hold F9 and say something: Togle types it where your cursor is',
  plan: 'Sign in with your AI plan in Settings, so Togle cleans up what you say and writes your meeting notes'
} as const

interface Props {
  settings: Settings
  stt: SttStatus
  onDone: () => void
}

/**
 * The first minute, once: Togle works before anything is set up. Talk (speech recognition comes down once, then F9
 * types what you say, offline), sign in with your plan or skip it, and what Togle found on this computer. What was not
 * done goes on the to-do list.
 */
export function FirstMinute({ settings, stt, onDone }: Props) {
  const talkKey = useHotkeys().find((key) => key.id === 'dictate')?.keys || 'F9'
  const [heard, setHeard] = useState('')
  const [draft, setDraft] = useState('')
  const [skipped, setSkipped] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const { accounts } = useAccounts()
  const chatgpt = accounts.find((account) => account.id === 'chatgpt-default') ?? accounts.find((account) => account.provider === 'chatgpt')
  // The plan is ChatGPT's: a Claude Code sign-in on this computer is that app's, not Togle's.
  const signedIn = !!chatgpt?.signedIn
  const [signInError, setSignInError] = useState('')

  // A dictation that finished with words: it works.
  useEffect(() => {
    void api.dictationStatus().then((state) => { if (state.lastText) setHeard(state.lastText) }, () => undefined)
    return api.onDictation((state) => { if ((state.phase === 'done' || state.phase === 'ready') && state.lastText) setHeard(state.lastText) })
  }, [])

  const finish = async (): Promise<void> => {
    if (finishing) return
    setFinishing(true)
    // On day one, the steps not done yet sit on the to-do list.
    const left = [...(heard ? [] : [DAY_ONE.talk]), ...(signedIn ? [] : [DAY_ONE.plan])]
    for (const text of left) await api.addTodo(text).catch(() => undefined)
    onDone()
  }

  return (
    <section className="first-minute" aria-label="The first minute">
      <header>
        <h2>Togle works before you set anything up</h2>
        <p className="hint">One sign-in turns on the parts that need AI. The steps you have not done yet sit on your to-do list.</p>
      </header>

      <ol className="first-steps">
        <li className={`first-step ${heard ? 'done' : ''}`} aria-label="Talk">
          <h3>Talk</h3>
          {stt.state === 'missing' ? <SpeechDownload language={settings.transcription.language} />
            : <p>Hold <kbd>{talkKey}</kbd> and say something. Your words appear where your cursor is. This works offline.</p>}
          <textarea aria-label="Try it here" rows={2} placeholder={`Click here, then hold ${talkKey} and talk`} value={draft} disabled={stt.state === 'missing'} onChange={(event) => setDraft(event.target.value)} />
          {heard && <p className="first-ok" role="status">It works. Heard: “{heard}”</p>}
        </li>

        <li className={`first-step ${signedIn ? 'done' : ''}`} aria-label="Sign in with your plan">
          <h3>Sign in with your plan</h3>
          <p>One click opens ChatGPT in your browser. From then on Togle cleans up what you say and writes your meeting notes.</p>
          <dl className="first-example">
            <div><dt>As heard</dt><dd>send it to dario no wait to marta by friday</dd></div>
            <div><dt>With your plan</dt><dd>Send it to Marta by Friday.</dd></div>
          </dl>
          {signedIn ? <p className="first-ok" role="status">Signed in. What Togle uses counts toward your plan's limit.</p>
            : chatgpt?.signingIn || chatgpt?.pending ? <p className="hint" role="status">Finish signing in in your browser.</p>
              : skipped ? <p className="hint">Skipped. It waits on your to-do list.</p>
                : (
                  <div className="row">
                    <button className="primary" disabled={!chatgpt} onClick={() => {
                      setSignInError('')
                      void api.updateSettings({ ai: null, provider: 'chatgpt', subscriptionAccountId: '' })
                        .then(() => api.signInAccount(chatgpt!.id))
                        .catch((failure) => setSignInError(errorText(failure)))
                    }}>Sign in with ChatGPT</button>
                    <button className="ghost" onClick={() => setSkipped(true)}>Skip</button>
                  </div>
                )}
          {signInError && <p className="error" role="alert">{signInError}</p>}
        </li>

        <li className="first-step" aria-label="Togle finds the rest">
          <h3>Togle finds the rest</h3>
          <Found />
          {(api.platform === 'win32' || api.platform === 'linux' || api.platform === 'darwin') && <p className="hint">When a call starts in Zoom, Meet or Teams, Togle offers to write it down. After your first yes, it can do that by itself in that app.</p>}
        </li>
      </ol>

      <div className="row first-done"><button className="primary" disabled={finishing} onClick={() => void finish()}>Done</button></div>
    </section>
  )
}

/** Speech recognition, before it is on this computer: what it is, its size, and the one click that gets it. */
function SpeechDownload({ language }: { language: string }) {
  const [state, setState] = useState<LocalSpeechState | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.localSpeech().then(setState, () => undefined)
    return api.onLocalSpeech(setState)
  }, [])
  if (!state) return <p className="hint">Looking at this computer…</p>
  if (state.installing) {
    return (
      <div className="first-download" role="status">
        <span>{state.installing.here ? `Taking ${state.installing.what} from this computer` : `Getting ${state.installing.what}: ${size(state.installing.received)} of ${size(state.installing.total)}`}</span>
        <progress value={state.installing.received} max={state.installing.total || 1} />
        <button className="ghost small" onClick={() => void api.cancelLocalSpeech()}>Stop</button>
      </div>
    )
  }
  const offer = state.offer
  if (!offer) return <p className="error">There's no speech recognition to install for this system.</p>
  const models = localModelsFor(language, offer.gpu).filter((id) => offer.models.some((model) => model.id === id))
  const total = offer.engine + offer.models.filter((model) => models.includes(model.id) && !model.here).reduce((sum, model) => sum + model.bytes, 0)
  return (
    <>
      <p>Togle hears speech on this computer, so it needs speech recognition here first. It is one download, and then everything works offline.</p>
      <div className="row">
        <button className="primary" onClick={() => { setError(''); void api.installLocalSpeech(models).catch((failure) => { if (!/Stopped/.test(errorText(failure))) setError(errorText(failure)) }) }}>Get speech recognition ({size(total)})</button>
      </div>
      {(error || state.error) && <p className="error" role="alert">{error || state.error}</p>}
    </>
  )
}

/** The coding agents on this computer, and how many tasks each has. */
function Found() {
  const [found, setFound] = useState<{ agents: RunnerStatus[]; tasks: TaskView[] } | null>(null)
  useEffect(() => {
    let current = true
    void Promise.all([api.runnerStatus(), api.runnerTasks()]).then(([agents, tasks]) => { if (current) setFound({ agents, tasks }) }, () => { if (current) setFound({ agents: [], tasks: [] }) })
    return () => { current = false }
  }, [])
  if (!found) return <p className="hint">Looking at this computer…</p>
  const installed = found.agents.filter((agent) => agent.installed)
  if (!installed.length) return <p>No coding agent on this computer yet. When you install Claude Code, Codex or Hermes, Togle finds it and lists its tasks under Agents.</p>
  return (
    <div className="first-found-list">
      <span className="hint">Found on this computer</span>
      <ul className="first-found" aria-label="Found on this computer">
        {installed.map((agent) => {
          const count = found.tasks.filter((task) => task.runner === agent.runner).length
          return <li key={agent.runner}><span className="av" aria-hidden="true">{agent.runner === 'codex' ? 'X' : agent.name.charAt(0).toUpperCase()}</span><strong>{agent.name}</strong><span>{count === 1 ? '1 task' : `${count} tasks`}</span></li>
        })}
      </ul>
    </div>
  )
}
