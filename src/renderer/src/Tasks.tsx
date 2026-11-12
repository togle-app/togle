import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { changedFiles, KNOWN_AGENTS, needsYou, stepsLine, type ClaudeHookStatus, type LogEntry, type RunnerStatus, type TaskDetail, type TaskView, type ViewRequest } from '@shared/runner'
import { Changes } from './Changes'
import { useHotkeys } from './hotkeys'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

const api = window.togle

/** A task's agent by name: the name it came with, else the one Togle knows it by. */
const agentOf = (task: Pick<TaskView, 'runner' | 'agent'>): string => task.agent ?? KNOWN_AGENTS[task.runner] ?? task.runner
const STATE_WORDS: Record<TaskView['state'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Done', stopped: 'Stopped', failed: 'Stopped by an error' }
// How often the list is asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000
// The first this many earlier tasks show; the rest come with "Show all".
const EARLIER_SHOWN = 8
// The task looked at last, for when the screen is opened again.
let remembered: string | undefined
// What a banner says of a session in its own window that asks a question: the terminal asks too, and either answer counts.
const ASKS_ELSEWHERE = 'It runs in its own window and asks there too. Answer here or there: the first answer counts.'

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

/** `focus`: a task to show, asked for from outside (a notice, the to-do list), on what it changed if `changes`; a new `seq` asks again. */
export function Tasks({ focus }: { focus?: { key: string; seq: number; changes?: boolean } }) {
  const [tasks, setTasks] = useState<TaskView[]>([])
  // The task whose changes are shown in place of the task itself.
  const [seeing, setSeeing] = useState<string | null>(null)
  const [status, setStatus] = useState<RunnerStatus[]>([])
  const [selected, setSelected] = useState<string | undefined>(remembered)
  const [detail, setDetail] = useState<TaskDetail | null>(null)
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

  // Opened on a task from outside: it is the one shown.
  useEffect(() => {
    if (!focus?.key) return
    setSelected(focus.key)
    setSeeing(focus.changes ? focus.key : null)
  }, [focus?.key, focus?.seq, focus?.changes])

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
  // A task Togle runs that stopped waits for a reply, with the ones that ask.
  const waiting = tasks.filter(needsYou)
  const working = tasks.filter((t) => t.state === 'working')
  const earlier = tasks.filter((t) => !needsYou(t) && t.state !== 'working')
  const row = (task: TaskView): ReactNode => (
    <TaskRow
      key={task.key}
      task={task}
      now={now}
      selected={task.key === selected}
      onSelect={() => setSelected(task.key)}
    />
  )

  return (
    <div className={`tasks ${selected ? 'has-detail' : ''}`} aria-label="Tasks">
      <aside className="tasks-list" aria-label="Agent tasks on this computer">
        <div className="tasks-head">
          <span className="tasks-label">This computer</span>
          <button className="primary small" disabled={!installed.length} onClick={() => void api.openTaskBox({}).catch((caught) => setError(errorText(caught)))}>
            New task
          </button>
        </div>
        {loaded && !installed.length && <p className="empty">No coding agent found. Install Claude Code, Codex or Hermes, and Togle finds it.</p>}
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
        <TerminalAnswers />
      </aside>
      <section className="tasks-detail">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {detail && seeing === detail.task.key ? (
          <Changes taskKey={detail.task.key} title={detail.task.title} folder={detail.task.folder} onBack={() => setSeeing(null)} />
        ) : detail ? (
          <TaskPanel
            key={detail.task.key}
            detail={detail}
            now={now}
            onSeeChanges={() => setSeeing(detail.task.key)}
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

/**
 * Whether Claude Code in a terminal asks Togle about its commands, and the button that turns that on or off. `compact` is
 * for a row of Settings, which has the name and the note itself.
 */
export function TerminalAnswers({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<ClaudeHookStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    void api.claudeHookStatus().then(setStatus, () => undefined)
  }, [])
  if (!status?.claude) return null
  const change = async (work: () => Promise<ClaudeHookStatus>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setStatus(await work())
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setBusy(false)
    }
  }
  if (!status.supported) {
    return (
      <p className={`hint ${compact ? '' : 'tasks-connect'}`}>
        Claude Code {status.version?.replace(/\s*\(.*$/, '')} is older than {status.minimum}, so Togle cannot answer its terminal sessions. Update Claude Code to use this.
      </p>
    )
  }
  if (compact) {
    return (
      <span className="tasks-connect-compact">
        {status.installed && status.current ? (
          <>
            <span className="hint">Connected</span>
            <button className="ghost" disabled={busy} onClick={() => void change(() => api.disconnectClaudeHook())}>
              Turn off
            </button>
          </>
        ) : (
          <button className="ghost" disabled={busy || !!status.problem} title={`Adds one entry to ${status.file}`} onClick={() => void change(() => api.connectClaudeHook())}>
            {status.installed ? 'Connect again' : 'Connect Claude Code'}
          </button>
        )}
        {(error || status.problem) && (
          <span className="error" role="alert">
            {error || status.problem}
          </span>
        )}
      </span>
    )
  }
  return (
    <div className="tasks-connect" aria-label="Claude Code in a terminal">
      {status.installed && status.current ? (
        <>
          <p>
            <strong>Connected.</strong> Claude Code sessions in a terminal ask Togle about a command too. Answer here or in the terminal: the first answer counts.
          </p>
          <button className="small" disabled={busy} onClick={() => void change(() => api.disconnectClaudeHook())}>
            Turn off
          </button>
        </>
      ) : (
        <>
          <p>
            <strong>{status.installed ? 'Togle has moved since this was set up.' : 'Answer from here.'}</strong>{' '}
            {status.installed ? 'Connect again, so Claude Code finds it.' : 'Claude Code in a terminal can ask Togle about a command, so you can allow or refuse it from a notice or from this window. You can still answer in the terminal. The first answer counts.'}
          </p>
          <button className="primary small" disabled={busy || !!status.problem} onClick={() => void change(() => api.connectClaudeHook())}>
            {status.installed ? 'Connect again' : 'Connect Claude Code'}
          </button>
          <details>
            <summary>What this changes</summary>
            <p className="hint">
              It adds one entry to <code>{status.file}</code>, and keeps a copy of that file beside it the first time. Turn off takes the entry out again. When Togle is not running, Claude Code asks in the terminal as it always did.
            </p>
          </details>
        </>
      )}
      {(error || status.problem) && (
        <p className="error" role="alert">
          {error || status.problem}
        </p>
      )}
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
  const stoppedHere = needsYou(task) && task.state !== 'waiting'
  // One line, as the design has it: the agent, where it works, and how it stands. Stopped and waiting for a reply, it
  // says why; done, it says when.
  const detail = stoppedHere ? (task.state === 'failed' ? `stopped by an error${task.line ? ': ' + task.line : ''}` : 'stopped · reply to go on') : task.state === 'waiting' ? 'waiting' : task.state === 'working' ? 'working' : task.state === 'failed' ? 'stopped by an error' : task.state === 'stopped' ? 'stopped' : `done · ${ago(task.updatedAt, now)}`
  const where = !task.mine && task.pid ? 'terminal' : baseName(task.folder)
  const dangerous = task.pending.some((request) => request.danger)
  return (
    <button className={`task-row ${selected ? 'selected' : ''}`} role="listitem" data-state={task.state} data-needs={stoppedHere ? 'you' : undefined} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <span className="task-dot" aria-hidden="true" />
      <span className="task-copy">
        <strong>{task.title}</strong>
        <span>
          {agentOf(task)} · {where} · {detail}
        </span>
      </span>
      {dangerous && <span className="task-danger">Dangerous</span>}
    </button>
  )
}

interface PanelProps {
  detail: TaskDetail
  now: number
  onSeeChanges: () => void
  onBack: () => void
  onAnswer: (requestId: string, decision: 'allow-once' | 'allow-always' | 'refuse') => void
  onReply: (requestId: string, text: string) => void
  onSend: (text: string) => void
  onStop: () => void
  onEndCommands: () => void
  onOpen: () => void
  onTakeOver: () => void
  onClose: () => void
}

function TaskPanel({ detail, now, onSeeChanges, onBack, onAnswer, onReply, onSend, onStop, onEndCommands, onOpen, onTakeOver, onClose }: PanelProps) {
  const { task, log } = detail
  const talkKey = useHotkeys().find((key) => key.id === 'dictate')?.keys || 'F9'
  const [text, setText] = useState('')
  const [confirmTakeOver, setConfirmTakeOver] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' })
  }, [log.length, task.pending.length])
  const running = task.state === 'working' || task.state === 'waiting'
  const latest = [...log].reverse().find((entry) => entry.kind === 'agent')
  const changed = changedFiles(log)
  const steps = stepsLine(log)
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
            {agentOf(task)} · <span title={task.folder}>{task.folder ? baseName(task.folder) : 'No folder'}</span> · <span className="task-state" data-state={task.state}>{STATE_WORDS[task.state]}</span>
            {task.updatedAt && !running ? ` · ${ago(task.updatedAt, now)}` : ''}
            {changed > 0 && ` · ${changed} ${changed === 1 ? 'file' : 'files'} changed`}
            {task.folder && (
              <>
                {' · '}
                <button className="link" onClick={onSeeChanges} title="What differs from the last commit in this folder">
                  See changes
                </button>
              </>
            )}
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
                <span>This ends the {agentOf(task)} running in its terminal. The conversation is kept and goes on here.</span>
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
                <span>{task.pending.length ? ASKS_ELSEWHERE : `${task.line || 'It runs in its own window.'} Togle can see it, and cannot answer it there.`}</span>
                <button className="small" onClick={() => setConfirmTakeOver(true)}>
                  Take over
                </button>
              </>
            )
          ) : task.pending.length ? (
            <span>{ASKS_ELSEWHERE}</span>
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
        {/* Where it stands first: what the agent said last. Its steps and the conversation fold under one line. */}
        {latest && <div className="task-agent task-latest"><Markdown text={latest.text} /></div>}
        {log.length > 0 && (
          <details className="task-steps">
            <summary>{steps ?? 'What was said'}</summary>
            {log.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </details>
        )}
        <div ref={end} />
      </div>

      {task.pending.map((request) => (
        <RequestCard key={request.id} request={request} onAllow={() => onAnswer(request.id, 'allow-once')} onAlways={() => onAnswer(request.id, 'allow-always')} onRefuse={() => onAnswer(request.id, 'refuse')} onReply={(answer) => onReply(request.id, answer)} />
      ))}

      {task.mine && (
        <form className="task-reply" onSubmit={send}>
          <input value={text} onChange={(event) => setText(event.target.value)} placeholder={'Reply, or hold ' + talkKey + ' and talk'} aria-label="Reply to the agent" />
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

function RequestCard({ request, onAllow, onAlways, onRefuse, onReply }: { request: ViewRequest; onAllow: () => void; onAlways: () => void; onRefuse: () => void; onReply: (text: string) => void }) {
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
      {/* What always reaches, in the agent's terms; never for a command that looks dangerous. */}
      {request.always && !request.danger && (<button className="link task-always" onClick={onAlways}>{request.always}</button>)}
    </section>
  )
}
