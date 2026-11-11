// Every coding agent's tasks as one list for the window, and what the person can do with them. The agents' own
// backends (codex.ts, claude.ts) know how to talk to their agent; this joins them: the tasks they keep on this computer,
// the ones Togle runs (with what happened in each, so the window can show it), and the actions on a task by its key.
import { promises as fs } from 'node:fs'
import type { Changes, Decision, LogEntry, RunnerKind, RunnerStatus, StartRequest, TaskAttention, TaskDetail, TaskEvent, TaskInfo, TaskView, ViewRequest } from '@shared/runner'
import { dangerOf } from '@shared/runner-command'
import { changesIn } from './changes'
import { ExternalRequests, type Held, type Look, type OutsideAsk } from './external'
import { endTree, listProcesses } from './process-tree'
import type { Backend, Detected, TaskHandle } from './types'

export const RUNNER_NAMES: Record<RunnerKind, string> = { codex: 'Codex', claude: 'Claude Code', hermes: 'Hermes' }

/** The names Togle gave tasks, kept between runs. */
export interface TitleStore {
  get(key: string): string | undefined
  set(key: string, title: string): void
}

/** A task Togle started or picked up, remembered: some agents cannot list their own sessions. */
export interface TaskRecord {
  runner: RunnerKind
  id: string
  title: string
  folder: string
  /** When it was started or picked up, in milliseconds. */
  at: number
}

export interface RecordStore {
  all(): TaskRecord[]
  add(record: TaskRecord): void
}

export interface HubOptions {
  backends: Backend[]
  /** Something the window shows has changed. Called at most about every 100 ms. */
  changed: () => void
  titles?: TitleStore
  records?: RecordStore
  /** How long the agents' lists are reused, in milliseconds. */
  cacheMs?: number
  /** How long quitting waits for the commands of stopped tasks to end, in milliseconds. */
  quitWaitMs?: number
  /** How often the requests of sessions Togle does not run are looked at, and how long each is left alone first, in milliseconds. */
  outsideEveryMs?: number
  outsideGraceMs?: number
}

interface Owned {
  key: string
  handle: TaskHandle
  log: LogEntry[]
  /** Commands in progress. */
  running: number
  updatedAt: number
  off: () => void
}

const LOG_LIMIT = 400
const keyOf = (runner: RunnerKind, id: string): string => `${runner}:${id}`
const short = (value: string, longest = 90): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > longest ? `${line.slice(0, longest - 1)}…` : line
}
const firstSentence = (value: string): string => short(/^[^.!?\n]*[.!?]?/.exec(value.trim())?.[0] ?? value)
const baseName = (folder: string): string => folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''

/** What a request asks, in one line. */
function requestLine(request: ViewRequest): string {
  if (request.kind === 'question') return `Asks: ${short(request.questions?.[0]?.text ?? '')}`
  if (request.kind === 'edit') return `Wants to change ${short(request.files?.join(', ') ?? 'a file', 70)}`
  return `Wants to run ${short(request.command ?? '', 70)}`
}

/** Waiting for the person first, then what is working, then the rest, newest first. */
const rank = (task: TaskView): number => (task.state === 'waiting' ? 0 : task.state === 'working' ? 1 : 2)
const order = (a: TaskView, b: TaskView): number => rank(a) - rank(b) || b.updatedAt - a.updatedAt

export class RunnerHub {
  private readonly owned = new Map<string, Owned>()
  private cache: { at: number; infos: TaskInfo[] } | null = null
  private found: { at: number; status: RunnerStatus[] } | null = null
  private timer: NodeJS.Timeout | null = null
  private nextLog = 1
  private disposed = false
  private disposing: Promise<void> | null = null
  private readonly cacheMs: number
  private readonly outside: ExternalRequests

  constructor(private readonly options: HubOptions) {
    this.cacheMs = options.cacheMs ?? 4_000
    this.outside = new ExternalRequests({
      changed: () => this.fresh(),
      look: (held) => this.lookAt(held),
      ...(options.outsideEveryMs ? { everyMs: options.outsideEveryMs } : {}),
      ...(options.outsideGraceMs !== undefined ? { graceMs: options.outsideGraceMs } : {})
    })
  }

