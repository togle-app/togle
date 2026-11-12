// An agent on this computer through ACP, the Agent Client Protocol: the agent's program speaks JSON-RPC over its standard
// input and output. One program serves every task Togle runs with that agent; each task is a session in it. Hermes is one
// such agent (hermes.ts); an agent the person adds in Settings is another, started by the command they give.
//
// What trying Hermes on Windows (Hermes 0.22) showed, which this follows for every ACP agent:
// - Starting a session takes several seconds, and a turn is one `session/prompt` that answers when the turn ends.
// - `session/cancel` ends the turn and the command that is running, so Stop needs no second press.
// - ACP's own list of sessions may be empty for sessions it did not start, so Togle keeps a record of its own (the hub).
// - A command that needs permission arrives as `session/request_permission` with options: allow once or always, reject
//   once or always. Allow once is the "once" option; "always" is the agent's own, said in its own words.
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { PendingRequest, TaskInfo } from '@shared/runner'
import { type Id, JsonRpcPeer, RpcError, list, rec, text } from './jsonrpc'
import { TaskBase } from './task-base'
import type { Backend, Detected, ResumeOptions, StartOptions, TaskHandle } from './types'

export interface AcpOptions {
  /** The agent's id in task keys ("hermes", "acp-gemini"). */
  runner: string
  /** Its name, as the person reads it. */
  name: string
  /** The full command that starts it as an ACP agent, or null when it is not on this computer. */
  command: () => Promise<string[] | null>
  env?: NodeJS.ProcessEnv
  /** Togle's version, told to the agent. */
  version?: string
  /** A model for every task, when the person's default is not the one to use. */
  model?: string
  /** The first line its version command prints. */
  versionOf?: (command: string[]) => Promise<string | undefined>
}

export const lines = (file: string, args: string[]): Promise<string[]> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))
  })

export const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

/**
 * A command line as the person wrote it, in words: spaces split it, and double quotes keep a word with spaces together
 * ("C:\Program Files\agent\agent.exe" --acp).
 */
export function commandWords(line: string): string[] {
  const words: string[] = []
  let word = '', quoted = false, any = false
  for (const char of line.trim()) {
    if (char === '"') { quoted = !quoted; any = true; continue }
    if (!quoted && /\s/.test(char)) {
      if (word || any) words.push(word)
      word = ''
      any = false
      continue
    }
    word += char
  }
  if (word || any) words.push(word)
  return words
}

/**
 * Where a program named in a command is on this computer: the path given, or the first the system's search finds. On
 * Windows an installed .exe is taken before a .cmd shim. Null when it is nowhere.
 */
export async function whereIs(program: string): Promise<string | null> {
  if (path.isAbsolute(program)) return (await exists(program)) ? program : null
  const found = await lines(process.platform === 'win32' ? 'where' : 'which', [program])
  if (process.platform !== 'win32') return found[0] ?? null
  return found.find((file) => /\.exe$/i.test(file)) ?? found.find((file) => /\.(cmd|bat)$/i.test(file)) ?? null
}

