// Codex on this computer. Togle runs each task as a thread on Codex's shared server (its "daemon", see codex-daemon.ts) and
// opens the thread's screen when someone looks at it: Codex's own terminal program, `codex --remote unix:// resume <thread>`, in
// a terminal of Togle's own. The person has the program they know, with its keys and commands, and the thread goes on when the
// screen is closed and when Togle quits: the server, not Togle, runs it. Togle is a second client of the server beside the
// screen. It hears what the thread does and what it asks, and an answer given in either place is enough: the other is told it
// was answered (`serverRequest/resolved`). Codex's sign-in and settings are the person's own; Togle touches neither.
//
// What trying Codex 0.169 (the server) with Codex 0.166 (its screen) on Windows showed, which this follows:
// - A client joins the server through `codex app-server proxy` and a WebSocket (codex-link.ts). `thread/start` subscribes the
//   client to its thread; `thread/resume` subscribes it to one that exists (it needs a first message: "no rollout found"
//   before). Status changes reach every client; a thread's items and what it asks reach the subscribed ones.
// - What a thread asks reaches the screen and every subscribed client at once. Whoever answers first wins. A request that is
//   still open when every client has gone stays open, and is sent again to the next client that joins the thread.
// - A command already running goes on when the screen or Togle is gone, and the turn goes on to its answer with nobody
//   connected. `turn/interrupt` ends the turn but not a command already running: Stop's second press ends that.
// - A thread started with no `approvalPolicy` and `sandbox` follows the person's own Codex settings, as in their terminal.
// - The server may report a thread `notLoaded` in the middle of a turn: that is not read as "not running" while a turn is.
import { execFile, spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentQuestion, ModelInfo, StepDetail, TaskHistory, TaskInfo, TaskState } from '@shared/runner'
import { askedLine } from './claude-sessions'
import { daemonPid, daemonState, startDaemon } from './codex-daemon'
import { codexEntries, turnsOf } from './codex-history'
import { detailOf, diffOf, isFileKey } from './step-detail'
import { WsRpcPeer } from './codex-link'
import { type Id, JsonRpcPeer, NO_ANSWER, type PeerHandlers, RpcError, type RpcPeer, list, rec, text } from './jsonrpc'
import { keepJson } from './keep'
import { endCommandsMatching, unwrapShell } from './process-tree'
import { type Answer, TaskBase } from './task-base'
import { cleanWords, loadPty, openTerminal, TerminalTask, type TerminalChunk } from './terminal'
import type { Backend, Detected, ResumeOptions, ScreenSide, StartOptions, TaskHandle, TerminalSide } from './types'

export interface CodexOptions {
  /** What starts Codex, before the word `app-server`. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** Togle's version, told to Codex. */
  version?: string
  /** Where what its screens print goes, for the window. Required: a screen whose words are not told shows only what it had printed when it was opened. */
  told: (chunk: TerminalChunk) => void
  /** A folder of Togle's own where the threads Togle runs are listed between runs: those that go on while Togle is closed are heard again. Without one, nothing is kept. */
  keep?: string
  /** The process Codex's shared server runs as, when one does: found by its command line when left out. */
  serverPid?: () => Promise<number | null>
  /** How often a lost connection to the shared server is tried again, in milliseconds. */
  retryMs?: number
}

const NATIVE: Record<string, { pkg: string; triple: string }> = {
  'win32-x64': { pkg: 'codex-win32-x64', triple: 'x86_64-pc-windows-msvc' },
  'win32-arm64': { pkg: 'codex-win32-arm64', triple: 'aarch64-pc-windows-msvc' }
}

// The newest turns shown with every step (as many as the other agents' first look); and how many pages of a hundred older ones
// "show earlier" brings.
const RECENT_TURNS = 12
// For how many threads what their steps hold is kept.
const DETAILS_KEPT = 4
const OLDER_PAGES = 3

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

/** The folder a thread works in: older Codex tells it as `cwd`, newer as the first of its `environments`. */
const folderOf = (thread: Record<string, unknown>): string => text(thread.cwd) || text(rec(list(thread.environments)[0]).cwd)

const titleOf = (thread: Record<string, unknown>): string => text(thread.name).trim() || oneLine(text(thread.preview)) || 'Codex task'

