// Hermes on this computer, through ACP, the Agent Client Protocol: `hermes acp` speaks JSON-RPC over its standard input
// and output. One program serves every Hermes task Togle runs; each task is a session in it.
//
// What trying it on Windows (Hermes 0.22) showed, which this follows:
// - Starting a session takes several seconds, and a turn is one `session/prompt` that answers when the turn ends.
// - `session/cancel` ends the turn and the command that is running, so Stop needs no second press.
// - ACP's own list of sessions is empty for sessions it did not start, so Togle keeps a record of its own (the hub).
// - A command that needs permission arrives as `session/request_permission` with options: allow once or always,
//   reject once or always. Allowing here is always the "once" option. Hermes asks only when its own settings say so
//   (the person's may be set to never ask) and refuses some commands outright without asking.
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { PendingRequest, TaskInfo } from '@shared/runner'
import { type Id, JsonRpcPeer, RpcError, list, rec, text } from './jsonrpc'
import { TaskBase } from './task-base'
import type { Backend, Detected, ResumeOptions, StartOptions, TaskHandle } from './types'

export interface HermesOptions {
  /** What starts Hermes, before the word `acp`. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** Togle's version, told to Hermes. */
  version?: string
  /** A model for every task ("provider:model"), when the person's default is not the one to use. */
  model?: string
}

const lines = (file: string, args: string[]): Promise<string[]> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => resolve(error ? [] : stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)))
  })

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

/** The program that starts Hermes, or null when it is not on this computer. `TOGLE_HERMES_PATH` names it by hand. */
export async function findHermes(): Promise<string | null> {
  const forced = process.env.TOGLE_HERMES_PATH
  if (forced && (await exists(forced))) return forced
  const found = await lines(process.platform === 'win32' ? 'where' : 'which', ['hermes'])
  if (process.platform !== 'win32') return found[0] ?? null
  // The .cmd beside it is a shim that Node cannot start without a shell.
  return found.find((file) => /\.exe$/i.test(file)) ?? null
}

// The ways ACP names what a tool does.
const EDIT_KINDS = new Set(['edit', 'delete', 'move'])
const oneLine = (value: string, longest = 90): string => value.replace(/\s+/g, ' ').trim().slice(0, longest)

/** The command a tool call runs, as Hermes writes it: "$ <command>" in its content, else its title after "terminal:". */
function commandOf(call: Record<string, unknown>): string {
  const shown = list(call.content).map((item) => text(rec(rec(item).content).text)).find((words) => words.startsWith('$ '))
  if (shown) return shown.slice(2).trim()
  const raw = rec(call.rawInput)
  if (typeof raw.command === 'string') return raw.command
  return text(call.title).replace(/^terminal:\s*/i, '').trim()
}

const filesOf = (call: Record<string, unknown>): string[] => list(call.locations).map((place) => text(rec(place).path)).filter(Boolean)

class HermesTask extends TaskBase {
  readonly runner = 'hermes' as const
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
  /** Hermes ended under the task: what its turns say after that is only the program going away. */
  private dead = false
  /** While a session is loaded, what Hermes replays of its past is not news. */
  replaying = false

  constructor(
    private readonly server: HermesServer,
    id: string,
    folder: string,
    title: string
  ) {
    super()
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

  // ---- What Hermes says ----

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
    this.emit({ type: 'turn-ended', outcome, error: outcome === 'failed' ? `Hermes stopped the turn (${reason}).` : null })
    if (outcome === 'failed') this.emit({ type: 'error', message: `Hermes stopped the turn (${reason}).` })
    if (!this.open) this.setBase(this.stopped ? 'stopped' : 'idle')
  }