/** Quotes a word for cmd.exe when it has to (spaces, or characters cmd reads): a .cmd shim only starts through it. */
export const forCmd = (word: string): string => (/[\s"&|<>^()%!]/.test(word) ? `"${word.replace(/"/g, '""')}"` : word)

// The ways ACP names what a tool does.
const EDIT_KINDS = new Set(['edit', 'delete', 'move'])
const oneLine = (value: string, longest = 90): string => value.replace(/\s+/g, ' ').trim().slice(0, longest)

/** The command a tool call runs: "$ <command>" in its content (as Hermes writes it), its raw input, else its title. */
function commandOf(call: Record<string, unknown>): string {
  const shown = list(call.content).map((item) => text(rec(rec(item).content).text)).find((words) => words.startsWith('$ '))
  if (shown) return shown.slice(2).trim()
  const raw = rec(call.rawInput)
  if (typeof raw.command === 'string') return raw.command
  if (Array.isArray(raw.command)) return raw.command.map(String).join(' ')
  return text(call.title).replace(/^terminal:\s*/i, '').trim()
}

const filesOf = (call: Record<string, unknown>): string[] => list(call.locations).map((place) => text(rec(place).path)).filter(Boolean)

class AcpTask extends TaskBase {
  readonly runner: string
  private stopped = false
  /** Turns asked for whose end has not been told. */
  private open = 0
  /** What the agent has said since it last did something else: one message. */
  private words = ''
  /** Commands in progress: tool call id to the command. */
  private readonly commands = new Map<string, string>()
  /** Edits in progress: tool call id to files. */
  private readonly edits = new Map<string, string[]>()
  private readonly refused = new Set<string>()
  /** The agent ended under the task: what its turns say after that is only the program going away. */
  private dead = false
  /** While a session is loaded, what the agent replays of its past is not news. */
  replaying = false

  constructor(
    private readonly server: AcpServer,
    id: string,
    folder: string,
    title: string
  ) {
    super()
    this.runner = server.runner
    this.id = id
    this.folder = folder
    this.title = title
  }

  async send(message: string): Promise<void> {
    this.stopped = false
    this.open++
    this.setBase('working')
    // A turn is one call that answers when it ends: it is not waited for here.
    this.server.peer.request('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text: message }] }, 12 * 3_600_000).then(
      (result) => this.turnEnded(rec(result)),
      (error: unknown) => this.turnFailed(error)
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.cancelRequests()
    if (this.open) this.server.peer.notify('session/cancel', { sessionId: this.id })
    this.setBase('stopped')
  }

  /** Cancelling ends the command that is running, so there is nothing left for a second press. */
  async endCommands(): Promise<number> {
    return 0
  }

  async close(): Promise<void> {
    this.cancelRequests()
    this.server.tasks.delete(this.id ?? '')
    this.emit({ type: 'ended', reason: 'closed' })
  }

  gone(): void {
    this.dead = true
    this.cancelRequests()
    this.setBase('failed')
    this.emit({ type: 'ended', reason: 'crashed' })
  }

  // ---- What the agent says ----

  private flush(): void {
    const said = this.words.trim()
    this.words = ''
    if (said) this.emit({ type: 'message', text: said })
  }

  private turnEnded(result: Record<string, unknown>): void {
    this.flush()
    this.open = Math.max(0, this.open - 1)
    const reason = text(result.stopReason)
    const outcome = reason === 'cancelled' ? 'interrupted' : reason === 'end_turn' || !reason ? 'completed' : 'failed'
    const why = `${this.server.name} stopped the turn (${reason}).`
    this.emit({ type: 'turn-ended', outcome, error: outcome === 'failed' ? why : null })
    if (outcome === 'failed') this.emit({ type: 'error', message: why })
    if (!this.open) this.setBase(this.stopped ? 'stopped' : 'idle')
  }

  private turnFailed(error: unknown): void {
    if (this.dead) return
    const spoke = this.words.trim()
    this.flush()
    this.open = Math.max(0, this.open - 1)
    const why = error instanceof RpcError ? error.message : error instanceof Error ? error.message : String(error)
    // An agent may tell why in words (a model that refused the request) before it answers with a plain error.
    const message = spoke ? oneLine(spoke.split('\n')[0], 160) : why
    if (!this.stopped) this.emit({ type: 'error', message })
    // What the program answered is the fault; the agent's words above are only what is shown.
    this.emit({ type: 'turn-ended', outcome: this.stopped ? 'interrupted' : 'failed', error: this.stopped ? null : message, ...(this.stopped ? {} : { fault: why }) })
    if (!this.open) this.setBase(this.stopped ? 'stopped' : 'idle')
  }

  update(update: Record<string, unknown>): void {
    if (this.replaying) return
    switch (text(update.sessionUpdate)) {
      case 'agent_message_chunk':
        this.words += text(rec(update.content).text)
        break
      case 'tool_call':
        this.flush()
        this.toolStarted(update)
        break
      case 'tool_call_update':
        this.toolUpdated(update)
        break
      case 'session_info_update':
        // An agent may name a session by what was asked first: a name given here stays.
        if (!this.title) this.setTitle(oneLine(text(update.title)))
        break
      default:
        break
    }
  }

  private toolStarted(call: Record<string, unknown>): void {
    const id = text(call.toolCallId)
    const kind = text(call.kind)
    if (EDIT_KINDS.has(kind)) {
      this.edits.set(id, filesOf(call))
    } else if (kind === 'execute') {
      const command = commandOf(call)
      this.commands.set(id, command)
      this.emit({ type: 'command', command, status: 'started', exitCode: null })
    }
  }

  private toolUpdated(call: Record<string, unknown>): void {
    const id = text(call.toolCallId)
    const status = text(call.status)
    if (status !== 'completed' && status !== 'failed') return
    const command = this.commands.get(id)
    if (command !== undefined) {
      this.commands.delete(id)
      this.emit({ type: 'command', command, status: this.refused.delete(id) ? 'declined' : status === 'failed' ? 'failed' : 'finished', exitCode: null })
      return
    }
    const files = this.edits.get(id)
    if (files) {
      this.edits.delete(id)
      if (status === 'completed' && files.length) this.emit({ type: 'files', paths: files })
    }
  }

  /** A command or an edit that needs the person's word. */
  async asked(params: Record<string, unknown>, rpcId: Id): Promise<unknown> {
    const call = rec(params.toolCall)
    const options = list(params.options).map(rec)
    const edit = EDIT_KINDS.has(text(call.kind))
    const command = commandOf(call)
    // The agent's own "always" option, in its own words (it decides how long it keeps the choice).
    const alwaysOption = options.find((o) => text(o.kind) === 'allow_always')
    const request: PendingRequest = edit
      ? { id: String(rpcId), kind: 'edit', folder: this.folder, files: filesOf(call).length ? filesOf(call) : [oneLine(text(call.title))], offersAlways: !!alwaysOption }
      : { id: String(rpcId), kind: 'command', command, raw: command, folder: this.folder, offersAlways: !!alwaysOption, ...(alwaysOption ? { always: `${oneLine(text(alwaysOption.name)) || 'Always allow'} (${this.server.name} keeps it)` } : {}) }
    const answer = await this.ask(request)
    const choose = (kind: string): unknown => {
      const option = options.find((o) => text(o.kind) === kind)
      return option ? { outcome: { outcome: 'selected', optionId: text(option.optionId) } } : null
    }
    if (answer.kind === 'decision' && answer.decision === 'allow-always') {
      const allowed = choose('allow_always')
      if (allowed) return allowed
    }
    if (answer.kind === 'decision' && answer.decision !== 'refuse') {
      const allowed = choose('allow_once')
      if (allowed) return allowed
      this.emit({ type: 'error', message: `${this.server.name} offers no way to allow this once, so it was refused.` })
    } else if (answer.kind === 'decision') {
      this.refused.add(text(call.toolCallId))
      const refused = choose('reject_once') ?? choose('reject_always')
      if (refused) return refused
    }
    return { outcome: { outcome: 'cancelled' } }
  }
}

class AcpServer {
  readonly tasks = new Map<string, AcpTask>()
  readonly peer: JsonRpcPeer
  /** Whether the agent can pick a session up with `session/resume` (else `session/load` does). */
  resumes = false

  constructor(
    readonly runner: string,
    readonly name: string,
    command: string[],
    env: NodeJS.ProcessEnv | undefined,
    private readonly onClosed: () => void
  ) {
    const [program, ...args] = command
    // A .cmd shim (an agent installed with npm, on Windows) only starts through cmd.exe.
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(program)
    const proc = shim
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${[program, ...args].map(forCmd).join(' ')}"`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: true, env: env ?? process.env })
      : spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env ?? process.env })
    this.peer = new JsonRpcPeer(
      proc,
      {
        request: (method, params, id) => this.route(method, rec(params), id),
        notification: (method, params) => this.notified(method, rec(params)),
        closed: () => this.closed()
      },
      true
    )
  }

  async initialize(version: string): Promise<void> {
    try {
      const init = rec(
        await this.peer.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'togle', title: 'Togle', version } }, 60_000)
      )
      this.resumes = 'resume' in rec(rec(init.agentCapabilities).sessionCapabilities)
    } catch (error) {
      const why = this.peer.errors.join('').trim().split('\n').pop()
      throw new Error(`${this.name} did not start${why ? `: ${why}` : '.'}`, { cause: error })
    }
  }

  private route(method: string, params: Record<string, unknown>, id: Id): Promise<unknown> {
    const task = this.tasks.get(text(params.sessionId))
    if (method !== 'session/request_permission' || !task) return Promise.reject(new RpcError('Togle cannot answer this.', -32601))
    return task.asked(params, id)
  }

  private notified(method: string, params: Record<string, unknown>): void {
    if (method !== 'session/update') return
    this.tasks.get(text(params.sessionId))?.update(rec(params.update))
  }

  private closed(): void {
    for (const task of [...this.tasks.values()]) task.gone()
    this.tasks.clear()
    this.onClosed()
  }
}

