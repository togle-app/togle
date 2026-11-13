// Claude Code on this computer. Togle starts `claude` as a program of its own, in the folder of the task, and talks to
// it in Claude Code's own streaming format (`--input-format stream-json --output-format stream-json`): one JSON line per
// message each way. It never touches Claude Code's sign-in: the program is the one the person installed and signed in.
//
// What trying it on Windows (Claude Code 2.1.322) showed, which this follows:
// - Permission requests are answered through a hook that posts each one to a port on this computer (claude-hooks.ts).
// - An interrupt (`control_request`) ends the turn and the command that is running, so Stop needs no second press.
// - A reply goes into the same running program. `--resume <id>` in a new program continues the same session.
// - A resumed program may first report an empty result for a background task that finished meanwhile; it is not the
//   end of the turn Togle asked for, which is the first result after something was said.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentQuestion, PendingRequest, TaskInfo, TaskState } from '@shared/runner'
import { claudeSessions } from './claude-sessions'
import { HookServer, type HookTarget, type HookVerdict } from './claude-hooks'
import { list, rec, text } from './jsonrpc'
import { TaskBase } from './task-base'
import type { Backend, Detected, ResumeOptions, StartOptions, TaskHandle } from './types'

/** A session Claude Code has running (`claude agents --json`). */
export interface LiveSession {
  sessionId?: string
  cwd?: string
  kind?: string
  status?: string
  state?: string
  pid?: number
  name?: string
  waitingFor?: string
  startedAt?: number
}

/** A session Claude Code kept on this computer. */
export interface StoredSession {
  id: string
  title: string
  cwd: string
  updatedAt: number
}

export interface ClaudeOptions {
  /** What starts Claude Code, before its flags. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** The sessions it has running. `claude agents --json --all` when left out. */
  live?: () => Promise<LiveSession[]>
  /** The sessions it kept, as files under ~/.claude/projects. Read from there when left out. */
  stored?: () => Promise<StoredSession[]>
}

const lines = (file: string, args: string[]): Promise<string[]> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))
  })

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

/** The program that starts Claude Code, or null when it is not on this computer. `TOGLE_CLAUDE_PATH` names it by hand. */
export async function findClaude(): Promise<string | null> {
  const forced = process.env.TOGLE_CLAUDE_PATH
  if (forced && (await exists(forced))) return forced
  const found = await lines(process.platform === 'win32' ? 'where' : 'which', ['claude'])
  if (process.platform !== 'win32') return found[0] ?? null
  const exe = found.find((file) => /\.exe$/i.test(file))
  if (exe) return exe
  // npm's claude.cmd shim: Node cannot start it without a shell, so the program it starts is used.
  for (const file of found.filter((f) => /\.(cmd|bat)$/i.test(f))) {
    const native = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (await exists(native)) return native
  }
  return null
}

const oneLine = (value: string, longest = 90): string => value.replace(/\s+/g, ' ').trim().slice(0, longest)

const stateOfLive = (session: LiveSession): TaskState => {
  switch (session.state) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'waiting'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'stopped'
    case 'done':
      return 'idle'
    default:
      break
  }
  if (session.status === 'waiting') return 'waiting'
  if (session.status === 'busy') return 'working'
  return 'idle'
}

async function liveSessions(command: string[]): Promise<LiveSession[]> {
  const out = (await lines(command[0], [...command.slice(1), 'agents', '--json', '--all'])).join('\n')
  try {
    return list(JSON.parse(out) as unknown).map(rec) as LiveSession[]
  } catch {
    return []
  }
}

async function storedSessions(): Promise<StoredSession[]> {
  return (await claudeSessions(100)).map((session) => ({ id: session.id, title: session.title, cwd: session.cwd ?? '', updatedAt: session.updatedAt }))
}

// What a tool is, for the person reading a request.
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const summary = (tool: string, input: Record<string, unknown>): string => {
  if (typeof input.command === 'string') return input.command
  if (typeof input.url === 'string') return `${tool} ${input.url}`
  if (typeof input.pattern === 'string') return `${tool} ${input.pattern}`
  return oneLine(`${tool} ${JSON.stringify(input)}`, 200)
}

interface Context {
  command: string[]
  env: NodeJS.ProcessEnv | undefined
  hooks: HookServer
}

