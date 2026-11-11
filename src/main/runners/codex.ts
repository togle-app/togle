// Codex on this computer, through its app server. `codex app-server` speaks JSON-RPC over its standard input and
// output, the way Codex's editor extension does. One app server serves every task Togle runs: each task is a thread.
//
// What trying it on Windows (Codex 0.166) showed, which this follows:
// - The program to start is the native codex.exe: Node cannot start npm's codex.cmd without a shell.
// - A thread Togle starts must set its own approval policy and sandbox: the person's Codex may be set to never ask.
// - `turn/interrupt` ends the turn at once, but a command already running goes on to its end. Ending it is a second
//   press (`endCommands`), done by finding the command among the programs below the app server.
// - A thread shows `active` with the flag `waitingOnApproval` while a command waits for the person.
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentQuestion, TaskInfo, TaskState } from '@shared/runner'
import { type Id, JsonRpcPeer, RpcError, list, rec, text } from './jsonrpc'
import { endCommandsMatching, unwrapShell } from './process-tree'
import { type Answer, TaskBase } from './task-base'
import type { Backend, Detected, ResumeOptions, StartOptions, TaskHandle } from './types'

export interface CodexOptions {
  /** What starts the app server, before the word `app-server`. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** Togle's version, told to Codex. */
  version?: string
}

