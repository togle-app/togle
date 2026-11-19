// What the rest of the app can do with a coding agent, whichever agent it is. One backend per agent implements it:
// see its tasks, start one, answer what it waits for, stop it, and pick it up again later.
import type { BackgroundShell, Decision, PendingRequest, RunnerKind, StepDetail, TaskEvent, TaskHistory, TaskInfo, TaskOffers, TaskState } from '@shared/runner'

export interface StartOptions {
  /** The folder the task works in. */
  folder: string
  /** The first thing it is asked. */
  prompt: string
  /** What it is called in the list; the agent's own name for it when left out. */
  title?: string
  /**
   * Whether every command asks the person first, whatever the agent's own settings say. Off for an agent whose screen
   * follows the person's own settings (Claude Code); on for a task that starts from another device.
   */
  asks?: boolean
}

export interface ResumeOptions {
  asks?: boolean
  /** The folder the task worked in (as `list` told). Claude Code finds a session from there. */
  folder?: string
  /** The id its agent gave a task that runs in the background (`TaskInfo.job`): that task is opened, not started again. */
  job?: string
  /** With a task that is not in the background yet: the flags its program was started with that decide what it does (its model, effort, permission mode), so that it goes on the same way. */
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
 * A task that runs in the background, whose screen is the agent's own, opened in a terminal of Togle's own when the
 * person looks at it. Togle also hears it: what the agent asks reaches Togle as a request, and it is answered there or on
 * the screen. Closing the screen, or quitting Togle, does not stop the task.
 */
export interface ScreenSide {
  /** The id of the program that runs the task, while it runs. */
  readonly pid: number | null
  /** The session it is in now: the person can change it on the screen (a cleared conversation is another session). */
  session(): string
  /** The id its agent gives the task, to open it, stop it and list it. */
  readonly job: string
  /** Whether its screen is open in a terminal of Togle's own. */
  readonly open: boolean
  /** Which screen is open: each new one starts afresh. */
  readonly screenId: string | undefined
  /** Why the screen is closed, when it closed by itself: opened in another window, or could not open. */
  readonly closed: string | undefined
  /** Opens the screen here. A screen open in another window is closed by it, as the agent has one at a time. */
  show(): Promise<void>
  /** Closes the screen here. The task goes on. */
  hide(): Promise<void>
  /** The line that opens the screen in the person's own terminal. */
  readonly line: string
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
  /** Present for a task that runs in a terminal of Togle's own, while that terminal is open. */
  readonly terminal?: TerminalSide
  /** Present for a task that runs in the background and has the agent's own screen, which Togle hears too (Claude Code). */
  readonly screen?: ScreenSide
  /** What a task waits for in its agent's own screen when Togle has no request of its own for it ("permission prompt"). */
  readonly waitingFor?: string
  /**
   * Whether its agent's own screen takes a line typed while a turn only works, in its own way (Claude Code queues it, Hermes steers the
   * turn with it): then Chat types it at once, as Terminal does, and holds words only while something waits on the screen (they would
   * answer it). Without this, words sent while it works wait in Togle until its turn has ended.
   */
  readonly takesWordsWhileWorking?: boolean
  /**
   * Gives what waits in its agent's own queue (words typed while it works) back to the person: it comes out of the queue and its prompt is
   * left empty, so that the words are Chat's to change and send again. All of the queue or none, as Claude Code's Up arrow does it: `words` are
   * what the queue holds, in the order it was typed. Left out by an agent that has no queue of its own.
   */
  takeBackQueue?(words: readonly string[]): Promise<void>
  /** What the task started that still runs in the background, when its agent tells (Claude Code's shells). */
  readonly shells?: readonly BackgroundShell[]
  /** The commands and models its agent told it has for this task, so far. Left out by an agent that tells none. */
  offers?(): TaskOffers
}

export interface Backend {
  readonly runner: RunnerKind
  /** Its name as the person reads it, for an agent Togle does not know by name (one added in Settings). */
  readonly name?: string
  /** Its tasks run in the background and open as the agent's own screen, following the person's own settings (Claude Code). */
  readonly screens?: boolean
  detect(): Promise<Detected>
  /** The tasks this agent has on this computer, newest first. */
  list(): Promise<TaskInfo[]>
  start(options: StartOptions): Promise<TaskHandle>
  /** Picks up a task that was started earlier, here or in the agent's own app. */
  resume(id: string, options?: ResumeOptions): Promise<TaskHandle>
  /**
   * Picks up the tasks Togle ran before and that went on without it, and hands each to `adopt` as it appears: now, and later
   * whenever one of them asks something. Only for an agent whose tasks outlive Togle.
   */
  restore?(adopt: (task: TaskHandle) => void): Promise<void>
  /** Why the agent's own screen cannot be opened here, in words, or nothing when it can: asked before a program is ended for it. */
  screenProblem?(id: string): Promise<string | undefined>
  /**
   * The conversation of a task as the agent keeps it (its last turns, or all of them with `all`), or null when the agent keeps
   * none Togle can read. Left out by an agent that tells none: the window then shows what happened while Togle watched.
   */
  history?(id: string, all: boolean): Promise<TaskHistory | null>
  /**
   * What a step of that conversation holds, to show when it is opened (what a command printed, the words of a thought), by the
   * key the step came with (`LogEntry.more`). Null when nothing is kept under that key. Only a key the agent's own reading of
   * the conversation gave is looked up: the key says nothing of where to read.
   */
  step?(id: string, more: string): Promise<StepDetail | null>
  /**
   * A picture in what the person said in that conversation, by the key its entry came with (`LogEntry.images`): its type and
   * its bytes in base64. Read again from the agent's own record only when the window shows it; null when it is not kept.
   */
  picture?(id: string, key: string): Promise<{ type: string; data: string } | null>
  /** Stops using the agent's program. Tasks that run in the background go on. */
  close(): Promise<void>
}