class ClaudeTask extends TaskBase implements HookTarget {
  readonly runner = 'claude' as const
  private proc: ChildProcessWithoutNullStreams | null = null
  private hook: { key: string; settings: string } | null = null
  private alive = false
  private closing = false
  private stopped = false
  /** Messages sent whose turn has not ended. */
  private open = 0
  /** Whether Claude Code has said or done anything since the last message was sent. */
  private active = false
  private requests = 0
  /** The one rule Claude Code suggested for a request, kept when "always" was offered: the answer gives it back. */
  private readonly rules = new Map<string, Record<string, unknown>>()
  private interrupts = 0
  private readonly errors: string[] = []
  /** Commands in flight: tool use id to the command. */
  private readonly commands = new Map<string, string>()
  /** Commands the person refused. */
  private readonly refused = new Set<string>()
  private exit: Promise<void> = Promise.resolve()

  constructor(private readonly context: Context) {
    super()
  }

  async launch(folder: string, resume: string | null, asks: boolean, name: string | null): Promise<void> {
    this.folder = folder
    this.hook = await this.context.hooks.attach(this, asks)
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'default', '--settings', this.hook.settings]
    if (resume) args.push('--resume', resume)
    if (name) args.push('--name', name)
    const proc = spawn(this.context.command[0], [...this.context.command.slice(1), ...args], { cwd: folder, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.context.env ?? process.env })
    this.proc = proc
    this.alive = true
    const started = new Promise<void>((resolve, reject) => {
      proc.once('spawn', () => resolve())
      proc.once('error', reject)
    })
    this.exit = new Promise<void>((resolve) => {
      proc.on('error', (error) => {
        this.errors.push(error.message)
        this.ended(null)
        resolve()
      })
      proc.on('exit', (code) => {
        this.ended(code)
        resolve()
      })
    })
    createInterface({ input: proc.stdout }).on('line', (line) => this.line(line))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.errors.push(String(chunk))
      if (this.errors.length > 20) this.errors.shift()
    })
    proc.stdin.on('error', () => undefined)
    if (resume) this.id = resume
    // A program that cannot be started fails the start, and not the first thing said to it.
    try {
      await started
    } catch (error) {
      throw new Error(`Claude Code could not be started${error instanceof Error ? `: ${error.message}` : '.'}`, { cause: error })
    }
  }

  private ended(code: number | null): void {
    if (!this.alive) return
    this.alive = false
    if (this.hook) void this.context.hooks.detach(this.hook.key, this.hook.settings)
    this.cancelRequests()
    if (this.closing) {
      this.emit({ type: 'ended', reason: 'closed' })
      return
    }
    const why = this.errors.join('').trim().split('\n').pop()
    this.setBase('failed')
    this.emit({ type: 'error', message: `Claude Code stopped${code ? ` (${code})` : ''}${why ? `: ${why}` : '.'}` })
    this.emit({ type: 'ended', reason: 'crashed' })
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.proc?.stdin.write(`${JSON.stringify(message)}\n`)
    } catch {
      // The program is gone: its exit settles the task.
    }
  }

  async send(message: string): Promise<void> {
    if (!this.alive) throw new Error('Claude Code is not running.')
    this.stopped = false
    this.open++
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message }] } })
    this.setBase('working')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.cancelRequests()
    if (this.alive && this.open) this.write({ type: 'control_request', request_id: `togle-${++this.interrupts}`, request: { subtype: 'interrupt' } })
    this.setBase('stopped')
  }

  /** Claude Code's interrupt ends the command that is running, so there is nothing left for a second press. */
  async endCommands(): Promise<number> {
    return 0
  }

  async close(): Promise<void> {
    this.closing = true
    this.cancelRequests()
    if (!this.alive) return
    try {
      this.proc?.stdin.end()
    } catch {
      // already closed
    }
    const timer = setTimeout(() => this.proc?.kill(), 3_000)
    timer.unref()
    await this.exit
    clearTimeout(timer)
  }

  // ---- What Claude Code says ----

  private line(raw: string): void {
    let message: Record<string, unknown>
    try {
      message = rec(JSON.parse(raw))
    } catch {
      return
    }
    switch (text(message.type)) {
      case 'system':
        if (message.subtype === 'init') this.id = text(message.session_id) || this.id
        break
      case 'assistant':
        this.active = true
        for (const block of list(rec(message.message).content).map(rec)) {
          if (block.type === 'text' && text(block.text).trim()) this.emit({ type: 'message', text: text(block.text) })
          else if (block.type === 'tool_use') this.toolStarted(block)
        }
        break
      case 'user':
        for (const block of list(rec(message.message).content).map(rec)) if (block.type === 'tool_result') this.toolFinished(block)
        break
      case 'result':
        this.result(message)
        break
      default:
        break
    }
  }

  private toolStarted(block: Record<string, unknown>): void {
    const command = text(rec(block.input).command)
    if (!command) return
    this.commands.set(text(block.id), command)
    this.emit({ type: 'command', command, status: 'started', exitCode: null })
  }

  private toolFinished(block: Record<string, unknown>): void {
    const id = text(block.tool_use_id)
    const command = this.commands.get(id)
    if (!command) return
    this.commands.delete(id)
    const refused = this.refused.delete(command)
    this.emit({ type: 'command', command, status: refused ? 'declined' : block.is_error === true ? 'failed' : 'finished', exitCode: null })
  }

  private result(message: Record<string, unknown>): void {
    const subtype = text(message.subtype)
    const error = message.is_error === true || (subtype !== 'success' && subtype !== 'error_during_execution')
    // A result with nothing before it is not the end of what was asked: see the note at the top.
    if (this.open === 0 || (!this.active && !error && subtype === 'success')) return
    this.open--
    if (this.open === 0) this.active = false
    const interrupted = this.stopped && subtype === 'error_during_execution'
    const failed = !interrupted && (error || subtype === 'error_during_execution')
    const why = failed ? text(message.result) || subtype || 'The turn failed.' : null
    this.emit({ type: 'turn-ended', outcome: interrupted ? 'interrupted' : failed ? 'failed' : 'completed', error: why })
    if (why) this.emit({ type: 'error', message: why })
    if (this.open === 0) this.setBase(this.stopped ? 'stopped' : 'idle')
  }

  // ---- A permission request, from the hook ----

  async permission(event: Record<string, unknown>, gone: AbortSignal): Promise<HookVerdict> {
    const tool = text(event.tool_name)
    const input = rec(event.tool_input)
    const id = `claude-${++this.requests}`
    const request = this.describe(id, tool, input, event)
    gone.addEventListener('abort', () => this.dropRequest(id, 'cancelled'), { once: true })
    const answer = await this.ask(request)
    if (answer.kind === 'text' && request.kind === 'question') {
      // Every question of the tool gets the words: one at a time is what a person usually asks.
      return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries((request.questions ?? []).map((q) => [q.text, answer.text])) } }
    }
    const rule = this.rules.get(id)
    this.rules.delete(id)
    // Always: Claude Code saves the very rule it suggested, where it said it would, and asks no more for what it matches.
    if (answer.kind === 'decision' && answer.decision === 'allow-always' && rule) return { behavior: 'allow', updatedPermissions: [rule] }
    if (answer.kind === 'decision' && answer.decision !== 'refuse') return { behavior: 'allow' }
    if (answer.kind === 'cancelled') return { behavior: 'deny', message: 'The task was stopped.' }
    if (request.command) this.refused.add(request.command)
    return { behavior: 'deny', message: 'The person refused this in Togle.' }
  }

  private describe(id: string, tool: string, input: Record<string, unknown>, event: Record<string, unknown>): PendingRequest {
    const offersAlways = list(event.permission_suggestions).length > 0
    const folder = text(event.cwd) || this.folder
    if (tool === 'AskUserQuestion') {
      const questions: AgentQuestion[] = list(input.questions).map(rec).map((q, at) => ({
        id: String(at),
        text: text(q.question) || text(q.header),
        options: list(q.options).map((option) => text(rec(option).label)).filter(Boolean),
        free: true,
        secret: false
      }))
      return { id, kind: 'question', questions, offersAlways: false }
    }
    if (EDITS.has(tool)) {
      const file = text(input.file_path) || text(input.notebook_path)
      return { id, kind: 'edit', folder, files: file ? [file] : [], offersAlways }
    }
    const command = summary(tool, input)
    const always = alwaysRule(tool, command, folder, event)
    if (always) this.rules.set(id, always.rule)
    return { id, kind: 'command', command, raw: command, folder, offersAlways, ...(always ? { always: always.words } : {}) }
  }
}

