import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { RunnerKind, RunnerStatus, TaskView, ViewRequest } from '@shared/runner'
import { canAllowHere, shownPart } from '@shared/runner-command'
import type { TodoItem, TodoList } from '@shared/todo'
import { Icon } from './Icon'
import { NewTask } from './Tasks'

const api = window.togle

const NAMES: Record<RunnerKind, string> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }
// How often the tasks are asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

/** What the task an item was given to is doing, as a short chip. */
function chipOf(task: TaskView | undefined): { text: string; tone: 'work' | 'wait' | 'done' | 'fail' | 'gone' } {
  if (!task) return { text: 'Task not found', tone: 'gone' }
  const who = NAMES[task.runner]
  switch (task.state) {
    case 'working':
      return { text: `${who} · working`, tone: 'work' }
    case 'waiting':
      return { text: `${who} · waiting for you`, tone: 'wait' }
    case 'idle':
      return { text: `${who} · done`, tone: 'done' }
    case 'failed':
      return { text: `${who} · stopped by an error`, tone: 'fail' }
    default:
      return { text: `${who} · stopped`, tone: 'gone' }
  }
}

/** What a waiting task asks, in a few words for a row. */
function asking(request: ViewRequest | undefined, task: TaskView): { says: string; detail: string } {
  if (!request) return { says: task.line || 'is waiting', detail: '' }
  if (request.kind === 'question') return { says: 'asks', detail: shownPart(request.questions?.[0]?.text ?? 'A question') }
  if (request.kind === 'edit') return { says: 'wants to change', detail: shownPart((request.files ?? []).join('\n') || 'a file') }
  return { says: 'wants to run', detail: shownPart(request.command ?? request.raw ?? '') }
}

