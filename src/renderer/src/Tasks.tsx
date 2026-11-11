import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { LogEntry, RunnerKind, RunnerStatus, TaskDetail, TaskView, ViewRequest } from '@shared/runner'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

const api = window.togle

const NAMES: Record<RunnerKind, string> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }
const STATE_WORDS: Record<TaskView['state'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Done', stopped: 'Stopped', failed: 'Stopped by an error' }
// How often the list is asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000
// The first this many earlier tasks show; the rest come with "Show all".
const EARLIER_SHOWN = 8
// The task looked at last, for when the screen is opened again.
let remembered: string | undefined

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

function ago(at: number, now: number): string {
  if (!at) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

const isDetail = (value: unknown): value is TaskDetail => typeof value === 'object' && value !== null && 'task' in value && 'log' in value

export function Tasks() {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [status, setStatus] = useState<RunnerStatus[]>([])
  const [selected, setSelected] = useState<string | undefined>(remembered)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [showAll, setShowAll] = useState(false)
  const selectedNow = useRef(selected)
  selectedNow.current = selected

  const refresh = useCallback(async () => {
    try {
      const [list, found] = await Promise.all([api.runnerTasks(), api.runnerStatus()])
      setTasks(Array.isArray(list) ? list : [])
      setStatus(Array.isArray(found) ? found : [])
      const key = selectedNow.current
      if (key) {
        const next: unknown = await api.runnerDetail(key).catch(() => null)
        setDetail(isDetail(next) && next.task.key === key ? next : null)
      } else setDetail(null)
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setNow(Date.now())
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const off = api.onRunnersChanged(() => void refresh())
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [refresh])

  useEffect(() => {
    remembered = selected
    void refresh()
  }, [selected, refresh])

  /** Does something for the person, and shows what went wrong in plain words. */
  const act = useCallback(
    async (work: () => Promise<unknown>): Promise<void> => {
      setError('')
      try {
        await work()
      } catch (caught) {
        setError(errorText(caught))
      } finally {
        void refresh()
      }
    },
    [refresh]
  )

  const installed = status.filter((s) => s.installed)
  const waiting = tasks.filter((t) => t.state === 'waiting')
  const working = tasks.filter((t) => t.state === 'working')
  const earlier = tasks.filter((t) => t.state !== 'waiting' && t.state !== 'working')
  const folders = [...new Set(tasks.map((t) => t.folder).filter(Boolean))].slice(0, 5)
  const row = (task: TaskView): ReactNode => (
    <TaskRow
      key={task.key}
      task={task}
      now={now}
      selected={task.key === selected && !starting}
      onSelect={() => {
        setStarting(false)
        setSelected(task.key)
      }}
    />
  )

  return (
    <div className={`tasks ${selected || starting ? 'has-detail' : ''}`} aria-label="Tasks">
      <aside className="tasks-list" aria-label="Agent tasks on this computer">
        <div className="tasks-head">
          <span className="tasks-label">This computer</span>
          <button className="primary small" disabled={!installed.length} onClick={() => setStarting(true)}>
            New task
          </button>
        </div>
        {loaded && !installed.length && <p className="empty">No coding agent found. Install Claude Code or Codex and Togle finds it.</p>}
        {!!waiting.length && <TaskGroup label="Waiting for you">{waiting.map(row)}</TaskGroup>}
        {!!working.length && <TaskGroup label="Working">{working.map(row)}</TaskGroup>}
        {!!earlier.length && (
          <TaskGroup label={`Earlier · ${earlier.length} task${earlier.length === 1 ? '' : 's'}`}>
            {(showAll ? earlier : earlier.slice(0, EARLIER_SHOWN)).map(row)}
            {earlier.length > EARLIER_SHOWN && (
              <button className="link" onClick={() => setShowAll(!showAll)}>
                {showAll ? 'Show fewer' : `Show all ${earlier.length}`}
              </button>
            )}
          </TaskGroup>
        )}
        {loaded && !!installed.length && !tasks.length && <p className="empty">No tasks yet. Start one, or let an agent run in a terminal and it shows here.</p>}
        {!!installed.length && <p className="hint tasks-found">Found: {installed.map((s) => s.name).join(', ')}</p>}
      </aside>
      <section className="tasks-detail">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {starting ? (
          <NewTask
            installed={installed}
            folders={folders}
            onCancel={() => setStarting(false)}
            onStart={(request) =>
              act(async () => {
                const view = await api.startRunnerTask(request)
                setStarting(false)
                setSelected(view.key)
              })
            }
          />
        ) : detail ? (
          <TaskPanel
            key={detail.task.key}
            detail={detail}
            now={now}
            onBack={() => setSelected(undefined)}
            onAnswer={(requestId, decision) => act(() => api.answerRunnerTask(detail.task.key, requestId, decision))}
            onReply={(requestId, text) => act(() => api.replyRunnerTask(detail.task.key, requestId, text))}
            onSend={(text) => act(() => api.sendToRunnerTask(detail.task.key, text))}
            onStop={() => act(() => api.stopRunnerTask(detail.task.key))}
            onEndCommands={() => act(() => api.endRunnerCommands(detail.task.key))}
            onOpen={() => act(() => api.openRunnerTask(detail.task.key))}
            onTakeOver={() => act(() => api.takeOverRunnerTask(detail.task.key))}
            onClose={() => act(() => api.closeRunnerTask(detail.task.key))}
          />
        ) : (
          <div className="tasks-empty">
            <p>Pick a task, or start a new one.</p>
            <p className="hint">Every row says what the agent is doing. A command it wants to run waits here for you.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function TaskGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="task-group">
      <h3 className="tasks-label">{label}</h3>
      <div role="list">{children}</div>
    </div>
  )
}

function TaskRow({ task, now, selected, onSelect }: { task: TaskView; now: number; selected: boolean; onSelect: () => void }) {
  const detail = task.line || (task.state === 'waiting' || task.state === 'working' ? STATE_WORDS[task.state] : ago(task.updatedAt, now))
  const dangerous = task.pending.some((request) => request.danger)
  return (
    <button className={`task-row ${selected ? 'selected' : ''}`} role="listitem" data-state={task.state} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <span className="task-dot" aria-hidden="true" />
      <span className="task-copy">
        <strong>{task.title}</strong>
        <span>
          {NAMES[task.runner]} · {baseName(task.folder)} · {detail}
        </span>
      </span>
      {dangerous && <span className="task-danger">Dangerous</span>}
    </button>
  )
}

function NewTask({ installed, folders, onCancel, onStart }: { installed: RunnerStatus[]; folders: string[]; onCancel: () => void; onStart: (request: { runner: RunnerKind; folder: string; prompt: string }) => Promise<void> }) {
  const [runner, setRunner] = useState<RunnerKind>(installed[0]?.runner ?? 'claude')
  const [folder, setFolder] = useState(folders[0] ?? '')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (busy || !folder.trim() || !prompt.trim()) return
    setBusy(true)
    try {
      await onStart({ runner, folder: folder.trim(), prompt })
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="task-new" onSubmit={(event) => void submit(event)} aria-label="New task">
      <h2>New task</h2>
      <fieldset className="task-new-agents">
        <legend>Agent</legend>
        {installed.map((s) => (
          <label key={s.runner} className={runner === s.runner ? 'on' : ''}>
            <input type="radio" name="agent" value={s.runner} checked={runner === s.runner} onChange={() => setRunner(s.runner)} />
            {s.name}
          </label>
        ))}
      </fieldset>
      <label className="task-new-field">
        <span>Folder</span>
        <span className="task-new-folder">
          <input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="The folder it works in" aria-label="Folder" />
          <button type="button" onClick={() => void api.pickRunnerFolder().then((picked) => picked && setFolder(picked))}>
            Choose…
          </button>
        </span>
      </label>
      {folders.length > 0 && (
        <div className="chips" aria-label="Recent folders">
          {folders.map((recent) => (
            <button key={recent} type="button" className={`chip ${recent === folder ? 'on' : ''}`} onClick={() => setFolder(recent)} title={recent}>
              {baseName(recent)}
            </button>
          ))}
        </div>
      )}
      <label className="task-new-field">
        <span>Task</span>
        <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={4} placeholder="Say what it should do" aria-label="Task" autoFocus />
      </label>
      <p className="hint">Every command and every change asks you first.</p>
      <div className="row">
        <button className="primary" disabled={busy || !folder.trim() || !prompt.trim()}>
          {busy ? 'Starting…' : 'Start'}
        </button>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

interface PanelProps {
  detail: TaskDetail
  now: number
  onBack: () => void
  onAnswer: (requestId: string, decision: 'allow-once' | 'refuse') => void
  onReply: (requestId: string, text: string) => void
  onSend: (text: string) => void
  onStop: () => void
  onEndCommands: () => void
  onOpen: () => void
  onTakeOver: () => void
  onClose: () => void
}

function TaskPanel({ detail, now, onBack, onAnswer, onReply, onSend, onStop, onEndCommands, onOpen, onTakeOver, onClose }: PanelProps) {
  const { task, log } = detail
  const [text, setText] = useState('')
  const [confirmTakeOver, setConfirmTakeOver] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [log.length, task.pending.length])
  const running = task.state === 'working' || task.state === 'waiting'
  const send = (event: FormEvent): void => {
    event.preventDefault()
    const message = text.trim()
    if (!message) return
    onSend(message)
    setText('')
  }
  return (
    <div className="task-panel">
      <header className="task-header">
        <button className="ghost small tasks-back" onClick={onBack} aria-label="Back to the list">
          <Icon name="back" size={14} />
        </button>
        <div className="task-title">
          <h2 title={task.title}>{task.title}</h2>
          <p>
            {NAMES[task.runner]} · {task.folder || 'No folder'} · <span className="task-state" data-state={task.state}>{STATE_WORDS[task.state]}</span>
            {task.updatedAt && !running ? ` · ${ago(task.updatedAt, now)}` : ''}
          </p>
        </div>
        <div className="task-actions">
          {task.mine && running && (
            <button className="small primary stop" onClick={onStop}>
              <Icon name="stop" size={12} /> Stop
            </button>
          )}
          {task.mine && task.commandsRunning && task.state === 'stopped' && (
            <button className="small" onClick={onEndCommands} title="Stop ended the agent's turn. The command it started is still running.">
              End the running command
            </button>
          )}
          {task.mine && !running && (
            <button className="ghost small" onClick={onClose} title="Togle stops running it. It stays on this computer.">
              Let go
            </button>
          )}
        </div>
      </header>

      {!task.mine && (
        <div className="task-banner" role="note">
          {task.pid ? (
            confirmTakeOver ? (
              <>
                <span>This ends the {NAMES[task.runner]} running in its terminal. The conversation is kept and goes on here.</span>
                <span className="row">
                  <button className="primary small" onClick={onTakeOver}>
                    End it and take over
                  </button>
                  <button className="ghost small" onClick={() => setConfirmTakeOver(false)}>
                    Cancel
                  </button>
                </span>
              </>
            ) : (
              <>
                <span>{task.line || 'It runs in its own window.'} Togle can see it, and cannot answer it there.</span>
                <button className="small" onClick={() => setConfirmTakeOver(true)}>
                  Take over
                </button>
              </>
            )
          ) : (
            <>
              <span>Togle is not running this task. Continue it here to answer it and reply to it.</span>
              <button className="primary small" onClick={onOpen}>
                Continue here
              </button>
            </>
          )}
        </div>
      )}

      <div className="task-log" role="log" aria-label="What happened">
        {log.length === 0 && task.mine && <p className="hint">Nothing yet.</p>}
        {log.length === 0 && !task.mine && <p className="hint">Togle shows what happens in a task once it runs it.</p>}
        {log.map((entry) => (
          <LogLine key={entry.id} entry={entry} />
        ))}
        <div ref={end} />
      </div>

      {task.pending.map((request) => (
        <RequestCard key={request.id} request={request} onAllow={() => onAnswer(request.id, 'allow-once')} onRefuse={() => onAnswer(request.id, 'refuse')} onReply={(answer) => onReply(request.id, answer)} />
      ))}

      {task.mine && (
        <form className="task-reply" onSubmit={send}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Reply to the agent" aria-label="Reply to the agent" />
          <button className="primary small" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  )
}

const COMMAND_MARK: Record<NonNullable<LogEntry['status']>, string> = { running: '▶', finished: '✓', declined: '✕', failed: '✕' }
const COMMAND_WORD: Record<NonNullable<LogEntry['status']>, string> = { running: 'running', finished: 'done', declined: 'refused', failed: 'failed' }

function LogLine({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case 'you':
      return <div className="task-you">{entry.text}</div>
    case 'agent':
      return (
        <div className="task-agent">
          <Markdown text={entry.text} />
        </div>
      )
    case 'command':
      return (
        <div className="task-cmd" data-status={entry.status}>
          <span aria-hidden="true">{COMMAND_MARK[entry.status ?? 'finished']}</span>
          <code>{entry.text}</code>
          <span className="hint">{COMMAND_WORD[entry.status ?? 'finished']}</span>
        </div>
      )
    case 'asked':
      return <div className="task-note">It asked about {entry.text}</div>
    default:
      return <div className="task-note">{entry.text}</div>
  }
}

function RequestCard({ request, onAllow, onRefuse, onReply }: { request: ViewRequest; onAllow: () => void; onRefuse: () => void; onReply: (text: string) => void }) {
  const [text, setText] = useState('')
  if (request.kind === 'question') {
    const questions = request.questions ?? []
    return (
      <section className="task-request" aria-label="The agent asks you">
        <h3>Asks</h3>
        {questions.map((question) => (
          <div key={question.id}>
            <p>{question.text}</p>
            {question.options.length > 0 && (
              <div className="task-options">
                {question.options.map((option) => (
                  <button key={option} className="small" onClick={() => onReply(option)}>
                    {option}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        <form
          className="task-reply"
          onSubmit={(event) => {
            event.preventDefault()
            if (text.trim()) onReply(text.trim())
            setText('')
          }}
        >
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder="Your answer" aria-label="Your answer" type={questions[0]?.secret ? 'password' : 'text'} />
          <button className="primary small" disabled={!text.trim()}>
            Reply
          </button>
        </form>
      </section>
    )
  }
  const edit = request.kind === 'edit'
  return (
    <section className={`task-request ${request.danger ? 'danger' : ''}`} aria-label={edit ? 'The agent wants to change files' : 'The agent wants to run a command'}>
      <h3>
        {edit ? 'Wants to change' : 'Wants to run'}
        {request.danger && <span className="task-danger">Dangerous</span>}
      </h3>
      {edit ? (
        <ul className="task-files">
          {(request.files ?? []).map((file) => (
            <li key={file}>{file}</li>
          ))}
        </ul>
      ) : (
        <pre className="task-command">{request.command}</pre>
      )}
      {request.danger && <p className="task-why">{request.danger} Look at the whole command before you allow it.</p>}
      {request.reason && <p className="hint">{request.reason}</p>}
      {request.folder && <p className="hint">In {request.folder}</p>}
      <div className="row">
        <button className="primary small" onClick={onAllow}>
          Allow once
        </button>
        <button className="small" onClick={onRefuse}>
          Refuse
        </button>
      </div>
    </section>
  )
}
