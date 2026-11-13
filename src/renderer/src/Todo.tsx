import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { KNOWN_AGENTS, needsYou, type RunnerStatus, type TaskView, type ViewRequest } from '@shared/runner'
import { canAllowHere, shownPart } from '@shared/runner-command'
import type { TodoItem, TodoList } from '@shared/todo'
import type { CallOffer, TodoOffer } from '@shared/call-todo'
import { meetingTitle } from './MeetingsPage'
import { Icon } from './Icon'

const api = window.togle

/** A task's agent by name: the name it came with, else the one Togle knows it by. */
const agentOf = (task: Pick<TaskView, 'runner' | 'agent'>): string => task.agent ?? KNOWN_AGENTS[task.runner] ?? task.runner
// How often the tasks are asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

/** What the task an item was given to is doing, as a short chip. */
function chipOf(task: TaskView | undefined): { text: string; tone: 'work' | 'wait' | 'done' | 'fail' | 'gone' } {
  if (!task) return { text: 'Task not found', tone: 'gone' }
  const who = agentOf(task)
  switch (task.state) {
    case 'working':
      return { text: `${who} · working`, tone: 'work' }
    case 'waiting':
      return { text: `${who} · waiting for you`, tone: 'wait' }
    case 'idle':
      return { text: `${who} · done`, tone: 'done' }
    case 'failed':
      return { text: `${who} · ${task.signedOut ? 'signed out' : 'stopped by an error'}`, tone: 'fail' }
    default:
      return { text: `${who} · stopped`, tone: 'gone' }
  }
}

/** The longest command shown whole on a row; a longer one, or one of several lines, opens in Agents. */
const ROW_FITS = 72

/** What a waiting task asks, in a few words for a row: the command (or what signs the agent in) shows as code. */
function asking(request: ViewRequest | undefined, task: TaskView): { says: string; detail: string; code: boolean } {
  // Stopped and waiting for a reply to go on: it says why, and signed out, what signs the agent in again.
  if (!request && task.signedOut) return task.fix ? { says: 'is signed out · sign in with', detail: task.fix, code: true } : { says: 'is signed out.', detail: 'Sign it in, then reply.', code: false }
  if (!request && task.state === 'failed') return { says: task.line ? 'stopped by an error:' : 'stopped by an error', detail: task.line, code: false }
  if (!request && task.state === 'stopped') return { says: 'was stopped.', detail: 'Reply to go on.', code: false }
  if (!request) return { says: task.line || 'is waiting', detail: '', code: false }
  if (request.kind === 'question') return { says: 'asks:', detail: shownPart(request.questions?.[0]?.text ?? 'a question'), code: false }
  if (request.kind === 'edit') return { says: 'wants to change', detail: shownPart((request.files ?? []).join('\n') || 'a file'), code: true }
  return { says: 'wants to run', detail: shownPart(request.command ?? request.raw ?? ''), code: true }
}

/** An item's words as they are compared: a call's to-do ends with a full stop, the same item on the list may not. */
const plain = (text: string): string => text.trim().replace(/\.$/, '').toLocaleLowerCase()