/** The to-do list: what waits for the person at the top, then their own list, kept in a plain text file. */
export function Todo({ onOpenTask }: { onOpenTask: (key: string, changes?: boolean) => void }) {
  const [list, setList] = useState<TodoList | null>(null)
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [status, setStatus] = useState<RunnerStatus[]>([])
  const [keys, setKeys] = useState('F9')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ line: number; text: string } | null>(null)
  const [giving, setGiving] = useState<number | null>(null)
  const [error, setError] = useState('')

  const refreshList = useCallback(async () => {
    try {
      setList(await api.todoList())
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [])
  const refreshTasks = useCallback(async () => {
    try {
      const [found, installed] = await Promise.all([api.runnerTasks(), api.runnerStatus()])
      setTasks(Array.isArray(found) ? found : [])
      setStatus(Array.isArray(installed) ? installed : [])
    } catch {
      // The Tasks screen says what went wrong with the agents; here the rows stay as they were.
    }
  }, [])

  useEffect(() => {
    void refreshList()
    void refreshTasks()
    const offList = api.onTodoChanged(() => void refreshList())
    const offTasks = api.onRunnersChanged(() => void refreshTasks())
    const timer = setInterval(() => void refreshTasks(), REFRESH_MS)
    const again = (): void => {
      void refreshList()
      void refreshTasks()
    }
    window.addEventListener('focus', again)
    return () => {
      offList()
      offTasks()
      clearInterval(timer)
      window.removeEventListener('focus', again)
    }
  }, [refreshList, refreshTasks])

  useEffect(() => {
    void api
      .listHotkeys()
      .then((found) => {
        const dictate = found.find((key) => key.id === 'dictate')
        if (dictate?.ok && dictate.keys) setKeys(dictate.keys)
      })
      .catch(() => undefined)
  }, [])

  /** Changes the list, and shows what went wrong in plain words. */
  const change = useCallback(
    async (work: () => Promise<TodoList>): Promise<boolean> => {
      setError('')
      try {
        setList(await work())
        return true
      } catch (caught) {
        setError(errorText(caught))
        void refreshList()
        return false
      }
    },
    [refreshList]
  )
  const answer = useCallback(async (work: () => Promise<unknown>): Promise<void> => {
    setError('')
    try {
      await work()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      void refreshTasks()
    }
  }, [refreshTasks])

  const add = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = draft.trim()
    if (text && (await change(() => api.addTodo(text)))) setDraft('')
  }
  const saveEdit = async (item: TodoItem): Promise<void> => {
    const next = editing && editing.line === item.line ? editing.text.trim() : ''
    setEditing(null)
    if (next && next !== item.text) await change(() => api.editTodo({ line: item.line, text: item.text }, next))
  }
  const give = async (item: TodoItem, request: { runner: RunnerKind; folder: string; prompt: string }): Promise<void> => {
    setError('')
    try {
      const started = await api.startRunnerTask({ ...request, title: item.text.slice(0, 60) })
      setGiving(null)
      if (!(await change(() => api.linkTodo({ line: item.line, text: item.text }, started.key)))) setError((previous) => `The task started, but the item could not be given to it. ${previous}`)
      void refreshTasks()
    } catch (caught) {
      setError(errorText(caught))
    }
  }

  const installed = status.filter((s) => s.installed)
  const folders = [...new Set(tasks.map((t) => t.folder).filter(Boolean))].slice(0, 5)
  const waiting = tasks.filter((task) => task.state === 'waiting')
  const items = list?.items ?? []
  const open = items.filter((item) => !item.done)
  const ticked = items.filter((item) => item.done)
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })

  const row = (item: TodoItem): ReactNode => {
    const task = item.task ? tasks.find((candidate) => candidate.key === item.task) : undefined
    const chip = item.task ? chipOf(task) : null
    const isEditing = editing?.line === item.line
    return (
      <div key={item.line} className={`todo-item ${item.done ? 'done' : ''}`}>
        <div className="todo-row" role="listitem">
          <button className="todo-box" role="checkbox" aria-checked={item.done} aria-label={`${item.done ? 'Untick' : 'Tick'}: ${item.text}`} onClick={() => void change(() => api.setTodoDone({ line: item.line, text: item.text }, !item.done))}>
            {item.done && <Icon name="check" size={12} />}
          </button>
          {isEditing ? (
            <input
              className="todo-edit"
              aria-label="Change the item"
              autoFocus
              value={editing.text}
              onChange={(event) => setEditing({ line: item.line, text: event.target.value })}
              onBlur={() => void saveEdit(item)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void saveEdit(item)
                else if (event.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <button className="todo-text" title="Change it" onClick={() => setEditing({ line: item.line, text: item.text })}>
              {item.text}
            </button>
          )}
          {chip && (
            <button className={`todo-chip ${chip.tone}`} title="Open the task" disabled={!task} onClick={() => task && onOpenTask(task.key)}>
              {chip.text}
            </button>
          )}
          {task?.state === 'idle' && !item.done && (
            <button className="small" onClick={() => onOpenTask(task.key, true)}>
              See changes
            </button>
          )}
          {!item.done && !item.task && !!installed.length && (
            <button className="small" onClick={() => setGiving(giving === item.line ? null : item.line)}>
              Give to an agent
            </button>
          )}
          <button className="icon todo-remove" aria-label={`Delete: ${item.text}`} title="Delete" onClick={() => void change(() => api.removeTodo({ line: item.line, text: item.text }))}>
            <Icon name="close" size={12} />
          </button>
        </div>
        {giving === item.line && (
          <div className="todo-give">
            <NewTask heading="Give to an agent" prompt={item.text} installed={installed} folders={folders} onCancel={() => setGiving(null)} onStart={(request) => give(item, request)} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="todo" aria-label="To-do">
      <header className="todo-head">
        <h2>{today}</h2>
      </header>
      <form className="todo-add" onSubmit={(event) => void add(event)}>
        <input aria-label="Add a to-do" placeholder={`Add a to-do, or hold ${keys} and say it`} value={draft} onChange={(event) => setDraft(event.target.value)} />
        <kbd>{keys}</kbd>
      </form>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!!waiting.length && (
        <section className="todo-group" aria-label="Waiting for you">
          <h3 className="tasks-label">Waiting for you</h3>
          <div role="list">
            {waiting.map((task) => {
              const request = task.mine ? task.pending[0] : undefined
              const { says, detail } = asking(request, task)
              const allowHere = !!request && canAllowHere(request)
              return (
                <div key={task.key} className="todo-row need" role="listitem" data-state="waiting">
                  <span className="todo-dot" aria-hidden="true" />
                  <span className="todo-grow">
                    <b>{task.title}</b>
                    <small>
                      {NAMES[task.runner]} · {baseName(task.folder)} · {says}
                    </small>
                    {detail && <code className={`todo-command ${request?.kind ?? ''}`}>{detail}</code>}
                    {request?.danger && (
                      <small className="todo-why">
                        <span className="task-danger">Dangerous</span> {request.danger}
                      </small>
                    )}
                  </span>
                  {request && request.kind !== 'question' && allowHere && (
                    <button className="primary small" onClick={() => void answer(() => api.answerRunnerTask(task.key, request.id, 'allow-once'))}>
                      Allow once
                    </button>
                  )}
                  {request && request.kind !== 'question' && (
                    <button className="small" onClick={() => void answer(() => api.answerRunnerTask(task.key, request.id, 'refuse'))}>
                      Refuse
                    </button>
                  )}
                  <button className={`small ${request?.kind === 'question' ? 'primary' : 'ghost'}`} onClick={() => onOpenTask(task.key)}>
                    {request?.kind === 'question' ? 'Reply' : 'Open'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>
      )}
      <section className="todo-group" aria-label="To do">
        <h3 className="tasks-label">To do</h3>
        <div role="list">
          {open.map(row)}
          {ticked.map(row)}
        </div>
        {list && !items.length && <p className="empty">Nothing on your list. Add what you need to do today.</p>}
      </section>
      <p className="hint todo-file">
        Your list is a plain text file on this computer.{' '}
        <button className="link" onClick={() => void api.showTodoFile()}>
          Show the file
        </button>
      </p>
    </div>
  )
}