/** Where Claude Code saves a rule, as the words on the button say it. */
const REACH: Record<string, (folder: string) => string> = {
  session: () => 'for the rest of this task',
  localSettings: (folder) => 'in ' + folder,
  projectSettings: (folder) => 'in ' + folder,
  userSettings: () => 'everywhere'
}

/**
 * The rule "always" would keep, when Claude Code suggested one: an allow rule for this tool only, saved where Claude
 * Code says (this task, this project, or everywhere). Anything else it may suggest (a change of permission mode, more
 * folders) is never offered here.
 */
function alwaysRule(tool: string, command: string, folder: string, event: Record<string, unknown>): { rule: Record<string, unknown>; words: string } | undefined {
  for (const suggestion of list(event.permission_suggestions).map(rec)) {
    const rules = list(suggestion.rules).map(rec)
    const reach = REACH[text(suggestion.destination)]
    if (text(suggestion.type) !== 'addRules' || text(suggestion.behavior) !== 'allow' || !reach || !rules.length || !rules.every((rule) => text(rule.toolName) === tool && text(rule.ruleContent))) continue
    const what = rules.length === 1 && text(rules[0].ruleContent) === command ? 'this command' : rules.map((rule) => text(rule.ruleContent)).join(', ')
    const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder
    return { rule: suggestion, words: 'Always allow ' + what + ' ' + reach(name) }
  }
  return undefined
}