/** The to-do list: what waits for the person at the top, then their own list, kept in a plain text file. */
export function Todo({ onOpenTask, onOpenCall }: { onOpenTask: (key: string, changes?: boolean) => void; onOpenCall: (id: string) => void }) {
  const [list, setList] = useState<TodoList | null>(null)
  // What calls left for today: names to confirm, notes that are ready, and the to-dos in them that are the person's.
  const [offers, setOffers] = useState<{ calls: CallOffer[]; items: TodoOffer[] }>({ calls: [], items: [] })
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [status, setStatus] = useState<RunnerStatus[]>([])
  const [keys, setKeys] = useState('F9')
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState<{ line: number; text: string } | null>(null)
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

  const refreshOffers = useCallback(async () => {
    try {
      const found = await api.meetingOffers()
      if (found && Array.isArray(found.calls) && Array.isArray(found.items)) setOffers(found)
    } catch {
      // Calls are in Meetings; here the offers stay as they were.
    }
  }, [])

  useEffect(() => {
    void refreshList()
    void refreshTasks()
    void refreshOffers()
    const offCalls = api.onCallSessions(() => void refreshOffers())
    const offList = api.onTodoChanged(() => void refreshList())
    const offTasks = api.onRunnersChanged(() => void refreshTasks())
    const timer = setInterval(() => void refreshTasks(), REFRESH_MS)
    const again = (): void => {
      void refreshList()
      void refreshTasks()
      void refreshOffers()
    }
    window.addEventListener('focus', again)
    return () => {
      offList()
      offTasks()
      offCalls()
      clearInterval(timer)
      window.removeEventListener('focus', again)
    }
  }, [refreshList, refreshTasks, refreshOffers])

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
    if (!editing || editing.line !== item.line) return
    const next = editing.text.trim()
    setEditing(null)
    // Its words cleared, the item goes: a row has no delete button.
    if (!next) await change(() => api.removeTodo({ line: item.line, text: item.text }))
    else if (next !== item.text) await change(() => api.editTodo({ line: item.line, text: item.text }, next))
  }
  // The task box, as for any task: with the item's words, and the item, which the task is then given to.
  const give = (item: TodoItem): void => {
    setError('')
    api.openTaskBox({ prompt: item.text, todo: { line: item.line, text: item.text } }).catch((caught) => setError(errorText(caught)))
  }

  const installed = status.filter((s) => s.installed)
  const waiting = tasks.filter(needsYou)
  const items = list?.items ?? []
  const open = items.filter((item) => !item.done)
  const ticked = items.filter((item) => item.done)
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  // A to-do from a call that is already on the list is not offered again.
  const onList = new Set(items.map((item) => plain(item.text)))
  const fromCalls = offers.items.filter((offer) => !onList.has(plain(offer.text)))

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
            <button className="small" onClick={() => give(item)}>
              Give to an agent
            </button>
          )}
        </div>
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
              // A task that runs elsewhere has requests only when its question is held here, and then they can be answered here.
              const request = task.pending[0]
              const { says, detail, code } = asking(request, task)
              // A command or a change is allowed here only when all of it shows on the row and it doesn't look dangerous.
              const fits = !!request && request.kind !== 'question' && canAllowHere(request) && !detail.includes('\n') && detail.length <= ROW_FITS
              const reply = request?.kind === 'question' || (!request && task.state !== 'waiting')
              return (
                <div key={task.key} className="todo-row need" role="listitem" data-state="waiting">
                  <span className="todo-dot" aria-hidden="true" />
                  <span className="todo-grow">
                    <b>{task.title}</b>
                    <small className="todo-line">
                      {agentOf(task)} · {baseName(task.folder)} · {says}
                      {detail && (code ? <> <code>{detail.split('\n')[0]}</code></> : ` ${detail}`)}
                    </small>
                  </span>
                  {request?.danger && <span className="task-danger">Dangerous</span>}
                  {fits && (
                    <>
                      <button className="primary small" onClick={() => void answer(() => api.answerRunnerTask(task.key, request.id, 'allow-once'))}>
                        Allow once
                      </button>
                      <button className="small" onClick={() => void answer(() => api.answerRunnerTask(task.key, request.id, 'refuse'))}>
                        Refuse
                      </button>
                    </>
                  )}
                  {/* A question, or a task Togle runs that stopped, goes on with a reply; anything else opens in Agents. */}
                  {!fits && (
                    <button className={`small ${reply ? 'primary' : ''}`} onClick={() => onOpenTask(task.key)}>
                      {reply ? 'Reply' : 'Open'}
                    </button>
                  )}
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
      {(!!offers.calls.length || !!fromCalls.length) && (
        <section className="todo-group" aria-label="From your calls">
          <h3 className="tasks-label">From your calls</h3>
          <div role="list">
            {offers.calls.map((call) => (
              <div key={call.id} className="todo-row" role="listitem">
                <span className="todo-dot done" aria-hidden="true" />
                <span className="todo-grow">
                  <b>{meetingTitle(call)}</b>
                  <small>
                    {[call.notes && 'Notes are ready', call.toConfirm > 0 && `${call.toConfirm} ${call.toConfirm === 1 ? 'name' : 'names'} to confirm`].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <button className={`small ${call.toConfirm > 0 ? 'primary' : 'ghost'}`} onClick={() => onOpenCall(call.id)}>
                  {call.toConfirm > 0 ? 'Confirm names' : 'Open'}
                </button>
              </div>
            ))}
            {fromCalls.map((offer) => (
              <div key={offer.callId + offer.text} className="todo-row" role="listitem" title={`From ${meetingTitle({ title: offer.title, startedAt: offer.startedAt })}`}>
                <span className="todo-grow todo-offer">{offer.text.replace(/\.$/, '')}</span>
                <button className="small" onClick={() => void change(() => api.addTodo(offer.text.trim().replace(/\.$/, ''))).then(() => refreshOffers())}>
                  Add
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