const NATIVE: Record<string, { pkg: string; triple: string }> = {
  'win32-x64': { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

const firstLine = async (file: string, name: string): Promise<string | null> => {
  try {
    return (await run(file, [name])).split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
  } catch {
    return null
  }
}

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

/** The program that starts Codex, or null when it is not on this computer. `TOGLE_CODEX_PATH` names it by hand. */
export async function findCodex(): Promise<string | null> {
  const forced = process.env.TOGLE_CODEX_PATH
  if (forced && (await exists(forced))) return forced
  if (process.platform !== 'win32') return firstLine('which', 'codex')
  // npm puts a codex.cmd shim by the real program, and the real program is what Node can start.
  const shim = await firstLine('where', 'codex.cmd')
  const native = NATIVE[`${process.platform}-${process.arch}`]
  if (shim && native) {
    const exe = path.join(path.dirname(shim), 'node_modules', '@openai', 'codex', 'node_modules', '@openai', native.pkg, 'vendor', native.triple, 'bin', 'codex.exe')
    if (await exists(exe)) return exe
  }
  return firstLine('where', 'codex.exe')
}

const policy = (asks: boolean | undefined): Record<string, unknown> => (asks ? { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } : {})

const oneLine = (value: string, longest = 90): string => value.replace(/\s+/g, ' ').trim().slice(0, longest)

const titleOf = (thread: Record<string, unknown>): string => text(thread.name).trim() || oneLine(text(thread.preview)) || 'Codex task'

/** The state a thread's status stands for. A thread this app server does not hold is `notLoaded`: not running here. */
const stateOf = (status: unknown): TaskState => {
  const s = rec(status)
  if (s.type === 'systemError') return 'failed'
  if (s.type === 'active') return list(s.activeFlags).length ? 'waiting' : 'working'
  return 'idle'
}

const infoOf = (thread: Record<string, unknown>, live: CodexTask | undefined): TaskInfo => ({
  id: text(thread.id),
  runner: 'codex',
  title: live?.title || titleOf(thread),
  folder: text(thread.cwd),
  state: live ? live.state : stateOf(thread.status),
  updatedAt: (typeof thread.updatedAt === 'number' ? thread.updatedAt : 0) * 1000
})

const decisionOf = (answer: Answer): 'accept' | 'decline' | 'cancel' => (answer.kind === 'cancelled' ? 'cancel' : answer.kind === 'decision' && answer.decision === 'allow-once' ? 'accept' : 'decline')

class CodexTask extends TaskBase {
  readonly runner = 'codex' as const
  private turnId: string | null = null
  private stopped = false
  /** Commands in progress: item id to the command as Codex sent it. */
  private readonly running = new Map<string, string>()
  /** The files each edit in progress changes: item id to paths. */
  private readonly edits = new Map<string, string[]>()

  constructor(private readonly server: CodexServer, thread: Record<string, unknown>) {
    super()
    this.id = text(thread.id)
    this.title = titleOf(thread)
    this.folder = text(thread.cwd)
    this.setBase(stateOf(thread.status))
  }

  async send(message: string): Promise<void> {
    this.stopped = false
    const input = [{ type: 'text', text: message }]
    if (this.turnId && this.state !== 'idle') {
      // A turn is running: the words steer it.
      try {
        await this.server.peer.request('turn/steer', { threadId: this.id, expectedTurnId: this.turnId, input })
        return
      } catch (error) {
        if (!(error instanceof RpcError)) throw error
        // The turn had just ended: the words start the next.
      }
    }
    const started = rec(await this.server.peer.request('turn/start', { threadId: this.id, input }))
    this.turnId = text(rec(started.turn).id) || null
    this.setBase('working')
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.cancelRequests()
    if (this.turnId) await this.server.peer.request('turn/interrupt', { threadId: this.id, turnId: this.turnId }).catch(() => undefined)
    this.setBase('stopped')
  }

  async endCommands(): Promise<number> {
    const pid = this.server.pid
    if (!pid) return 0
    let ended = 0
    for (const command of [...this.running.values()]) ended += await endCommandsMatching(pid, unwrapShell(command))
    return ended
  }

  async close(): Promise<void> {
    this.cancelRequests()
    await this.server.peer.request('thread/unsubscribe', { threadId: this.id }, 5_000).catch(() => undefined)
    this.server.tasks.delete(this.id ?? '')
    this.emit({ type: 'ended', reason: 'closed' })
  }

  /** The program ended under the task. */
  gone(): void {
    this.cancelRequests()
    this.setBase('failed')
    this.emit({ type: 'ended', reason: 'crashed' })
  }

  // ---- What the app server says ----

  status(status: unknown): void {
    const next = stateOf(status)
    if (next === 'idle' && this.stopped) return
    this.setBase(next)
  }

  named(name: string): void {
    this.setTitle(name.trim())
  }

  turnStarted(turn: Record<string, unknown>): void {
    this.turnId = text(turn.id) || this.turnId
    if (!this.stopped) this.setBase('working')
  }

  turnCompleted(turn: Record<string, unknown>): void {
    const status = text(turn.status)
    const error = Object.keys(rec(turn.error)).length ? text(rec(turn.error).message) || 'The turn failed.' : null
    this.turnId = null
    this.emit({ type: 'turn-ended', outcome: status === 'interrupted' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed', error })
    if (error) this.emit({ type: 'error', message: error })
    this.setBase(this.stopped ? 'stopped' : 'idle')
  }

  itemStarted(item: Record<string, unknown>): void {
    const id = text(item.id)
    if (item.type === 'commandExecution') {
      this.running.set(id, text(item.command))
      this.emit({ type: 'command', command: unwrapShell(text(item.command)), status: 'started', exitCode: null })
    } else if (item.type === 'fileChange') {
      this.edits.set(id, list(item.changes).map((change) => text(rec(change).path)).filter(Boolean))
    }
  }

  itemCompleted(item: Record<string, unknown>): void {
    const id = text(item.id)
    if (item.type === 'commandExecution') {
      const command = text(item.command) || this.running.get(id) || ''
      this.running.delete(id)
      const status = text(item.status)
      this.emit({
        type: 'command',
        command: unwrapShell(command),
        status: status === 'declined' ? 'declined' : status === 'failed' ? 'failed' : 'finished',
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null
      })
    } else if (item.type === 'agentMessage') {
      const message = text(item.text)
      if (message) this.emit({ type: 'message', text: message })
    } else if (item.type === 'fileChange') {
      this.edits.delete(id)
      const paths = list(item.changes).map((change) => text(rec(change).path)).filter(Boolean)
      if (paths.length && text(item.status) === 'completed') this.emit({ type: 'files', paths })
    }
  }

  resolvedElsewhere(requestId: Id): void {
    this.dropRequest(String(requestId), 'cancelled')
  }

  /** Something the agent asks, which waits for the person. */
  async asked(method: string, params: Record<string, unknown>, rpcId: Id): Promise<unknown> {
    const id = String(rpcId)
    if (method === 'item/commandExecution/requestApproval') {
      const raw = text(params.command)
      const answer = await this.ask({
        id,
        kind: 'command',
        command: unwrapShell(raw),
        raw,
        folder: text(params.cwd) || this.folder,
        reason: text(params.reason) || undefined,
        offersAlways: list(params.proposedExecpolicyAmendment).length > 0
      })
      return { decision: decisionOf(answer) }
    }
    if (method === 'item/fileChange/requestApproval') {
      const files = this.edits.get(text(params.itemId)) ?? (text(params.grantRoot) ? [text(params.grantRoot)] : [])
      const answer = await this.ask({ id, kind: 'edit', folder: this.folder, reason: text(params.reason) || undefined, files, offersAlways: false })
      return { decision: decisionOf(answer) }
    }
    if (method === 'item/tool/requestUserInput') {
      const questions: AgentQuestion[] = list(params.questions).map((raw) => {
        const q = rec(raw)
        return {
          id: text(q.id),
          text: text(q.question) || text(q.header),
          options: list(q.options).map((option) => text(rec(option).label)).filter(Boolean),
          free: q.isOther === true || !list(q.options).length,
          secret: q.isSecret === true
        }
      })
      const answer = await this.ask({ id, kind: 'question', questions, offersAlways: false })
      if (answer.kind !== 'text') throw new RpcError('The person did not answer.', -32000)
      return { answers: Object.fromEntries(questions.map((q, at) => [q.id, { answers: at === 0 ? [answer.text] : [] }])) }
    }
    this.emit({ type: 'error', message: `Codex asked for something Togle cannot answer yet (${method}).` })
    throw new RpcError('Togle cannot answer this yet.', -32601)
  }
}

class CodexServer {
  readonly tasks = new Map<string, CodexTask>()
  readonly peer: JsonRpcPeer

  constructor(
    command: string[],
    env: NodeJS.ProcessEnv | undefined,
    private readonly onClosed: () => void
  ) {
    const proc = spawn(command[0], [...command.slice(1), 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: env ?? process.env })
    this.peer = new JsonRpcPeer(
      proc,
      {
        request: (method, params, id) => this.route(method, rec(params), id),
        notification: (method, params) => this.notified(method, rec(params)),
        closed: () => this.closed()
      },
      false
    )
  }

  get pid(): number | undefined {
    return this.peer.pid
  }

  async initialize(version: string): Promise<void> {
    try {
      await this.peer.request('initialize', { clientInfo: { name: 'togle', title: 'Togle', version } }, 30_000)
    } catch (error) {
      const why = this.peer.errors.join('').trim().split('\n').pop()
      throw new Error(`Codex did not start${why ? `: ${why}` : '.'}`, { cause: error })
    }
    this.peer.notify('initialized')
  }

  adopt(thread: Record<string, unknown>): CodexTask {
    const id = text(thread.id)
    const known = this.tasks.get(id)
    if (known) return known
    const task = new CodexTask(this, thread)
    this.tasks.set(id, task)
    return task
  }

  private route(method: string, params: Record<string, unknown>, id: Id): Promise<unknown> {
    const task = this.tasks.get(text(params.threadId))
    if (!task) return Promise.reject(new RpcError('Togle is not running that task.', -32601))
    return task.asked(method, params, id)
  }

  private notified(method: string, params: Record<string, unknown>): void {
    const task = this.tasks.get(text(params.threadId))
    if (!task) return
    switch (method) {
      case 'thread/status/changed':
        task.status(params.status)
        break
      case 'thread/name/updated':
        task.named(text(params.name) || text(params.threadName))
        break
      case 'turn/started':
        task.turnStarted(rec(params.turn))
        break
      case 'turn/completed':
        task.turnCompleted(rec(params.turn))
        break
      case 'item/started':
        task.itemStarted(rec(params.item))
        break
      case 'item/completed':
        task.itemCompleted(rec(params.item))
        break
      case 'serverRequest/resolved':
        task.resolvedElsewhere(params.requestId as Id)
        break
      default:
        break
    }
  }

  private closed(): void {
    for (const task of [...this.tasks.values()]) task.gone()
    this.tasks.clear()
    this.onClosed()
  }
}

export class CodexBackend implements Backend {
  readonly runner = 'codex' as const
  private server: Promise<CodexServer> | null = null

  constructor(private readonly options: CodexOptions = {}) {}

  async detect(): Promise<Detected> {
    const command = this.options.command?.[0] ?? (await findCodex())
    if (!command) return { installed: false }
    const version = (await run(command, [...(this.options.command?.slice(1) ?? []), '--version']).catch(() => '')).trim()
    return { installed: true, command, ...(version ? { version } : {}) }
  }

  private connect(): Promise<CodexServer> {
    this.server ??= this.launch().catch((error: unknown) => {
      this.server = null
      throw error
    })
    return this.server
  }

  private async launch(): Promise<CodexServer> {
    const command = this.options.command ?? [await findCodex()].filter((found): found is string => !!found)
    if (!command.length) throw new Error('Codex is not installed on this computer.')
    const server = new CodexServer(command, this.options.env, () => {
      this.server = null
    })
    await server.initialize(this.options.version ?? '0.0.0')
    return server
  }

  async list(): Promise<TaskInfo[]> {
    const server = await this.connect()
    const found = rec(await server.peer.request('thread/list', { limit: 100, sortKey: 'updated_at', sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] }))
    return list(found.data)
      .map(rec)
      .map((thread) => infoOf(thread, server.tasks.get(text(thread.id))))
  }

  async start(options: StartOptions): Promise<TaskHandle> {
    const server = await this.connect()
    const started = rec(await server.peer.request('thread/start', { cwd: options.folder, ephemeral: false, ...policy(options.asks) }))
    const task = server.adopt(rec(started.thread))
    if (options.title) {
      await server.peer.request('thread/name/set', { threadId: task.id, name: options.title })
      task.title = options.title
    }
    await task.send(options.prompt)
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    const server = await this.connect()
    const resumed = rec(await server.peer.request('thread/resume', { threadId: id, ...policy(options.asks) }))
    return server.adopt(rec(resumed.thread))
  }

  async close(): Promise<void> {
    const server = await this.server?.catch(() => null)
    this.server = null
    server?.peer.close()
  }
}