/** A thread's id is a UUID: anything else could be read as a flag by the program it is handed to. */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The state a thread's status stands for. A thread the server does not hold is `notLoaded`: not running there. */
const stateOf = (status: unknown): TaskState => {
  const s = rec(status)
  if (s.type === 'systemError') return 'failed'
  if (s.type === 'active') return list(s.activeFlags).length ? 'waiting' : 'working'
  return 'idle'
}

/** What a thread that waits waits for, in words: the person is told on the thread's screen when Togle has no request of its own. */
const waitingOf = (status: unknown): string | undefined => {
  const flags = list(rec(status).activeFlags).map(text)
  if (flags.includes('waitingOnApproval')) return 'approval'
  if (flags.includes('waitingOnUserInput')) return 'an answer'
  return flags.length ? 'you' : undefined
}

const infoOf = (thread: Record<string, unknown>, live: CodexTask | undefined, shared: boolean): TaskInfo => {
  const loaded = rec(thread.status).type !== 'notLoaded'
  const state = live ? live.state : stateOf(thread.status)
  const title = live?.title || titleOf(thread)
  // Codex's preview of a thread is the start of what was asked first in it.
  const asked = askedLine(text(thread.preview), title)
  return {
    id: text(thread.id),
    runner: 'codex',
    title,
    ...(asked ? { asked } : {}),
    folder: folderOf(thread) || live?.folder || '',
    state,
    updatedAt: (typeof thread.updatedAt === 'number' ? thread.updatedAt : 0) * 1000,
    // On the shared server a thread that is loaded there goes on without any window, and its screen is opened.
    ...(shared && (loaded || live) ? { job: text(thread.id) } : {}),
    ...(state === 'waiting' && !live?.pending.length && waitingOf(thread.status) ? { waitingFor: waitingOf(thread.status) } : {})
  }
}

const decisionOf = (answer: Answer): 'accept' | 'decline' | 'cancel' => (answer.kind === 'cancelled' ? 'cancel' : answer.kind === 'decision' && answer.decision !== 'refuse' ? 'accept' : 'decline')
/**
 * A command's answer. Always: Codex keeps the rule it proposed (the words commands start with) and runs matching commands
 * from then on without asking, wherever they run; the button says so.
 */
const commandDecisionOf = (answer: Answer, amendment: string[]): unknown =>
  answer.kind === 'decision' && answer.decision === 'allow-always' && amendment.length ? { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } : decisionOf(answer)