  /**
   * A question from a session Togle does not run, asked by its hook. It is held until the person answers it here, or
   * until it is gone; the one who asked is told which. A session Togle runs itself is answered through its own route.
   */
  askOutside(ask: OutsideAsk, signal: AbortSignal): Promise<Decision | 'gone'> {
    if (this.disposed || this.owned.has(keyOf(ask.runner, ask.asked.sessionId))) return Promise.resolve('gone')
    return this.outside.hold(ask, signal)
  }

  /** Which agents are on this computer. */
  async status(): Promise<RunnerStatus[]> {
    if (this.found && Date.now() - this.found.at < 20_000) return this.found.status
    const status = await Promise.all(
      this.options.backends.map(async (backend): Promise<RunnerStatus> => {
        const detected: Detected = await backend.detect().catch(() => ({ installed: false }))
        return { runner: backend.runner, name: RUNNER_NAMES[backend.runner], installed: detected.installed, ...(detected.version ? { version: detected.version } : {}) }
      })
    )
    this.found = { at: Date.now(), status }
    return status
  }

  async list(): Promise<TaskView[]> {
    const views = new Map<string, TaskView>()
    for (const info of await this.infos()) views.set(keyOf(info.runner, info.id), this.viewOfInfo(info))
    for (const owned of this.owned.values()) views.set(owned.key, this.viewOfOwned(owned, views.get(owned.key)))
    for (const key of this.outside.keys()) if (!this.owned.has(key)) views.set(key, this.viewOfOutside(key, views.get(key)))
    return [...views.values()].sort(order)
  }

  async detail(key: string): Promise<TaskDetail> {
    const task = (await this.list()).find((view) => view.key === key)
    if (!task) throw new Error('That task is gone.')
    return { task, log: [...(this.owned.get(key)?.log ?? [])] }
  }

  async start(request: StartRequest): Promise<TaskView> {
    const backend = this.backend(request.runner)
    const prompt = request.prompt.trim()
    if (!prompt) throw new Error('Say what the task is.')
    const folder = await fs.stat(request.folder).catch(() => null)
    if (!folder?.isDirectory()) throw new Error('That folder is not there.')
    // A task started here always asks before a command or an edit.
    const handle = await backend.start({ folder: request.folder, prompt, title: request.title?.trim() || undefined, asks: true })
    const owned = await this.adopt(handle)
    this.log(owned, 'you', prompt)
    this.options.titles?.set(owned.key, owned.handle.title)
    this.fresh()
    return this.viewOfOwned(owned, undefined)
  }

  /** Picks up a task that was started earlier, so it can be answered and replied to here. */
  async open(key: string): Promise<TaskView> {
    const known = this.owned.get(key)
    if (known) return this.viewOfOwned(known, undefined)
    const info = (await this.infos()).find((task) => keyOf(task.runner, task.id) === key)
    if (!info) throw new Error('That task is gone.')
    const handle = await this.backend(info.runner).resume(info.id, { asks: true, folder: info.folder })
    const owned = await this.adopt(handle)
    this.fresh()
    return this.viewOfOwned(owned, this.viewOfInfo(info))
  }

