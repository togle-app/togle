// Which tasks need the person, as small notices: a command, a change or a question waits, or a turn ended. This only
// decides what to say and what has been said. The window that shows a notice and the mark on the tray are elsewhere.
import type { TaskAttention, TaskNotice, ViewRequest } from '@shared/runner'
import { canAllowHere, shownPart as shown } from '@shared/runner-command'
import { RUNNER_NAMES } from './hub'

const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder

function waitingNotice(task: TaskAttention, request: ViewRequest, others: number): TaskNotice {
  const base = { id: `${task.key}#${request.id}`, kind: 'waiting' as const, key: task.key, title: task.title, where: `${RUNNER_NAMES[task.runner]} · ${baseName(task.folder)}`, requestId: request.id, others }
  if (request.kind === 'question') return { ...base, says: 'asks', detail: shown(request.questions?.[0]?.text ?? 'A question'), detailKind: 'question', canRefuse: false, canAllow: false }
  if (request.kind === 'edit') {
    return { ...base, says: 'wants to change', detail: shown((request.files ?? []).join('\n') || 'a file'), detailKind: 'files', canRefuse: true, canAllow: canAllowHere(request) }
  }
  // Allowing here means having read all of it: a long command, or one that looks dangerous, is allowed in the window.
  return { ...base, says: 'wants to run', detail: shown(request.command ?? request.raw ?? ''), detailKind: 'command', canRefuse: true, canAllow: canAllowHere(request), ...(request.danger ? { danger: request.danger } : {}) }
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
  private readonly last = new Map<string, TaskAttention['state']>()
  private endings = 0

  constructor(private readonly clock: () => number = Date.now) {}

  look(tasks: readonly TaskAttention[]): AttentionLook {
    const now = this.clock()
    const live = new Set<string>()
    const requests: { task: TaskAttention; request: ViewRequest; at: number }[] = []
    for (const task of tasks) {
      for (const request of task.pending) {
        const id = `${task.key}#${request.id}`
        live.add(id)
        if (!this.firstSeen.has(id)) this.firstSeen.set(id, now)
        requests.push({ task, request, at: this.firstSeen.get(id) as number })
      }
    }
    // What is no longer asked is forgotten, so what was closed does not stay in memory.
    for (const id of [...this.firstSeen.keys()]) {
      if (live.has(id)) continue
      this.firstSeen.delete(id)
      this.dismissed.delete(id)
    }
    requests.sort((a, b) => a.at - b.at)
    const waitingTasks = new Set(requests.map(({ task }) => task.key))
    const notices = requests.filter(({ task, request }) => !this.dismissed.has(`${task.key}#${request.id}`)).map(({ task, request }) => waitingNotice(task, request, waitingTasks.size - 1))

    const finished: TaskNotice[] = []
    const present = new Set<string>()
    for (const task of tasks) {
      present.add(task.key)
      const before = this.last.get(task.key)
      this.last.set(task.key, task.state)
      // A turn can end between two looks, so a task seen waiting that is idle now has finished as well.
      if ((before === 'working' || before === 'waiting') && task.state === 'idle') finished.push(this.ending(task, 'done'))
      else if ((before === 'working' || before === 'waiting') && task.state === 'failed') finished.push(this.ending(task, 'failed'))
    }
    for (const key of [...this.last.keys()]) if (!present.has(key)) this.last.delete(key)
    return { waiting: waitingTasks.size, notices, finished }
  }

  /** The person closed a notice: it does not come back. */
  dismiss(id: string): void {
    this.dismissed.add(id)
  }

  private ending(task: TaskAttention, kind: 'done' | 'failed'): TaskNotice {
    return {
      id: `${task.key}#end${++this.endings}`,
      kind,
      key: task.key,
      title: task.title,
      where: `${RUNNER_NAMES[task.runner]} · ${baseName(task.folder)}`,
      says: kind === 'done' ? 'finished' : 'stopped with an error',
      detail: shown(task.line),
      detailKind: 'words',
      canRefuse: false,
      canAllow: false,
      others: 0
    }
  }
}
