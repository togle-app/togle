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
//
// Commands of Claude Code's own ("/model", typed as a reply), tried the same way with 2.1.323:
// - It runs them in this mode too, and tells a program which it has: asked with a control request (`initialize`), it
//   answers with its commands (name, description, what may follow) and its models, without asking a model anything.
// - A command answers as an `assistant` line whose model is `<synthetic>`, then a `result` that cost nothing.
// - "/clear" prints `conversation_reset`, a new `system init` with ANOTHER session id, and an empty result. "/compact"
//   prints `compact_boundary`, what it printed as a `user` line (`<local-command-stdout>`), and an empty result. Neither
//   prints an `assistant` line, so the result that follows such a line is the end of the turn all the same.
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentCommand, AgentModel, TaskInfo, TaskOffers, TaskState } from '@shared/runner'
import { claudeHasSession, claudeSessions } from './claude-sessions'
import { HookServer, type HookTarget, type HookVerdict } from './claude-hooks'
import { oneLine, requestOf, verdictOf } from './claude-requests'
import { ClaudeScreenTask, screenEnv } from './claude-screen'
import { list, rec, text } from './jsonrpc'
import { TaskBase } from './task-base'
import { loadPty, openTerminal, type TerminalChunk } from './terminal'
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
  /** Where what its screens print goes, for the window. */
  told?: (chunk: TerminalChunk) => void
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

interface Context {
  command: string[]
  env: NodeJS.ProcessEnv | undefined
  hooks: HookServer
}

/** The request that asks Claude Code what it offers, by the id its answer comes back with. */
const OFFERS = 'togle-offers'
/** How many of the last things Claude Code said are remembered by their id. */
const HEARD_KEPT = 600
/** The colors a terminal would show what a command printed in. */
const COLORS = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')

/** A command as Claude Code told it, or nothing when it has no name or is one Claude Code keeps for itself ("__…"). */
function commandOf(told: Record<string, unknown>): AgentCommand[] {
  const name = text(told.name).replace(/^\//, '')
  if (!name || name.startsWith('__')) return []
  const hint = text(told.argumentHint).trim()
  return [{ name, description: oneLine(text(told.description), 200), ...(hint ? { hint: oneLine(hint, 120) } : {}) }]
}

/** A model as Claude Code told it: what follows "/model", its name, and what it is for. */
function modelOf(told: Record<string, unknown>): AgentModel[] {
  const id = text(told.value)
  return id ? [{ id, name: text(told.displayName) || id, description: oneLine(text(told.description), 120) }] : []
}

class ClaudeTask extends TaskBase implements HookTarget {
  readonly runner = 'claude' as const
  /** The session Claude Code is in now: another than `id` once the person emptied the conversation ("/clear"). */
  session: string | null = null
  /** This program picked up a session that was there (`--resume`). */
  private resumed = false
  /** How many of its turns have ended. */
  private turns = 0
  /** When the last message was sent to it. */
  private sentAt = 0
  /** The ids of what Claude Code said lately, to know what it tells again. */
  private readonly heard = new Set<string>()
  /** What Claude Code told it offers for the reply box. */
  private commandList: AgentCommand[] = []
  private modelList: AgentModel[] = []
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
    if (resume) {
      this.id = resume
      this.session = resume
      this.resumed = true
    }
    // A program that cannot be started fails the start, and not the first thing said to it.
    try {
      await started
    } catch (error) {
      throw new Error(`Claude Code could not be started${error instanceof Error ? `: ${error.message}` : '.'}`, { cause: error })
    }
    // What the reply box lists when "/" is typed: asked once, and answered without a model.
    this.write({ type: 'control_request', request_id: OFFERS, request: { subtype: 'initialize' } })
  }

  /** The commands and models Claude Code told it has: its own names and words for them. */
  offers(): TaskOffers {
    return { commands: this.commandList, models: this.modelList }
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
    this.sentAt = Date.now()
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
        if (message.subtype === 'init') this.sessionTold(message)
        // "/compact" is done: the turn's result follows without a word from the model.
        else if (message.subtype === 'compact_boundary') this.active = true
        break
      case 'conversation_reset':
        // "/clear": Claude Code goes on in a new, empty session. Nothing else comes before the turn's result.
        this.active = true
        this.emit({ type: 'cleared' })
        break
      case 'control_response':
        this.offersTold(rec(message.response))
        break
      case 'assistant': {
        // After "/compact" Claude Code tells again the last things that were said and done, each under the id it had:
        // what was heard once is not heard twice.
        const uuid = text(message.uuid)
        if (message.isReplay === true || (uuid && this.heard.has(uuid))) break
        if (uuid) {
          this.heard.add(uuid)
          if (this.heard.size > HEARD_KEPT) this.heard.delete(this.heard.values().next().value as string)
        }
        this.active = true
        for (const block of list(rec(message.message).content).map(rec)) {
          if (block.type === 'text' && text(block.text).trim()) this.emit({ type: 'message', text: text(block.text) })
          else if (block.type === 'tool_use') this.toolStarted(block)
        }
        break
      }
      case 'user': {
        const content = rec(message.message).content
        if (typeof content === 'string') this.printed(content, text(message.timestamp))
        else for (const block of list(content).map(rec)) if (block.type === 'tool_result') this.toolFinished(block)
        break
      }
      case 'result':
        this.result(message)
        break
      default:
        break
    }
  }

  /** The session Claude Code is in. The task keeps the id it was first known by: after "/clear" the session is another. */
  private sessionTold(message: Record<string, unknown>): void {
    const session = text(message.session_id)
    if (!session) return
    this.id ||= session
    this.session = session
  }

  /** The answer to what Claude Code offers. Only its commands and models are kept: the rest of it is not Togle's. */
  private offersTold(response: Record<string, unknown>): void {
    if (text(response.request_id) !== OFFERS || response.subtype !== 'success') return
    const told = rec(response.response)
    this.commandList = list(told.commands).map(rec).flatMap(commandOf)
    this.modelList = list(told.models).map(rec).flatMap(modelOf)
  }

  /**
   * What a command of Claude Code's own printed ("/compact" prints "Compacted"), shown as what the agent said. Only a
   * line that is nothing but that (the summary "/compact" keeps may quote what an earlier command printed), and only
   * one written since the last message was sent: after compacting, Claude Code tells again what earlier commands
   * printed, with the time they printed it.
   */
  private printed(content: string, written: string): void {
    const words = /^\s*<local-command-stdout>([\s\S]*)<\/local-command-stdout>\s*$/.exec(content)?.[1]?.replace(COLORS, '').trim()
    if (!words) return
    const at = Date.parse(written)
    if (Number.isFinite(at) && at < this.sentAt - 2_000) return
    this.active = true
    this.emit({ type: 'message', text: words })
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
    // In a program that picked a session up and has not ended a turn yet, a result with nothing before it is not the end
    // of what was asked: see the note at the top. Anywhere else it is: a command of Claude Code's own that printed nothing.
    const stale = this.resumed && this.turns === 0 && !this.active && !error && subtype === 'success'
    if (this.open === 0 || stale) return
    this.open--
    this.turns++
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
    const id = `claude-${++this.requests}`
    const { request, rule } = requestOf(id, event, this.folder)
    gone.addEventListener('abort', () => this.dropRequest(id, 'cancelled'), { once: true })
    const { verdict, refused } = verdictOf(await this.ask(request), request, rule, rec(event.tool_input))
    if (refused) this.refused.add(refused)
    return verdict
  }
}