  private turnFailed(error: unknown): void {
    if (this.dead) return
    const spoke = this.words.trim()
    this.flush()
    this.open = Math.max(0, this.open - 1)
    const why = error instanceof RpcError ? error.message : error instanceof Error ? error.message : String(error)
    // Hermes tells why in words (a model that refused the request) before it answers with a plain error.
    const message = spoke ? oneLine(spoke.split('\n')[0], 160) : why
    if (!this.stopped) this.emit({ type: 'error', message })
    this.emit({ type: 'turn-ended', outcome: this.stopped ? 'interrupted' : 'failed', error: this.stopped ? null : message })
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
        // Hermes names a session by what was asked first: a name given here stays.
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
    // Hermes's own "always" option, in its own words (it decides how long it keeps the choice).
    const alwaysOption = options.find((o) => text(o.kind) === 'allow_always')
    const request: PendingRequest = edit
      ? { id: String(rpcId), kind: 'edit', folder: this.folder, files: filesOf(call).length ? filesOf(call) : [oneLine(text(call.title))], offersAlways: !!alwaysOption }
      : { id: String(rpcId), kind: 'command', command, raw: command, folder: this.folder, offersAlways: !!alwaysOption, ...(alwaysOption ? { always: `${oneLine(text(alwaysOption.name)) || 'Always allow'} (Hermes keeps it)` } : {}) }
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
      this.emit({ type: 'error', message: 'Hermes offers no way to allow this once, so it was refused.' })
    } else if (answer.kind === 'decision') {
      this.refused.add(text(call.toolCallId))
      const refused = choose('reject_once') ?? choose('reject_always')
      if (refused) return refused
    }
    return { outcome: { outcome: 'cancelled' } }
  }
}

class HermesServer {
  readonly tasks = new Map<string, HermesTask>()
  readonly peer: JsonRpcPeer
  /** Whether Hermes can pick a session up with `session/resume` (else `session/load` does). */
  resumes = false
  modes: string[] = []

  constructor(
    command: string[],
    env: NodeJS.ProcessEnv | undefined,
    private readonly onClosed: () => void
  ) {
    const proc = spawn(command[0], [...command.slice(1), 'acp'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env ?? process.env })
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
      throw new Error(`Hermes did not start${why ? `: ${why}` : '.'}`, { cause: error })
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

export class HermesBackend implements Backend {
  readonly runner = 'hermes' as const
  private server: Promise<HermesServer> | null = null

  constructor(private readonly options: HermesOptions = {}) {}

  async detect(): Promise<Detected> {
    const command = this.options.command?.length ? this.options.command : [await findHermes()].filter((found): found is string => !!found)
    if (!command.length) return { installed: false }
    const version = (await lines(command[0], [...command.slice(1), '--version']))[0]
    return { installed: true, command: command[0], ...(version ? { version } : {}) }
  }

  private connect(): Promise<HermesServer> {
    this.server ??= this.launch().catch((error: unknown) => {
      this.server = null
      throw error
    })
    return this.server
  }

  private async launch(): Promise<HermesServer> {
    const command = this.options.command?.length ? this.options.command : [await findHermes()].filter((found): found is string => !!found)
    if (!command.length) throw new Error('Hermes is not installed on this computer.')
    const server = new HermesServer(command, this.options.env, () => {
      this.server = null
    })
    await server.initialize(this.options.version ?? '0.0.0')
    return server
  }

  /** ACP lists none of the sessions it did not start, so the hub's record of started tasks is the list. */
  async list(): Promise<TaskInfo[]> {
    return []
  }

  async start(options: StartOptions): Promise<TaskHandle> {
    const server = await this.connect()
    const created = rec(await server.peer.request('session/new', { cwd: options.folder, mcpServers: [] }, 120_000))
    const id = text(created.sessionId)
    if (!id) throw new Error('Hermes did not start the task.')
    const task = await this.prepare(server, new HermesTask(server, id, options.folder, options.title ?? oneLine(options.prompt)), created, options.asks)
    await task.send(options.prompt)
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    const server = await this.connect()
    const known = server.tasks.get(id)
    if (known) return known
    const folder = options.folder ?? ''
    const task = new HermesTask(server, id, folder, '')
    server.tasks.set(id, task)
    // Hermes tells the session's past again, whether it is resumed or loaded: all of it comes before the answer.
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

  private async prepare(server: HermesServer, task: HermesTask, session: Record<string, unknown>, asks: boolean | undefined): Promise<HermesTask> {
    server.tasks.set(task.id ?? '', task)
    const id = task.id ?? ''
    const modes = list(rec(session.modes).availableModes).map((mode) => text(rec(mode).id))
    if (this.options.model) await server.peer.request('session/set_model', { sessionId: id, modelId: this.options.model }, 30_000)
    // Asking is the mode Hermes calls default; its own settings may still never ask.
    if (asks && modes.includes('default') && text(rec(session.modes).currentModeId) !== 'default') await server.peer.request('session/set_mode', { sessionId: id, modeId: 'default' }, 30_000).catch(() => undefined)
    return task
  }

  async close(): Promise<void> {
    const server = await this.server?.catch(() => null)
    this.server = null
    server?.peer.close()
  }
}
