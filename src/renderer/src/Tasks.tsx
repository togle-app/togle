import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AGENT_INSTALLS, changedFiles, KNOWN_AGENTS, needsYou, slashList, type LogEntry, type RunnerStatus, type TaskDetail, type TaskOffers, type TaskView, type ViewRequest } from '@shared/runner'
import type { DeviceTasks, RemoteAct, RemoteTask } from '@shared/reach'
import { useReach } from './Devices'
import { openSettings } from './open-settings'
import { useHotkeys } from './hotkeys'
import { Icon } from './Icon'
import { AGENTS_FOUND, keepAnswer, keptAnswer, TASKS_LISTED, useKeptState, WaitLine } from './kept'
import { AgentLead, AgentMark, agentOf } from './AgentMark'
import { DETAIL_MIN, LIST_COLLAPSE_BELOW, LIST_MAX, LIST_MIN, setPanes, usePanes } from './panes'
import { PointMenu, type Point } from './PointMenu'
import { ResizeHandle } from './ResizeHandle'
import { applyGroupChange, madeKey, NO_GROUPS, ownGroupOf, projectKeyOf, subjectFolded, type GroupChange, type TaskGroups } from '@shared/task-groups'
import { withQuote, splitQuote } from '@shared/quote'
import { QuoteBar, QuoteBlock, QuoteFloat, useQuoteSpot } from './Quote'
import { RequestCard } from './RequestCard'
import { StateMark, type MarkKind } from './StateMark'
import { clock, currentPlan, lastTurnKey, PlanCard, promptsOf, Thread, turnStart, useHistory } from './TaskThread'
import { ThreadRail } from './ThreadRail'
import { TerminalView } from './TerminalView'

const api = window.togle

