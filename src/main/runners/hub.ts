// Every coding agent's tasks as one list for the window, and what the person can do with them. The agents' own
// backends (codex.ts, claude.ts) know how to talk to their agent; this joins them: the tasks they keep on this computer,
// the ones Togle runs (with what happened in each, so the window can show it), and the actions on a task by its key.
import { promises as fs } from 'node:fs'
import { isSignedOut, KNOWN_AGENTS, SIGN_IN_COMMANDS, type Changes, type Decision, type LogEntry, type RunnerKind, type RunnerStatus, type StartRequest, type TaskAttention, type TaskDetail, type TaskEvent, type TaskHistory, type TaskInfo, type TaskOffers, type TaskState, type TaskView, type ViewRequest } from '@shared/runner'
import { dangerOf } from '@shared/runner-command'
import { changesIn } from './changes'
import { carriedFlags } from './claude-job'
import { endTree, listProcesses } from './process-tree'
import type { Backend, Detected, TaskHandle } from './types'

/** The agents Togle knows by name; an added agent is named by its backend. */
export const RUNNER_NAMES: Readonly<Record<RunnerKind, string>> = KNOWN_AGENTS

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
  /** A task was started here, from whichever place: told with what it was started from. */
  started?: (task: TaskView, request: StartRequest) => void
  /** Adds to where agents are looked for what the person's terminal would see; true when that added anything. */
  widenPath?: () => Promise<boolean>
}

interface Owned {
  key: string
  handle: TaskHandle
  log: LogEntry[]
  /** Commands in progress. */
  running: number
  updatedAt: number
  off: () => void
  /** The error the last turn ended with, until the person replies: the task stopped by itself. */
  problem?: string
  /** What the agent's program said of that error, apart from the agent's own words: what tells that it is signed out. */
  fault?: string
  /** An error the agent told just now: it explains the program stopping, when that comes right after. */
  justSaid?: string
  /** Why the agent's program stopped, when it stopped by itself. */
  crash?: string
}

