// What the rest of the app can do with a coding agent, whichever agent it is. One backend per agent implements it:
// see its tasks, start one, answer what it waits for, stop it, and pick it up again later.
import type { Decision, PendingRequest, RunnerKind, TaskEvent, TaskInfo, TaskOffers, TaskState } from '@shared/runner'

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
  /** The agent's own screen, in a terminal of Togle's own, instead of a conversation Togle shows. Only Claude Code has one. */
  screen?: boolean
  /** With a screen: the flags the program was started with that decide what it does (its model, effort, permission mode), so that it opens the same way. */
  flags?: string[]
}

export interface Detected {
  installed: boolean
  /** What starts it. */
  command?: string
  version?: string
}

/** A task that runs in a terminal of Togle's own: what it printed, and what the person types into it. */
export interface TerminalSide {
  /** What it printed so far (the last part, when it printed a lot), and where that ends among all it ever printed. */
  read(): { text: string; end: number }
  /** What the person types, as their keys send it. */
  write(data: string): void
  resize(cols: number, rows: number): void
  /** The words it was given that its command had no place for, until they are typed in. */
  readonly words?: string
  /** Types those words into it, without pressing Enter: the person does, once the agent is ready for them. */
  typeWords(): void
}

/**
 * A task that is the agent's own screen in a terminal of Togle's own, and which Togle also hears: what the agent asks
 * reaches Togle as a request, and it is answered there or on the screen.
 */
export interface ScreenSide {
  /** The program's id on this computer, while it runs. */
  readonly pid: number | null
  /** The session it is in now: the person can change it on the screen (a cleared conversation is another session). */
  session(): string
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
  /** Present for a task that runs in a terminal of Togle's own. */
  readonly terminal?: TerminalSide
  /** Present for such a task when it is the agent's own screen that Togle hears too (Claude Code). */
  readonly screen?: ScreenSide
  /** The commands and models its agent told it has for this task, so far. Left out by an agent that tells none. */
  offers?(): TaskOffers
}

export interface Backend {
  readonly runner: RunnerKind
  /** Its name as the person reads it, for an agent Togle does not know by name (one added in Settings). */
  readonly name?: string
  detect(): Promise<Detected>
  /** The tasks this agent has on this computer, newest first. */
  list(): Promise<TaskInfo[]>
  start(options: StartOptions): Promise<TaskHandle>
  /** Picks up a task that was started earlier, here or in the agent's own app. */
  resume(id: string, options?: ResumeOptions): Promise<TaskHandle>
  /** Why the agent's own screen cannot be opened here, in words, or nothing when it can: asked before a program is ended for it. */
  screenProblem?(id: string): Promise<string | undefined>
  /** Stops using the agent's program. Tasks stay as they are. */
  close(): Promise<void>
}