const STATE_WORDS: Record<TaskView['state'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Done', stopped: 'Stopped', failed: 'Stopped by an error' }
// How often the list is asked for again: what runs in a terminal of its own sends no message when it changes.
const REFRESH_MS = 4_000
// What finished within a day stays in the list; older tasks fold under Earlier.
const RECENT_MS = 24 * 3600_000
// The task looked at last, for when the screen is opened again.
// The task shown, kept while the page lives (a screen left and come back to) and over a page that loads again.
let remembered: string | undefined = (() => {
  try {
    return sessionStorage.getItem('togle.selected') || undefined
  } catch {
    return undefined
  }
})()
// Where each thread was read to when its task was last on screen, and the list's own scroll: kept while the window is open, so that a
// place drawn again is where it was left.
const threadScrolls = new Map<string, { top: number; stick: boolean }>()
let listScroll = 0
// What was asked for from outside (a notice, the to-do list) is taken once: Agents drawn again later does not go back to it.
let focusTaken = 0
let sessionTaken = 0
// What the screen read last, for when it is opened again (see kept.tsx): the list of tasks, the agents, and the view tasks open in.
const KEPT_TASKS = TASKS_LISTED
const KEPT_STATUS = AGENTS_FOUND
const KEPT_OPENS = 'agents.opens'
// What Togle saw of each task it runs (its own log), read last: a task opened again shows it at once. A few dozen at most.
const logs = new Map<string, LogEntry[]>()
function keepLog(key: string, entries: LogEntry[]): void {
  logs.delete(key)
  logs.set(key, entries)
  while (logs.size > 24) logs.delete(logs.keys().next().value as string)
}

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

/** When a scheduled job runs next, as a person says it: "4:00 PM", "tomorrow 8:00 AM", "Mon 9:00 AM". */
function nextTime(at: number, now: number): string {
  const when = new Date(at)
  const today = new Date(now)
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = Math.round((new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000)
  return days <= 0 ? time : days === 1 ? `tomorrow ${time}` : `${when.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
}

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

/** A task is shown as its agent's own screen (Terminal), or as its conversation, a card for what it asks and a reply box (Chat). Kept as `session` and `cards`. */
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
  // The one known last, while Settings is read again: a task does not open in Terminal for a moment and then in Chat.
  const [opens, setOpens] = useState<View>(() => keptAnswer<View>(KEPT_OPENS) ?? 'session')
  const [picked, setPicked] = useState<Record<string, View>>(readViews)
  useEffect(() => {
    let live = true
    const take = (settings: { tasks?: { view?: unknown } } | undefined): void => {
      const view: View = settings?.tasks?.view === 'cards' ? 'cards' : 'session'
      keepAnswer(KEPT_OPENS, view)
      if (live) setOpens(view)
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

// ---- How the list is organized: by project, then by what the work is about, then by where each task stands ----

/** It finished (or stopped by an error) and the person has not had it on screen since. */
/** The mark in a chip that says how a task stands, the same as its words (what needs you is said by the panel itself). */
const chipMark = (state: TaskView['state'], schedule?: string): MarkKind => (state === 'idle' ? (schedule ? 'resting' : 'done') : state)
/** How a task's mark shows it: what needs you first (it asks, or it stopped with a reply to give), then what it does. A
 *  scheduled job between its runs rests: it is not done. */
const markOf = (task: TaskView): MarkKind => (needsYou(task) ? 'waiting' : task.state === 'working' ? 'working' : task.state === 'failed' ? 'failed' : task.state === 'stopped' ? 'stopped' : task.schedule ? 'resting' : 'done')
const isFresh = (task: TaskView): boolean => task.fresh === true && !needsYou(task) && task.state !== 'working' && task.state !== 'waiting'
/** Where a task stands, in the order a subject lists them: it needs you, it works, it finished and you have not opened it, it is done. */
const standing = (task: TaskView): number => (needsYou(task) ? 0 : task.state === 'working' ? 1 : isFresh(task) ? 2 : 3)
/** Inside one standing the order holds still: the working ones by name (they change all the time), the others newest first. */
const inOrder = (a: TaskView, b: TaskView): number =>
  standing(a) - standing(b) || (standing(a) === 1 ? a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt) || a.key.localeCompare(b.key)
const byName = (a: string, b: string): number => a.localeCompare(b, undefined, { sensitivity: 'base' })
/** A project is its folder: the same folder, the same project, however its path is written (Windows does not tell case apart). */
const projectKey = (folder: string): string => projectKeyOf(folder, api.platform)
/** The folder a folder is in ("C:\work" for "C:\work\website"): where a project is, to know it by. */
const parentOf = (folder: string): string => folder.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
/** A scheduled job's row is the job; work outside any project is Everyday; the rest is in a project, its folder. */
const kindOf = (task: TaskView): 'scheduled' | 'everyday' | 'project' => (task.schedule ? 'scheduled' : task.outsideProject || !task.folder ? 'everyday' : 'project')
/** The group Togle puts a task in by itself, by its key (task-groups.ts): main sorts each of these by subject. */
const ownGroup = (task: TaskView): string => ownGroupOf(task, api.platform)

/**
 * The colors of a group's mark. None is amber, indigo, green or red: those say how a task stands. A group keeps its color:
 * a project's is worked out from its folder, a made group's from its id (so a new name keeps it), with nothing kept.
 */
const MARK_COLORS = ['#f29ac6', '#c3a3ff', '#6ec5ef', '#b6d86c', '#a7b0c2']
function markColor(key: string): string {
  let hash = 0
  for (let at = 0; at < key.length; at++) hash = (hash * 31 + key.charCodeAt(at)) >>> 0
  return MARK_COLORS[hash % MARK_COLORS.length]
}
/** The letter on a group's mark: the first letter or digit of its name. */
const markLetter = (name: string): string => (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toLocaleUpperCase()

type GroupKind = 'made' | 'scheduled' | 'everyday' | 'project'
/** What waits for you, works and is new among some tasks. */
interface Counted {
  waiting: number
  working: number
  fresh: number
}
const countsOf = (tasks: TaskView[]): Counted => ({ waiting: tasks.filter(needsYou).length, working: tasks.filter((task) => task.state === 'working').length, fresh: tasks.filter(isFresh).length })
interface TaskGroup {
  key: string
  kind: GroupKind
  name: string
  /** A project's folder, and the folder it is in, to know it by; none for the other kinds. */
  folder: string
  where: string
  /** Its tasks under no heading: one just started, one alone in its subject, one the person dropped on the group, or all of them while sorting is off. */
  loose: TaskView[]
  subjects: { name: string; tasks: TaskView[]; counts: Counted }[]
  counts: Counted
  /** A group of Togle's own that the person gave a name: its own name can be given back. */
  renamed: boolean
}

/** A group's mark, the same on the group in the list and on its tasks: a letter on its color, a clock, or a house. */
function GroupMark({ group, size = 'big' }: { group: Pick<TaskGroup, 'kind' | 'key' | 'name'>; size?: 'big' | 'small' }) {
  if (group.kind === 'scheduled' || group.kind === 'everyday') {
    return (
      <span className={`project-mark ${size} ${group.kind}`} aria-hidden="true">
        <Icon name={group.kind === 'scheduled' ? 'clock' : 'home'} size={size === 'big' ? 14 : 10} />
      </span>
    )
  }
  return <span className={`project-mark ${size}`} style={{ background: markColor(group.key) }} data-letter={markLetter(group.name)} aria-hidden="true" />
}

/** The mark between two parts of where a task is, in its header. */
const CrumbGap = () => <span className="crumb-gap" aria-hidden="true"><Icon name="chevron" size={12} /></span>

function groupOf(base: Omit<TaskGroup, 'loose' | 'subjects' | 'counts'>, tasks: TaskView[], placed: TaskGroups['placed']): TaskGroup {
  // Scheduled jobs keep the order of their names: a job's row stays where it is as it runs.
  const order = base.kind === 'scheduled' ? (a: TaskView, b: TaskView): number => byName(a.title, b.title) || a.key.localeCompare(b.key) : inOrder
  // A task the person moved has the subject they dropped it on, or none: a subject Togle gives it later does not move it.
  const subjectOf = (task: TaskView): string => (base.kind === 'scheduled' ? '' : task.key in placed ? placed[task.key].subject ?? '' : task.subject?.trim() ?? '')
  const subjects = new Map<string, TaskView[]>()
  for (const task of tasks) {
    const subject = subjectOf(task)
    if (subject) subjects.set(subject, [...(subjects.get(subject) ?? []), task])
  }
  // A heading shows once two tasks share it: over one task it would say what the task's own name says.
  const headed = [...subjects.entries()].filter(([, list]) => list.length > 1)
  const underHeading = new Set(headed.flatMap(([, list]) => list.map((task) => task.key)))
  return {
    ...base,
    loose: tasks.filter((task) => !underHeading.has(task.key)).sort(order),
    subjects: headed.sort(([a], [b]) => byName(a, b)).map(([subject, list]) => ({ name: subject, tasks: list.sort(order), counts: countsOf(list) })),
    counts: countsOf(tasks)
  }
}

/**
 * The tasks in groups, each in a place of its own that does not change: the groups the person made, in the order they made
 * them (`withMade`: also the empty ones); scheduled jobs; work outside any project (Everyday); then one group for each project,
 * A to Z by its name (two folders of one name are told apart by the folder they are in). A task the person moved is in the
 * group they put it in. Inside a group, by subject (A to Z), each subject's tasks in the order of where they stand; tasks under
 * no heading come first. Nothing here depends on when a task last changed, except among the ones that are done.
 */
function groupTasks(list: TaskView[], arrangement: TaskGroups, withMade: boolean): TaskGroup[] {
  const made = new Set(arrangement.made.map((group) => madeKey(group.id)))
  const keyOf = (task: TaskView): string => {
    const placed = arrangement.placed[task.key]?.group
    return placed && placed !== 'scheduled' && (!placed.startsWith('made:') || made.has(placed)) ? placed : ownGroup(task)
  }
  const byGroup = new Map<string, TaskView[]>()
  for (const task of list) byGroup.set(keyOf(task), [...(byGroup.get(keyOf(task)) ?? []), task])
  const named = (key: string, own: string): { name: string; renamed: boolean } => ({ name: arrangement.names[key] ?? own, renamed: key in arrangement.names })
  const groups: TaskGroup[] = []
  for (const group of arrangement.made) {
    const tasks = byGroup.get(madeKey(group.id)) ?? []
    if (tasks.length || withMade) groups.push(groupOf({ key: madeKey(group.id), kind: 'made', name: group.name, renamed: false, folder: '', where: '' }, tasks, arrangement.placed))
  }
  for (const kind of ['scheduled', 'everyday'] as const) {
    const tasks = byGroup.get(kind) ?? []
    if (tasks.length) groups.push(groupOf({ key: kind, kind, ...named(kind, kind === 'scheduled' ? 'Scheduled' : 'Everyday'), folder: '', where: '' }, tasks, arrangement.placed))
  }
  const projects = [...byGroup.entries()]
    .filter(([key]) => key.startsWith('project:'))
    .map(([key, tasks]) => {
      const folder = tasks.find((task) => ownGroup(task) === key)?.folder ?? key.slice('project:'.length)
      return { key, folder, own: baseName(folder), tasks }
    })
  for (const project of projects) {
    if (projects.filter((other) => other.own.toLocaleLowerCase() === project.own.toLocaleLowerCase()).length > 1) {
      project.own = `${baseName(parentOf(project.folder)) || parentOf(project.folder)}/${project.own}`
    }
  }
  projects
    .map((project) => ({ ...project, ...named(project.key, project.own) }))
    .sort((a, b) => byName(a.name, b.name) || a.key.localeCompare(b.key))
    .forEach((project) => groups.push(groupOf({ key: project.key, kind: 'project', name: project.name, renamed: project.renamed, folder: project.folder, where: parentOf(project.folder) }, project.tasks, arrangement.placed)))
  return groups
}

/** The person's own arrangement (task-groups.ts): what main last sent, read again behind it, with the changes not yet kept laid over it, so a change shows at once. */
const KEPT_GROUPS = 'agents.groups'
function useArrangement(): [TaskGroups, (change: GroupChange) => void] {
  const [fromMain, setFromMain] = useState<TaskGroups>(() => keptAnswer<TaskGroups>(KEPT_GROUPS) ?? NO_GROUPS)
  const [pending, setPending] = useState<GroupChange[]>([])
  useEffect(() => {
    let live = true
    const read = (): void => {
      void api.taskGroups().then((groups) => {
        keepAnswer(KEPT_GROUPS, groups)
        if (live) setFromMain((was) => (JSON.stringify(was) === JSON.stringify(groups) ? was : groups))
      }, () => undefined)
    }
    read()
    // Main changes it too: the tasks dropped on a heading that Togle's sorting renamed follow it.
    const off = api.onRunnersChanged(read)
    return () => {
      live = false
      off()
    }
  }, [])
  const change = useCallback((next: GroupChange) => {
    setPending((was) => [...was, next])
    const settle = (): void => setPending((was) => was.filter((item) => item !== next))
    void api.changeTaskGroups(next).then((groups) => {
      keepAnswer(KEPT_GROUPS, groups)
      setFromMain(groups)
      settle()
    }, settle)
  }, [])
  return [pending.reduce(applyGroupChange, fromMain), change]
}

/** The groups folded, kept in the page between runs, as the view picked for each task is. `fold` folds or opens one (by itself, the other of what it is). */
const FOLDED = 'togle.foldedgroups'
function useFolded(): [Set<string>, (key: string, fold?: boolean) => void] {
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(FOLDED) ?? '[]') as unknown
      return new Set(Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : [])
    } catch {
      return new Set()
    }
  })
  const toggle = useCallback((key: string, fold?: boolean) => {
    setFolded((was) => {
      if (fold !== undefined && was.has(key) === fold) return was
      const next = new Set(was)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(FOLDED, JSON.stringify([...next].slice(-200)))
      } catch {
        // Not kept: it opens unfolded next time.
      }
      return next
    })
  }, [])
  return [folded, toggle]
}

/** What a dragged task carries: its key. */
const DRAG = 'application/x-togle-task'
/** How long a dragged task stays over a folded box or heading before it opens. */
const SPRING_MS = 500
/** A box, or a heading in one, as one word: what a dragged task is over, and what it opened. */
const spot = (group: string, subject = ''): string => `${group}\n${subject}`

/** What waits, works and is new in a group or a folded heading, in words. */
const countWords = (counts: Counted): string => [counts.waiting && `${counts.waiting} waiting`, counts.working && `${counts.working} working`, counts.fresh && `${counts.fresh} new`].filter(Boolean).join(', ')

/** What waits, works and is new in a group or a folded heading: numbers in the colors of the dots that say it, and the words for a screen reader. */
function Counts({ counts }: { counts: Counted }) {
  const words = countWords(counts)
  if (!words) return null
  return (
    <span className="group-counts" role="img" aria-label={words} title={words}>
      {!!counts.waiting && <span className="count-pill wait">{counts.waiting}</span>}
      {!!counts.working && <span className="count-pill work">{counts.working}</span>}
      {!!counts.fresh && <span className="count-pill fresh">{counts.fresh}</span>}
    </span>
  )
}

/** `focus`: a task to show, asked for from outside (a notice, the to-do list); a new `seq` asks again. */
export function Tasks({ focus }: { focus?: { key: string; seq: number } }) {
  // Opened again, the screen starts from what it read last (see kept.tsx), and reads again behind it.
  const [tasks, setTasks] = useState<TaskView[]>(() => keptAnswer<TaskView[]>(KEPT_TASKS) ?? [])
  const [status, setStatus] = useState<RunnerStatus[]>(() => keptAnswer<RunnerStatus[]>(KEPT_STATUS) ?? [])
  const [selected, setSelected] = useState<string | undefined>(remembered)
  // Togle's own log of the task shown, read behind it: the task itself is its row in the list.
  const [log, setLog] = useState<{ key: string; entries: LogEntry[] } | null>(() => (remembered && logs.has(remembered) ? { key: remembered, entries: logs.get(remembered) ?? [] } : null))
  // A task picked that the list does not have yet (one just started): the list is read for it.
  const [lookingFor, setLookingFor] = useState<string>()
  const [error, setError] = useState('')
  const [loaded, setLoaded] = useState(() => keptAnswer(KEPT_TASKS) !== undefined)
  // The person's own arrangement of the list, and what they are doing to it: a group folded, a task dragged (where it is
  // over, and the folded boxes and headings it opened by staying over them, open until the drag ends), a group being
  // named, a row's menu.
  const [arrangement, changeGroups] = useArrangement()
  const [folded, toggleFold] = useFolded()
  const [dragging, setDragging] = useState<string>()
  const [dropAt, setDropAt] = useState<{ group: string; subject: string }>()
  const [sprung, setSprung] = useState<Set<string>>(() => new Set())
  const [renaming, setRenaming] = useState<string>()
  const [rowMenu, setRowMenu] = useState<{ at: Point; key: string } | null>(null)
  const [groupMenu, setGroupMenu] = useState<{ at: Point; key: string } | null>(null)
  const [now, setNow] = useState(Date.now())
  const [showEarlier, setShowEarlier] = useKeptState('agents.earlier', false)
  const listBox = useRef<HTMLElement>(null)
  const tasksBox = useRef<HTMLDivElement>(null)
  // How wide the list is, and whether it is hidden: what the person set by dragging its edge (panes.ts).
  const panes = usePanes()
  useLayoutEffect(() => { if (listBox.current) listBox.current.scrollTop = listScroll }, [])
  // Take over pressed on a row: the task opens with the question that confirms it.
  const [takingOver, setTakingOver] = useState<string>()
  // A task handed back: the line that goes on in the person's own terminal, shown where the task was.
  const [handedBack, setHandedBack] = useState<{ key: string; command: string; folder: string; held?: string }>()
  const remote = useRemoteTasks()
  const views = useTaskViews()
  const selectedNow = useRef(selected)
  selectedNow.current = selected
  const tasksNow = useRef(tasks)
  tasksNow.current = tasks
  // Answers are taken in the order they were asked for: one that comes after a newer one is not shown over it.
  const turns = useRef({ list: 0, listShown: 0, status: 0, statusShown: 0, log: 0 })

  /** Togle's own log of a task, read behind it. Taken only for the task still shown, and only the newest answer; one that fails keeps what is shown. */
  const readLog = useCallback(async (key: string | undefined): Promise<void> => {
    if (!key || key.startsWith(REMOTE)) return
    const turn = ++turns.current.log
    const next: unknown = await api.runnerDetail(key).catch(() => null)
    if (!isDetail(next) || next.task.key !== key || selectedNow.current !== key || turn !== turns.current.log) return
    keepLog(key, next.log)
    setLog({ key, entries: next.log })
  }, [])

  /** The list and the agents, each taken when it comes (one does not wait for the other), and the log of the task shown. */
  const refresh = useCallback(async (): Promise<void> => {
    const listTurn = ++turns.current.list
    const statusTurn = ++turns.current.status
    const list = api.runnerTasks().then(
      (found) => {
        if (listTurn < turns.current.listShown) return
        turns.current.listShown = listTurn
        const next = Array.isArray(found) ? found : []
        keepAnswer(KEPT_TASKS, next)
        setTasks(next)
        setLookingFor(undefined)
      },
      (caught) => setError(errorText(caught))
    ).finally(() => {
      setNow(Date.now())
      setLoaded(true)
    })
    const agents = api.runnerStatus().then(
      (found) => {
        if (statusTurn < turns.current.statusShown) return
        turns.current.statusShown = statusTurn
        const next = Array.isArray(found) ? found : []
        keepAnswer(KEPT_STATUS, next)
        setStatus(next)
      },
      () => undefined
    )
    await Promise.all([list, agents, readLog(selectedNow.current)])
  }, [readLog])

  useEffect(() => {
    void refresh()
    const off = api.onRunnersChanged(() => void refresh())
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [refresh])

  // A task picked shows at once, from its row in the list and what was read of it before; its log is read behind it, and the
  // list too when it does not have the task yet.
  useEffect(() => {
    remembered = selected
    try {
      if (selected) sessionStorage.setItem('togle.selected', selected)
      else sessionStorage.removeItem('togle.selected')
    } catch {
      /* kept for this run only */
    }
    setLog(selected && logs.has(selected) ? { key: selected, entries: logs.get(selected) ?? [] } : null)
    if (selected && !selected.startsWith(REMOTE) && !tasksNow.current.some((task) => task.key === selected)) {
      setLookingFor(selected)
      void refresh()
    } else void readLog(selected)
  }, [selected, refresh, readLog])

  // The task shown: its row in the list, and Togle's own log of it.
  const listed = selected && !selected.startsWith(REMOTE) ? tasks.find((task) => task.key === selected) : undefined
  const detail: TaskDetail | null = listed ? { task: listed, log: log?.key === listed.key ? log.entries : [] } : null
  const logRead = !!listed && (log?.key === listed.key || !listed.mine)

  // Opened on a task from outside: it is the one shown.
  useEffect(() => {
    if (!focus?.key || focus.seq === focusTaken) return
    focusTaken = focus.seq
    setSelected(focus.key)
  }, [focus?.key, focus?.seq])

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
  // once for each time the task is asked for from outside, so that a pick of Chat afterwards stays.
  useEffect(() => {
    if (!focus?.key || sessionTaken === focus.seq) return
    const task = tasks.find((item) => item.key === focus.key)
    if (!task) return
    sessionTaken = focus.seq
    if (task.mine && task.screen && task.waitingFor && !task.pending.length) {
      if (views.of(task.key) !== 'session') views.pick(task.key, 'session')
      if (!task.terminal) void act(() => api.openRunnerTask(task.key))
    }
  }, [focus?.key, focus?.seq, tasks, views, act])

  const installed = status.filter((s) => s.installed)
  // In the list: what waits for you or works, what finished within a day, and what finished that you have not opened (that
  // never folds away unseen). Older tasks fold under Earlier. Both are organized the same way (groupTasks), with the person's
  // own arrangement over Togle's: the groups they made, the names they gave, the tasks they moved.
  const recent = (task: TaskView): boolean => needsYou(task) || task.state === 'working' || isFresh(task) || now - task.updatedAt < RECENT_MS
  const shown = groupTasks(tasks.filter(recent), arrangement, true)
  const earlier = tasks.filter((task) => !recent(task))
  const earlierGroups = groupTasks(earlier, arrangement, false)
  // Which group each task is in, as the list shows it: a task's header shows the same, and a row names its folder when its
  // group is not its folder's.
  const placeOf = new Map<string, TaskGroup>()
  for (const group of [...shown, ...earlierGroups]) for (const task of [...group.loose, ...group.subjects.flatMap((subject) => subject.tasks)]) placeOf.set(task.key, group)
  // A task dropped on a group (or on a subject in one) is moved there; dropped back where Togle puts it, the move is undone.
  const dropTask = (key: string, group: string, subject?: string): void => {
    const task = tasks.find((item) => item.key === key)
    if (!task || group === 'scheduled') return
    if (group === ownGroup(task) && (subject ?? '') === (task.subject?.trim() ?? '')) changeGroups({ kind: 'put-back', task: key })
    else changeGroups({ kind: 'place', task: key, group, ...(subject ? { subject } : {}) })
  }
  // A group and a subject take a dropped task (not Scheduled: only scheduled jobs are there). Folded, one opens when the
  // task stays over it a moment (and folds again if the task goes elsewhere), and one the task is dropped in opens for good.
  const dropOn = (group: string, subject = '') => {
    const here = (was: { group: string; subject: string } | undefined): boolean => was?.group === group && was.subject === subject
    return group === 'scheduled'
      ? {}
      : {
          onDragOver: (event: ReactDragEvent) => {
            if (!dragging) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'move'
            setDropAt((was) => (here(was) ? was : { group, subject }))
          },
          onDragLeave: (event: ReactDragEvent) => {
            if (!(event.currentTarget as Node).contains(event.relatedTarget as Node)) setDropAt((was) => (here(was) ? undefined : was))
          },
          onDrop: (event: ReactDragEvent) => {
            event.preventDefault()
            event.stopPropagation()
            const key = event.dataTransfer.getData(DRAG) || dragging
            setDropAt(undefined)
            setDragging(undefined)
            setSprung(new Set())
            if (!key) return
            dropTask(key, group, subject || undefined)
            if (folded.has(group)) toggleFold(group, false)
            if (subject && subjectFolded(arrangement, group, subject)) changeGroups({ kind: 'fold-subject', group, subject, folded: false })
          }
        }
  }
  // Where a dragged task is, when that is a folded box or heading: it opens there after a moment.
  const overSpot = dragging && dropAt ? spot(dropAt.group, dropAt.subject) : undefined
  const overFolded = !!dropAt && (dropAt.subject ? subjectFolded(arrangement, dropAt.group, dropAt.subject) : folded.has(dropAt.group))
  useEffect(() => {
    if (!overSpot || !overFolded || sprung.has(overSpot)) return
    const timer = setTimeout(() => setSprung((was) => new Set(was).add(overSpot)), SPRING_MS)
    return () => clearTimeout(timer)
  }, [overSpot, overFolded, sprung])
  // The name typed for a group, kept once, however the box closes (Enter, Escape or a click elsewhere).
  const finishRename = (group: TaskGroup, typed: string): void => {
    if (renaming !== group.key) return
    setRenaming(undefined)
    const name = typed.trim()
    if (name && name !== group.name) changeGroups({ kind: 'rename', group: group.key, name })
  }
  // A new group, named by the person straight away.
  const newGroup = (task?: string): void => {
    const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    changeGroups({ kind: 'make', id, name: 'New group' })
    if (task) changeGroups({ kind: 'place', task, group: madeKey(id) })
    setRenaming(madeKey(id))
  }
  const row = (task: TaskView, old = false): ReactNode => (
    <TaskRow
      key={task.key}
      task={task}
      now={now}
      old={old}
      selected={task.key === selected}
      withFolder={kindOf(task) === 'project' && placeOf.get(task.key)?.key !== ownGroup(task)}
      dragging={dragging === task.key}
      onSelect={() => setSelected(task.key)}
      onTakeOver={takesOver(task) ? () => { setTakingOver(task.key); setSelected(task.key) } : undefined}
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG, task.key)
        event.dataTransfer.effectAllowed = 'move'
        setDragging(task.key)
      }}
      onDragEnd={() => {
        setDragging(undefined)
        setDropAt(undefined)
        setSprung(new Set())
      }}
      onMenu={(at) => setRowMenu({ at, key: task.key })}
    />
  )
  // A group is a box. Its head folds it (a folded box keeps its counts and still takes a dropped task) and has its own menu
  // on a right-click (or the menu key): Rename, Togle's own name back, Delete a group the person made. Its mark (a letter on
  // its color; a clock for scheduled jobs, a house for Everyday), its name, where a project's folder is, and what waits, works
  // and is new in it.
  // A subject heading in it folds the same way: it says how many tasks it holds and, folded, what waits, works and is new
  // in them; it still takes a dropped task, and it shows when the task open is in it. Its tasks hang from it on a line.
  const groupBox = (group: TaskGroup, old: boolean): ReactNode => {
    const isFolded = folded.has(group.key) && !sprung.has(spot(group.key))
    const hasOpen = isFolded && [...group.loose, ...group.subjects.flatMap((subject) => subject.tasks)].some((task) => task.key === selected)
    return (
      <section key={group.key} className={`task-project ${group.kind}${isFolded ? ' folded' : ''}${dropAt?.group === group.key && !dropAt.subject ? ' drop' : ''}${hasOpen ? ' has-open' : ''}`} aria-label={group.name} {...dropOn(group.key)}>
        <div
          className="task-project-head"
          onContextMenu={old || renaming === group.key ? undefined : (event) => {
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            // From the menu key there is no pointer: the menu opens by the head.
            setGroupMenu({ key: group.key, at: event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left + 24, y: box.bottom - 4 } })
          }}
        >
          {renaming === group.key ? (
            <span className="group-renaming">
              <GroupMark group={group} />
              <input
                className="group-rename"
                aria-label={`A name for ${group.name}`}
                defaultValue={group.name}
                maxLength={60}
                autoFocus
                onFocus={(event) => event.currentTarget.select()}
                // Enter keeps the name, Escape keeps the one it had, and a click elsewhere keeps what was typed.
                onKeyDown={(event) => {
                  if (event.key === 'Enter') finishRename(group, event.currentTarget.value)
                  else if (event.key === 'Escape') finishRename(group, group.name)
                }}
                onBlur={(event) => finishRename(group, event.currentTarget.value)}
              />
            </span>
          ) : (
            // The counts' words are on all of the head (its title); its menu is a right-click.
            <button type="button" className="group-fold" aria-expanded={!isFolded} title={old ? undefined : countWords(group.counts) || undefined} onClick={() => toggleFold(group.key)}>
              <span className="fold-chevron" aria-hidden="true"><Icon name="chevron" size={12} /></span>
              <GroupMark group={group} />
              <span className="task-project-title">
                <span className="task-project-name">{group.name}</span>
                <span className="task-project-sub">
                  <span className="task-project-where" title={group.folder || undefined}>
                    {group.kind === 'project' ? group.where : group.kind === 'scheduled' ? 'Jobs that run by themselves' : group.kind === 'everyday' ? 'Not in a project' : 'Your group'}
                  </span>
                </span>
              </span>
              {/* What waits, works and is new in it, at the head's right, level with its mark: numbers only, the words on the pointer. */}
              {!old && <Counts counts={group.counts} />}
            </button>
          )}
        </div>
        {!isFolded && (
          <>
            {!!group.loose.length && <div className="task-list" role="list">{group.loose.map((task) => row(task, old))}</div>}
            {group.subjects.map((subject) => {
              const subjectIsFolded = subjectFolded(arrangement, group.key, subject.name) && !sprung.has(spot(group.key, subject.name))
              const holdsOpen = subjectIsFolded && subject.tasks.some((task) => task.key === selected)
              const held = `${subject.tasks.length} tasks`
              return (
                <div key={subject.name} className={`task-subject${subjectIsFolded ? ' folded' : ''}${dropAt?.group === group.key && dropAt.subject === subject.name ? ' drop' : ''}${holdsOpen ? ' has-open' : ''}`} role="group" aria-label={subject.name} {...dropOn(group.key, subject.name)}>
                  <button type="button" className="subject-fold" aria-expanded={!subjectIsFolded} onClick={() => changeGroups({ kind: 'fold-subject', group: group.key, subject: subject.name, folded: !subjectIsFolded })}>
                    <span className="fold-chevron" aria-hidden="true"><Icon name="chevron" size={11} /></span>
                    <span className="task-subject-name" title={subject.name}>{subject.name}</span>
                    <span className="subject-count" role="img" aria-label={held} title={held}>{subject.tasks.length}</span>
                    {subjectIsFolded && !old && <Counts counts={subject.counts} />}
                  </button>
                  {!subjectIsFolded && <div className="task-list" role="list">{subject.tasks.map((task) => row(task, old))}</div>}
                </div>
              )
            })}
            {group.kind === 'made' && !group.loose.length && !group.subjects.length && <p className="group-empty">Drag a task here, or right-click one and pick Move to.</p>}
          </>
        )}
      </section>
    )
  }
  const projectList = (groups: TaskGroup[], old: boolean): ReactNode => groups.map((group) => groupBox(group, old))
  // A group head's own menu (right-click, or the menu key): rename it, take Togle's own name back, delete one the person made.
  const menuGroup = groupMenu ? shown.find((group) => group.key === groupMenu.key) : undefined
  const groupItems = menuGroup
    ? [
        { label: 'Rename', onSelect: () => setRenaming(menuGroup.key) },
        ...(menuGroup.renamed ? [{ label: 'Use Togle’s name', onSelect: () => changeGroups({ kind: 'rename', group: menuGroup.key, name: '' }) }] : []),
        ...(menuGroup.kind === 'made' ? [{ label: 'Delete group', danger: true, onSelect: () => changeGroups({ kind: 'remove', group: menuGroup.key }) }] : [])
      ]
    : []
  // A row's own menu (right-click, or the menu key): move it to another group, or a new one, or put it back where Togle puts it.
  const menuTask = rowMenu ? tasks.find((task) => task.key === rowMenu.key) : undefined
  const menuItems = menuTask
    ? [
        ...shown
          .filter((group) => group.kind !== 'scheduled' && group.key !== placeOf.get(menuTask.key)?.key)
          .map((group) => ({ label: `Move to ${group.name}`, onSelect: () => dropTask(menuTask.key, group.key) })),
        { label: 'Move to a new group', onSelect: () => newGroup(menuTask.key) },
        ...(menuTask.key in arrangement.placed ? [{ label: 'Put back where Togle puts it', onSelect: () => changeGroups({ kind: 'put-back', task: menuTask.key }) }] : [])
      ]
    : []
  // The task on screen, told to main: one that finished is not new once it has been seen here.
  const onScreen = detail?.task.key ?? null
  useEffect(() => {
    api.taskOnScreen(onScreen)
  }, [onScreen])
  useEffect(() => () => api.taskOnScreen(null), [])
  const reach = useReach()
  const remoteSelected = selected?.startsWith(REMOTE)
    ? remote.flatMap((device) => device.tasks.map((task) => ({ device, task }))).find(({ device, task }) => remoteKey(device.device, task.key) === selected)
    : undefined

  return (
    <div className={`tasks ${selected ? 'has-detail' : ''}${panes.listHidden ? ' list-hidden' : ''}`} style={panes.list === undefined ? undefined : ({ '--list-width': `${panes.list}px` } as CSSProperties)} aria-label="Tasks" ref={tasksBox}>
      <aside ref={listBox} className="tasks-list" aria-label={remote.length ? 'Agent tasks on your devices' : 'Agent tasks on this computer'} onScroll={(event) => { listScroll = event.currentTarget.scrollTop }}>
        <WaitLine waiting={!loaded} label="Reading the tasks" />
        <div className="tasks-head">
          <span className="tasks-label">This computer</span>
          <span className="tasks-head-actions">
            <button className="ghost small icon-only" aria-label="New group" title="New group: a box of your own, to drag tasks into" onClick={() => newGroup()}>
              <Icon name="folderPlus" size={15} />
            </button>
            <button className="primary small" disabled={!installed.length} onClick={() => void api.openTaskBox({}).catch((caught) => setError(errorText(caught)))}>
              New task
            </button>
          </span>
        </div>
        {rowMenu && menuTask && <PointMenu at={rowMenu.at} label={`Move ${menuTask.title}`} items={menuItems} onClose={() => setRowMenu(null)} />}
        {groupMenu && menuGroup && <PointMenu at={groupMenu.at} label={`Change ${menuGroup.name}`} items={groupItems} onClose={() => setGroupMenu(null)} />}
        {loaded && !installed.length && (status.some((agent) => agent.removed) ? <p className="empty">No agent is on Togle’s lists. Add one back in Settings.</p> : <NoAgents />)}
        {!!shown.length && <div className="task-groups">{projectList(shown, false)}</div>}
        {!!earlier.length && (
          <div className="task-earlier">
            <button className="link task-earlier-toggle" aria-expanded={showEarlier} onClick={() => setShowEarlier(!showEarlier)}>
              Earlier · {earlier.length} task{earlier.length === 1 ? '' : 's'}
            </button>
            {showEarlier && <div className="task-groups">{projectList(earlierGroups, true)}</div>}
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
      <ResizeHandle
        label="Resize the task list"
        className="list-handle"
        size={() => {
          const whole = tasksBox.current?.getBoundingClientRect().width ?? 900
          return { width: panes.listHidden ? 0 : listBox.current?.getBoundingClientRect().width ?? LIST_MIN, min: LIST_MIN, max: Math.max(LIST_MIN, Math.min(LIST_MAX, whole - DETAIL_MIN)) }
        }}
        // Squeezed narrower than its names need it hides, and dragged out again it is back: it has no button for it.
        collapseBelow={LIST_COLLAPSE_BELOW}
        onSize={(width) => setPanes({ list: Math.round(width), listHidden: false })}
        collapsed={panes.listHidden === true}
        onCollapsed={(hidden) => setPanes({ listHidden: hidden })}
      />
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
        ) : detail ? (
          <TaskPanel
            key={detail.task.key}
            detail={detail}
            now={now}
            onBack={() => setSelected(undefined)}
            onAnswer={(requestId, decision) => act(() => api.answerRunnerTask(detail.task.key, requestId, decision))}
            onReply={(requestId, text) => act(() => api.replyRunnerTask(detail.task.key, requestId, text))}
            onSend={(text) => act(() => api.sendToRunnerTask(detail.task.key, text))}
            onHeld={(action, index) => act(() => api.heldRunnerReply(detail.task.key, action, index))}
            onInterrupt={async (text) => {
              let sent = true
              await act(async () => {
                try { await api.interruptRunnerTask(detail.task.key, text) } catch (caught) { sent = false; throw caught }
              })
              return sent
            }}
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
            logRead={logRead}
            place={placeOf.get(detail.task.key)}
          />
        ) : selected && (!loaded || lookingFor === selected) ? (
          <div className="tasks-empty tasks-opening">
            <WaitLine waiting label="Opening the task" words="Opening the task…" />
          </div>
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
            <strong><AgentMark runner={agent.runner} name={agent.name} /></strong> by {agent.maker} ·{' '}
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

interface RowProps {
  task: TaskView
  now: number
  old: boolean
  selected: boolean
  /** Its group is not its folder's (the person moved it): the row names its folder. */
  withFolder: boolean
  dragging: boolean
  onSelect: () => void
  onTakeOver?: () => void
  onDragStart: (event: ReactDragEvent) => void
  onDragEnd: () => void
  /** Its own menu, where it was right-clicked (or its menu key pressed). */
  onMenu: (at: Point) => void
}

function TaskRow({ task, now, old, selected, withFolder, dragging, onSelect, onTakeOver, onDragStart, onDragEnd, onMenu }: RowProps) {
  const stoppedHere = needsYou(task) && task.state !== 'waiting'
  const elsewhere = !task.mine && !!task.pid
  // One line, as the design has it: the agent, where it works, and how it stands. A task in a terminal says so. Stopped
  // and waiting for a reply, it says why; done long ago, it says when.
  const detail = elsewhere ? '' : stoppedHere ? (task.signedOut ? `signed out${task.fix ? ` · sign in with ${task.fix}` : ''}` : task.state === 'failed' ? `stopped by an error${task.line ? ': ' + task.line : ''}` : task.screen ? 'stopped · open it to go on' : 'stopped · reply to go on') : task.state === 'waiting' ? (task.waitingFor && !task.pending.length ? 'waiting on its screen' : 'waiting') : task.state === 'working' ? 'working' : task.state === 'failed' ? 'stopped by an error' : task.state === 'stopped' ? 'stopped' : old ? `done · ${ago(task.updatedAt, now)}` : 'done'
  // A scheduled job's row is the job: its schedule, when it runs next (or that it runs now), and its last run when that failed.
  const job = task.schedule ? [task.state === 'failed' ? 'last run failed' : '', task.schedule, task.state === 'working' ? 'running now' : task.nextRun ? `next ${nextTime(task.nextRun, now)}` : ''].filter(Boolean).join(' · ') : ''
  // Its project is the heading over it, so the line leaves out the folder, unless the person moved it to another group. The agent
  // is its mark (its name is the tooltip), first in the line.
  const line = job || (elsewhere ? 'terminal' : [withFolder ? baseName(task.folder) : '', detail].filter(Boolean).join(' · '))
  const fresh = isFresh(task)
  return (
    <div
      className={`task-item${dragging ? ' dragging' : ''}`}
      role="listitem"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onContextMenu={(event) => {
        event.preventDefault()
        const box = event.currentTarget.getBoundingClientRect()
        // From the menu key there is no pointer: the menu opens by the row.
        onMenu(event.clientX || event.clientY ? { x: event.clientX, y: event.clientY } : { x: box.left + 24, y: box.bottom - 4 })
      }}
    >
      <button className={`task-row ${selected ? 'selected' : ''} ${onTakeOver ? 'with-action' : ''}`} data-state={task.state} data-needs={stoppedHere ? 'you' : undefined} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
        <StateMark kind={markOf(task)} />
        <span className="task-copy">
          <strong>{task.title}</strong>
          <span>
            <AgentLead runner={task.runner} name={agentOf(task)} rest={line} />
            {/* Finished, and not opened since: new until it has been on screen. */}
            {fresh && <span className="task-new"> · new</span>}
          </span>
        </span>
      </button>
      {onTakeOver && <button className="small task-row-action" onClick={onTakeOver}>Take over</button>}
    </div>
  )
}

/**
 * After Hand back: the line that goes on in the person's own terminal, to run in the folder the task worked in, and what they
 * had sent from Chat that waited to go in and now does not (its words, to type there).
 */
function HandedBack({ command, folder, held }: { command: string; folder: string; held?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="task-banner handed-back" role="note">
      <span>
        To open it in your terminal, run <code>{command}</code> in <code>{folder}</code>.
        {held && <> What you sent and was waiting did not go in: <q className="held-back">{held}</q></>}
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

/**
 * At the end of the conversation of a task that works, when no step of it is running (a step that runs has its own clock):
 * that it works, and how long this turn has run. The clock is for the eye only: read out, it would speak every second.
 */
function NowLine({ since }: { since?: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="task-now">
      <span className="now-mark" aria-hidden="true" />
      <span className="now-words">Working…</span>
      {since !== undefined && now >= since && (
        <span className="now-clock" aria-hidden="true">
          {clock(now - since)}
        </span>
      )}
    </div>
  )
}

interface PanelProps {
  detail: TaskDetail
  now: number
  onBack: () => void
  onAnswer: (requestId: string, decision: 'allow-once' | 'allow-always' | 'refuse') => void
  onReply: (requestId: string, text: string) => void
  onSend: (text: string) => void
  /** What waits to go in from Chat: sent now, sent now with the agent stopped first, or taken back (all of it, or one message). */
  onHeld: (action: 'send' | 'drop' | 'interrupt', index?: number) => Promise<void>
  /** Stops what the agent does and sends these words as soon as it has: true when they went in. */
  onInterrupt: (text: string) => Promise<boolean>
  onStop: () => Promise<void>
  onEndCommands: () => Promise<void>
  onOpen: () => Promise<void>
  /** The view the task is shown in, and a pick of the other. */
  view: View
  onView: (view: View) => void
  onTakeOver: () => Promise<void>
  /** Take over was pressed on the task's row: the question that confirms it shows at once. */
  takeOverAsked: boolean
  onHandBack: () => Promise<void>
  /** The task was just handed back: the line that goes on in the person's own terminal, and what waited from Chat. */
  handedBack?: { command: string; folder: string; held?: string }
  /** Whether Togle's own log of the task has been read (a task it does not run has none). */
  logRead: boolean
  /** The group the list shows it in: the header shows the same. */
  place?: TaskGroup
}

/**
 * A press that goes through main and changes the task (a screen opened, the task taken over or handed back, its command ended):
 * the button says what it does while it does it, and the panel takes no second such press, until the task changes or, once main
 * has answered and nothing changed (it refused, and says why), a moment after.
 */
function usePressed(task: TaskView): [string | undefined, (name: string, work: () => Promise<void>) => () => void] {
  const [pressed, setPressed] = useState<string>()
  const changed = `${task.state} ${task.terminal ? 'screen' : ''} ${task.mine ? 'mine' : ''} ${task.screenId ?? ''} ${task.commandsRunning ? 'running' : ''}`
  useEffect(() => setPressed(undefined), [changed])
  const press = (name: string, work: () => Promise<void>) => () => {
    if (pressed) return
    setPressed(name)
    void work().finally(() => setTimeout(() => setPressed((now) => (now === name ? undefined : now)), 1_500))
  }
  return [pressed, press]
}

function TaskPanel({ detail, onBack, onAnswer, onReply, onSend, onHeld, onInterrupt, onStop, onEndCommands, onOpen, view, onView, onTakeOver, takeOverAsked, onHandBack, handedBack, logRead, place }: PanelProps) {
  const { task, log } = detail
  const talkKey = useHotkeys().find((key) => key.id === 'dictate')?.keys || 'F9'
  // A task whose agent has a screen Togle can show is seen in two views; any other task has the one it has.
  const twoViews = task.mine && !!task.screen
  // The agent's own screen is on screen: no card over it and no reply box, because what it asks is answered on it.
  const sessionShown = task.terminal && (!task.screen || view === 'session')
  // What is typed for a task stays with it, when another task or another place is shown and then this one again. A secret (what an
  // agent asks for in a password box) is never kept: it has a box of its own, which goes with the place, and the words typed before
  // are still there when the question is over.
  const secretAsked = task.pending.some((request) => request.kind === 'question' && !!request.questions?.[0]?.secret)
  const [typed, setTyped] = useKeptState(`reply:${task.key}`, '')
  const [hidden, setHidden] = useState('')
  useEffect(() => { if (!secretAsked) setHidden('') }, [secretAsked])
  const text = secretAsked ? hidden : typed
  const setText = (value: string): void => (secretAsked ? setHidden(value) : setTyped(value))
  // A part of a message the person is answering (Quote over a selection): it goes with their next reply, and with no other.
  const [quoted, setQuoted] = useKeptState<string | null>(`quote:${task.key}`, null)
  const thread = useRef<HTMLDivElement>(null)
  const replyText = useRef<HTMLTextAreaElement>(null)
  // Stop, and the presses that open or move the task's screen: each says what it does until the task changes.
  const [pressed, press] = usePressed(task)
  const [confirmTakeOver, setConfirmTakeOver] = useState(takeOverAsked)
  useEffect(() => { if (takeOverAsked) setConfirmTakeOver(true) }, [takeOverAsked])
  const logBox = useRef<HTMLDivElement>(null)
  const running = task.state === 'working' || task.state === 'waiting'
  // The conversation as its agent keeps it, also of what was said before Togle opened the task; else what happened while Togle watched.
  // Read only while Chat is what shows: the agent's screen (open, or closed with Terminal picked) needs none of it.
  const webShown = !sessionShown && !(task.mine && !!task.screen && view === 'session' && !task.terminal)
  const { history, loaded: historyLoaded, all, showAll } = useHistory(task, webShown)
  // Until the agent's record is read (the first time), nothing is shown rather than Togle's own log for a moment: the record is
  // what stays. With no record to read, Togle's own log is the conversation.
  const shown = history ? history.entries : historyLoaded ? log : []
  const readingConversation = webShown && (!historyLoaded || (!history && !logRead))
  // Of the turns shown only, so a count is not given for a conversation that has older turns left out.
  const changed = history?.more && !all ? 0 : changedFiles(shown)
  // The thread stays at its end while new words come, unless the person scrolled up to read: then a button brings the latest back.
  const stick = useRef(threadScrolls.get(task.key)?.stick ?? true)
  // Back on a task that was read higher up: its conversation goes back to where it was, once it is long enough to.
  const restore = useRef<number | null>(threadScrolls.get(task.key)?.stick === false ? threadScrolls.get(task.key)?.top ?? null : null)
  const [away, setAway] = useState(false)
  const toEnd = useCallback((): void => {
    const box = logBox.current
    if (box) box.scrollTop = box.scrollHeight
  }, [])
  // Also when a step ends where it stands, and when the task starts or stops working: the line that says what it does now comes and goes.
  const lastShown = shown[shown.length - 1]
  // "Show earlier" brings turns in above what is in view, and what is in view stays where it is: the first part of the
  // conversation, and where it was in the window, are kept until the earlier turns are in.
  const kept = useRef<{ part: Element; top: number } | null>(null)
  const showEarlierTurns = (): void => {
    const part = logBox.current?.querySelector('.turn, .thread-day')
    if (part) kept.current = { part, top: part.getBoundingClientRect().top }
    showAll()
  }
  useLayoutEffect(() => {
    const box = logBox.current
    if (box && restore.current !== null) {
      if (box.scrollHeight - box.clientHeight >= restore.current) { box.scrollTop = restore.current; restore.current = null }
      // The conversation is all read in and is not that long any more: the end is where it goes.
      else if (historyLoaded) { restore.current = null; stick.current = true; toEnd() }
      return
    }
    if (box && kept.current) {
      if (kept.current.part.isConnected) box.scrollTop += kept.current.part.getBoundingClientRect().top - kept.current.top
      kept.current = null
    } else if (stick.current) toEnd()
  }, [shown.length, lastShown?.id, lastShown?.status, task.pending.length, task.state, toEnd, historyLoaded])
  // The questions asked, from the same entries the thread draws: a rail beside the conversation from the third on.
  const prompts = useMemo(() => promptsOf(shown), [shown])
  const railShown = prompts.length >= 3
  // The turn that was the last one when the task last stood still. A reply makes the task work at once and the agent's
  // record has the reply a moment later: until then that turn is drawn as over, and the clock waits for the new turn.
  const turnKey = lastTurnKey(shown)
  const settledTurn = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!running) settledTurn.current = turnKey
  }, [running, turnKey])
  const newTurn = running && turnKey !== settledTurn.current
  // The entries drawn before, from the same reading (the agent's record, all of it or its last turns, or Togle's own log): an
  // entry not among them comes in with a little motion, once. A reading of its own draws all it has at once, still.
  const reading = `${history ? 'record' : 'log'}${all ? ' all' : ''}`
  const drawn = useRef<{ reading: string; ids: Set<number> } | null>(null)
  const known = drawn.current?.reading === reading ? drawn.current.ids : null
  useEffect(() => {
    if (!historyLoaded && !shown.length) return
    const ids = drawn.current?.reading === reading ? drawn.current.ids : new Set<number>()
    for (const entry of shown) ids.add(entry.id)
    drawn.current = { reading, ids }
  })
  // A step of this turn that runs has its own clock: the line that says it works then waits.
  const turnBegan = shown.map((entry) => entry.kind).lastIndexOf('you')
  const stepRuns = shown.slice(turnBegan + 1).some((entry) => entry.status === 'running')
  // The agent's own checklist for the turn at hand, by the reply box.
  const plan = currentPlan(shown)
  // And when its place gets shorter or taller: a card for what the agent asks, more lines in the reply box, the window.
  useEffect(() => {
    const box = logBox.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(() => {
      if (box.isConnected && stick.current) toEnd()
    })
    watch.observe(box)
    return () => watch.disconnect()
  }, [toEnd, webShown])
  // A question the agent asks is answered from the reply box; anything else typed there goes to the task.
  const question = task.pending.find((request) => request.kind === 'question')
  // What is typed while the agent asks a question answers it, as the agent asks for it: a quote is not part of that.
  useEffect(() => { if (question) setQuoted(null) }, [question])
  const say = (message: string): void => {
    // What the person sends is the newest thing in the conversation, and it shows, wherever they were reading (a reply that
    // quotes a part of an older message is sent from there).
    stick.current = true
    toEnd()
    if (question) onReply(question.id, message)
    // A command of the agent's own (it starts with / or !) goes alone, and the quote waits for a reply that is words.
    else if (quoted && !/^[/!]/.test(message)) {
      onSend(withQuote(quoted, message))
      setQuoted(null)
    } else onSend(message)
    setText('')
  }
  const send = (event: FormEvent): void => {
    event.preventDefault()
    const message = text.trim()
    if (message) say(message)
  }
  // Interrupt: stop what the agent does and send these words as soon as it has stopped. They stay in the box until they have
  // gone in, and stay if they could not. (What is queued waits for the end of the turn they start.)
  const [interrupting, setInterrupting] = useState(false)
  const interruptible = running && !question && !!text.trim()
  const interrupt = async (): Promise<void> => {
    const message = text.trim()
    if (!message || interrupting || !interruptible) return
    const withIt = !!quoted && !/^[/!]/.test(message)
    stick.current = true
    toEnd()
    setInterrupting(true)
    const sent = await onInterrupt(withIt && quoted ? withQuote(quoted, message) : message)
    setInterrupting(false)
    if (!sent) return
    setText('')
    if (withIt) setQuoted(null)
  }
  // The agent's own commands, listed over the reply box while a "/" and the start of a name are typed, and its models
  // after "/model ". What the agent offers is asked when the task opens, and again when a "/" starts the reply.
  const [offers, setOffers] = useState<TaskOffers>(NO_OFFERS)
  const slashed = text.startsWith('/')
  // Terminal picked and its screen is closed: what waits is answered on a card until the screen is opened.
  const closedSession = task.mine && !!task.screen && view === 'session' && !task.terminal
  const cardsView = !sessionShown && !closedSession
  const answers = task.mine && cardsView
  // The part of one message the person has selected in the conversation, for a Quote button over it.
  const spot = useQuoteSpot(thread, answers && !question)
  const quote = (words: string): void => {
    setQuoted(words)
    window.getSelection()?.removeAllRanges()
    replyText.current?.focus()
  }
  // An agent that can only be written to on its screen takes words when its turn has ended (Codex takes them while it works too):
  // what is sent while it works waits, and goes in then. The box takes words all the while.
  const holdsReply = !!task.screen && task.runner !== 'codex' && (task.state === 'working' || task.state === 'waiting' || !!task.waitingFor) && !task.pending.some((request) => request.kind === 'question')
  const replyHint = holdsReply ? `Reply: it goes in when ${agentOf(task)} finishes` : 'Reply, or hold ' + talkKey + ' and talk'
  // What waits to go in, and why it has not: it goes in by itself when the turn ends, unless the task stopped or it did not go in.
  const held = task.held ?? []
  const heldWaitsForYou = !!task.heldPaused || task.state === 'stopped' || task.state === 'failed'
  const heldLine = task.heldNote ? `It did not go in: ${task.heldNote}` : heldWaitsForYou ? 'Not sent: the task stopped.' : `Goes in when ${agentOf(task)} finishes this turn.`
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
  const keyed = (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>): void => {
    // Words still being put together (Korean, Japanese, Chinese): Enter picks them there, and sends nothing.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (!listed) {
      // In the box of several lines, Enter sends and Shift+Enter starts a new line. (A password's box sends as any form does.)
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && interruptible && event.currentTarget instanceof HTMLTextAreaElement) {
        // Ctrl+Enter interrupts: it stops what the agent does and sends these words now.
        event.preventDefault()
        void interrupt()
      } else if (event.key === 'Enter' && !event.shiftKey && event.currentTarget instanceof HTMLTextAreaElement) {
        event.preventDefault()
        const message = text.trim()
        if (message) say(message)
      } else if (event.key === 'Escape' && quoted) {
        // Esc lets go of the quote, as it closes the list of commands.
        event.preventDefault()
        event.stopPropagation()
        setQuoted(null)
      }
      return
    }
    const count = listed.items.length
    if (event.key === 'ArrowDown') { event.preventDefault(); setPicked((at + 1) % count) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setPicked((at + count - 1) % count) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setClosed(true) }
    // Tab completes the name, to go on typing what follows it.
    else if (event.key === 'Tab') { event.preventDefault(); setText(listed.kind === 'models' ? `/model ${listed.items[at].id}` : `/${listed.items[at].name} `) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(at) }
  }
  // Where it is, as the list has it: its box, and the heading it is under there.
  const where = place ? place.name : kindOf(task) === 'project' ? baseName(task.folder) : kindOf(task) === 'scheduled' ? 'Scheduled' : 'Everyday'
  const heading = place?.subjects.find((subject) => subject.tasks.some((one) => one.key === task.key))?.name
  return (
    <div className="task-panel">
      <header className="task-header">
        <button className="ghost small tasks-back" onClick={onBack} aria-label="Back to the list">
          <Icon name="back" size={14} />
        </button>
        {/* From its box to it, on one line: the box's mark and name as in the list, the heading it is under, then its name. */}
        <div className="task-title">
          <span className="crumb crumb-place" title={task.folder || undefined}>
            {place && <GroupMark group={place} size="small" />}
            <span className="crumb-words">{where}</span>
          </span>
          <CrumbGap />
          {heading && (
            <>
              <span className="crumb crumb-heading" title={heading}><span className="crumb-words">{heading}</span></span>
              <CrumbGap />
            </>
          )}
          <h2 title={task.title}>{task.title}</h2>
        </div>
        <div className="task-actions">
          {/* Stop, then what follows from it, then Hand back, as the design page has them in a header. */}
          {task.mine && running && (
            <button className="small" disabled={!!pressed} onClick={press('stop', onStop)} title={task.screen ? 'Ends the agent’s turn, as Esc does on its screen (Ctrl+C in Hermes).' : undefined}>
              {pressed === 'stop' ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {task.mine && task.commandsRunning && task.state === 'stopped' && (
            <button className="small" disabled={!!pressed} onClick={press('end', onEndCommands)} title="Stop ended the agent's turn. The command it started is still running.">
              {pressed === 'end' ? 'Ending…' : 'End the running command'}
            </button>
          )}
          {task.mine && task.screen && (
            <button className="small" disabled={!!pressed} onClick={press('hand back', onHandBack)} title="Closes its screen here and gives you the line to open it in your own terminal. The task goes on.">
              {pressed === 'hand back' ? 'Handing back…' : 'Hand back'}
            </button>
          )}
        </div>
      </header>
      <div className="task-status">
        <span className="state-chip" data-state={task.signedOut ? 'failed' : task.state}><StateMark kind={task.signedOut ? 'failed' : chipMark(task.state, task.schedule)} still />{task.signedOut ? 'Signed out' : STATE_WORDS[task.state]}</span>
        <span className="task-agent-name"><AgentMark runner={task.runner} name={agentOf(task)} /></span>
        {changed > 0 && <span className="hint">{`${changed} ${changed === 1 ? 'file' : 'files'} changed`}</span>}
        {twoViews && (
          <span className="segmented view-switch" role="group" aria-label="View">
            {(['cards', 'session'] as const).map((name) => (
              <button key={name} type="button" className={view === name ? 'on' : ''} aria-pressed={view === name} onClick={() => onView(name)} title={name === 'cards' ? 'The conversation, a card for what the agent asks, and a reply box.' : 'The agent’s own screen.'}>
                {name === 'cards' ? 'Chat' : 'Terminal'}
              </button>
            ))}
          </span>
        )}
      </div>

      {task.mine && task.signedOut && <SignedOut task={task} />}

      {handedBack && !task.terminal && <HandedBack command={handedBack.command} folder={handedBack.folder} held={handedBack.held} />}

      {!task.mine && (
        <div className="task-banner" role="note">
          {takesOver(task) ? (
            confirmTakeOver ? (
              <>
                <span>This ends the {agentOf(task)} running in its terminal and moves the same conversation into the background, with its screen here.</span>
                <span className="row">
                  <button className="primary small" disabled={!!pressed} onClick={press('take over', onTakeOver)}>
                    {pressed === 'take over' ? 'Taking over…' : 'End it and take over'}
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
              <button className="primary small" disabled={!!pressed} onClick={press('open', onOpen)}>
                {pressed === 'open' ? 'Opening…' : 'Open here'}
              </button>
            </>
          ) : task.pid ? (
            <span>It runs in its own window, where it is answered.</span>
          ) : (
            <>
              <span>{task.runner in KNOWN_AGENTS ? `Togle is not running this task. Continue it here: it opens as ${agentOf(task)}'s own screen, to answer there.` : 'Togle is not running this task. Continue it here to answer it and reply to it.'}</span>
              <button className="primary small" disabled={!!pressed} onClick={press('open', onOpen)}>
                {pressed === 'open' ? 'Opening…' : 'Continue here'}
              </button>
            </>
          )}
        </div>
      )}

      {sessionShown ? (
        // The agent's own screen, with no card over it and no reply box: what it asks is answered on it, and a notice still comes.
        <TerminalPanel task={task} ending={pressed === 'end'} onEnd={press('end', onEndCommands)} />
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
            <button className="primary small" disabled={!!pressed} onClick={press('open', onOpen)}>
              {pressed === 'open' ? 'Opening…' : 'Open the screen'}
            </button>
          </div>
        </>
      ) : (
      <>
      {/* The conversation has the room between the task's lines and the reply box, which is at the foot of the pane. */}
      <div className="thread-place" ref={thread}>
        <WaitLine waiting={readingConversation} label="Reading the conversation" words="Reading the conversation…" />
        <div
          className={`task-log thread${railShown ? ' has-rail' : ''}`}
          role="log"
          aria-label="The conversation"
          ref={logBox}
          onScroll={(event) => {
            const box = event.currentTarget
            const left = box.scrollHeight - box.scrollTop - box.clientHeight
            stick.current = left < 60
            restore.current = null
            threadScrolls.set(task.key, { top: box.scrollTop, stick: stick.current })
            setAway(left > 160)
            // Scrolled while earlier turns were on their way: the place they were asked from is not gone back to.
            kept.current = null
          }}
        >
          {history?.more && !all && <button type="button" className="link task-earlier-turns" onClick={showEarlierTurns}>Show earlier</button>}
          {shown.length === 0 && !readingConversation && task.mine && <p className="hint">{task.screen ? 'Nothing said yet. Pick Terminal to see its screen.' : 'Nothing yet.'}</p>}
          {shown.length === 0 && !readingConversation && !task.mine && <p className="hint">Togle shows what happens in a task once it runs it.</p>}
          {/* The whole conversation, in order: a turn that is over as what was asked, a line for the work and the answer; the turn going on in the open. */}
          <Thread entries={shown} state={task.state} settled={settledTurn.current} taskKey={task.key} known={known} stepsRun={running || task.commandsRunning} />
          {/* That it works, and for how long this turn has run: when no step of it runs, which has its own clock. */}
          {task.state === 'working' && !stepRuns && <NowLine since={newTurn ? turnStart(shown) : undefined} />}
        </div>
        {spot && <QuoteFloat spot={spot} onQuote={() => quote(spot.text)} />}
        {railShown && <ThreadRail key={task.key} prompts={prompts} log={logBox} onEarlier={history?.more && !all ? showEarlierTurns : undefined} onLeaveEnd={() => { stick.current = false }} />}
        {away && (
          <button
            type="button"
            className="thread-jump"
            aria-label="Go to the latest"
            onClick={() => {
              stick.current = true
              const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
              logBox.current?.scrollTo({ top: logBox.current.scrollHeight, behavior: still ? 'auto' : 'smooth' })
            }}
          >
            <Icon name="down" size={13} />
            Latest
          </button>
        )}
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

      {/* The agent's own checklist for the turn at hand, on top of the reply box. */}
      {plan && <PlanCard key={`${task.key} ${lastTurnKey(shown) ?? ''}`} plan={plan} />}

      {/* What was sent while the agent worked, waiting for its turn to end: as it will be said, with when it goes in. */}
      {task.mine && held.length > 0 && (
        <div className="held-reply" role="status" aria-label="Queued messages">
          <div className="held-head">
            <span className="held-title">Queued</span>
            <span className="held-count" aria-label={`${held.length} ${held.length === 1 ? 'message' : 'messages'}`}>{held.length}</span>
          </div>
          <ol className="held-words">
            {held.map((words, index) => {
              const split = splitQuote(words)
              return (
                <li key={index} className="held-row">
                  <span className="held-text">{split && <QuoteBlock text={split.quote} />}{split ? split.reply : words}</span>
                  <span className="held-row-actions">
                    {/* Back in the box to change, when the box is empty. */}
                    {!text && (
                      <button type="button" className="ghost small held-edit" aria-label={`Edit queued message ${index + 1}`} title="Put it back in the box to change it" onClick={() => {
                        if (split) { setQuoted(split.quote); setText(split.reply) } else setText(words)
                        void onHeld('drop', index)
                        replyText.current?.focus()
                      }}>Edit</button>
                    )}
                    <button type="button" className="ghost small held-remove" aria-label={`Remove queued message ${index + 1}`} title="Take it back" onClick={() => void onHeld('drop', index)}>×</button>
                  </span>
                </li>
              )
            })}
          </ol>
          <div className="held-foot">
            <span className={task.heldNote ? 'held-line bad' : 'held-line'}>{heldLine}</span>
            <span className="held-actions">
              {heldWaitsForYou
                ? <button type="button" className="small" disabled={!!pressed} onClick={press('held-send', () => onHeld('send'))}>{pressed === 'held-send' ? 'Sending…' : 'Send now'}</button>
                : <button type="button" className="small" disabled={!!pressed} onClick={press('held-interrupt', () => onHeld('interrupt'))} title={`Stops what ${agentOf(task)} is doing and sends what is queued now`}>{pressed === 'held-interrupt' ? 'Interrupting…' : 'Interrupt and send'}</button>}
              {held.length > 1 && <button type="button" className="ghost small" onClick={() => void onHeld('drop')}>Remove all</button>}
            </span>
          </div>
        </div>
      )}

      {task.mine && (
        <div className="task-reply-place" ref={replyPlace}>
          {listed && (
            <div className={room.under ? 'slash-list under' : 'slash-list'} style={{ maxHeight: room.height }} id="slash-list" role="listbox" aria-label={listed.kind === 'models' ? `${agentOf(task)}'s models` : `${agentOf(task)}'s commands`}>
              {listed.kind === 'models'
                ? listed.items.map((model, row) => (
                    <button type="button" role="option" id={`slash-${row}`} aria-selected={row === at} className={row === at ? 'on' : ''} ref={row === at ? pickedRow : undefined} key={model.id} title={model.description || undefined} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setPicked(row)} onClick={() => choose(row)}>
                      <b>{model.name}</b>
                      <small>{model.description}</small>
                    </button>
                  ))
                : listed.items.map((command, row) => (
                    <button type="button" role="option" id={`slash-${row}`} aria-selected={row === at} className={row === at ? 'on' : ''} ref={row === at ? pickedRow : undefined} key={command.name} title={`/${command.name}${command.hint ? ` ${command.hint}` : ''}${command.description ? `\n${command.description}` : ''}`} onMouseDown={(event) => event.preventDefault()} onMouseMove={() => setPicked(row)} onClick={() => choose(row)}>
                      <b>/{command.name}{command.hint && <span> {command.hint}</span>}</b>
                      <small>{command.description}</small>
                    </button>
                  ))}
            </div>
          )}
          {quoted && !question && <QuoteBar quote={quoted} onRemove={() => { setQuoted(null); replyText.current?.focus() }} />}
          <form className="task-reply" onSubmit={send}>
            {/* A box that grows with what is typed: Enter sends, Shift+Enter starts a new line. A password is one line, and not shown. */}
            {question?.questions?.[0]?.secret ? (
              <input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={keyed} placeholder={replyHint} aria-label="Reply to the agent" type="password" />
            ) : (
              <textarea ref={replyText} rows={1} value={text} onChange={(event) => setText(event.target.value)} onKeyDown={keyed} placeholder={replyHint} aria-label="Reply to the agent" aria-autocomplete="list" aria-controls={listed ? 'slash-list' : undefined} aria-activedescendant={listed ? `slash-${at}` : undefined} />
            )}
            {interruptible && (
              <button type="button" className="reply-interrupt small" disabled={interrupting} onClick={() => void interrupt()} title={`Stops what ${agentOf(task)} is doing and sends this now (Ctrl+Enter)`}>
                <Icon name="stop" size={11} />
                {interrupting ? 'Interrupting…' : 'Interrupt'}
              </button>
            )}
            <button className={text.trim() ? 'reply-send primary' : 'reply-send'} disabled={!text.trim()} aria-label={holdsReply ? 'Send when it finishes' : 'Send'} title={holdsReply ? `It goes in when ${agentOf(task)} finishes` : undefined}>
              <Icon name="send" size={14} />
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
function TerminalPanel({ task, ending, onEnd }: { task: TaskView; ending: boolean; onEnd: () => void }) {
  const running = task.state === 'working' || task.state === 'waiting'
  return (
    <div className="task-terminal">
      {/* The agent's own screen needs no words about itself: it is the screen the person knows. */}
      {!task.screen && (
        <div className="task-banner" role="note">
          <span>{running ? `${agentOf(task)} runs in this terminal. It asks here, and you answer here, as in any terminal.` : `${agentOf(task)} has ended. What it printed stays here.`}</span>
          {running && task.mine && (
            <button className="small" disabled={ending} onClick={onEnd} title="Ends the agent and what it started">
              {ending ? 'Ending…' : 'End it'}
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
      <TerminalView taskKey={task.key} screenId={task.screenId} guard={task.screen ? task.runner : undefined} />
    </div>
  )
}

/** A task on another of the person's devices, in the same one line as a task here. */
function RemoteRow({ task, now, selected, onSelect }: { task: RemoteTask; now: number; selected: boolean; onSelect: () => void }) {
  const detail = task.state === 'waiting' ? 'waiting for you' : task.state === 'working' ? 'working' : task.state === 'failed' ? 'stopped by an error' : task.state === 'stopped' ? 'stopped' : `done · ${ago(task.updatedAt, now)}`
  return (
    <button className={`task-row ${selected ? 'selected' : ''}`} role="listitem" data-state={task.state} aria-current={selected ? 'true' : undefined} onClick={onSelect}>
      <StateMark kind={task.state === 'idle' ? 'done' : task.state} />
      <span className="task-copy">
        <strong>{task.title}</strong>
        <span><AgentLead name={task.agent} rest={`${task.terminal ? 'terminal' : task.folder} · ${detail}`} /></span>
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
        {/* From the device to it, as for a task here: the device, the folder it works in, then its name. */}
        <div className="task-title">
          <span className="crumb crumb-place" title={device.name}>
            <span className="project-mark small device-mark" aria-hidden="true"><Icon name={device.role === 'phone' ? 'phone' : 'monitor'} size={10} /></span>
            <span className="crumb-words">{device.name}</span>
          </span>
          <CrumbGap />
          {!task.terminal && task.folder && (
            <>
              <span className="crumb crumb-heading" title={task.folder}><span className="crumb-words">{task.folder}</span></span>
              <CrumbGap />
            </>
          )}
          <h2 title={task.title}>{task.title}</h2>
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
        <span className="state-chip" data-state={task.state}><StateMark kind={chipMark(task.state)} still />{STATE_WORDS[task.state]}</span>
        <span className="task-agent-name">{task.agent}</span>
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
