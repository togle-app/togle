import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { KNOWN_AGENTS, needsYou, type RunnerStatus, type TaskView, type ViewRequest } from '@shared/runner'
import { canAllowHere, shownPart } from '@shared/runner-command'
import type { TodoItem, TodoList } from '@shared/todo'
import type { CallOffer, TodoOffer } from '@shared/call-todo'
import { meetingTitle } from './MeetingsPage'
import { AGENTS_FOUND, keepAnswer, keptAnswer, TASKS_LISTED, useKeptState } from './kept'
import { StateMark, type MarkKind } from './StateMark'

const api = window.togle

/** A task's agent by name: the name it came with, else the one Togle knows it by. */
const agentOf = (task: Pick<TaskView, 'runner' | 'agent'>): string => task.agent ?? KNOWN_AGENTS[task.runner] ?? task.runner
// How often the tasks are asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

/** A chip's tone as the mark in it. */
const TONE_MARK: Record<'work' | 'wait' | 'done' | 'fail' | 'gone', MarkKind> = { work: 'working', wait: 'waiting', done: 'done', fail: 'failed', gone: 'stopped' }

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

// What To-do read last, for when it is opened again (see kept.tsx).
const KEPT_LIST = 'todo.list'
const KEPT_OFFERS = 'todo.offers'
const KEPT_KEYS = 'todo.keys'

/** An item's words as they are compared: a call's to-do ends with a full stop, the same item on the list may not. */
const plain = (text: string): string => text.trim().replace(/\.$/, '').toLocaleLowerCase()

/** The to-do list: what waits for the person at the top, then their own list, kept in a plain text file. */
export function Todo({ onOpenTask, onOpenCall }: { onOpenTask: (key: string) => void; onOpenCall: (id: string) => void }) {
  // Opened again (To-do is home), the list starts from what was read last (see kept.tsx), and is read again behind it.
  const [list, setList] = useState<TodoList | null>(() => keptAnswer<TodoList>(KEPT_LIST) ?? null)
  // What calls left for today: names to confirm, notes that are ready, and the to-dos in them that are the person's.
  const [offers, setOffers] = useState<{ calls: CallOffer[]; items: TodoOffer[] }>(() => keptAnswer<{ calls: CallOffer[]; items: TodoOffer[] }>(KEPT_OFFERS) ?? { calls: [], items: [] })
  const [tasks, setTasks] = useState<TaskView[]>(() => keptAnswer<TaskView[]>(TASKS_LISTED) ?? [])
  const [status, setStatus] = useState<RunnerStatus[]>(() => keptAnswer<RunnerStatus[]>(AGENTS_FOUND) ?? [])
  const [keys, setKeys] = useState(() => keptAnswer<string>(KEPT_KEYS) ?? 'F9')
  // What is typed for a new item stays when the window shows another place and the list again.
  const [draft, setDraft] = useKeptState('todo.draft', '')
  const [editing, setEditing] = useState<{ line: number; text: string } | null>(null)
  const [error, setError] = useState('')

  const refreshList = useCallback(async () => {
    try {
      const found = await api.todoList()
      keepAnswer(KEPT_LIST, found)
      setList(found)
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [])
  // The tasks and the agents, each taken when it comes: one does not wait for the other. A read that fails keeps the rows as
  // they were (the Agents screen says what went wrong).
  const refreshTasks = useCallback(async () => {
    await Promise.all([
      api.runnerTasks().then((found) => {
        const next = Array.isArray(found) ? found : []
        keepAnswer(TASKS_LISTED, next)
        setTasks(next)
      }, () => undefined),
      api.runnerStatus().then((installed) => {
        const next = Array.isArray(installed) ? installed : []
        keepAnswer(AGENTS_FOUND, next)
        setStatus(next)
      }, () => undefined)
    ])
  }, [])

  const refreshOffers = useCallback(async () => {
    try {
      const found = await api.meetingOffers()
      if (found && Array.isArray(found.calls) && Array.isArray(found.items)) {
        keepAnswer(KEPT_OFFERS, found)
        setOffers(found)
      }
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
        if (dictate?.ok && dictate.keys) {
          keepAnswer(KEPT_KEYS, dictate.keys)
          setKeys(dictate.keys)
        }
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
  // A call is on the list while it needs you: names to confirm. Its notes wait in Meetings either way.
  const callsToConfirm = offers.calls.filter((call) => call.toConfirm > 0)

  const row = (item: TodoItem): ReactNode => {
    const task = item.task ? tasks.find((candidate) => candidate.key === item.task) : undefined
    const chip = item.task ? chipOf(task) : null
    const isEditing = editing?.line === item.line
    return (
      <div key={item.line} className={`todo-item ${item.done ? 'done' : ''}`}>
        <div className="todo-row" role="listitem">
          {/* A small square, green once ticked, as the design draws it. */}
          <button className="todo-box" role="checkbox" aria-checked={item.done} aria-label={`${item.done ? 'Untick' : 'Tick'}: ${item.text}`} onClick={() => void change(() => api.setTodoDone({ line: item.line, text: item.text }, !item.done))} />
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
              {task && <StateMark kind={TONE_MARK[chip.tone]} still />}
              {chip.text}
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
                // What can be allowed here shows whole (`allows`): on a narrow window its line breaks, where any other is shortened.
                <div key={task.key} className={`todo-row need ${fits ? 'allows' : ''}`} role="listitem" data-state="waiting">
                  <StateMark kind="waiting" still />
                  <span className="todo-grow">
                    <b>{task.title}</b>
                    <small className="todo-line">
                      {agentOf(task)} · {baseName(task.folder)} · {says}
                      {/* A command that looks dangerous is marked red, and why is on it. */}
                      {detail && (code ? <> <code className={request?.danger ? 'danger' : undefined} title={request?.danger || undefined}>{detail.split('\n')[0]}</code></> : ` ${detail}`)}
                    </small>
                  </span>
                  {/* The buttons stay together: on a narrow window they go under the words, the two of them. */}
                  <span className="todo-actions">
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
                  </span>
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
      {(!!callsToConfirm.length || !!fromCalls.length) && (
        <section className="todo-group" aria-label="From your calls">
          <h3 className="tasks-label">From your calls</h3>
          <div role="list">
            {callsToConfirm.map((call) => (
              <div key={call.id} className="todo-row" role="listitem">
                <span className="todo-dot done" aria-hidden="true" />
                <span className="todo-grow">
                  <b>{meetingTitle(call)}</b>
                  <small>
                    {[call.notes && 'Notes are ready', call.toConfirm > 0 && `${call.toConfirm} ${call.toConfirm === 1 ? 'name' : 'names'} to confirm`].filter(Boolean).join(' · ')}
                  </small>
                </span>
                <button className="small" onClick={() => onOpenCall(call.id)}>
                  Confirm names
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