  /**
   * Takes a task over from the program that runs it in a terminal: that program is ended (the conversation is kept)
   * and Togle picks the task up. Only for Claude Code, and only for the program that was listed for it.
   */
  async takeOver(key: string): Promise<TaskView> {
    this.cache = null
    const info = (await this.infos()).find((task) => keyOf(task.runner, task.id) === key)
    if (!info) throw new Error('That task is gone.')
    if (this.owned.has(key) || !info.pid) return this.open(key)
    if (info.runner !== 'claude') throw new Error(`${RUNNER_NAMES[info.runner]} tasks cannot be taken over.`)
    const program = (await listProcesses()).find((proc) => proc.pid === info.pid)
    if (!program || !/claude/i.test(program.command)) throw new Error('That program is not Claude Code any more, so it was left alone.')
    await endTree(info.pid)
    for (let waited = 0; waited < 5_000; waited += 200) {
      if (!(await listProcesses()).some((proc) => proc.pid === info.pid)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    this.cache = null
    return this.open(key)
  }

  async send(key: string, text: string): Promise<void> {
    const owned = this.mine(key)
    const message = text.trim()
    if (!message) return
    this.log(owned, 'you', message)
    this.touch(owned)
    await owned.handle.send(message)
    this.fresh()
  }

  answer(key: string, requestId: string, decision: Decision): void {
    if (decision !== 'allow-once' && decision !== 'refuse') throw new Error('Allow once or refuse.')
    // A question held for a session that runs elsewhere: the answer goes back to its hook.
    if (this.outside.answer(key, requestId, decision)) return
    if (!this.owned.has(key) && this.outside.keys().includes(key)) throw new Error('That question is gone: it was answered where the session runs.')
    this.mine(key).handle.answer(requestId, decision)
  }

  reply(key: string, requestId: string, text: string): void {
    this.mine(key).handle.reply(requestId, text)
  }

  async stop(key: string): Promise<void> {
    const owned = this.mine(key)
    await owned.handle.stop()
    this.touch(owned)
    this.fresh()
  }

  async endCommands(key: string): Promise<number> {
    const owned = this.mine(key)
    const ended = await owned.handle.endCommands()
    if (ended) this.log(owned, 'note', ended === 1 ? 'Ended the command that was running.' : `Ended ${ended} commands that were running.`)
    this.fresh()
    return ended
  }

  /** Lets go of a task Togle runs. It stays on this computer. */
  async close(key: string): Promise<void> {
    const owned = this.owned.get(key)
    if (!owned) return
    this.owned.delete(key)
    owned.off()
    await owned.handle.close()
    this.fresh()
  }

  /** What differs from the last commit in the folder a task works in. */
  async changes(key: string): Promise<Changes> {
    const folder = this.owned.get(key)?.handle.folder || (await this.infos()).find((task) => keyOf(task.runner, task.id) === key)?.folder
    if (!folder) throw new Error('That task is gone.')
    return changesIn(folder)
  }

  /** What the tasks Togle runs need now. Asks the agents nothing, so it is cheap enough to ask at every change. */
  attention(): TaskAttention[] {
    const mine = [...this.owned.values()].map((owned) => {
      const view = this.viewOfOwned(owned, undefined)
      return { key: owned.key, runner: view.runner, title: view.title, folder: view.folder, state: view.state, pending: view.pending, line: view.line }
    })
    // Sessions that run elsewhere and ask about a command: answered here as well.
    const elsewhere = this.outside.keys().filter((key) => !this.owned.has(key)).map((key) => {
      const known = this.cache?.infos.find((info) => keyOf(info.runner, info.id) === key)
      const view = this.viewOfOutside(key, known ? this.viewOfInfo(known) : undefined)
      return { key, runner: view.runner, title: view.title, folder: view.folder, state: view.state, pending: view.pending, line: view.line }
    })
    return [...mine, ...elsewhere]
  }

  /** The tasks Togle runs that would stop in the middle if Togle quit now: working, or waiting for the person. */
  busy(): { key: string; title: string; waiting: boolean }[] {
    return [...this.owned.values()]
      .filter(({ handle }) => handle.state === 'working' || handle.state === 'waiting')
      .map(({ key, handle }) => ({ key, title: this.titleOf(key, handle.title), waiting: handle.state === 'waiting' }))
  }

  /** Lets go of every task and ends the agents' programs. Asked twice, it is done once. */
  dispose(): Promise<void> {
    this.disposing ??= this.shutDown()
    return this.disposing
  }

  private async shutDown(): Promise<void> {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // The hooks waiting on a question here are told nothing was decided: the question stays where its session asks it.
    this.outside.dropAll()
    const owned = [...this.owned.values()]
    // A task still at work is stopped as the Stop button stops it. Closing the agent's program is not enough: Claude
    // Code and Hermes leave the command they were running behind, running with nobody watching.
    await Promise.all(owned.filter(({ handle }) => handle.state === 'working' || handle.state === 'waiting').map((task) => this.stopForQuit(task)))
    this.owned.clear()
    await Promise.all(owned.map(async (task) => { task.off(); await task.handle.close().catch(() => undefined) }))
    await Promise.all(this.options.backends.map((backend) => backend.close().catch(() => undefined)))
  }

  /** Stops a task and the commands it runs, and waits a moment for them to end. */
  private async stopForQuit(task: Owned): Promise<void> {
    try {
      await task.handle.stop()
      await task.handle.endCommands()
      const limit = this.options.quitWaitMs ?? 3_000
      for (let waited = 0; task.running > 0 && waited < limit; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      // The task is going away either way.
    }
  }

  // ---- Inside ----

  private backend(runner: RunnerKind): Backend {
    const found = this.options.backends.find((backend) => backend.runner === runner)
    if (!found) throw new Error(`${RUNNER_NAMES[runner]} is not set up in this version of Togle.`)
    return found
  }

  private mine(key: string): Owned {
    const owned = this.owned.get(key)
    if (!owned) throw new Error('Togle is not running that task. Continue it first.')
    return owned
  }

  private async infos(): Promise<TaskInfo[]> {
    if (this.cache && Date.now() - this.cache.at < this.cacheMs) return this.cache.infos
    const installed = new Set((await this.status()).filter((status) => status.installed).map((status) => status.runner))
    const lists = await Promise.allSettled(this.options.backends.filter((backend) => installed.has(backend.runner)).map((backend) => backend.list()))
    const infos = lists.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    // What the agents do not list themselves, from the record of what Togle started.
    for (const record of this.options.records?.all() ?? []) {
      if (installed.has(record.runner) && !infos.some((info) => info.runner === record.runner && info.id === record.id)) {
        infos.push({ id: record.id, runner: record.runner, title: record.title, folder: record.folder, state: 'idle', updatedAt: record.at })
      }
    }
    this.cache = { at: Date.now(), infos }
    return infos
  }

  private fresh(): void {
    this.cache = null
    this.changedSoon()
  }

  private changedSoon(): void {
    if (this.timer || this.disposed) return
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.disposed) this.options.changed()
    }, 100)
    this.timer.unref?.()
  }

