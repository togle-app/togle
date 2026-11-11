// Requests that come from a program Togle does not run: a Claude Code session in a terminal whose hook asks about a
// command. Each is held until the person answers it in Togle, or until the question is gone: answered where the session
// runs (the terminal asks at the same time, and either answer counts), or the session's program ended.
import type { Decision, PendingRequest, RunnerKind, TaskState } from '@shared/runner'
import type { AskedPermission } from '../channel/claude-permission'

export interface OutsideAsk {
  runner: RunnerKind
  asked: AskedPermission
}

export interface Held {
  id: string
  /** The session's task, by key: `claude:<session id>`. */
  key: string
  runner: RunnerKind
  sessionId: string
  folder: string
  transcript?: string
  request: PendingRequest
  /** When it came, in milliseconds. */
  at: number
  settle(outcome: Decision | 'gone'): void
  /** Whether the session has been seen waiting since: only then does not waiting mean it moved on. */
  seenWaiting: boolean
  /** How many looks in a row found the session no longer waiting. */
  notWaiting: number
}

/** What a look at the session says. `state` is null when the agent cannot tell. */
export interface Look {
  /** Its transcript grew since the question came, which it does once the question is answered. */
  transcriptGrew: boolean
  state: TaskState | 'gone' | null
}

export interface ExternalOptions {
  changed: () => void
  /** A look at the session of a held request. */
  look?: (held: Held) => Promise<Look>
  /** How often the held requests are looked at, in milliseconds. */
  everyMs?: number
  /** How long a request is left alone before what the agent says about the session is believed, in milliseconds. */
  graceMs?: number
}

/** More than this many at once are not held. */
const MOST = 100

export class ExternalRequests {
  private readonly held = new Map<string, Held>()
  private next = 1
  private timer: NodeJS.Timeout | null = null
  private looking = false

  constructor(private readonly options: ExternalOptions) {}

  /** Holds a request until it is answered, or `signal` says the one who asked has gone. */
  hold(ask: OutsideAsk, signal: AbortSignal): Promise<Decision | 'gone'> {
    if (this.held.size >= MOST || signal.aborted) return Promise.resolve('gone')
    const { asked } = ask
    const id = `ext-${this.next++}`
    return new Promise((resolve) => {
      const entry: Held = {
        id,
        key: `${ask.runner}:${asked.sessionId}`,
        runner: ask.runner,
        sessionId: asked.sessionId,
        folder: asked.folder,
        ...(asked.transcript ? { transcript: asked.transcript } : {}),
        request: {
          id,
          kind: asked.kind,
          ...(asked.command !== undefined ? { command: asked.command } : {}),
          ...(asked.raw !== undefined ? { raw: asked.raw } : {}),
          folder: asked.folder,
          ...(asked.reason ? { reason: asked.reason } : {}),
          ...(asked.files ? { files: asked.files } : {}),
          offersAlways: false
        },
        at: Date.now(),
        seenWaiting: false,
        notWaiting: 0,
        settle: (outcome) => {
          if (!this.held.delete(id)) return
          signal.removeEventListener('abort', gone)
          if (!this.held.size) this.stopLooking()
          this.options.changed()
          resolve(outcome)
        }
      }
      const gone = (): void => entry.settle('gone')
      signal.addEventListener('abort', gone, { once: true })
      this.held.set(id, entry)
      this.startLooking()
      this.options.changed()
    })
  }

  /** The requests of one session, the one that has waited longest first. */
  forKey(key: string): Held[] {
    return [...this.held.values()].filter((entry) => entry.key === key).sort((a, b) => a.at - b.at)
  }

  keys(): string[] {
    return [...new Set([...this.held.values()].map((entry) => entry.key))]
  }

  /** Answers a held request. False when there is none like it (already answered, or gone). */
  answer(key: string, requestId: string, decision: Decision): boolean {
    const entry = this.held.get(requestId)
    if (!entry || entry.key !== key) return false
    entry.settle(decision)
    return true
  }

  /** Lets every held request go: its hook is told nothing was decided, and the question stays where it is asked. */
  dropAll(): void {
    for (const entry of [...this.held.values()]) entry.settle('gone')
    this.stopLooking()
  }

  private startLooking(): void {
    if (this.timer || !this.options.look) return
    this.timer = setInterval(() => void this.lookAll(), this.options.everyMs ?? 3_000)
    this.timer.unref?.()
  }

  private stopLooking(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Asks the agent how each held session is. A question is gone when its session's transcript grew, or when the session
   * was seen waiting and is not any more (twice in a row, so a moment between two answers is not taken for it), which
   * is also what it looks like when its program ended. A session the agent cannot tell about is left to its hook: the
   * hook's end, or Togle's own wait running out, lets it go.
   */
  private async lookAll(): Promise<void> {
    const { look } = this.options
    if (!look || this.looking) return
    this.looking = true
    try {
      for (const entry of [...this.held.values()]) {
        if (Date.now() - entry.at < (this.options.graceMs ?? 8_000)) continue
        const seen = await look(entry).catch(() => ({ transcriptGrew: false, state: null }) as Look)
        if (!this.held.has(entry.id)) continue
        if (seen.transcriptGrew) {
          entry.settle('gone')
          continue
        }
        if (seen.state === 'waiting') {
          entry.seenWaiting = true
          entry.notWaiting = 0
        } else if (seen.state !== null && entry.seenWaiting && ++entry.notWaiting >= 2) entry.settle('gone')
      }
    } finally {
      this.looking = false
    }
  }
}
