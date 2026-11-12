// Coding agents on this computer (Codex, Claude Code, Hermes) as the rest of Togle sees them: tasks, the state each is
// in, and what a waiting one asks. Each agent has one backend in src/main/runners that turns its own protocol into this.

/** An agent, by its id in task keys: one Togle knows (`codex`, `claude`, `hermes`), or one the person added (`acp-…`). */
export type RunnerKind = string

/** Whether Togle can make the agent ask before every command and every change: Claude Code and Codex. Hermes and an added
 * agent ask as their own settings say. */
export const asksEveryTime = (runner: RunnerKind): boolean => runner === 'claude' || runner === 'codex'

/** The agents Togle knows by name, before any is added. */
export const KNOWN_AGENTS: Readonly<Record<string, string>> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }

/**
 * An agent the person added in Settings: any agent that speaks ACP, started by the command its docs give for that.
 * `id` is its id in task keys ("acp-gemini").
 */
export interface AddedAgent {
  id: string
  name: string
  command: string
}

/** The id an added agent gets from its name: "acp-" and the name's letters and digits ("Gemini CLI" is acp-gemini-cli). */
export const agentIdOf = (name: string): string => `acp-${name.toLowerCase().normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent'}`

/** Why a name and a command cannot be an added agent, or undefined when they can. */
export function addedAgentProblem(name: unknown, command: unknown): string | undefined {
  if (typeof name !== 'string' || !name.trim()) return 'Give the agent a name.'
  if (name.trim().length > 40) return 'Keep the name under 40 characters.'
  if (typeof command !== 'string' || !command.trim()) return 'Give the command that starts it.'
  if (command.length > 500) return 'Keep the command under 500 characters.'
  if (/[\r\n\0]/.test(command)) return 'The command goes on one line.'
  return undefined
}

/** The added agents a settings file holds, each checked: what is not one is left out. */
export function addedAgentsFrom(value: unknown): AddedAgent[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item) => {
    const agent = item as Partial<AddedAgent> | null
    if (!agent || typeof agent.id !== 'string' || !/^acp-[a-z0-9-]{1,40}$/.test(agent.id) || seen.has(agent.id) || addedAgentProblem(agent.name, agent.command)) return []
    seen.add(agent.id)
    return [{ id: agent.id, name: agent.name!.trim(), command: agent.command!.trim() }]
  })
}

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
  /** One the person added, which they can remove. */
  added?: boolean
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
  /** The files a `files` step changed. */
  paths?: string[]
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
  /** Its agent's name, as the person reads it ("Codex", or the name given to an added agent). */
  agent?: string
}

/**
 * Whether a task needs the person: it asks, or it is one Togle runs that stopped (by their Stop, or by itself) and
 * waits for a reply to go on. A task stopped in its own window is not Togle's to continue.
 */
export function needsYou(task: Pick<TaskView, 'state' | 'mine'>): boolean {
  return task.state === 'waiting' || (task.mine && (task.state === 'stopped' || task.state === 'failed'))
}

/** How many files a task changed, by what its log says (each file once). */
export function changedFiles(log: readonly LogEntry[]): number {
  return new Set(log.filter((entry) => entry.kind === 'files').flatMap((entry) => entry.paths ?? [])).size
}

/**
 * What a task did, in one line, for the fold that holds its log: "5 steps: ran 3 commands, changed 2 files, 1 refused".
 * Undefined while it has done nothing but talk.
 */
export function stepsLine(log: readonly LogEntry[]): string | undefined {
  const commands = log.filter((entry) => entry.kind === 'command')
  const ran = commands.filter((entry) => entry.status !== 'declined').length
  const refused = commands.length - ran
  const files = changedFiles(log)
  const steps = commands.length + log.filter((entry) => entry.kind === 'files').length
  if (!steps) return undefined
  const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
  const parts = [...(ran ? [`ran ${plural(ran, 'command', 'commands')}`] : []), ...(files ? [`changed ${plural(files, 'file', 'files')}`] : []), ...(refused ? [`${refused} refused`] : [])]
  return `${plural(steps, 'step', 'steps')}: ${parts.join(', ')}`
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
  /** Its agent's name, for an agent Togle does not know by name. */
  agent?: string
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
  /**
   * For a command, when the agent offers it: what "always allow" would make the agent remember, in words that say how
   * far it reaches ("Always allow this command in api-server", "Always allow commands that start with npm run"). It is
   * the button's words. Never offered for a command that looks dangerous.
   */
  always?: string
}

/** The person's answer to a command or an edit. `allow-always` is only for a request that offers `always`. */
export type Decision = 'allow-once' | 'allow-always' | 'refuse'

export type TaskEvent =
  | { type: 'state'; state: TaskState }
  | { type: 'title'; title: string }
  | { type: 'message'; text: string }
  | { type: 'request'; request: PendingRequest }
  | { type: 'request-ended'; id: string; outcome: 'allowed' | 'always' | 'refused' | 'answered' | 'cancelled' }
  | { type: 'command'; command: string; status: 'started' | 'finished' | 'declined' | 'failed'; exitCode: number | null }
  | { type: 'files'; paths: string[] }
  | { type: 'turn-ended'; outcome: 'completed' | 'interrupted' | 'failed'; error: string | null }
  | { type: 'error'; message: string }
  | { type: 'ended'; reason: 'closed' | 'crashed' }
