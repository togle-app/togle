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

/** Whether Claude Code in a terminal asks Togle about its commands, and what that depends on. */
export interface ClaudeHookStatus {
  /** Whether Claude Code is on this computer. */
  claude: boolean
  version?: string
  /** Whether that version can start Togle's hook. */
  supported: boolean
  /** The first version that can. */
  minimum: string
  /** Whether Claude Code's settings hold Togle's entry. */
  installed: boolean
  /** Whether that entry starts this Togle the way it would be started now. */
  current: boolean
  /** The settings file. */
  file: string
  /** Why the settings could not be read, in words. */
  problem?: string
}

/** One file that differs from the last commit in a task's folder. */
export interface ChangedFile {
  /** Relative to the folder's repository, with forward slashes. */
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'new'
  /** Lines added and removed; null for a file that is not text. */
  added: number | null
  removed: number | null
}

/** What differs from the last commit in the folder a task works in. */
export interface Changes {
  /** Whether the folder is in a git repository that could be read. */
  git: boolean
  /** Why it could not be read, in words. */
  problem?: string
  /** The repository's branch. */
  branch?: string
  files: ChangedFile[]
  /** All the differences as a unified diff, cut where it gets too long. */
  diff: string
  truncated: boolean
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

/**
 * Whether a task needs the person: it asks, or it is one Togle runs that stopped (by their Stop, or by itself) and
 * waits for a reply to go on. A task stopped in its own window is not Togle's to continue.
 */
export function needsYou(task: Pick<TaskView, 'state' | 'mine'>): boolean {
  return task.state === 'waiting' || (task.mine && (task.state === 'stopped' || task.state === 'failed'))
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

/** What a task Togle runs needs from the person right now, for the small notice and the mark on the tray. */
export interface TaskAttention {
  key: string
  runner: RunnerKind
  title: string
  folder: string
  state: TaskState
  /** What waits to be allowed or answered, oldest first. */
  pending: ViewRequest[]
  /** What the task is doing or said last, in a line. */
  line: string
}

/** A small notice: a task waits for the person, or it finished. */
export interface TaskNotice {
  /** What it is about, so the same thing is not shown twice: the task and its request, or the task and the turn that ended. */
  id: string
  kind: 'waiting' | 'done' | 'failed'
  /** The task, by its key. */
  key: string
  title: string
  /** The agent and the folder: "Codex · api-server". */
  where: string
  /** Follows `where`: "wants to run", "wants to change", "asks", "finished", "stopped with an error". */
  says: string
  /** The command in full, the files, the question, or what the finished task said last. */
  detail: string
  detailKind: 'command' | 'files' | 'question' | 'words'
  /** The request the buttons answer. */
  requestId?: string
  /** Refuse is offered: a command or a change can always be refused. */
  canRefuse: boolean
  /** Allow once is offered: only when all of what is asked is shown here and it does not look dangerous. */
  canAllow: boolean
  /** Why the command looks dangerous, in plain words. */
  danger?: string
  /** How many other tasks wait too. */
  others: number
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
