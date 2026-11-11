// Coding agents on this computer (Codex, Claude Code, Hermes) as the rest of Togle sees them: tasks, the state each is
// in, and what a waiting one asks. Each agent has one backend in src/main/runners that turns its own protocol into this.

export type RunnerKind = 'codex' | 'claude' | 'hermes'

/**
 * What a task is doing. `working`: a turn is running. `waiting`: the agent needs the person (a command to allow, a
 * question). `idle`: the turn ended, and a reply starts the next. `stopped`: the person pressed Stop. `failed`: the
 * agent or its program broke.
 */
export type TaskState = 'working' | 'waiting' | 'idle' | 'stopped' | 'failed'

/** One task: an agent's session on this computer. */
export interface TaskInfo {
  /** Its own id in its agent: a Codex thread, a Claude Code session, a Hermes session. */
  id: string
  runner: RunnerKind
  /** What it is for: the name its agent gave it, else what was asked first. */
  title: string
  /** The folder it works in. */
  folder: string
  state: TaskState
  /** When it last changed, in milliseconds. */
  updatedAt: number
  /** The program running it on this computer, when one is: what ends it, so Togle can take the task over. */
  pid?: number
  /** What a task running in another program waits for there ("permission prompt"). */
  waitingFor?: string
}

/** The agents Togle can work with, and whether each is on this computer. */
export interface RunnerStatus {
  runner: RunnerKind
  name: string
  installed: boolean
  version?: string
}

/** One line of what happened in a task, for the window to show. */
export interface LogEntry {
  id: number
  at: number
  /** `you` said it, `agent` answered, `command` ran, `files` changed, `asked` is a request that waits, `note` is anything else worth saying. */
  kind: 'you' | 'agent' | 'command' | 'files' | 'asked' | 'note'
  text: string
  /** A command's outcome. */
  status?: 'running' | 'finished' | 'declined' | 'failed'
}

/** A request as the window shows it: with Togle's mark on a command that looks dangerous. */
export interface ViewRequest extends PendingRequest {
  /** Why the command looks dangerous, in plain words. Only a hint: the whole command is what runs. */
  danger?: string
}

/** A task as the window shows it. */
export interface TaskView extends TaskInfo {
  /** `runner:id`. */
  key: string
  /** Whether Togle runs it, so it can be answered, replied to and stopped here. */
  mine: boolean
  /** What it is doing or waiting for, in one line. */
  line: string
  pending: ViewRequest[]
  /** Whether a command may still be running after Stop (Codex lets one finish), so the second press is offered. */
  commandsRunning: boolean
}

export interface TaskDetail {
  task: TaskView
  log: LogEntry[]
}

/** What the person types to start a task. */
export interface StartRequest {
  runner: RunnerKind
  folder: string
  prompt: string
  title?: string
}

/** One question an agent asks the person, with the answers it suggests. */
export interface AgentQuestion {
  id: string
  text: string
  options: string[]
  /** Whether an answer of their own words is welcome. */
  free: boolean
  /** Whether what they type is a secret (a password), so it is not shown or kept. */
  secret: boolean
}

/** What a waiting task asks. */
export interface PendingRequest {
  id: string
  kind: 'command' | 'edit' | 'question'
  /** A command as it should be read: the shell's wrapping taken off. */
  command?: string
  /** The command exactly as the agent sent it. */
  raw?: string
  folder?: string
  reason?: string
  /** The files an edit changes, or the folder it asks to write in. */
  files?: string[]
  questions?: AgentQuestion[]
  /** The agent also offers "always allow this". It is never passed on to another device. */
  offersAlways: boolean
}

/** The person's answer to a command or an edit. */
export type Decision = 'allow-once' | 'refuse'

export type TaskEvent =
  | { type: 'state'; state: TaskState }
  | { type: 'title'; title: string }
  | { type: 'message'; text: string }
  | { type: 'request'; request: PendingRequest }
  | { type: 'request-ended'; id: string; outcome: 'allowed' | 'refused' | 'answered' | 'cancelled' }
  | { type: 'command'; command: string; status: 'started' | 'finished' | 'declined' | 'failed'; exitCode: number | null }
  | { type: 'files'; paths: string[] }
  | { type: 'turn-ended'; outcome: 'completed' | 'interrupted' | 'failed'; error: string | null }
  | { type: 'error'; message: string }
  | { type: 'ended'; reason: 'closed' | 'crashed' }
