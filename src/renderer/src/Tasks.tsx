import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AGENT_INSTALLS, changedFiles, KNOWN_AGENTS, needsYou, slashList, type RunnerStatus, type TaskDetail, type TaskOffers, type TaskView, type ViewRequest } from '@shared/runner'
import type { DeviceTasks, RemoteAct, RemoteTask } from '@shared/reach'
import { Changes } from './Changes'
import { useReach } from './Devices'
import { openSettings } from './open-settings'
import { useHotkeys } from './hotkeys'
import { Icon } from './Icon'
import { RequestCard } from './RequestCard'
import { Thread, useHistory } from './TaskThread'
import { TerminalView } from './TerminalView'

const api = window.togle

/** A task's agent by name: the name it came with, else the one Togle knows it by. */
const agentOf = (task: Pick<TaskView, 'runner' | 'agent'>): string => task.agent ?? KNOWN_AGENTS[task.runner] ?? task.runner
const STATE_WORDS: Record<TaskView['state'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Done', stopped: 'Stopped', failed: 'Stopped by an error' }
// How often the list is asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000
// What finished within a day stays in the list; older tasks fold under Earlier.
const RECENT_MS = 24 * 3600_000
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
const NO_OFFERS: TaskOffers = { commands: [], models: [] }
// The tallest the list of an agent's commands gets, in pixels: about seven rows, and the rest scrolls.
const SLASH_LIST_HEIGHT = 208

// A task on another of the person's devices is picked by its device and its key there.
const REMOTE = 'remote:'
const remoteKey = (device: string, key: string): string => `${REMOTE}${device}:${key}`

/** A task is shown as its agent's own screen (Terminal), or as its conversation, a card for what it asks and a reply box (Web). Kept as `session` and `cards`. */
type View = 'cards' | 'session'
const VIEWS = 'togle.taskviews'
/** The view picked for each task, kept in the page between runs. */
const readViews = (): Record<string, View> => {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEWS) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(stored).filter((entry): entry is [string, View] => entry[1] === 'cards' || entry[1] === 'session'))
  } catch {
    return {}
  }
}
const keepViews = (views: Record<string, View>): void => {
  try {
    localStorage.setItem(VIEWS, JSON.stringify(Object.fromEntries(Object.entries(views).slice(-200))))
  } catch {
    // Not kept: each task opens in the view Settings says.
  }
}

/** Which view each task is shown in: the one picked for it, else the one Settings says tasks open in. */
function useTaskViews(): { of: (key: string) => View; pick: (key: string, view: View) => void } {
  const [opens, setOpens] = useState<View>('session')
  const [picked, setPicked] = useState<Record<string, View>>(readViews)
  useEffect(() => {
    let live = true
    const take = (settings: { tasks?: { view?: unknown } } | undefined): void => {
      if (live) setOpens(settings?.tasks?.view === 'cards' ? 'cards' : 'session')
    }
    void api.getSettings().then(take, () => undefined)
    const off = api.onSettingsChanged(take)
    return () => {
      live = false
      off()
    }
  }, [])
  return {
    of: (key) => picked[key] ?? opens,
    pick: (key, view) =>
      setPicked((previous) => {
        const next = { ...previous, [key]: view }
        keepViews(next)
        return next
      })
  }
}