  private touch(owned: Owned): void {
    owned.updatedAt = Date.now()
  }

  private async adopt(handle: TaskHandle): Promise<Owned> {
    // Claude Code tells a task's id with its first answer: wait for it, as the key is built from it.
    for (let waited = 0; !handle.id; waited += 50) {
      if (handle.state === 'failed' || waited > 20_000) throw new Error(`${RUNNER_NAMES[handle.runner]} did not start the task.`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const key = keyOf(handle.runner, handle.id)
    const before = this.owned.get(key)
    if (before) return before
    const owned: Owned = { key, handle, log: [], running: 0, updatedAt: Date.now(), off: () => undefined }
    this.owned.set(key, owned)
    this.options.records?.add({ runner: handle.runner, id: handle.id, title: this.titleOf(key, handle.title), folder: handle.folder, at: Date.now() })
    owned.off = handle.on((event) => {
      this.record(owned, event)
      this.changedSoon()
    })
    return owned
  }

  private log(owned: Owned, kind: LogEntry['kind'], text: string, status?: LogEntry['status']): LogEntry {
    const entry: LogEntry = { id: this.nextLog++, at: Date.now(), kind, text, ...(status ? { status } : {}) }
    owned.log.push(entry)
    if (owned.log.length > LOG_LIMIT) owned.log.shift()
    return entry
  }

  private record(owned: Owned, event: TaskEvent): void {
    owned.updatedAt = Date.now()
    switch (event.type) {
      case 'message':
        this.log(owned, 'agent', event.text)
        break
      case 'command':
        if (event.status === 'started') {
          owned.running++
          this.log(owned, 'command', event.command, 'running')
        } else {
          owned.running = Math.max(0, owned.running - 1)
          const entry = [...owned.log].reverse().find((e) => e.kind === 'command' && e.status === 'running' && e.text === event.command)
          if (entry) entry.status = event.status === 'declined' ? 'declined' : event.status === 'failed' ? 'failed' : 'finished'
        }
        break
      case 'files':
        this.log(owned, 'files', `Changed ${event.paths.length} file${event.paths.length === 1 ? '' : 's'}: ${short(event.paths.join(', '), 160)}`)
        break
      case 'request':
        this.log(owned, 'asked', event.request.kind === 'question' ? (event.request.questions?.[0]?.text ?? 'A question') : event.request.command ?? `Change ${event.request.files?.join(', ') ?? 'a file'}`)
        break
      case 'request-ended':
        this.log(owned, 'note', event.outcome === 'allowed' ? 'You allowed it.' : event.outcome === 'refused' ? 'You refused it.' : event.outcome === 'answered' ? 'You answered.' : 'It was not needed any more.')
        break
      case 'title':
        this.options.titles?.set(owned.key, event.title)
        break
      case 'turn-ended':
        if (event.outcome === 'interrupted') this.log(owned, 'note', 'Stopped.')
        break
      case 'error':
        this.log(owned, 'note', event.message)
        break
      case 'ended':
        owned.running = 0
        this.log(owned, 'note', event.reason === 'crashed' ? 'The agent program stopped.' : 'Let go of the task.')
        break
      default:
        break
    }
  }

  private titleOf(key: string, ...candidates: (string | undefined)[]): string {
    return this.options.titles?.get(key) || candidates.find((title) => title && title.trim()) || 'Task'
  }

  private withMark(request: PendingLike): ViewRequest {
    const danger = request.kind === 'command' ? dangerOf(request.command ?? request.raw ?? '') : null
    return danger ? { ...request, danger } : { ...request }
  }

  private viewOfInfo(info: TaskInfo): TaskView {
    const key = keyOf(info.runner, info.id)
    const line = info.waitingFor ? `Waiting in its own window: ${info.waitingFor}` : info.state === 'working' ? 'Working in its own window' : ''
    return { ...info, key, title: this.titleOf(key, info.title), mine: false, line, pending: [], commandsRunning: false }
  }

  /** A session that runs elsewhere, as it is while one of its questions is held here: waiting, and answerable. */
  private viewOfOutside(key: string, before: TaskView | undefined): TaskView {
    const held = this.outside.forKey(key)
    const first = held[0]
    const pending = held.map((entry) => this.withMark(entry.request))
    const base: TaskView = before ?? {
      key,
      runner: first.runner,
      id: first.sessionId,
      title: this.titleOf(key, baseName(first.folder) ? `${RUNNER_NAMES[first.runner]} in ${baseName(first.folder)}` : `${RUNNER_NAMES[first.runner]} session`),
      folder: first.folder,
      state: 'waiting',
      updatedAt: first.at,
      mine: false,
      line: '',
      pending: [],
      commandsRunning: false
    }
    return { ...base, state: 'waiting', updatedAt: Math.max(base.updatedAt, first.at), mine: false, pending, line: requestLine(pending[0]) }
  }

  /** How a held request's session is: what its agent says about it, and whether its transcript grew since. */
  private async lookAt(held: Held): Promise<Look> {
    let transcriptGrew = false
    if (held.transcript) {
      const stat = await fs.stat(held.transcript).catch(() => null)
      transcriptGrew = !!stat && stat.mtimeMs > held.at + 1_500
    }
    const backend = this.options.backends.find((candidate) => candidate.runner === held.runner)
    const state = backend?.sessionState ? await backend.sessionState(held.sessionId).catch(() => null) : null
    return { transcriptGrew, state }
  }

  private viewOfOwned(owned: Owned, info: TaskView | undefined): TaskView {
    const { handle } = owned
    const pending = handle.pending.map((request) => this.withMark(request))
    const lastCommand = [...owned.log].reverse().find((e) => e.kind === 'command' && e.status === 'running')
    const lastWords = [...owned.log].reverse().find((e) => e.kind === 'agent')
    const first = pending[0]
    const line = first
      ? requestLine(first)
      : lastCommand
        ? `Running ${short(lastCommand.text, 70)}`
        : handle.state === 'working'
          ? 'Working…'
          : lastWords
            ? firstSentence(lastWords.text)
            : ''
    return {
      key: owned.key,
      runner: handle.runner,
      id: handle.id ?? '',
      title: this.titleOf(owned.key, handle.title, info?.title),
      folder: handle.folder || info?.folder || '',
      state: handle.state,
      updatedAt: owned.updatedAt,
      mine: true,
      line,
      pending,
      commandsRunning: owned.running > 0
    }
  }
}

type PendingLike = TaskHandle['pending'][number]