/** The environment of a screen: this computer's, as a terminal gives it. */
const screenEnv = (base: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

/** One screen: Codex's own program on a thread, in a terminal of Togle's own. It is over with its program, and the thread goes on. */
class CodexScreen extends TerminalTask {
  /** How its program ended: 0 or 130 (Ctrl+C) when the person left, anything else when Codex could not open it. */
  code: number | undefined

  constructor(id: string, title: string, folder: string, term: ConstructorParameters<typeof TerminalTask>[5], told: (chunk: TerminalChunk) => void, gone: () => void, readonly screenId: string) {
    super('codex', id, title, folder, 'Codex', term, undefined, told, gone)
  }

  protected override get tag(): string {
    return this.screenId
  }

  protected override exited(code: number, signal?: number): void {
    this.code = code
    super.exited(code, signal)
  }
}

const NOT_ANSWERED = 'The person did not answer.'

class CodexTask extends TaskBase implements ScreenSide {
  readonly runner = 'codex' as const
  private turnId: string | null = null
  /** The turn that ended last: its end may be heard before the answer that named it. */
  private lastEnded: string | null = null
  private stopped = false
  /** The turn that was running when Stop was pressed. */
  private stoppedTurn: string | null = null
  /** Closing: what waits is left open on the server, for the screen or the next client, and not answered. */
  private releasing = false
  /** Requests someone else answered: nothing is sent for them. */
  private readonly elsewhere = new Set<string>()
  /** Commands in progress: item id to the command as Codex sent it. */
  private readonly running = new Map<string, string>()
  /** The files each edit in progress changes: item id to paths. */
  private readonly edits = new Map<string, string[]>()
  private screenTask: CodexScreen | null = null
  private screens = 0
  closed: string | undefined

  constructor(private readonly server: CodexServer, thread: Record<string, unknown>) {
    super()
    this.id = text(thread.id)
    this.title = titleOf(thread)
    this.folder = folderOf(thread)
    this.setBase(stateOf(thread.status))
  }

  private get thread(): string {
    return this.id ?? ''
  }

  // ---- The screen (a thread on the shared server) ----

  get screen(): ScreenSide | undefined {
    return this.server.shared ? this : undefined
  }

  get terminal(): TerminalSide | undefined {
    return this.screenTask ?? undefined
  }

  get pid(): number | null {
    return null
  }

  get job(): string {
    return this.thread
  }

  get open(): boolean {
    return this.screenTask !== null
  }

  get screenId(): string | undefined {
    return this.screenTask?.screenId
  }

  get line(): string {
    return `codex resume ${this.thread}`
  }

  session(): string {
    return this.thread
  }

  async show(): Promise<void> {
    if (this.screenTask) return
    if (!THREAD_ID.test(this.thread)) throw new Error('That is not a thread Codex knows.')
    const pty = await loadPty()
    if (!pty) {
      this.closed = 'Togle cannot open a terminal on this computer.'
      throw new Error(`${this.closed} The task goes on: ${this.line} opens it in your own terminal.`)
    }
    this.closed = undefined
    const { command, env, told } = this.server.context
    const task: CodexScreen = new CodexScreen(
      this.thread,
      this.title,
      this.folder,
      openTerminal(pty, command[0], [...command.slice(1), '--remote', 'unix://', 'resume', this.thread], this.folder || process.cwd(), screenEnv(env)),
      told,
      () => this.screenEnded(task),
      `${this.thread.slice(0, 8)}-${++this.screens}`
    )
    this.screenTask = task
    this.emit({ type: 'screen', shown: true })
    this.server.context.look()
  }

  async hide(): Promise<void> {
    const task = this.screenTask
    if (!task) return
    this.screenTask = null
    this.emit({ type: 'screen', shown: false })
    await task.close()
  }

  /** The program of a screen ended: the person left it, or it could not open (the server is not there). */
  private screenEnded(task: CodexScreen): void {
    if (this.screenTask !== task) return
    this.screenTask = null
    const said = cleanWords(task.read().text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    // A screen that could not open prints why and ends with an error; one the person left ends well.
    if (task.code !== 0 && task.code !== 130 && said.length > 0) this.closed = said.at(-1)?.slice(0, 200)
    this.emit({ type: 'screen', shown: false })
    this.server.context.look()
  }

  // ---- What the person does ----

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
    // Working from now on, and before the answer: a quick turn can end before the answer to this call is read, and
    // what the app server said about it since is the later word.
    this.setBase('working')
    try {
      const started = rec(await this.server.peer.request('turn/start', { threadId: this.id, input }))
      const turnId = text(rec(started.turn).id) || null
      if (turnId !== this.lastEnded) this.turnId = turnId
    } catch (error) {
      this.setBase('idle')
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stoppedTurn = this.turnId
    this.cancelRequests()
    if (this.turnId) await this.server.peer.request('turn/interrupt', { threadId: this.id, turnId: this.turnId }).catch(() => undefined)
    this.setBase('stopped')
  }

  async endCommands(): Promise<number> {
    const pid = await this.server.commandRoot()
    if (!pid) return 0
    let ended = 0
    for (const command of [...this.running.values()]) ended += await endCommandsMatching(pid, unwrapShell(command))
    return ended
  }

  /**
   * Lets go of the task. On the shared server the thread goes on, and what waits stays open for the screen or the next client to
   * answer; on a server of Togle's own the thread is let go of and the server ends with Togle.
   */
  async close(): Promise<void> {
    this.releasing = true
    this.cancelRequests()
    await this.hide()
    if (!this.server.shared) await this.server.peer.request('thread/unsubscribe', { threadId: this.id }, 5_000).catch(() => undefined)
    this.server.tasks.delete(this.thread)
    this.emit({ type: 'ended', reason: 'closed' })
  }

  /** The connection ended under the task. On the shared server that says nothing of the thread, which goes on. */
  gone(): void {
    this.releasing = true
    this.cancelRequests()
    void this.hide()
    if (this.server.shared) {
      this.setBase('idle')
      this.emit({ type: 'ended', reason: 'closed' })
      return
    }
    this.setBase('failed')
    this.emit({ type: 'ended', reason: 'crashed' })
  }

  // ---- What the server says ----

  status(status: unknown): void {
    const next = stateOf(status)
    if (next === 'idle' && this.stopped) return
    // `notLoaded` while a turn is known to run says the server let go of its copy of the thread, not that the work stopped.
    if (rec(status).type === 'notLoaded' && this.turnId) return
    this.setBase(next)
  }

  named(name: string): void {
    this.setTitle(name.trim())
  }

  turnStarted(turn: Record<string, unknown>): void {
    const id = text(turn.id)
    this.turnId = id || this.turnId
    // A turn that is another one than the one Stop interrupted is new (the person typed on the screen again): the task works
    // again, and ends as any other. The turn Stop interrupted can still be told as started after Stop was pressed.
    if (this.stopped && id && id !== this.stoppedTurn) this.stopped = false
    if (!this.stopped) this.setBase('working')
  }

  turnCompleted(turn: Record<string, unknown>): void {
    const status = text(turn.status)
    const error = Object.keys(rec(turn.error)).length ? text(rec(turn.error).message) || 'The turn failed.' : null
    this.lastEnded = text(turn.id) || this.lastEnded
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

  /**
   * A thread taken up in the middle of a turn (Togle was closed when it began): the turn and the commands it runs are read from
   * the thread, so that Stop can end the turn and the second press can end the commands.
   */
  async learn(): Promise<void> {
    if (this.turnId) return
    const read = rec(await this.server.peer.request('thread/read', { threadId: this.id, includeTurns: true }).catch(() => ({})))
    const open = [...list(rec(read.thread).turns).map(rec)].reverse().find((turn) => text(turn.status) === 'inProgress')
    if (!open) return
    this.turnId = text(open.id) || null
    for (const item of list(open.items).map(rec)) if (text(item.status) === 'inProgress') this.itemStarted(item)
  }

  /** Answered on the screen, or by another client: the card goes, and nothing is sent for it. */
  resolvedElsewhere(requestId: Id): void {
    const id = String(requestId)
    this.elsewhere.add(id)
    this.dropRequest(id, 'cancelled')
    // A request that was not Togle's to answer (never asked here) leaves nothing behind.
    setTimeout(() => this.elsewhere.delete(id), 5_000).unref?.()
  }

  /** No answer for a request that was cancelled for a reason other than Stop: the server has its answer, or keeps the question open. */
  private unanswered(id: string, answer: Answer): boolean {
    return answer.kind === 'cancelled' && (this.releasing || this.elsewhere.delete(id))
  }

  /** Something the agent asks, which waits for the person. */
  async asked(method: string, params: Record<string, unknown>, rpcId: Id): Promise<unknown> {
    const id = String(rpcId)
    if (method === 'item/commandExecution/requestApproval') {
      const raw = text(params.command)
      const amendment = list(params.proposedExecpolicyAmendment).map(text).filter(Boolean)
      const answer = await this.ask({
        id,
        kind: 'command',
        command: unwrapShell(raw),
        raw,
        folder: text(params.cwd) || this.folder,
        reason: text(params.reason) || undefined,
        offersAlways: amendment.length > 0,
        ...(amendment.length ? { always: `Always allow commands that start with ${amendment.join(' ')}` } : {})
      })
      if (this.unanswered(id, answer)) return NO_ANSWER
      return { decision: commandDecisionOf(answer, amendment) }
    }
    if (method === 'item/fileChange/requestApproval') {
      const files = this.edits.get(text(params.itemId)) ?? (text(params.grantRoot) ? [text(params.grantRoot)] : [])
      const answer = await this.ask({ id, kind: 'edit', folder: this.folder, reason: text(params.reason) || undefined, files, offersAlways: false })
      if (this.unanswered(id, answer)) return NO_ANSWER
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
      if (this.unanswered(id, answer)) return NO_ANSWER
      if (answer.kind !== 'text') throw new RpcError(NOT_ANSWERED, -32000)
      return { answers: Object.fromEntries(questions.map((q, at) => [q.id, { answers: at === 0 ? [answer.text] : [] }])) }
    }
    // Something Togle has no card for (a question from a tool, a permission): it waits on the thread's screen. Togle sends the
    // server nothing for it, so that nothing of Togle's can beat the person's own answer there.
    this.emit({ type: 'error', message: `Codex asked for something Togle cannot answer yet (${method}). Answer it on its screen.` })
    return NO_ANSWER
  }
}

/** What a server asks of the backend that runs it. */
interface ServerContext {
  command: string[]
  env: NodeJS.ProcessEnv
  /** Where what a screen prints goes, for the window. */
  told: (chunk: TerminalChunk) => void
  /** The process the shared server runs as, when one does. */
  serverPid: () => Promise<number | null>
  /** Something changed: the window is told soon. */
  look: () => void
}

/** How long a request of a thread whose task is not made yet waits for it, in milliseconds. */
const EARLY_MS = 10_000

/** A screen that cannot open does not undo the task: it goes on, and the task says why its screen is closed. */
const openFailed =
  (task: CodexTask) =>
  (error: unknown): void => {
    task.closed ??= error instanceof Error ? error.message : String(error)
  }

class CodexServer {
  readonly tasks = new Map<string, CodexTask>()
  readonly peer: RpcPeer
  /** What the server asked of a thread that has no task yet. */
  private readonly early = new Map<string, { method: string; params: Record<string, unknown>; id: Id; settle: (answer: Promise<unknown>) => void }[]>()

  /** `shared`: Codex's shared server, joined through its proxy; else a server of our own on standard input and output. */
  constructor(
    readonly context: ServerContext,
    readonly shared: boolean,
    private readonly onClosed: () => void
  ) {
    const handlers: PeerHandlers = {
      request: (method, params, id) => this.route(method, rec(params), id),
      notification: (method, params) => this.notified(method, rec(params)),
      closed: () => this.closed()
    }
    this.peer = shared
      ? new WsRpcPeer([context.command[0], ...context.command.slice(1), 'app-server', 'proxy'], context.env, handlers)
      : new JsonRpcPeer(spawn(context.command[0], [...context.command.slice(1), 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: context.env }), handlers, false)
  }

  /** The process that runs the commands of the threads: Codex's server, or ours. */
  async commandRoot(): Promise<number | undefined> {
    return this.shared ? ((await this.context.serverPid()) ?? undefined) : this.peer.pid
  }

  async initialize(version: string): Promise<void> {
    try {
      if (this.peer instanceof WsRpcPeer) await this.peer.opened
      await this.peer.request('initialize', { clientInfo: { name: 'togle', title: 'Togle', version } }, 30_000)
    } catch (error) {
      const why = error instanceof RpcError && this.shared ? error.message : this.peer.errors.join('').trim().split('\n').pop()
      this.peer.close()
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
    for (const early of this.early.get(id) ?? []) early.settle(task.asked(early.method, early.params, early.id))
    this.early.delete(id)
    return task
  }

  private route(method: string, params: Record<string, unknown>, id: Id): Promise<unknown> {
    const thread = text(params.threadId)
    const task = this.tasks.get(thread)
    if (task) return task.asked(method, params, id)
    // A thread is joined a moment before its task is made, and the server sends what waits on it as it is joined: the request
    // waits for the task. When none comes it is left open, for the screen or the next client, and never refused.
    return new Promise((resolve, reject) => {
      const entry = { method, params, id, settle: (answer: Promise<unknown>) => void answer.then(resolve, reject) }
      this.early.set(thread, [...(this.early.get(thread) ?? []), entry])
      setTimeout(() => {
        const left = this.early.get(thread)
        if (!left?.includes(entry)) return
        this.early.set(thread, left.filter((other) => other !== entry))
        resolve(NO_ANSWER)
      }, EARLY_MS).unref?.()
    })
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
    this.context.look()
  }

  private closed(): void {
    for (const task of [...this.tasks.values()]) task.gone()
    this.tasks.clear()
    this.onClosed()
  }
}

/** A thread Togle runs on the shared server, and what is needed to hear it again if Togle is closed while it works. */
interface Known {
  id: string
  folder: string
  title: string
  /** When Togle last ran or opened the thread, in milliseconds. */
  at: number
}

const KNOWN = 'threads.json'
/** How long a thread the server calls `notLoaded` is still looked at again, in milliseconds. */
const NOT_LOADED_MS = 30 * 60_000
const SOURCES = ['cli', 'vscode', 'exec', 'appServer']
/** The most threads that are remembered. */
const KEEP_MOST = 60

export class CodexBackend implements Backend {
  readonly runner = 'codex' as const
  readonly screens = true
  /** The connection to Codex's shared server, while there is one (or while one is being made: the server may be starting). */
  private shared: Promise<CodexServer> | null = null
  /** The same connection, once it is made. */
  private joined: CodexServer | null = null
  private catching: Promise<boolean> | null = null
  /** A server of our own, only to list the threads while the shared one is not running. */
  private own: Promise<CodexServer> | null = null
  private lookedAt = 0
  private readonly known = new Map<string, Known>()
  /** What the steps of the threads read last hold to be opened, by thread. */
  private readonly details = new Map<string, Map<string, string>>()
  private loaded?: Promise<void>
  private adopted?: (task: TaskHandle) => void
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null
  private retries = 0
  private closing = false
  private resolved?: Promise<ServerContext>

  constructor(private readonly options: CodexOptions) {}

  async detect(): Promise<Detected> {
    const command = this.options.command?.[0] ?? (await findCodex())
    if (!command) return { installed: false }
    const version = (await run(command, [...(this.options.command?.slice(1) ?? []), '--version']).catch(() => '')).trim()
    return { installed: true, command, ...(version ? { version } : {}) }
  }

  private context(): Promise<ServerContext> {
    this.resolved ??= (async (): Promise<ServerContext> => {
      const command = this.options.command ?? [await findCodex()].filter((found): found is string => !!found)
      if (!command.length) throw new Error('Codex is not installed on this computer.')
      return {
        command,
        env: this.options.env ?? process.env,
        told: this.options.told,
        serverPid: this.options.serverPid ?? daemonPid,
        look: () => this.look()
      }
    })()
    this.resolved.catch(() => {
      this.resolved = undefined
    })
    return this.resolved
  }

  // ---- The servers ----

  /** The connection to Codex's shared server. `start`: the server is started when it is not running; otherwise this fails. */
  private async join(start: boolean): Promise<CodexServer> {
    const pending = this.shared
    if (pending) {
      try {
        return await pending
      } catch {
        // Several callers wait on one attempt: the first to see it fail clears it, and the others join the new one if it has begun.
        if (this.shared === pending) this.shared = null
        else if (this.shared) return this.join(start)
      }
    }
    const attempt = (async (): Promise<CodexServer> => {
      const context = await this.context()
      const state = start ? await startDaemon(context.command, context.env) : await daemonState(context.command, context.env)
      if (!state.running) throw new Error('Codex’s shared server is not running.')
      const server = new CodexServer(context, true, () => {
        if (this.shared === attempt) this.shared = null
        if (this.joined === server) this.joined = null
        // Whatever Togle ran there goes on; Togle looks again for it soon.
        this.look()
        this.ticking()
      })
      await server.initialize(this.options.version ?? '0.0.0')
      this.joined = server
      // A server of our own is only for when there is no shared one.
      this.dropOwn()
      return server
    })()
    this.shared = attempt
    attempt.then(
      // Whatever Togle ran before and still works is taken up again on each new connection, however it was made.
      () => void this.catchUp(),
      () => {
        if (this.shared === attempt) this.shared = null
      }
    )
    return attempt
  }

  /** Lets go of the server of our own, which is only for when there is no shared one. */
  private dropOwn(): void {
    const own = this.own
    this.own = null
    void own?.then((found) => found.peer.close(), () => undefined)
  }

  /**
   * The server to list the threads from: the shared one when it runs (asked every so often), else one of our own. The list does
   * not wait while the shared server is being started for a task: it is read from our own meanwhile.
   */
  private async listing(): Promise<CodexServer> {
    if (this.joined) return this.joined
    if (!this.shared && Date.now() - this.lookedAt > 8_000) {
      this.lookedAt = Date.now()
      try {
        return await this.join(false)
      } catch {
        // Not running: the threads are read from a server of our own.
      }
    }
    this.own ??= (async (): Promise<CodexServer> => {
      const context = await this.context()
      const server = new CodexServer(context, false, () => {
        this.own = null
      })
      await server.initialize(this.options.version ?? '0.0.0')
      return server
    })().catch((error: unknown) => {
      this.own = null
      throw error
    })
    return this.own
  }

  // ---- What Codex lists ----

  async list(): Promise<TaskInfo[]> {
    const server = await this.listing()
    // A server that does not answer soon is left to the next look: one slow agent must not hold up the whole list.
    const found = rec(await server.peer.request('thread/list', { limit: 100, sortKey: 'updated_at', sourceKinds: SOURCES }, 15_000))
    const rows = list(found.data)
      .map(rec)
      .map((thread) => infoOf(thread, server.tasks.get(text(thread.id)), server.shared))
    // A thread the server lists only once its first message is saved: one Togle runs is shown from the start.
    for (const task of server.tasks.values()) {
      if (!task.id || rows.some((row) => row.id === task.id)) continue
      rows.unshift({ id: task.id, runner: 'codex', title: task.title || 'Codex task', folder: task.folder, state: task.state, updatedAt: Date.now(), ...(server.shared ? { job: task.id } : {}) })
    }
    return rows
  }

  /**
   * What Codex kept of a thread's conversation: its newest turns with every step, and with `all` the older ones too, with what
   * was asked and answered (the whole thread in one call can be tens of megabytes). Null when the server has no such thread yet.
   */
  async history(id: string, all: boolean): Promise<TaskHistory | null> {
    const server = await this.listing()
    const ask = (params: Record<string, unknown>): Promise<unknown> => server.peer.request('thread/turns/list', { threadId: id, sortDirection: 'desc', ...params }, 15_000)
    let recent: { turns: unknown[]; next: string | null }
    try {
      recent = turnsOf(await ask({ limit: RECENT_TURNS, itemsView: 'full' }))
    } catch {
      return null
    }
    // What the steps of these turns hold to be opened, kept until the thread is read again (and for a few threads only).
    const details = new Map<string, string>()
    let entries = codexEntries([...recent.turns].reverse(), details)
    this.details.delete(id)
    this.details.set(id, details)
    while (this.details.size > DETAILS_KEPT) this.details.delete(this.details.keys().next().value as string)
    let next = recent.next
    if (all) {
      const older: unknown[][] = []
      for (let pages = 0; next && pages < OLDER_PAGES; pages++) {
        const page = turnsOf(await ask({ limit: 100, itemsView: 'summary', cursor: next }).catch(() => ({})))
        older.unshift([...page.turns].reverse())
        next = page.next
        if (!page.turns.length) break
      }
      entries = [...codexEntries(older.flat()), ...entries]
    }
    return { entries, more: !!next }
  }

  /** What a step of that conversation holds (what a command printed, a thought's words), as the thread's last reading gave it. */
  async step(id: string, more: string): Promise<StepDetail | null> {
    const raw = this.details.get(id)?.get(more)
    return isFileKey(more) ? diffOf(raw) : detailOf(raw)
  }

  /**
   * The model and the reasoning effort a thread runs on: the thread's own `model` and `reasoningEffort` (Codex 0.166 gives both on every
   * thread), read without its turns, which is cheap. Null when the server has no such thread or tells neither.
   */
  async modelOf(id: string): Promise<ModelInfo | null> {
    const server = await this.listing()
    const thread = rec(rec(await server.peer.request('thread/read', { threadId: id, includeTurns: false }, 15_000).catch(() => ({}))).thread)
    const model = text(thread.model)
    const effort = text(thread.reasoningEffort)
    return model || effort ? { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } : null
  }

  // ---- Starting and opening ----

  async start(options: StartOptions): Promise<TaskHandle> {
    const server = await this.join(true)
    const started = rec(await server.peer.request('thread/start', { cwd: options.folder, ephemeral: false, ...policy(options.asks) }))
    const task = server.adopt(rec(started.thread))
    if (!task.folder) task.folder = options.folder
    if (options.title) {
      await server.peer.request('thread/name/set', { threadId: task.id, name: options.title })
      task.title = options.title
    }
    await task.send(options.prompt)
    await this.remember(task)
    // A screen that cannot open does not undo the task: it goes on, and its screen says why it is closed.
    await task.show().catch(openFailed(task))
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    const server = await this.join(true)
    // A thread Togle runs already is opened, not joined again.
    const running = server.tasks.get(id)
    if (running) {
      await running.show().catch(openFailed(running))
      return running
    }
    const resumed = rec(await server.peer.request('thread/resume', { threadId: id, ...policy(options.asks) }))
    const task = server.adopt(rec(resumed.thread))
    // The folder as the list told it, when the server does not say.
    if (!task.folder && options.folder) task.folder = options.folder
    // One that is at work now (a screen of the person's own started it): the turn is read, so that Stop can end it.
    if (stateOf(rec(resumed.thread).status) !== 'idle') await task.learn()
    await this.remember(task)
    await task.show().catch(openFailed(task))
    return task
  }

  // ---- Threads that go on without Togle ----

  /** Picks up the threads Togle ran before that are at work or waiting now, with what they ask. */
  async restore(adopt: (task: TaskHandle) => void): Promise<void> {
    this.adopted = adopt
    await this.ready()
    if (!this.known.size) return
    await this.catchUp()
    this.ticking()
  }

  /** Joins the shared server if it runs, and takes up the threads Togle ran that are at work or waiting. One look at a time. */
  private catchUp(): Promise<boolean> {
    this.catching ??= this.takeUp().finally(() => {
      this.catching = null
    })
    return this.catching
  }

  private async takeUp(): Promise<boolean> {
    if (!this.known.size || !this.adopted) return false
    let server: CodexServer
    try {
      server = await this.join(false)
    } catch {
      return false
    }
    try {
      const rows = list(rec(await server.peer.request('thread/list', { limit: 100, sortKey: 'updated_at', sourceKinds: SOURCES })).data).map(rec)
      for (const known of [...this.known.values()]) {
        const row = rows.find((thread) => text(thread.id) === known.id)
        if (!row) continue
        // Idle: nothing waits for Togle, and the list shows it. Only what works or waits is taken up. `notLoaded` says only that
        // the server let go of its copy of the thread, which a turn may still be running: a thread Togle started lately is looked
        // at again, not forgotten.
        const status = rec(row.status).type
        if (status === 'notLoaded' && Date.now() - known.at < NOT_LOADED_MS) continue
        if (status !== 'active') {
          await this.dismiss(known)
          continue
        }
        if (server.tasks.has(known.id)) continue
        try {
          const resumed = rec(await server.peer.request('thread/resume', { threadId: known.id }))
          const task = server.adopt(rec(resumed.thread))
          if (!task.folder) task.folder = known.folder
          if (known.title) task.title = known.title
          await task.learn()
          this.adopted(task)
        } catch {
          // The thread could not be taken up now: the list still shows it, and opening it tries again.
        }
      }
    } catch {
      return false
    }
    return true
  }

  // ---- Looking again ----

  /** While a thread of Togle's may be at work with no connection to its server, the server is looked for again. */
  private ticking(): void {
    if (this.timer || this.closing || !this.known.size || !this.adopted) return
    const every = this.options.retryMs ?? (this.retries < 8 ? 8_000 : 30_000)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, every)
    this.timer.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.closing) return
    this.retries++
    try {
      if (!this.shared || !(await this.shared.then((server) => server.peer.running, () => false))) {
        if (await this.catchUp()) this.retries = 0
      }
    } catch {
      // Tried again at the next look.
    }
    if (this.known.size) this.ticking()
  }

  /** Something changed: nothing to do but be ready for the window to ask again. */
  private look(): void {
    if (this.soon || this.closing) return
    this.soon = setTimeout(() => {
      this.soon = null
    }, 150)
    this.soon.unref?.()
  }

  // ---- What is kept between runs ----

  private ready(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.options.keep) return
      try {
        const saved = rec(JSON.parse(await fs.readFile(path.join(this.options.keep, KNOWN), 'utf8')) as unknown)
        for (const item of list(saved.threads).map(rec)) {
          const id = typeof item.id === 'string' ? item.id : ''
          if (!THREAD_ID.test(id)) continue
          this.known.set(id, { id, folder: typeof item.folder === 'string' ? item.folder : '', title: typeof item.title === 'string' ? item.title : '', at: typeof item.at === 'number' ? item.at : 0 })
        }
      } catch {
        // Nothing was kept yet, or what was kept cannot be read: Togle starts without it.
      }
    })()
    return this.loaded
  }

  private async remember(task: CodexTask): Promise<void> {
    await this.ready()
    const id = task.id ?? ''
    if (!THREAD_ID.test(id)) return
    this.known.delete(id)
    this.known.set(id, { id, folder: task.folder, title: task.title, at: Date.now() })
    // The oldest are let go of when there are many.
    for (const old of [...this.known.keys()].slice(0, Math.max(0, this.known.size - KEEP_MOST))) this.known.delete(old)
    await this.save()
    this.ticking()
  }

  private async dismiss(known: Known): Promise<void> {
    this.known.delete(known.id)
    await this.save()
  }

  /** A write that fails is only not kept: the thread goes on, and the list shows it. */
  private async save(): Promise<void> {
    const keep = this.options.keep
    if (keep) await keepJson(path.join(keep, KNOWN), { threads: [...this.known.values()] })
  }

  /** Stops using Codex. The threads on the shared server go on: only the connection and the screens close here. */
  async close(): Promise<void> {
    this.closing = true
    for (const timer of [this.timer, this.soon]) if (timer) clearTimeout(timer)
    this.timer = null
    this.soon = null
    const servers = await Promise.all([this.shared, this.own].map((server) => server?.catch(() => null)))
    this.shared = null
    this.joined = null
    this.own = null
    for (const server of servers) server?.peer.close()
  }
}
