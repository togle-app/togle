import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import type { RunnerKind, RunnerStatus } from '@shared/runner'
import { useHotkeys } from './hotkeys'

const api = window.togle

const STORE = 'togle.taskbox'
interface Choice {
  runner?: RunnerKind
  folder?: string
}
// What was picked last, for the next time the box opens: kept in the page, which stays while the box is put away.
const remembered = (): Choice => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Choice
    return { runner: stored.runner, folder: typeof stored.folder === 'string' ? stored.folder : undefined }
  } catch {
    return {}
  }
}
const remember = (choice: Choice): void => {
  try {
    localStorage.setItem(STORE, JSON.stringify(choice))
  } catch {
    // Not kept: it asks again next time.
  }
}

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder
const parentName = (folder: string): string => baseName(folder.replace(/[\\/]+$/, '').split(/[\\/]/).slice(0, -1).join('/'))

/** The box over whatever is on screen, to start a coding agent's task: the agent, the folder, and the words. */
export function TaskBox() {
  const [installed, setInstalled] = useState<RunnerStatus[]>([])
  const [folders, setFolders] = useState<string[]>([])
  const [runner, setRunner] = useState<RunnerKind | undefined>(() => remembered().runner)
  const [folder, setFolder] = useState(() => remembered().folder ?? '')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const input = useRef<HTMLTextAreaElement>(null)
  const dictate = useHotkeys().find((key) => key.id === 'dictate')

  const load = useCallback(async () => {
    try {
      const [found, tasks] = await Promise.all([api.runnerStatus(), api.runnerTasks()])
      const here = (Array.isArray(found) ? found : []).filter((status) => status.installed)
      setInstalled(here)
      setFolders([...new Set((Array.isArray(tasks) ? tasks : []).map((task) => task.folder).filter(Boolean))].slice(0, 6))
      // The agent last used if it is still there, else the first one.
      setRunner((current) => (current && here.some((status) => status.runner === current) ? current : here[0]?.runner))
    } catch {
      // The Tasks screen says what is wrong with the agents.
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void load()
    return api.onTaskBoxShown(() => {
      void load()
      setError('')
      input.current?.focus()
    })
  }, [load])

  // The folder last used, else the one a task was most recently in.
  useEffect(() => {
    if (!folder && folders[0]) setFolder(folders[0])
  }, [folder, folders])

  const options = folder && !folders.includes(folder) ? [folder, ...folders] : folders
  const label = (path: string): string => (options.filter((other) => baseName(other) === baseName(path)).length > 1 ? `${baseName(path)} (in ${parentName(path)})` : baseName(path))

  const start = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault()
    const prompt = text.trim()
    if (busy || !runner || !folder || !prompt) return
    setBusy(true)
    setError('')
    try {
      await api.startRunnerTask({ runner, folder, prompt })
      remember({ runner, folder })
      setText('')
      api.closeTaskBox()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }

  const choose = async (): Promise<void> => {
    try {
      const picked = await api.pickTaskBoxFolder()
      if (picked) setFolder(picked)
    } catch (caught) {
      setError(errorText(caught))
    }
    input.current?.focus()
  }

  return (
    <form className="taskbox" onSubmit={(event) => void start(event)} onKeyDown={(event) => event.key === 'Escape' && api.closeTaskBox()} aria-label="Start a task">
      {loaded && !installed.length ? (
        <p className="taskbox-none">No coding agent found. Install Claude Code, Codex or Hermes, and Togle finds it.</p>
      ) : (
        <>
          <div className="taskbox-row">
            <div className="taskbox-agents" role="radiogroup" aria-label="Agent">
              {installed.map((status) => (
                <button key={status.runner} type="button" role="radio" aria-checked={runner === status.runner} className={runner === status.runner ? 'on' : ''} onClick={() => setRunner(status.runner)}>
                  {status.name}
                </button>
              ))}
            </div>
            <div className="taskbox-folder">
              <select aria-label="Folder" value={folder} onChange={(event) => setFolder(event.target.value)}>
                {!options.length && <option value="">No folder yet</option>}
                {options.map((path) => (
                  <option key={path} value={path} title={path}>
                    {label(path)}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => void choose()}>
                Choose…
              </button>
            </div>
          </div>
          <textarea
            ref={input}
            aria-label="Task"
            placeholder={`Say what to do. Hold ${dictate?.ok && dictate.keys ? dictate.keys : 'F9'} to say it, then press Enter.`}
            rows={4}
            autoFocus
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) void start(event)
            }}
          />
          {error && (
            <p className="taskbox-error" role="alert">
              {error}
            </p>
          )}
          <div className="taskbox-foot">
            <span>{runner === 'hermes' ? 'Hermes asks before a command only when its own settings say so.' : 'It asks before every command and every change.'} Enter starts. Esc closes.</span>
            <button className="primary" disabled={busy || !runner || !folder || !text.trim()}>
              {busy ? 'Starting…' : 'Start'}
            </button>
          </div>
        </>
      )}
    </form>
  )
}