export class ClaudeBackend implements Backend {
  readonly runner = 'claude' as const
  private readonly hooks = new HookServer()
  private readonly tasks = new Set<ClaudeTask>()

  constructor(private readonly options: ClaudeOptions = {}) {}

  private async command(): Promise<string[]> {
    if (this.options.command?.length) return this.options.command
    const found = await findClaude()
    if (!found) throw new Error('Claude Code is not installed on this computer.')
    return [found]
  }

  async detect(): Promise<Detected> {
    const command = this.options.command?.length ? this.options.command : [await findClaude()].filter((found): found is string => !!found)
    if (!command.length) return { installed: false }
    const version = (await lines(command[0], [...command.slice(1), '--version']))[0]
    return { installed: true, command: command[0], ...(version ? { version } : {}) }
  }

  async list(): Promise<TaskInfo[]> {
    const live = await (this.options.live ? this.options.live() : this.command().then(liveSessions)).catch(() => [] as LiveSession[])
    const stored = await (this.options.stored ?? storedSessions)().catch(() => [] as StoredSession[])
    const found = new Map<string, TaskInfo>()
    for (const session of stored) found.set(session.id, { id: session.id, runner: 'claude', title: session.title, folder: session.cwd, state: 'idle', updatedAt: session.updatedAt })
    for (const session of live) {
      if (!session.sessionId) continue
      const before = found.get(session.sessionId)
      found.set(session.sessionId, {
        id: session.sessionId,
        runner: 'claude',
        title: before?.title || session.name || path.basename(session.cwd ?? '') || 'Claude Code task',
        folder: session.cwd ?? before?.folder ?? '',
        state: stateOfLive(session),
        updatedAt: before?.updatedAt ?? session.startedAt ?? 0,
        ...(session.pid ? { pid: session.pid } : {}),
        ...(session.waitingFor ? { waitingFor: session.waitingFor } : {})
      })
    }
    for (const task of this.tasks) {
      if (!task.id) continue
      const before = found.get(task.id)
      found.set(task.id, { id: task.id, runner: 'claude', title: task.title || before?.title || 'Claude Code task', folder: task.folder || before?.folder || '', state: task.state, updatedAt: Date.now() })
    }
    return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async start(options: StartOptions): Promise<TaskHandle> {
    const task = await this.launch(options.folder, null, options.asks ?? false, options.title ?? null)
    task.title = options.title ?? oneLine(options.prompt)
    await task.send(options.prompt)
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    const known = (await this.list()).find((task) => task.id === id)
    const task = await this.launch(options.folder ?? known?.folder ?? os.homedir(), id, options.asks ?? false, null)
    task.title = known?.title ?? ''
    return task
  }

  private async launch(folder: string, resume: string | null, asks: boolean, name: string | null): Promise<ClaudeTask> {
    const task = new ClaudeTask({ command: await this.command(), env: this.options.env, hooks: this.hooks })
    task.on((event) => {
      if (event.type === 'ended') this.tasks.delete(task)
    })
    this.tasks.add(task)
    try {
      await task.launch(folder, resume, asks, name)
    } catch (error) {
      this.tasks.delete(task)
      throw error
    }
    return task
  }

  async close(): Promise<void> {
    await Promise.all([...this.tasks].map((task) => task.close()))
    await this.hooks.close()
  }
}