/** The tasks the person's other devices share (Reach, part of Togle Studio), kept current. */
function useRemoteTasks(): DeviceTasks[] {
  const reach = useReach()
  const [remote, setRemote] = useState<DeviceTasks[]>([])
  const member = !!reach?.available && reach.standing === 'member'
  useEffect(() => {
    if (!member) { setRemote([]); return }
    let live = true
    const read = (): void => { void api.reachRemoteTasks().then((list) => { if (live) setRemote(Array.isArray(list) ? list : []) }, () => undefined) }
    read()
    const off = api.onReachChanged(read)
    return () => { live = false; off() }
  }, [member])
  return remote
}

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
  const [showEarlier, setShowEarlier] = useState(false)
  // Take over pressed on a row: the task opens with the question that confirms it.
  const [takingOver, setTakingOver] = useState<string>()
  // A task handed back: the line that goes on in the person's own terminal, shown where the task was.
  const [handedBack, setHandedBack] = useState<{ key: string; command: string; folder: string }>()
  const remote = useRemoteTasks()
  const views = useTaskViews()
  const selectedNow = useRef(selected)
  selectedNow.current = selected

  const refresh = useCallback(async () => {
    try {
      const [list, found] = await Promise.all([api.runnerTasks(), api.runnerStatus()])
      setTasks(Array.isArray(list) ? list : [])
      setStatus(Array.isArray(found) ? found : [])
      const key = selectedNow.current
      if (key && !key.startsWith(REMOTE)) {
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

  // The window says which agent screen it shows (one with no card over it), so that a notice still comes over it.
  const sessionKey = detail && !seeing && detail.task.mine && detail.task.terminal && (!detail.task.screen || views.of(detail.task.key) === 'session') ? detail.task.key : null
  useEffect(() => {
    api.taskSessionShown(sessionKey)
  }, [sessionKey])
  // Away from the Tasks screen, none is shown. (Not on every change of the task: a pick of another screen would flash the notice away.)
  useEffect(() => () => api.taskSessionShown(null), [])

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

  // Opened from a notice that says an agent waits on its own screen (Hermes has no card for what it asks): the screen is what shows,
  // once for each time the task is asked for from outside, so that a pick of Web afterwards stays.
  const showedSession = useRef(0)
  useEffect(() => {
    if (!focus?.key || showedSession.current === focus.seq) return
    const task = tasks.find((item) => item.key === focus.key)
    if (!task) return
    showedSession.current = focus.seq
    if (task.mine && task.screen && task.waitingFor && !task.pending.length) {
      if (views.of(task.key) !== 'session') views.pick(task.key, 'session')
      if (!task.terminal) void act(() => api.openRunnerTask(task.key))
    }
  }, [focus?.key, focus?.seq, tasks, views, act])

  const installed = status.filter((s) => s.installed)
  // One list, as the design has it: what waits for you comes first (a task Togle runs that stopped waits for a reply too),
  // then what works, then what finished today. Older tasks fold under Earlier.
  const recent = (task: TaskView): boolean => needsYou(task) || task.state === 'working' || now - task.updatedAt < RECENT_MS
  const rank = (task: TaskView): number => (needsYou(task) ? 0 : task.state === 'working' ? 1 : 2)
  const shown = tasks.filter(recent).sort((a, b) => rank(a) - rank(b))
  const earlier = tasks.filter((task) => !recent(task))
  const row = (task: TaskView, old = false): ReactNode => (
    <TaskRow
      key={task.key}
      task={task}
      now={now}
      old={old}
      selected={task.key === selected}
      onSelect={() => setSelected(task.key)}
      onTakeOver={takesOver(task) ? () => { setTakingOver(task.key); setSelected(task.key) } : undefined}
    />
  )
  const reach = useReach()
  const remoteSelected = selected?.startsWith(REMOTE)
    ? remote.flatMap((device) => device.tasks.map((task) => ({ device, task }))).find(({ device, task }) => remoteKey(device.device, task.key) === selected)
    : undefined

  return (
    <div className={`tasks ${selected ? 'has-detail' : ''}`} aria-label="Tasks">
      <aside className="tasks-list" aria-label={remote.length ? 'Agent tasks on your devices' : 'Agent tasks on this computer'}>
        <div className="tasks-head">
          <span className="tasks-label">This computer</span>
          <button className="primary small" disabled={!installed.length} onClick={() => void api.openTaskBox({}).catch((caught) => setError(errorText(caught)))}>
            New task
          </button>
        </div>
        {loaded && !installed.length && (status.some((agent) => agent.removed) ? <p className="empty">No agent is on Togle’s lists. Add one back in Settings.</p> : <NoAgents />)}
        {!!shown.length && <div className="task-list" role="list">{shown.map((task) => row(task))}</div>}
        {!!earlier.length && (
          <div className="task-earlier">
            <button className="link task-earlier-toggle" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
              Earlier · {earlier.length} task{earlier.length === 1 ? '' : 's'}
            </button>
            {showEarlier && <div className="task-list" role="list">{earlier.map((task) => row(task, true))}</div>}
          </div>
        )}
        {loaded && !!installed.length && !tasks.length && <p className="empty">No tasks yet. Start one, or let an agent run in a terminal and it shows here.</p>}
        {remote.map((device) => (
          <div key={device.device} className="task-device" aria-label={`Agent tasks on ${device.name}`}>
            <div className="tasks-head">
              <span className="tasks-label">{device.name}{device.role === 'server' ? ' · server' : ''}{device.online ? '' : ' · offline'}</span>
            </div>
            {device.tasks.length ? (
              <div role="list">
                {device.tasks.map((task) => (
                  <RemoteRow key={task.key} task={task} now={now} selected={remoteKey(device.device, task.key) === selected} onSelect={() => setSelected(remoteKey(device.device, task.key))} />
                ))}
              </div>
            ) : <p className="empty">No tasks there in the last week.</p>}
          </div>
        ))}
        {/* With Reach in this Togle and no other device yet: where the design says Togle mentions more than one device. */}
        {reach?.available && reach.standing !== 'member' && (
          <div className="task-device task-devices-mention">
            <span className="tasks-label">Other devices</span>
            <p>Your server, your laptop, your phone.</p>
            <button className="primary small" onClick={() => openSettings('devices')}>Add a device</button>
          </div>
        )}
      </aside>
      <section className="tasks-detail">
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {remoteSelected ? (
          <RemotePanel
            key={selected}
            device={remoteSelected.device}
            task={remoteSelected.task}
            now={now}
            onBack={() => setSelected(undefined)}
            act={(remoteAct) => act(() => api.reachAct(remoteSelected.device.device, remoteAct))}
          />
        ) : selected?.startsWith(REMOTE) ? (
          <div className="tasks-empty">
            <p>That task is no longer shared by its device.</p>
          </div>
        ) : detail && seeing === detail.task.key ? (
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
            view={views.of(detail.task.key)}
            onView={(view) => {
              views.pick(detail.task.key, view)
              // Terminal is the agent's own screen: picking it opens the screen when it is closed.
              if (view === 'session' && detail.task.mine && detail.task.screen && !detail.task.terminal) void act(() => api.openRunnerTask(detail.task.key))
            }}
            onTakeOver={() => act(() => api.takeOverRunnerTask(detail.task.key))}
            takeOverAsked={takingOver === detail.task.key}
            onHandBack={() => act(async () => setHandedBack({ key: detail.task.key, ...(await api.handBackRunnerTask(detail.task.key)) }))}
            handedBack={handedBack?.key === detail.task.key ? handedBack : undefined}
          />
        ) : (
          <div className="tasks-empty">
            <p>Pick a task, or start a new one.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function NoAgents() {
  const windows = api.platform === 'win32'
  const [copied, setCopied] = useState('')
  const copy = (runner: string, line: string): void => {
    void navigator.clipboard.writeText(line).then(() => setCopied(runner), () => undefined)
  }
  return (
    <div className="no-agents">
      <p>No coding agent on this computer yet. Togle works with these. Paste one line into {windows ? 'PowerShell' : 'a terminal'}, then sign in as the agent asks. Togle finds it within a minute.</p>
      {AGENT_INSTALLS.map((agent) => (
        <div key={agent.runner} className="no-agents-row">
          <span className="no-agents-name">
            <strong>{agent.name}</strong> by {agent.maker} ·{' '}
            <button className="link" onClick={() => api.openExternal(agent.page)}>
              Its page
            </button>
          </span>
          <span className="no-agents-line">
            <code>{windows ? agent.windows : agent.unix}</code>
            <button className="small" onClick={() => copy(agent.runner, windows ? agent.windows : agent.unix)}>
              {copied === agent.runner ? 'Copied' : 'Copy'}
            </button>
          </span>
        </div>
      ))}
    </div>
  )
}

/** A session that runs in its own terminal, which Take over can move into Togle: Claude Code's only. */
const takesOver = (task: TaskView): boolean => !task.mine && !!task.pid && task.runner === 'claude'

function TaskRow({ task, now, old, selected, onSelect, onTakeOver }: { task: TaskView; now: number; old: boolean; selected: boolean; onSelect: () => void; onTakeOver?: () => void }) {
  const stoppedHere = needsYou(task) && task.state !== 'waiting'
  const elsewhere = !task.mine && !!task.pid
  // One line, as the design has it: the agent, where it works, and how it stands. A task in a terminal says so. Stopped
  // and waiting for a reply, it says why; done long ago, it says when.
  const detail = elsewhere ? '' : stoppedHere ? (task.signedOut ? `signed out${task.fix ? ` · sign in with ${task.fix}` : ''}` : task.state === 'failed' ? `stopped by an error${task.line ? ': ' + task.line : ''}` : task.screen ? 'stopped · open it to go on' : 'stopped · reply to go on') : task.state === 'waiting' ? (task.waitingFor && !task.pending.length ? 'waiting on its screen' : 'waiting') : task.state === 'working' ? 'working' : task.state === 'failed' ? 'stopped by an error' : task.state === 'stopped' ? 'stopped' : old ? `done · ${ago(task.updatedAt, now)}` : 'done'
  // A session Hermes lists has no folder (its list says only a name): the line leaves that part out, and no empty one shows.
  const line = elsewhere ? `${agentOf(task)} · terminal` : [agentOf(task), task.folder ? baseName(task.folder) : '', detail].filter(Boolean).join(' · ')
  return (
    <div className="task-item" role="listitem">
      <button className={`task-row ${selected ? 'selected' : ''} ${onTakeOver ? 'with-action' : ''}`} data-state={task.state} data-needs={stoppedHere ? 'you' : undefined} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
        <span className="task-dot" aria-hidden="true" />
        <span className="task-copy">
          <strong>{task.title}</strong>
          <span>{line}</span>
        </span>
      </button>
      {onTakeOver && <button className="small task-row-action" onClick={onTakeOver}>Take over</button>}
    </div>
  )
}

/** After Hand back: the line that goes on in the person's own terminal, to run in the folder the task worked in. */
function HandedBack({ command, folder }: { command: string; folder: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="task-banner handed-back" role="note">
      <span>
        To open it in your terminal, run <code>{command}</code> in <code>{folder}</code>.
      </span>
      <button className="small" onClick={() => void navigator.clipboard.writeText(command).then(() => setCopied(true), () => undefined)}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

/** A task whose agent is signed out: the command that signs it in, to run in a terminal. A reply then goes on. */
function SignedOut({ task }: { task: TaskView }) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    if (task.fix) void navigator.clipboard.writeText(task.fix).then(() => setCopied(true), () => undefined)
  }
  // A task that is the agent's own screen is replied to on its card view or typed to on its screen.
  const goOn = task.screen ? 'reply here or on its screen to go on' : 'reply here to go on'
  return (
    <div className="task-banner signed-out" role="note">
      <span>
        {agentOf(task)} is signed out.{' '}
        {task.fix ? (
          <>
            Run <code>{task.fix}</code> in a terminal, then {goOn}.
          </>
        ) : (
          `Sign it in as its own instructions say, then ${goOn}.`
        )}
      </span>
      {task.fix && (
        <button className="small" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      )}
    </div>
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
  /** The view the task is shown in, and a pick of the other. */
  view: View
  onView: (view: View) => void
  onTakeOver: () => void
  /** Take over was pressed on the task's row: the question that confirms it shows at once. */
  takeOverAsked: boolean
  onHandBack: () => void
  /** The task was just handed back: the line that goes on in the person's own terminal. */
  handedBack?: { command: string; folder: string }
}

function TaskPanel({ detail, onSeeChanges, onBack, onAnswer, onReply, onSend, onStop, onEndCommands, onOpen, view, onView, onTakeOver, takeOverAsked, onHandBack, handedBack }: PanelProps) {
  const { task, log } = detail
  const talkKey = useHotkeys().find((key) => key.id === 'dictate')?.keys || 'F9'
  // A task whose agent has a screen Togle can show is seen in two views; any other task has the one it has.
  const twoViews = task.mine && !!task.screen
  // The agent's own screen is on screen: no card over it and no reply box, because what it asks is answered on it.
  const sessionShown = task.terminal && (!task.screen || view === 'session')
  const [text, setText] = useState('')
  const [confirmTakeOver, setConfirmTakeOver] = useState(takeOverAsked)
  useEffect(() => { if (takeOverAsked) setConfirmTakeOver(true) }, [takeOverAsked])
  const end = useRef<HTMLDivElement>(null)
  const running = task.state === 'working' || task.state === 'waiting'
  // The conversation as its agent keeps it, also of what was said before Togle opened the task; else what happened while Togle watched.
  const { history, loaded: historyLoaded, all, showAll } = useHistory(task)
  const shown = history ? history.entries : log
  // Of the turns shown only, so a count is not given for a conversation that has older turns left out.
  const changed = history?.more && !all ? 0 : changedFiles(shown)
  // The thread stays at its end while new words come, unless the person scrolled up to read.
  const stick = useRef(true)
  useEffect(() => {
    if (stick.current) end.current?.scrollIntoView?.({ block: 'end' })
  }, [shown.length, task.pending.length])
  // A question the agent asks is answered from the reply box; anything else typed there goes to the task.
  const question = task.pending.find((request) => request.kind === 'question')
  const say = (message: string): void => {
    if (question) onReply(question.id, message)
    else onSend(message)
    setText('')
  }
  const send = (event: FormEvent): void => {
    event.preventDefault()
    const message = text.trim()
    if (message) say(message)
  }
  // The agent's own commands, listed over the reply box while a "/" and the start of a name are typed, and its models
  // after "/model ". What the agent offers is asked when the task opens, and again when a "/" starts the reply.
  const [offers, setOffers] = useState<TaskOffers>(NO_OFFERS)
  const slashed = text.startsWith('/')
  // Terminal picked and its screen is closed: what waits is answered on a card until the screen is opened.
  const closedSession = task.mine && !!task.screen && view === 'session' && !task.terminal
  const cardsView = !sessionShown && !closedSession
  const answers = task.mine && cardsView
  // An agent that can only be written to on its screen takes words when its turn has ended; Codex takes them while it works too.
  const holdsReply = !!task.screen && task.runner !== 'codex' && (task.state === 'working' || task.state === 'waiting' || !!task.waitingFor) && !task.pending.some((request) => request.kind === 'question')
  useEffect(() => {
    if (!answers) { setOffers(NO_OFFERS); return }
    let live = true
    void api.runnerOffers(task.key).then((told) => { if (live && told?.commands) setOffers(told) }, () => undefined)
    return () => { live = false }
  }, [task.key, answers, slashed])
  const [picked, setPicked] = useState(0)
  // Esc closes the list until what is typed changes.
  const [closed, setClosed] = useState(false)
  useEffect(() => { setPicked(0); setClosed(false) }, [text])
  const listed = !question && !closed ? slashList(text, offers) : null
  const at = listed ? Math.min(picked, listed.items.length - 1) : 0
  const pickedRow = useRef<HTMLButtonElement>(null)
  useEffect(() => { pickedRow.current?.scrollIntoView?.({ block: 'nearest' }) }, [at, listed?.kind])
  // Where the list has room: over the reply box, up to the task's state line; under the box when that is too little.
  const replyPlace = useRef<HTMLDivElement>(null)
  const [room, setRoom] = useState({ under: false, height: SLASH_LIST_HEIGHT })
  const rows = listed?.items.length ?? 0
  useLayoutEffect(() => {
    const place = replyPlace.current
    if (!rows || !place) return
    const box = place.getBoundingClientRect()
    const top = place.closest('.task-panel')?.querySelector('.task-status')?.getBoundingClientRect().bottom ?? 0
    const above = box.top - top - 8
    const below = window.innerHeight - box.bottom - 12
    const needed = Math.min(SLASH_LIST_HEIGHT, rows * 28 + 10)
    const under = above < needed && below > above
    setRoom({ under, height: Math.max(56, Math.min(SLASH_LIST_HEIGHT, under ? below : above)) })
  }, [rows])
  /** Enter on a listed row, or a click: a command is sent as it is, "/model" lists the models, a model is switched to. */
  const choose = (row: number): void => {
    if (!listed) return
    if (listed.kind === 'models') {
      const model = listed.items[row]
      if (model) say(`/model ${model.id}`)
      return
    }
    const command = listed.items[row]
    if (!command) return
    if (command.name === 'model' && offers.models.length) setText('/model ')
    else say(`/${command.name}`)
  }
  const keyed = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (!listed) return
    const count = listed.items.length
    if (event.key === 'ArrowDown') { event.preventDefault(); setPicked((at + 1) % count) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setPicked((at + count - 1) % count) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosed(true) }
    // Tab completes the name, to go on typing what follows it.
    else if (event.key === 'Tab') { event.preventDefault(); setText(listed.kind === 'models' ? `/model ${listed.items[at].id}` : `/${listed.items[at].name} `) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(at) }
  }
  return (
    <div className="task-panel">
      <header className="task-header">
        <button className="ghost small tasks-back" onClick={onBack} aria-label="Back to the list">
          <Icon name="back" size={14} />
        </button>
        <div className="task-title">
          <h2 title={task.title}>
            {task.title}
            <span className="task-where" title={task.folder}> · {agentOf(task)} · {task.folder ? baseName(task.folder) : 'no folder'}</span>
          </h2>
        </div>
        <div className="task-actions">
          {/* Stop, then what follows from it, then Hand back, as the design page has them in a header. */}
          {task.mine && running && (
            <button className="small" onClick={onStop} title={task.screen ? 'Ends the agent’s turn, as Esc does on its screen (Ctrl+C in Hermes).' : undefined}>
              Stop
            </button>
          )}
          {task.mine && task.commandsRunning && task.state === 'stopped' && (
            <button className="small" onClick={onEndCommands} title="Stop ended the agent's turn. The command it started is still running.">
              End the running command
            </button>
          )}
          {task.mine && task.screen && (
            <button className="small" onClick={onHandBack} title="Closes its screen here and gives you the line to open it in your own terminal. The task goes on.">
              Hand back
            </button>
          )}
        </div>
      </header>
      <div className="task-status">
        <span className="state-chip" data-state={task.signedOut ? 'failed' : task.state}>{task.signedOut ? 'Signed out' : STATE_WORDS[task.state]}</span>
        {(changed > 0 || task.folder) && (
          <span className="hint">
            {changed > 0 && `${changed} ${changed === 1 ? 'file' : 'files'} changed`}
            {changed > 0 && task.folder && <span className="sep" aria-hidden="true">·</span>}
            {task.folder && (
              <button className="link" onClick={onSeeChanges} title="What differs from the last commit in this folder">
                See changes
              </button>
            )}
          </span>
        )}
        {twoViews && (
          <span className="segmented view-switch" role="group" aria-label="View">
            {(['cards', 'session'] as const).map((name) => (
              <button key={name} type="button" className={view === name ? 'on' : ''} aria-pressed={view === name} onClick={() => onView(name)} title={name === 'cards' ? 'The conversation, a card for what the agent asks, and a reply box.' : 'The agent’s own screen.'}>
                {name === 'cards' ? 'Web' : 'Terminal'}
              </button>
            ))}
          </span>
        )}
      </div>

      {task.mine && task.signedOut && <SignedOut task={task} />}

      {handedBack && !task.terminal && <HandedBack command={handedBack.command} folder={handedBack.folder} />}

      {!task.mine && (
        <div className="task-banner" role="note">
          {takesOver(task) ? (
            confirmTakeOver ? (
              <>
                <span>This ends the {agentOf(task)} running in its terminal and moves the same conversation into the background, with its screen here.</span>
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
                <span>It runs in a terminal. Take over moves it into the background and opens its screen here, so you can answer it here too.</span>
                <button className="small" onClick={() => setConfirmTakeOver(true)}>
                  Take over
                </button>
              </>
            )
          ) : task.job ? (
            <>
              <span>It runs in the background{task.waitingFor ? `, and waits: ${task.waitingFor}` : ''}. Open its screen here to see it and answer it.</span>
              <button className="primary small" onClick={onOpen}>
                Open here
              </button>
            </>
          ) : task.pid ? (
            <span>It runs in its own window, where it is answered.</span>
          ) : (
            <>
              <span>{task.runner in KNOWN_AGENTS ? `Togle is not running this task. Continue it here: it opens as ${agentOf(task)}'s own screen, to answer there.` : 'Togle is not running this task. Continue it here to answer it and reply to it.'}</span>
              <button className="primary small" onClick={onOpen}>
                Continue here
              </button>
            </>
          )}
        </div>
      )}

      {sessionShown ? (
        // The agent's own screen, with no card over it and no reply box: what it asks is answered on it, and a notice still comes.
        <TerminalPanel task={task} onEnd={onEndCommands} />
      ) : closedSession ? (
        <>
          {/* Terminal is picked and its screen is closed: what waits is answered here, or on the screen once it is opened. */}
          {task.pending.map((request) => (
            <RequestCard key={request.id} request={request} onAllow={() => onAnswer(request.id, 'allow-once')} onAlways={() => onAnswer(request.id, 'allow-always')} onRefuse={() => onAnswer(request.id, 'refuse')} onReply={(answer) => onReply(request.id, answer)} />
          ))}
          <div className="task-banner screen-closed" role="note">
            <span>
              {task.screenClosed ?? 'Its screen is closed, and the task goes on.'}
              {task.waitingFor && !task.pending.length ? ` It waits on its screen: ${task.waitingFor}.` : ''}
            </span>
            <button className="primary small" onClick={onOpen}>
              Open the screen
            </button>
          </div>
        </>
      ) : (
      <>
      <div className="task-log" role="log" aria-label="The conversation" onScroll={(event) => { const box = event.currentTarget; stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < 60 }}>
        {history?.more && !all && <button type="button" className="link task-earlier-turns" onClick={showAll}>Show earlier</button>}
        {shown.length === 0 && task.mine && <p className="hint">{task.screen ? 'Nothing said yet. Pick Terminal to see its screen.' : 'Nothing yet.'}</p>}
        {shown.length === 0 && !task.mine && historyLoaded && <p className="hint">Togle shows what happens in a task once it runs it.</p>}
        {/* The whole conversation, in order: what was asked and answered in the open, and the steps between folded to a line. */}
        <Thread entries={shown} working={task.state === 'working'} />
        <div ref={end} />
      </div>

      {task.pending.map((request) => (
        <RequestCard key={request.id} request={request} onAllow={() => onAnswer(request.id, 'allow-once')} onAlways={() => onAnswer(request.id, 'allow-always')} onRefuse={() => onAnswer(request.id, 'refuse')} onReply={(answer) => onReply(request.id, answer)} />
      ))}

      {/* An agent that asks on its own screen (Hermes) has no card here: it says so, and the session is one press away. */}
      {task.mine && task.screen && task.waitingFor && !task.pending.length && (
        <div className="task-banner" role="note">
          <span>It waits on its screen: {task.waitingFor}.</span>
          <button className="primary small" onClick={() => onView('session')}>
            Open the terminal
          </button>
        </div>
      )}
      {task.mine && task.screen && !task.terminal && task.screenClosed && <p className="hint">{task.screenClosed}</p>}

      {task.mine && (
        <div className="task-reply-place" ref={replyPlace}>
          {listed && (
            <div className={room.under ? 'slash-list under' : 'slash-list'} style={{ maxHeight: room.height }} id="slash-list" role="listbox" aria-label={listed.kind === 'models' ? `${agentOf(task)}'s models` : `${agentOf(task)}'s commands`}>
              {listed.kind === 'models'
                ? listed.items.map((model, row) => (
                    <button type="button" role="option" id={`slash-${row}`} aria-selected={row === at} className={row === at ? 'on' : ''} ref={row === at ? pickedRow : undefined} key={model.id} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setPicked(row)} onClick={() => choose(row)}>
                      <b>{model.name}</b>
                      <small>{model.description}</small>
                    </button>
                  ))
                : listed.items.map((command, row) => (
                    <button type="button" role="option" id={`slash-${row}`} aria-selected={row === at} className={row === at ? 'on' : ''} ref={row === at ? pickedRow : undefined} key={command.name} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setPicked(row)} onClick={() => choose(row)}>
                      <b>/{command.name}{command.hint && <span> {command.hint}</span>}</b>
                      <small>{command.description}</small>
                    </button>
                  ))}
            </div>
          )}
          <form className="task-reply" onSubmit={send}>
            <input value={text} disabled={holdsReply} onChange={(event) => setText(event.target.value)} onKeyDown={keyed} placeholder={holdsReply ? 'Reply when it has finished' : 'Reply, or hold ' + talkKey + ' and talk'} aria-label="Reply to the agent" type={question?.questions?.[0]?.secret ? 'password' : 'text'} role="combobox" aria-autocomplete="list" aria-expanded={!!listed} aria-controls={listed ? 'slash-list' : undefined} aria-activedescendant={listed ? `slash-${at}` : undefined} />
            <button className="small" disabled={holdsReply || !text.trim()}>
              Send
            </button>
          </form>
        </div>
      )}
      </>
      )}
    </div>
  )
}

/**
 * A task whose agent has no ACP: it runs in a terminal of Togle's own, which the person reads and types into. Togle cannot
 * see what it asks, so the terminal is where it is answered. Words its command had no place for wait to be typed in.
 */
function TerminalPanel({ task, onEnd }: { task: TaskView; onEnd: () => void }) {
  const running = task.state === 'working' || task.state === 'waiting'
  return (
    <div className="task-terminal">
      {/* The agent's own screen needs no words about itself: it is the screen the person knows. */}
      {!task.screen && (
        <div className="task-banner" role="note">
          <span>{running ? `${agentOf(task)} runs in this terminal. It asks here, and you answer here, as in any terminal.` : `${agentOf(task)} has ended. What it printed stays here.`}</span>
          {running && task.mine && (
            <button className="small" onClick={onEnd} title="Ends the agent and what it started">
              End it
            </button>
          )}
        </div>
      )}
      {running && task.words && (
        <div className="task-banner task-words" role="note">
          <span>
            When {agentOf(task)} is ready, type your words in and press Enter: <q>{task.words}</q>
          </span>
          <button className="primary small" onClick={() => void api.typeTerminalWords(task.key).catch(() => undefined)}>
            Type them in
          </button>
        </div>
      )}
      <TerminalView taskKey={task.key} screenId={task.screenId} />
    </div>
  )
}

/** A task on another of the person's devices, in the same one line as a task here. */
function RemoteRow({ task, now, selected, onSelect }: { task: RemoteTask; now: number; selected: boolean; onSelect: () => void }) {
  const detail = task.state === 'waiting' ? 'waiting for you' : task.state === 'working' ? 'working' : task.state === 'failed' ? 'stopped by an error' : task.state === 'stopped' ? 'stopped' : `done · ${ago(task.updatedAt, now)}`
  return (
    <button className={`task-row ${selected ? 'selected' : ''}`} role="listitem" data-state={task.state} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <span className="task-dot" aria-hidden="true" />
      <span className="task-copy">
        <strong>{task.title}</strong>
        <span>{task.agent} · {task.terminal ? 'terminal' : task.folder} · {detail}</span>
      </span>
    </button>
  )
}

/**
 * A task on another device: what it waits for, with the command whole, and what can be done about it from here. Refuse
 * and Stop need no proof that you are there; Allow does (your fingerprint, face or PIN), and that comes later, so for now
 * a command is allowed on its own computer.
 */
function RemotePanel({ device, task, now, onBack, act }: { device: DeviceTasks; task: RemoteTask; now: number; onBack: () => void; act: (remote: RemoteAct) => void }) {
  const running = task.state === 'working' || task.state === 'waiting'
  const here = task.mine && !task.terminal
  return (
    <div className="task-panel">
      <header className="task-header">
        <button className="ghost small tasks-back" onClick={onBack} aria-label="Back to the list">
          <Icon name="back" size={14} />
        </button>
        <div className="task-title">
          <h2 title={task.title}>
            {task.title}
            <span className="task-where"> · {task.agent} · {task.folder}</span> <span className="task-device-chip">{device.name}</span>
          </h2>
        </div>
        <div className="task-actions">
          {here && running && <button className="small" disabled={!device.online} onClick={() => act({ what: 'stop', task: task.key })}>Stop</button>}
          {here && task.commandsRunning && task.state === 'stopped' && (
            <button className="small" disabled={!device.online} onClick={() => act({ what: 'end-commands', task: task.key })} title="Stop ended the agent's turn. The command it started is still running.">
              End the running command
            </button>
          )}
        </div>
      </header>
      <div className="task-status">
        <span className="state-chip" data-state={task.state}>{STATE_WORDS[task.state]}</span>
        {!running && <span className="hint">{ago(task.updatedAt, now)}</span>}
      </div>

      {!device.online && <div className="task-banner" role="note"><span>{device.name} is offline. It can be answered once it is back.</span></div>}
      {task.terminal && <div className="task-banner" role="note"><span>This task runs in a terminal on {device.name}. It is watched from here and answered only there.</span></div>}
      {!task.mine && !task.terminal && <div className="task-banner" role="note"><span>Togle doesn’t run this task on {device.name}, so it is answered there.</span></div>}

      <div className="task-log" role="log" aria-label="Where it stands">
        <div className="task-agent task-latest"><p>{task.line || 'Nothing yet.'}</p></div>
      </div>

      {task.pending.map((request) => (
        <section key={request.id} className={`task-request ${request.danger ? 'danger' : ''}`} aria-label={request.kind === 'question' ? 'The agent asks' : request.kind === 'edit' ? 'The agent wants to change files' : 'The agent wants to run a command'}>
          <h3>
            {request.kind === 'question' ? 'Asks' : request.kind === 'edit' ? 'Wants to change' : 'Wants to run'}
            {request.danger && <span className="task-danger">Dangerous</span>}
          </h3>
          {request.kind === 'command' && <pre className="task-command">{request.command}</pre>}
          {request.kind === 'edit' && <ul className="task-files">{(request.files ?? []).map((file) => <li key={file}>{file}</li>)}</ul>}
          {request.kind === 'question' && <p>{request.question}</p>}
          {request.danger && <p className="task-why">{request.danger}</p>}
          {here && request.kind !== 'question' && (
            <div className="row">
              <button className="small" disabled={!device.online} onClick={() => act({ what: 'refuse', task: task.key, request: request.id })}>Refuse</button>
            </div>
          )}
          <p className="hint">
            {request.kind === 'question'
              ? `Answer it on ${device.name}.`
              : `Allowing it from another device needs your fingerprint, face or PIN, and this Togle can’t ask for that yet. Allow it on ${device.name}.`}
          </p>
        </section>
      ))}
    </div>
  )
}
