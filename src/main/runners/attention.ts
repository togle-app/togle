// Which tasks need the person, as small notices: a command, a change or a question waits, or a turn ended. This only
// decides what to say and what has been said. The window that shows a notice and the mark on the tray are elsewhere.
import { isWork, needsYou, stepsLine, type TaskAttention, type TaskNotice, type ViewRequest } from '@shared/runner'
import { canAllowHere, shownPart as shown } from '@shared/runner-command'
import { projectFolderOf } from '@shared/task-groups'
import { RUNNER_NAMES } from './hub'
import { actionResult, resultExcerpt } from '../task-notification-text'

const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

function taskIdentity(task: TaskAttention) {
  const agent = task.agent || RUNNER_NAMES[task.runner] || task.runner
  return { key: task.key, title: task.title, agent, where: [agent, baseName(projectFolderOf(task.folder))].filter(Boolean).join(' · ') }
}

function waitingNotice(task: TaskAttention, request: ViewRequest, others: number): TaskNotice {
  const base = { ...taskIdentity(task), id: `${task.key}#${request.id}`, kind: 'waiting' as const, requestId: request.id, others, ...(request.reason ? { reason: request.reason } : {}) }
  if (request.kind === 'question') return { ...base, says: 'asks', detail: shown(request.questions?.[0]?.text ?? 'A question'), detailKind: 'question', canRefuse: false, canAllow: false }
  if (request.kind === 'edit') {
    return { ...base, says: 'wants to change', detail: shown((request.files ?? []).join('\n') || 'a file'), detailKind: 'files', canRefuse: true, canAllow: canAllowHere(request) }
  }
  // Allowing here means having read all of it: a long command, or one that looks dangerous, is allowed in the window.
  return { ...base, says: 'wants to run', detail: shown(request.command ?? request.raw ?? ''), detailKind: 'command', canRefuse: true, canAllow: canAllowHere(request), ...(request.danger ? { danger: request.danger } : {}) }
}

/** A task in the background that waits on its own screen, with no request of Togle's own to show (it came while Togle was closed): the notice only opens it. */
function screenNotice(task: TaskAttention, others: number): TaskNotice {
  return {
    id: `${task.key}#screen`,
    kind: 'waiting',
    ...taskIdentity(task),
    says: 'waits on its screen',
    detail: shown(task.waitingFor ?? ''),
    detailKind: 'words',
    canRefuse: false,
    canAllow: false,
    others
  }
}

export interface AttentionLook {
  /** How many tasks wait for the person. */
  waiting: number
  /** What to show for the waiting ones, the one waiting longest first, without any the person closed. */
  notices: TaskNotice[]
  /** The tasks that finished or broke since the last look, once each. */
  finished: TaskNotice[]
}

export class Attention {
  private readonly firstSeen = new Map<string, number>()
  private readonly dismissed = new Set<string>()
  private readonly last = new Map<string, { state: TaskAttention['state']; logAfter: number }>()
  private endings = 0

  constructor(private readonly clock: () => number = Date.now) {}

  look(tasks: readonly TaskAttention[]): AttentionLook {
    const now = this.clock()
    const live = new Set<string>()
    const requests: { task: TaskAttention; request: ViewRequest; at: number }[] = []
    const waitingTasks = tasks.filter(needsYou)
    for (const task of waitingTasks) {
      for (const request of task.pending) {
        const id = `${task.key}#${request.id}`
        live.add(id)
        if (!this.firstSeen.has(id)) this.firstSeen.set(id, now)
        requests.push({ task, request, at: this.firstSeen.get(id) as number })
      }
    }
    // A task in the background that waits with no request of Togle's own: it waits on its screen, and counts like any other.
    const onScreen = waitingTasks.filter((task) => !task.pending.length && !!task.waitingFor)
    for (const task of onScreen) {
      const id = `${task.key}#screen`
      live.add(id)
      if (!this.firstSeen.has(id)) this.firstSeen.set(id, now)
    }
    // What is no longer asked is forgotten, so what was closed does not stay in memory.
    for (const id of [...this.firstSeen.keys()]) {
      if (live.has(id)) continue
      this.firstSeen.delete(id)
      this.dismissed.delete(id)
    }
    requests.sort((a, b) => a.at - b.at)
    const asked = requests.filter(({ task, request }) => !this.dismissed.has(`${task.key}#${request.id}`)).map(({ task, request, at }) => ({ at, notice: waitingNotice(task, request, waitingTasks.length - 1) }))
    const onItsScreen = onScreen.filter((task) => !this.dismissed.has(`${task.key}#screen`)).map((task) => ({ at: this.firstSeen.get(`${task.key}#screen`) as number, notice: screenNotice(task, waitingTasks.length - 1) }))
    const notices = [...asked, ...onItsScreen].sort((a, b) => a.at - b.at).map(({ notice }) => notice)

    const finished: TaskNotice[] = []
    const present = new Set<string>()
    for (const task of tasks) {
      present.add(task.key)
      const previous = this.last.get(task.key)
      const before = previous?.state
      const logAfter = previous?.logAfter ?? 0
      const active = task.state === 'working' || task.state === 'waiting'
      this.last.set(task.key, { state: task.state, logAfter: active ? logAfter : task.log?.at(-1)?.id ?? logAfter })
      // A turn can end between two looks, so a task seen waiting that is idle now has finished as well. A signed-out agent
      // ends its first turn at once, before a look sees it working: that is news too, as the tasks here started in this run.
      if ((before === 'working' || before === 'waiting') && task.state === 'idle') finished.push(this.ending(task, 'done', logAfter))
      else if ((before === 'working' || before === 'waiting' || (before === undefined && task.signedOut)) && task.state === 'failed') finished.push(this.ending(task, 'failed', logAfter))
    }
    for (const key of [...this.last.keys()]) if (!present.has(key)) this.last.delete(key)
    return { waiting: waitingTasks.length, notices, finished }
  }

  /** The person closed a notice: it does not come back. */
  dismiss(id: string): void {
    this.dismissed.add(id)
  }

  private ending(task: TaskAttention, kind: 'done' | 'failed', logAfter: number): TaskNotice {
    // Signed out, it says what signs the agent in again.
    const signedOut = kind === 'failed' && task.signedOut
    const turn = task.log?.filter(entry => entry.id > logAfter) ?? []
    const activity = stepsLine(turn)
    // The task line can still contain an earlier reply. Only use it for completed turns when the runner supplies no log.
    const last = turn.findLast(entry => entry.kind === 'agent' || entry.kind === 'you' || isWork(entry))
    const reply = last?.kind === 'agent' ? last.text : task.log ? '' : task.line
    const result = signedOut ? (task.fix ? `Sign in again with ${task.fix}.` : 'Sign in to the agent to continue.')
      : kind === 'failed' ? resultExcerpt(task.line) || actionResult(turn)
      : resultExcerpt(reply) || actionResult(turn)
    return {
      id: `${task.key}#end${++this.endings}`,
      kind,
      ...taskIdentity(task),
      says: kind === 'done' ? 'finished' : signedOut ? 'is signed out' : 'stopped with an error',
      detail: signedOut && task.fix ? task.fix : shown(task.line),
      ...(activity ? { activity } : {}),
      ...(result ? { result } : {}),
      detailKind: signedOut && task.fix ? 'command' : 'words',
      canRefuse: false,
      canAllow: false,
      others: 0
    }
  }
}