export class ClaudeBackend implements Backend {
  readonly runner = 'claude' as const
  private readonly hooks = new HookServer()
  private readonly tasks = new Set<ClaudeTask>()
  /** The ones that are Claude Code's own screen, in a terminal of Togle's own. */
  private readonly screens = new Set<ClaudeScreenTask>()

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
      // After "/clear" Claude Code keeps the task in another session: that one is this task, and not a second row.
      if (task.session && task.session !== task.id) found.delete(task.session)
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

  async screenProblem(id: string): Promise<string | undefined> {
    if (!(await loadPty())) return 'Togle cannot open a terminal on this computer, so the Claude Code in its terminal was left as it is.'
    // A session that has had no message has no conversation to open: it was left as it is, and can be used where it is.
    const kept = this.options.stored ? (await this.options.stored().catch(() => [])).some((session) => session.id === id) : await claudeHasSession(id)
    return kept ? undefined : 'This Claude Code has not had a message yet, so there is no conversation to open here. It was left as it is.'
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    const known = (await this.list()).find((task) => task.id === id)
    const folder = options.folder ?? known?.folder ?? os.homedir()
    if (options.screen) return this.openScreen(id, folder, known?.title ?? '', options.flags ?? [])
    const task = await this.launch(folder, id, options.asks ?? false, null)
    task.title = known?.title ?? ''
    return task
  }

  /**
   * Claude Code's own screen on a session, in a terminal of Togle's own. Nothing is forced on it (no permission mode, no
   * rule that asks): the person's own settings apply, and Togle hears what Claude Code asks through the same hook.
   */
  private async openScreen(id: string, folder: string, title: string, flags: string[]): Promise<ClaudeScreenTask> {
    const pty = await loadPty()
    if (!pty) throw new Error('Togle cannot open a terminal on this computer.')
    const command = await this.command()
    let task: ClaudeScreenTask | undefined
    // The hook is made before the program, and the task after it: what is posted in between is the task's once it is there.
    const { key, settings } = await this.hooks.attach({ permission: (event, gone) => (task ? task.permission(event, gone) : Promise.resolve(null)), news: (what, event) => task?.news(what, event) }, false, true)
    try {
      const term = openTerminal(pty, command[0], [...command.slice(1), ...flags, '--resume', id, '--settings', settings], folder, screenEnv(this.options.env ?? process.env))
      task = new ClaudeScreenTask(
        id,
        title,
        folder,
        term,
        this.options.told ?? (() => undefined),
        () => {
          if (task) this.screens.delete(task)
          void this.hooks.detach(key, settings)
        },
        () => (this.options.live ? this.options.live() : liveSessions(command))
      )
    } catch (error) {
      await this.hooks.detach(key, settings)
      throw new Error(`Claude Code could not be started${error instanceof Error ? `: ${error.message}` : '.'}`, { cause: error })
    }
    this.screens.add(task)
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
    await Promise.all([...this.tasks, ...this.screens].map((task) => task.close()))
    await this.hooks.close()
  }
}