export class AcpBackend implements Backend {
  readonly runner: string
  readonly name: string
  private server: Promise<AcpServer> | null = null

  constructor(private readonly options: AcpOptions) {
    this.runner = options.runner
    this.name = options.name
  }

  async detect(): Promise<Detected> {
    const command = await this.options.command().catch(() => null)
    if (!command?.length) return { installed: false }
    const version = await this.options.versionOf?.(command).catch(() => undefined)
    return { installed: true, command: command[0], ...(version ? { version } : {}) }
  }

  private connect(): Promise<AcpServer> {
    this.server ??= this.launch().catch((error: unknown) => {
      this.server = null
      throw error
    })
    return this.server
  }

  private async launch(): Promise<AcpServer> {
    const command = await this.options.command()
    if (!command?.length) throw new Error(`${this.name} is not installed on this computer.`)
    const server = new AcpServer(this.runner, this.name, command, this.options.env, () => {
      this.server = null
    })
    await server.initialize(this.options.version ?? '0.0.0')
    return server
  }

  /** ACP may list none of the sessions it did not start, so the hub's record of started tasks is the list. */
  async list(): Promise<TaskInfo[]> {
    return []
  }

  async start(options: StartOptions): Promise<TaskHandle> {
    const server = await this.connect()
    const created = rec(await server.peer.request('session/new', { cwd: options.folder, mcpServers: [] }, 120_000))
    const id = text(created.sessionId)
    if (!id) throw new Error(`${this.name} did not start the task.`)
    const task = await this.prepare(server, new AcpTask(server, id, options.folder, options.title ?? oneLine(options.prompt)), created, options.asks)
    await task.send(options.prompt)
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    const server = await this.connect()
    const known = server.tasks.get(id)
    if (known) return known
    const folder = options.folder ?? ''
    const task = new AcpTask(server, id, folder, '')
    server.tasks.set(id, task)
    // The agent may tell the session's past again, whether it is resumed or loaded: all of it comes before the answer.
    task.replaying = true
    try {
      const picked = rec(await server.peer.request(server.resumes ? 'session/resume' : 'session/load', { sessionId: id, cwd: folder, mcpServers: [] }, 120_000))
      return await this.prepare(server, task, picked, options.asks)
    } catch (error) {
      server.tasks.delete(id)
      throw error
    } finally {
      task.replaying = false
    }
  }

  private async prepare(server: AcpServer, task: AcpTask, session: Record<string, unknown>, asks: boolean | undefined): Promise<AcpTask> {
    server.tasks.set(task.id ?? '', task)
    const id = task.id ?? ''
    const modes = list(rec(session.modes).availableModes).map((mode) => text(rec(mode).id))
    if (this.options.model) await server.peer.request('session/set_model', { sessionId: id, modelId: this.options.model }, 30_000)
    // Asking is the mode ACP agents call default; their own settings may still never ask.
    if (asks && modes.includes('default') && text(rec(session.modes).currentModeId) !== 'default') await server.peer.request('session/set_mode', { sessionId: id, modeId: 'default' }, 30_000).catch(() => undefined)
    return task
  }

  async close(): Promise<void> {
    const server = await this.server?.catch(() => null)
    this.server = null
    server?.peer.close()
  }
}
