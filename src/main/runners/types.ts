// What the rest of the app can do with a coding agent, whichever agent it is. One backend per agent implements it:
// see its tasks, start one, answer what it waits for, stop it, and pick it up again later.
import type { Decision, PendingRequest, RunnerKind, TaskEvent, TaskInfo, TaskState } from '@shared/runner'

export interface StartOptions {
  /** The folder the task works in. */
  folder: string
  /** The first thing it is asked. */
  prompt: string
  /** What it is called in the list; the agent's own name for it when left out. */
  title?: string
  /** Whether every command asks the person first. On for a task that starts from another device or from a call. */
  asks?: boolean
}

export interface ResumeOptions {
  asks?: boolean
  /** The folder the task worked in (as `list` told). Claude Code finds a session from there. */
  folder?: string
}

export interface Detected {
  installed: boolean
  /** What starts it. */
  command?: string
  version?: string
}

/** One task Togle is running: it can be watched, answered, stopped and talked to. */
export interface TaskHandle {
  readonly runner: RunnerKind
  /** Its own id in its agent. Known at once for Codex; Claude Code gives it with its first answer. */
  readonly id: string | null
  readonly title: string
  readonly folder: string
  readonly state: TaskState
  /** What it waits for now. */
  readonly pending: readonly PendingRequest[]
  /** Hears what the task does, starting with what already happened (up to the last 500 events). */
  on(listener: (event: TaskEvent) => void): () => void
  /** The next thing it is asked: the first request of a task, or a reply to what it said. */
  send(text: string): Promise<void>
  /** Allows or refuses one command or edit. Allowing is once only. */
  answer(requestId: string, decision: Decision): void
  /** Answers a question the agent asked in words. */
  reply(requestId: string, text: string): void
  /** The first press: the agent starts nothing new. Whether a command already running goes on depends on the agent. */
  stop(): Promise<void>
  /** The second press: ends the commands already running. Resolves with how many it ended. */
  endCommands(): Promise<number>
  /** Lets go of the task. It stays on this computer and can be picked up again. */
  close(): Promise<void>
}

export interface Backend {
  readonly runner: RunnerKind
  detect(): Promise<Detected>
  /** The tasks this agent has on this computer, newest first. */
  list(): Promise<TaskInfo[]>
  start(options: StartOptions): Promise<TaskHandle>
  /** Picks up a task that was started earlier, here or in the agent's own app. */
  resume(id: string, options?: ResumeOptions): Promise<TaskHandle>
  /** Stops using the agent's program. Tasks stay as they are. */
  close(): Promise<void>
}
