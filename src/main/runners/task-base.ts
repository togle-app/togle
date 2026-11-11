// What every running task has in common: its state, who is listening, and what it waits for. A backend adds how its
// agent is spoken to; this keeps the questions in one place so each is answered once and the state follows them.
import type { Decision, PendingRequest, RunnerKind, TaskEvent, TaskState } from '@shared/runner'
import type { TaskHandle } from './types'

/** What the person answered a waiting request with, as the backend hears it. */
export type Answer = { kind: 'decision'; decision: Decision } | { kind: 'text'; text: string } | { kind: 'cancelled' }

interface Wait {
  request: PendingRequest
  settle: (answer: Answer) => void
}

export abstract class TaskBase implements TaskHandle {
  abstract readonly runner: RunnerKind
  id: string | null = null
  title = ''
  folder = ''
  private base: TaskState = 'idle'
  private shown: TaskState = 'idle'
  private readonly listeners = new Set<(event: TaskEvent) => void>()
  private readonly waits = new Map<string, Wait>()

  /** `waiting` whenever a request is open, whatever the agent last said of itself. */
  get state(): TaskState {
    return this.waits.size && this.base !== 'stopped' && this.base !== 'failed' ? 'waiting' : this.base
  }

  get pending(): readonly PendingRequest[] {
    return [...this.waits.values()].map((wait) => wait.request)
  }

  on(listener: (event: TaskEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  protected emit(event: TaskEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch {
        // A listener that fails does not stop the task.
      }
    }
  }

  /** What the agent says of itself changed. */
  protected setBase(next: TaskState): void {
    this.base = next
    this.announce()
  }

  private announce(): void {
    const now = this.state
    if (now === this.shown) return
    this.shown = now
    this.emit({ type: 'state', state: now })
  }

  protected setTitle(title: string): void {
    if (!title || title === this.title) return
    this.title = title
    this.emit({ type: 'title', title })
  }

  /** The agent asks the person. Resolves with the answer, or `cancelled` when the task ends first. */
  protected ask(request: PendingRequest): Promise<Answer> {
    return new Promise<Answer>((resolve) => {
      this.waits.set(request.id, { request, settle: resolve })
      this.emit({ type: 'request', request })
      this.announce()
    })
  }

  /** The request was dealt with elsewhere (in the agent's own app, or by the agent giving up). */
  protected dropRequest(id: string, outcome: 'allowed' | 'refused' | 'answered' | 'cancelled'): void {
    const wait = this.waits.get(id)
    if (!wait) return
    this.waits.delete(id)
    wait.settle({ kind: 'cancelled' })
    this.emit({ type: 'request-ended', id, outcome })
    this.announce()
  }

  /** Every open request ends: the task was stopped or closed, and nothing may be allowed afterwards. */
  protected cancelRequests(): void {
    for (const id of [...this.waits.keys()]) this.dropRequest(id, 'cancelled')
  }

  answer(requestId: string, decision: Decision): void {
    const wait = this.waits.get(requestId)
    if (!wait || wait.request.kind === 'question') return
    this.waits.delete(requestId)
    wait.settle({ kind: 'decision', decision })
    this.emit({ type: 'request-ended', id: requestId, outcome: decision === 'allow-once' ? 'allowed' : 'refused' })
    this.announce()
  }

  reply(requestId: string, text: string): void {
    const wait = this.waits.get(requestId)
    if (!wait || wait.request.kind !== 'question') return
    this.waits.delete(requestId)
    wait.settle({ kind: 'text', text })
    this.emit({ type: 'request-ended', id: requestId, outcome: 'answered' })
    this.announce()
  }

  abstract send(text: string): Promise<void>
  abstract stop(): Promise<void>
  abstract endCommands(): Promise<number>
  abstract close(): Promise<void>
}