const LOG_LIMIT = 400
const keyOf = (runner: RunnerKind, id: string): string => `${runner}:${id}`
const short = (value: string, longest = 90): string => {
  const line = value.replace(/\s+/g, ' ').trim()
  return line.length > longest ? `${line.slice(0, longest - 1)}…` : line
}
const firstSentence = (value: string): string => short(/^[^.!?\n]*[.!?]?/.exec(value.trim())?.[0] ?? value)
/** A task's name from the words it was given: their first line, cut short. */
const taskName = (words: string): string => short(words.split('\n').find((line) => line.trim()) ?? words, 80)
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

  constructor(private readonly options: HubOptions) {
    this.cacheMs = options.cacheMs ?? 4_000
  }

  /** Which agents are on this computer. */
  async status(): Promise<RunnerStatus[]> {
    if (this.found && Date.now() - this.found.at < 20_000) return this.found.status
    const detect = (): Promise<RunnerStatus[]> =>
      Promise.all(
        this.options.backends.map(async (backend): Promise<RunnerStatus> => {
          const detected: Detected = await backend.detect().catch(() => ({ installed: false }))
          return { runner: backend.runner, name: this.nameOf(backend.runner), installed: detected.installed, ...(detected.version ? { version: detected.version } : {}), ...(backend.runner in KNOWN_AGENTS ? {} : { added: true }) }
        })
      )
    let status = await detect()
    // One not found may have been installed after Togle started, or where only a terminal looks: look again once more is known.
    if (status.some((item) => !item.installed) && (await this.options.widenPath?.().catch(() => false))) status = await detect()
    this.found = { at: Date.now(), status }
    return status
  }

  async list(): Promise<TaskView[]> {
    const views = new Map<string, TaskView>()
    for (const info of await this.infos()) views.set(keyOf(info.runner, info.id), this.viewOfInfo(info))
    for (const owned of this.owned.values()) views.set(owned.key, this.viewOfOwned(owned, views.get(owned.key)))
    return [...views.values()].map((view) => ({ ...view, agent: this.nameOf(view.runner) })).sort(order)
  }

  /** An agent's name as the person reads it. */
  nameOf(runner: RunnerKind): string {
    return this.options.backends.find((backend) => backend.runner === runner)?.name ?? KNOWN_AGENTS[runner] ?? runner
  }

  /** Whether Togle works with this agent. */
  has(runner: RunnerKind): boolean {
    return this.options.backends.some((backend) => backend.runner === runner)
  }

  /**
   * An agent the person added, or one they took off Togle's lists and added back: Togle works with it from now on. With
   * `restore`, the tasks of the agent that went on meanwhile are Togle's own again.
   */
  addBackend(backend: Backend, restore = false): void {
    if (this.disposed || this.has(backend.runner)) return
    this.options.backends.push(backend)
    this.found = null
    this.fresh()
    if (restore) void this.restoreOf(backend)
  }

  /**
   * An agent the person removed: its program is closed. An agent Togle finds by itself stays installed and its tasks go on in it, so
   * the tasks of it that Togle runs are let go of, with only their screens closed, and are off the list. A task of an agent the person
   * added ends with it, and stays in the list as stopped.
   */
  async removeBackend(runner: RunnerKind): Promise<void> {
    const at = this.options.backends.findIndex((backend) => backend.runner === runner)
    if (at < 0) return
    const [backend] = this.options.backends.splice(at, 1)
    this.found = null
    for (const [key, owned] of [...this.owned]) {
      if (owned.handle.runner !== runner || !(runner in KNOWN_AGENTS)) continue
      this.owned.delete(key)
      owned.off()
      await owned.handle.close().catch(() => undefined)
    }
    await backend.close().catch(() => undefined)
    this.fresh()
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
    // Named by the person's words (their first line), never by an agent's stand-in like "Codex task" or by what is added
    // after the words (where a saved call is).
    const title = request.title?.trim().slice(0, 120) || taskName(prompt)
    // A task of an agent that has its own screen follows the person's own settings there, as in their terminal; any other
    // task started here asks before every command and every edit.
    // A task asks every time unless its agent's screen follows the person's own settings; a request can only make it stricter.
    const handle = await backend.start({ folder: request.folder, prompt, title, asks: request.asks === true || !backend.screens })
    const owned = await this.adopt(handle, prompt)
    this.options.titles?.set(owned.key, title)
    this.fresh()
    const view = this.viewOfOwned(owned, undefined)
    this.options.started?.(view, request)
    return view
  }

  /**
   * Picks up a task that was started earlier, so it can be answered here. For an agent with its own screen (Claude Code),
   * that is its screen, opened here: a task in the background is opened by the id the agent gave it, and a session that is
   * not in the background yet goes there, with `flags` (the ones its program was started with). For any other agent, a
   * conversation Togle shows, which asks before every command.
   */
  async open(key: string, flags: string[] = []): Promise<TaskView> {
    const known = this.owned.get(key)
    if (known) {
      // A task in the background whose screen is closed: opening it opens the screen.
      await known.handle.screen?.show()
      this.fresh()
      return this.viewOfOwned(known, undefined)
    }
    const info = (await this.infos()).find((task) => keyOf(task.runner, task.id) === key)
    if (!info) throw new Error('That task is gone.')
    const backend = this.backend(info.runner)
    const handle = await backend.resume(info.id, backend.screens ? { folder: info.folder, ...(info.job ? { job: info.job } : {}), ...(flags.length ? { flags } : {}) } : { asks: true, folder: info.folder })
    const owned = await this.adopt(handle)
    this.fresh()
    return this.viewOfOwned(owned, this.viewOfInfo(info))
  }

  /**
   * Closes the screen of a task in the background here, and says how to open it in a terminal of the person's own. The
   * task goes on: a conversation has one screen at a time, and the next one to open it takes it.
   */
  async handBack(key: string): Promise<{ command: string; folder: string }> {
    const owned = this.mine(key)
    const screen = owned.handle.screen
    if (!screen) throw new Error('Only a task that is the agent’s own screen can be handed back.')
    const command = screen.line
    const folder = owned.handle.folder
    await screen.hide()
    this.fresh()
    return { command, folder }
  }

  /**
   * Takes a task over from the program that runs it in a terminal: that program is ended (the conversation is kept) and the
   * same conversation goes on in the background, with its screen here: the same screen the person had. Only for Claude
   * Code, and only for the program that was listed for it.
   */
  async takeOver(key: string): Promise<TaskView> {
    this.cache = null
    const info = (await this.infos()).find((task) => keyOf(task.runner, task.id) === key)
    if (!info) throw new Error('That task is gone.')
    if (this.owned.has(key) || !info.pid) return this.open(key)
    if (info.runner !== 'claude') throw new Error(`${this.nameOf(info.runner)} tasks cannot be taken over.`)
    // Before anything is ended: a program the person is using is not ended for a screen that cannot open.
    const problem = await this.backend(info.runner).screenProblem?.(info.id)
    if (problem) throw new Error(problem)
    const program = (await listProcesses()).find((proc) => proc.pid === info.pid)
    if (!program || !/claude/i.test(program.command)) throw new Error('That program is not Claude Code any more, so it was left alone.')
    // The conversation goes on the way the person started it: its model, effort and permission mode.
    const flags = carriedFlags(program.command)
    await endTree(info.pid)
    for (let waited = 0; waited < 5_000; waited += 200) {
      if (!(await listProcesses()).some((proc) => proc.pid === info.pid)) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    this.cache = null
    try {
      return await this.open(key, flags)
    } catch (error) {
      // The person's own program is ended by now, and the conversation is saved: how to go on is told with what went wrong.
      throw new Error(`${(error as Error).message} The conversation is saved: go on in your terminal with claude --resume ${info.id}`, { cause: error })
    }
  }

  async send(key: string, text: string): Promise<void> {
    const owned = this.mine(key)
    const message = text.trim()
    if (!message) return
    this.log(owned, 'you', message)
    this.touch(owned)
    // A reply goes on from where it stopped: what went wrong is past.
    owned.problem = undefined
    owned.fault = undefined
    await owned.handle.send(message)
    this.fresh()
  }

  answer(key: string, requestId: string, decision: Decision): void {
    if (decision !== 'allow-once' && decision !== 'allow-always' && decision !== 'refuse') throw new Error('Allow once or refuse.')
    // Always only where the agent offered it for this very request, and never for one that looks dangerous.
    if (decision === 'allow-always') {
      const request = this.owned.has(key) ? this.mine(key).handle.pending.find((item) => item.id === requestId) : undefined
      if (!request || !request.always || this.withMark(request).danger) throw new Error('This one can only be allowed once.')
    }
    this.mine(key).handle.answer(requestId, decision)
  }

  reply(key: string, requestId: string, text: string): void {
    this.mine(key).handle.reply(requestId, text)
  }

  /** What the reply box of a task lists when "/" is typed: its agent's own commands and models. None for a task Togle does not run. */
  offers(key: string): TaskOffers {
    return this.owned.get(key)?.handle.offers?.() ?? { commands: [], models: [] }
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
    if (ended) this.log(owned, 'note', owned.handle.terminal ? 'Ended it.' : ended === 1 ? 'Ended the command that was running.' : `Ended ${ended} commands that were running.`)
    this.fresh()
    return ended
  }

  // A task that runs in a terminal of Togle's own: what it printed, and what the person types and how big it is shown.
  terminalRead(key: string): { text: string; end: number } {
    return this.terminalOf(key).read()
  }

  terminalWrite(key: string, data: string): void {
    this.terminalOf(key).write(data)
  }

  terminalResize(key: string, cols: number, rows: number): void {
    this.terminalOf(key).resize(cols, rows)
  }

  /** Types the words the task was given into its terminal, without Enter. */
  typeWords(key: string): void {
    const owned = this.mine(key)
    this.terminalOf(key).typeWords()
    this.touch(owned)
    this.changedSoon()
  }

  private terminalOf(key: string): NonNullable<TaskHandle['terminal']> {
    const side = this.mine(key).handle.terminal
    if (!side) throw new Error('That task does not run in a terminal.')
    return side
  }

  /** Lets go of a task Togle runs. It stays on this computer. A task in the background goes on, and Togle goes on hearing it: only its screen closes. */
  async close(key: string): Promise<void> {
    const owned = this.owned.get(key)
    if (!owned) return
    if (owned.handle.screen) {
      await owned.handle.screen.hide()
      this.fresh()
      return
    }
    this.owned.delete(key)
    owned.off()
    await owned.handle.close()
    this.fresh()
  }

  /**
   * A task's conversation as its agent keeps it, for the Web view; null when the agent keeps none Togle can read (the window then
   * shows what happened while Togle watched). A task Togle runs is read by the session it is in now: a cleared one is another.
   */
  async history(key: string, all: boolean): Promise<TaskHistory | null> {
    const owned = this.owned.get(key)
    const info = owned ? undefined : (await this.infos()).find((task) => keyOf(task.runner, task.id) === key)
    const runner = owned?.handle.runner ?? info?.runner
    const id = owned ? (owned.handle.screen?.session() || owned.handle.id) : info?.id
    if (!runner || !id) return null
    const backend = this.options.backends.find((one) => one.runner === runner)
    return (await backend?.history?.(id, all).catch(() => null)) ?? null
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
      return { key: owned.key, runner: view.runner, agent: this.nameOf(view.runner), title: view.title, folder: view.folder, state: view.state, pending: view.pending, line: view.line, ...(view.signedOut ? { signedOut: true } : {}), ...(view.fix ? { fix: view.fix } : {}), ...(view.terminal ? { terminal: true } : {}), ...(view.waitingFor ? { waitingFor: view.waitingFor } : {}) }
    })
    return mine
  }

  /** The tasks Togle runs that would stop in the middle if Togle quit now: working, or waiting for the person. */
  busy(): { key: string; title: string; waiting: boolean }[] {
    return [...this.owned.values()]
      .filter(({ handle }) => !handle.screen && (handle.state === 'working' || handle.state === 'waiting'))
      .map(({ key, handle }) => ({ key, title: this.titleOf(key, handle.title), waiting: handle.state === 'waiting' }))
  }

  /** The tasks in the background that are working or waiting for the person, and that go on if Togle quits. */
  keepsGoing(): { key: string; title: string; waiting: boolean }[] {
    return [...this.owned.values()]
      .filter(({ handle }) => handle.screen && (handle.state === 'working' || handle.state === 'waiting'))
      .map(({ key, handle }) => ({ key, title: this.titleOf(key, handle.title), waiting: handle.state === 'waiting' }))
  }

  /**
   * Takes up the tasks that went on while Togle was closed, for the agents whose tasks outlive it. Each is Togle's own
   * again, with what it asks; one that asks later is taken up then.
   */
  async restore(): Promise<void> {
    await Promise.all(this.options.backends.map((backend) => this.restoreOf(backend)))
  }

  private async restoreOf(backend: Backend): Promise<void> {
    try {
      await backend.restore?.((handle) => {
        void this.adopt(handle).then(() => this.fresh(), () => undefined)
      })
    } catch {
      // An agent that cannot say what it kept now leaves the list as it is.
    }
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
    const owned = [...this.owned.values()]
    // A task still at work is stopped as the Stop button stops it. Closing the agent's program is not enough: Hermes
    // leaves the command it was running behind, running with nobody watching. A task in the background goes on: only its
    // screen closes.
    await Promise.all(owned.filter(({ handle }) => !handle.screen && (handle.state === 'working' || handle.state === 'waiting')).map((task) => this.stopForQuit(task)))
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
    if (!found) throw new Error(`${this.nameOf(runner)} is not set up in this version of Togle.`)
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

  /** Togle runs the task from now on. `first` is what the person asked it, logged before anything the agent says to it. */
  private async adopt(handle: TaskHandle, first?: string): Promise<Owned> {
    // Claude Code tells a task's id with its first answer: wait for it, as the key is built from it.
    for (let waited = 0; !handle.id; waited += 50) {
      if (handle.state === 'failed' || waited > 20_000) throw new Error(`${this.nameOf(handle.runner)} did not start the task.`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const key = keyOf(handle.runner, handle.id)
    const before = this.owned.get(key)
    if (before) return before
    const owned: Owned = { key, handle, log: [], running: 0, updatedAt: Date.now(), off: () => undefined }
    this.owned.set(key, owned)
    // Kept for an agent that cannot list its tasks, to pick them up again; a task in a terminal ends with its program, and
    // one in the background is listed by its agent.
    if (!handle.terminal && !handle.screen) this.options.records?.add({ runner: handle.runner, id: handle.id, title: this.titleOf(key, handle.title), folder: handle.folder, at: Date.now() })
    // What the agent said while it started comes after the words it was given, though it is heard all at once below.
    if (first) this.log(owned, 'you', first)
    owned.off = handle.on((event) => {
      this.record(owned, event)
      this.changedSoon()
    })
    return owned
  }

  private log(owned: Owned, kind: LogEntry['kind'], text: string, status?: LogEntry['status'], paths?: string[]): LogEntry {
    const entry: LogEntry = { id: this.nextLog++, at: Date.now(), kind, text, ...(status ? { status } : {}), ...(paths?.length ? { paths: paths.slice(0, 200) } : {}) }
    owned.log.push(entry)
    if (owned.log.length > LOG_LIMIT) owned.log.shift()
    return entry
  }

  private record(owned: Owned, event: TaskEvent): void {
    owned.updatedAt = Date.now()
    // An error explains the program stopping only when the stop comes right after it (a state change between is fine).
    const justSaid = owned.justSaid
    if (event.type !== 'state') owned.justSaid = undefined
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
        this.log(owned, 'files', `Changed ${event.paths.length} file${event.paths.length === 1 ? '' : 's'}: ${short(event.paths.join(', '), 160)}`, undefined, event.paths)
        break
      case 'request':
        this.log(owned, 'asked', event.request.kind === 'question' ? (event.request.questions?.[0]?.text ?? 'A question') : event.request.command ?? `Change ${event.request.files?.join(', ') ?? 'a file'}`)
        break
      case 'request-ended':
        this.log(owned, 'note', event.outcome === 'allowed' ? 'You allowed it.' : event.outcome === 'always' ? 'You allowed it, and the agent keeps that choice.' : event.outcome === 'refused' ? 'You refused it.' : event.outcome === 'answered' ? 'You answered.' : 'It was not needed any more.')
        break
      case 'title':
        this.options.titles?.set(owned.key, event.title)
        break
      case 'turn-ended':
        if (event.outcome === 'interrupted') this.log(owned, 'note', 'Stopped.')
        // A turn that ended with an error stops the task until the person replies; a turn that ended well clears it.
        owned.problem = event.outcome === 'failed' ? event.error || 'The turn ended with an error.' : undefined
        owned.fault = event.outcome === 'failed' ? (event.fault ?? event.error ?? undefined) : undefined
        break
      case 'error':
        this.log(owned, 'note', event.message)
        owned.justSaid = event.message
        break
      case 'cleared':
        // The agent emptied the conversation, as its own terminal would empty the screen: the task goes on from nothing.
        owned.log.length = 0
        owned.running = 0
        owned.problem = undefined
        owned.fault = undefined
        break
      case 'ended':
        if (event.reason === 'crashed') owned.crash = justSaid ?? 'The agent program stopped.'
        owned.running = 0
        this.log(owned, 'note', event.reason === 'crashed' ? 'The agent program stopped.' : 'Let go of the task.')
        // A screen is over with its program, however that ended (the person left it, or it stopped): the conversation is
        // the agent's, and its own list shows the task again, to continue here or to take over.
        if (owned.handle.screen) {
          owned.off()
          this.owned.delete(owned.key)
          this.fresh()
        }
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
    // A command that looks dangerous is allowed once at most: never for always.
    if (!danger) return { ...request }
    const { always: _always, ...rest } = request as PendingLike & { always?: string }
    return { ...rest, danger }
  }

  private viewOfInfo(info: TaskInfo): TaskView {
    const key = keyOf(info.runner, info.id)
    const where = info.job ? 'in the background' : 'in its own window'
    const line = info.waitingFor ? `Waiting ${where}: ${info.waitingFor}` : info.state === 'working' ? `Working ${where}` : ''
    return { ...info, key, title: this.titleOf(key, info.title), mine: false, line, pending: [], commandsRunning: false }
  }

  private viewOfOwned(owned: Owned, info: TaskView | undefined): TaskView {
    const { handle } = owned
    const pending = handle.pending.map((request) => this.withMark(request))
    const lastCommand = [...owned.log].reverse().find((e) => e.kind === 'command' && e.status === 'running')
    const lastWords = [...owned.log].reverse().find((e) => e.kind === 'agent')
    const first = pending[0]
    // Stopped by itself (a turn that ended with an error, or a program that stopped), it waits for a reply and says why.
    const why = handle.state === 'failed' ? (owned.crash ?? owned.problem) : handle.state === 'idle' ? owned.problem : undefined
    const state: TaskState = why ? 'failed' : handle.state
    // Signed out is told from what the agent's program said, never from what the agent wrote in the task.
    const signedOut = !!why && !!owned.fault && isSignedOut(owned.fault)
    const fix = signedOut ? SIGN_IN_COMMANDS[handle.runner] : undefined
    const line = first
      ? requestLine(first)
      : signedOut
        ? `${this.nameOf(handle.runner)} is signed out.`
        : why
          ? short(why, 160)
          : handle.waitingFor
            ? `Waiting on its screen: ${handle.waitingFor}`
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
      state,
      updatedAt: owned.updatedAt,
      mine: true,
      line,
      pending,
      commandsRunning: owned.running > 0,
      ...(signedOut ? { signedOut: true } : {}),
      ...(fix ? { fix } : {}),
      ...(handle.terminal ? { terminal: true, ...(handle.terminal.words ? { words: handle.terminal.words } : {}) } : {}),
      ...(handle.waitingFor ? { waitingFor: handle.waitingFor } : {}),
      ...(handle.screen ? { screen: true, job: handle.screen.job, ...(handle.screen.screenId ? { screenId: handle.screen.screenId } : {}), ...(handle.screen.closed ? { screenClosed: handle.screen.closed } : {}) } : {})
    }
  }
}

type PendingLike = TaskHandle['pending'][number]
