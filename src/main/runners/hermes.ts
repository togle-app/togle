// Hermes on this computer. Togle runs each task as Hermes's own terminal screen (`hermes --tui`) in a terminal of Togle's own:
// the person has the program they know, with its keys, commands and questions. The conversation does not live in the screen:
// the screen is a client of the Hermes gateway that runs in the background on the computer (the one that serves its messaging
// platforms, or one a screen starts and that ends itself after ten idle minutes), so a turn goes on when the screen is
// closed and when Togle quits. Hermes's own settings and sign-in are the person's; Togle touches neither, and adds no flag
// to the screen: it follows the person's own configuration, as in their terminal.
//
// What trying Hermes 0.22.5 on Windows showed, which this follows:
// - The screen sets its window title as `<marker> <session name> · <model> · <folder>`, where the marker is `⏳` while it works,
//   `⚠` while it waits on an approval, a password or a question, and `✓` when idle (Hermes's ui-tui, useMainApp.ts). That is how
//   Togle tells what a task does, for as long as its screen is open.
// - Commands run in the gateway, not under the screen: ending the screen leaves a running command running, and the turn goes
//   on to its answer. A turn with news in the last ten minutes is not ended when its screen goes (a quiet one is, after
//   twenty seconds); a session with no turn is let go of by the gateway after twenty seconds and is opened again from its store.
// - A session is held by one screen at a time: opening one that another window holds is refused, in words, and the screen ends.
// - `hermes chat --tui --query=<words> -c <name> --create-if-missing` starts a session named <name> with the words as its
//   first turn; `hermes --tui --resume <id or name>` opens one again. `hermes sessions list` lists them (its Workspace column
//   is the folder's name only), `rename` names one, `delete` removes one.
// - Hermes tells Togle nothing else while a screen holds a session: what it asks is answered on the screen, and Togle says
//   that it waits there. Once the screen is closed Togle knows nothing of what the session does.
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LogEntry, StepDetail, TaskHistory, TaskInfo } from '@shared/runner'
import { exists, lines } from './acp'
import { askedLine } from './claude-sessions'
import { hermesEntries } from './hermes-history'
import { lastTurns } from './history-turns'
import { detailOf, diffOf, isFileKey } from './step-detail'
import { keepJson } from './keep'
import { TaskBase } from './task-base'
import { cleanWords, loadPty, openTerminal, refuseCommand, TerminalTask, type TerminalChunk } from './terminal'
import type { Backend, Detected, ResumeOptions, ScreenSide, StartOptions, TaskHandle, TerminalSide } from './types'

export interface HermesOptions {
  /** What starts Hermes, before its words. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** Where what its screens print goes, for the window. Required: a screen whose words are not told shows only what it had printed when it was opened. */
  told: (chunk: TerminalChunk) => void
  /**
   * A folder of Togle's own where the name each session was started with, and the id Hermes gave it, are kept between runs: a
   * to-do line that names a task by its name finds it again when Togle starts. Without one, nothing is kept.
   */
  keep?: string
  /** How long the sessions are reused, in milliseconds. */
  cacheMs?: number
  /** How often Hermes's list is looked at for the session of a task just started, in milliseconds. */
  findMs?: number
  /** How long a reply typed on its screen waits to see Hermes take it (its window title goes to busy), in milliseconds. */
  takeMs?: number
  /** How long a session's conversation is reused before Hermes is asked for it again, in milliseconds. Each ask starts a Python program. */
  historyMs?: number
}

/** The program that starts Hermes, or null when it is not on this computer. `TOGLE_HERMES_PATH` names it by hand. */
export async function findHermes(): Promise<string | null> {
  const forced = process.env.TOGLE_HERMES_PATH
  if (forced && (await exists(forced))) return forced
  const found = await lines(process.platform === 'win32' ? 'where' : 'which', ['hermes'])
  if (process.platform !== 'win32') return found[0] ?? null
  // The .cmd beside it is a shim that Node cannot start without a shell.
  return found.find((file) => /\.exe$/i.test(file)) ?? null
}

/** A session as `hermes sessions list` tells it. */
export interface StoredRow {
  id: string
  title: string
  /** The start of the session's first message, when the list has titles too and a column for it. */
  preview?: string
  /** The folder's name only: that is all the list says. */
  workspace: string
  /** When it last changed, in milliseconds (the list says "4h ago" or a date). */
  updatedAt: number
}

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** "just now", "4h ago", "6d ago" or a date, as a time. */
function ageOf(said: string, now: number): number {
  const text = said.trim()
  if (/just now/i.test(text)) return now
  const ago = /^(\d+)\s*([smhdw])\w*\s+ago$/i.exec(text)
  if (ago) return now - Number(ago[1]) * (UNITS[ago[2].toLowerCase()] ?? 0)
  const date = Date.parse(text)
  return Number.isNaN(date) ? 0 : date
}

/**
 * The sessions in what `hermes sessions list` printed: a table whose columns start where its header's words do. Hermes prints
 * one of four, by whether any session listed has a title and whether any has a folder: the first column is the title (or, with
 * no titles, the start of the first message), then a folder or a preview, the time, perhaps the source, and the id. Hermes pads
 * a column by characters, so the columns are cut by characters here too: a title with an emoji (two UTF-16 units) moves nothing.
 */
export function parseSessionList(output: string, now = Date.now()): StoredRow[] {
  const rows = output.split(/\r?\n/)
  const head = rows.findIndex((line) => /^\s*(Title|Preview)\s+.*\bLast Active\b.*\bID\s*$/.test(line))
  if (head < 0) return []
  const header = rows[head]
  const workspace = header.indexOf('Workspace')
  const preview = header.indexOf('Preview', 1)
  const active = header.indexOf('Last Active')
  const source = header.indexOf('Src')
  const id = header.lastIndexOf('ID')
  // The first column ends where the next one starts, and the time where the source or the id does.
  const firstEnds = Math.min(...[workspace, preview, active].filter((at) => at > 0))
  const ageEnds = source > active ? source : id
  const found: StoredRow[] = []
  for (const line of rows.slice(head + 1)) {
    if (!line.trim() || /^[\s─-]+$/.test(line) || /more not shown/i.test(line)) continue
    const cells = Array.from(line)
    const key = cells.slice(id).join('').trim().split(/\s+/)[0] ?? ''
    // A row whose id is cut or missing is not one.
    if (!key || cells.length <= id) continue
    const place = workspace > 0 ? cells.slice(workspace, active).join('').trim() : ''
    // With titles, a column of its own holds the start of the first message.
    const said = preview > 0 && /^\s*Title\b/.test(header) ? cells.slice(preview, active).join('').trim() : ''
    found.push({ id: key, title: cells.slice(0, firstEnds).join('').trim(), ...(said && said !== '—' ? { preview: said } : {}), workspace: place === '—' ? '' : place, updatedAt: ageOf(cells.slice(active, ageEnds).join(''), now) })
  }
  return found
}

const exec = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<{ ok: boolean; out: string; text: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout ?? 20_000, maxBuffer: 16 * 1024 * 1024, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) }, (error, stdout, stderr) =>
      resolve({ ok: !error, out: String(stdout), text: `${stdout}${stderr}`.trim() })
    )
  })

/** The most words a task is started with: a Windows command line holds about 32,000 characters. */
const MOST_WORDS = 20_000

// A session's export is read whole: the biggest on this computer was 25 MB. Longer than this, or slower, it is left unread.
const EXPORT_MOST = 64 * 1024 * 1024
const EXPORT_MS = 30_000

/** What `hermes sessions export - --session-id <id>` printed, as JSON; null when it failed (it says so on stdout, not in an exit code that is always read). */
function exported(command: string[], env: NodeJS.ProcessEnv, id: string): Promise<unknown | null> {
  return new Promise((resolve) => {
    const child = spawn(command[0], [...command.slice(1), 'sessions', 'export', '-', '--session-id', id], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    const timer = setTimeout(() => child.kill(), EXPORT_MS)
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > EXPORT_MOST) {
        over = true
        child.kill()
      } else chunks.push(chunk)
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (over) return resolve(null)
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
  })
}

/** The environment of a screen: this computer's, as a terminal gives it. */
const screenEnv = (base: NodeJS.ProcessEnv): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

/** What a screen's window title says it is doing. */
export type Marker = 'busy' | 'waiting' | 'idle'

/** The marker in a window title, when it has one: ⏳ at work, ⚠ waiting on the person, ✓ idle. */
export function markerOf(title: string): Marker | undefined {
  if (title.startsWith('⏳')) return 'busy'
  if (title.startsWith('⚠')) return 'waiting'
  if (title.startsWith('✓')) return 'idle'
  return undefined
}

const OSC_TITLE = /\x1b\](?:0|2);([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** One screen: Hermes's own program in a terminal of Togle's own. It is over with its program, and the session goes on. */
class HermesScreen extends TerminalTask {
  private carry = ''
  /** How its program ended: 0 or 130 (Ctrl+C) when the person left, anything else when Hermes refused or failed. */
  code: number | undefined

  constructor(id: string, title: string, folder: string, term: ConstructorParameters<typeof TerminalTask>[5], told: (chunk: TerminalChunk) => void, gone: () => void, readonly screenId: string, private readonly marked: (marker: Marker) => void) {
    super('hermes', id, title, folder, 'Hermes', term, undefined, told, gone)
    term.onData((data) => this.sniff(data))
  }

  protected override get tag(): string {
    return this.screenId
  }

  protected override exited(code: number, signal?: number): void {
    this.code = code
    super.exited(code, signal)
  }

  /** Reads the window titles the screen sets, among what it prints; one cut in two by the end of a chunk is read with the next. */
  private sniff(data: string): void {
    const text = this.carry + data
    let end = 0
    for (const found of text.matchAll(OSC_TITLE)) {
      end = (found.index ?? 0) + found[0].length
      const marker = markerOf(found[1])
      if (marker) this.marked(marker)
    }
    const rest = text.slice(end)
    const open = rest.lastIndexOf('\x1b]')
    this.carry = open >= 0 && rest.length - open < 400 ? rest.slice(open) : ''
  }
}

/** How long a task started with words is shown as working before its screen says it is not: the screen takes a moment to begin. */
const BEGIN_MS = 25_000
/** How long Stop waits for a screen it had to open to say whether the session works. */
const SAYS_MS = 20_000

/** What a task asks of the backend that runs it. */
interface TaskContext {
  command: string[]
  env: NodeJS.ProcessEnv
  told: (chunk: TerminalChunk) => void
  /** Something changed: the sessions are asked again soon. */
  look: () => void
  /** Asks Hermes what it lists and names, once the session is known. */
  find(task: HermesTask): Promise<void>
  /** How long to wait between two looks for the session of a task just started, in milliseconds. */
  findMs: number
  /** How long a reply waits to see Hermes take it, in milliseconds. */
  takeMs: number
}

class HermesTask extends TaskBase implements ScreenSide {
  readonly runner = 'hermes' as const
  private screenTask: HermesScreen | null = null
  private screens = 0
  private sawBusy = false
  /** A turn is on (its screen showed ⏳ or ⚠ and has not shown ✓ since). */
  private turnOpen = false
  private holdUntil = 0
  private stopped = false
  /** How many times the screen's window title said a turn works or waits: a reply typed in is taken when it grows. */
  private busyMarks = 0
  /** Told when the screen next shows a marker: what Stop waits for on a screen it had to open. */
  private markedOnce: (() => void) | null = null
  private searches = 0
  private searching = false
  /** The marker of the last window title, to tell a change from a title set again. */
  private lastMarker: Marker | undefined
  /** The id Hermes gave the session, once it shows in its list: the task is first known by the name it was started with. */
  real: string | null = null
  closed: string | undefined
  waitingFor: string | undefined

  /** `words`: when it is a new session, the words and name it is started with; a session that exists is opened by `job`. */
  constructor(
    private readonly context: TaskContext,
    id: string,
    title: string,
    folder: string,
    private starting?: { words: string }
  ) {
    super()
    this.id = id
    this.title = title
    this.folder = folder
    this.setBase(starting ? 'working' : 'idle')
    if (starting) this.holdUntil = Date.now() + BEGIN_MS
  }

  // ---- The screen ----

  get screen(): ScreenSide {
    return this
  }

  get terminal(): TerminalSide | undefined {
    return this.screenTask ?? undefined
  }

  get pid(): number | null {
    return this.screenTask?.program ?? null
  }

  get open(): boolean {
    return this.screenTask !== null
  }

  get screenId(): string | undefined {
    return this.screenTask?.screenId
  }

  /** What opens the session: the id Hermes gave it, or the name it was started with until then (Hermes takes either). */
  get job(): string {
    return this.real ?? this.id ?? ''
  }

  get line(): string {
    return `hermes --resume ${this.job}`
  }

  session(): string {
    return this.job
  }

  async show(): Promise<void> {
    if (this.screenTask) return
    const pty = await loadPty()
    if (!pty) {
      this.closed = 'Togle cannot open a terminal on this computer.'
      throw new Error(`${this.closed} The task goes on: ${this.line} opens it in your own terminal.`)
    }
    this.closed = undefined
    const [program, ...rest] = this.context.command
    // The first screen of a new session starts it; any later one opens it again.
    const args = this.starting
      ? [...rest, 'chat', '--tui', `--query=${this.starting.words}`, '--in', this.folder, '-c', this.id ?? '', '--create-if-missing']
      : [...rest, '--tui', '--resume', this.job]
    if (this.starting) {
      this.sawBusy = false
      this.turnOpen = false
      this.holdUntil = Date.now() + BEGIN_MS
    }
    this.starting = undefined
    const task: HermesScreen = new HermesScreen(
      this.id ?? this.job,
      this.title,
      this.folder,
      openTerminal(pty, program, args, this.folder || os.homedir(), screenEnv(this.context.env)),
      this.context.told,
      () => this.screenEnded(task),
      `${(this.id ?? 'h').slice(-8)}-${++this.screens}`,
      (marker) => this.marked(marker)
    )
    this.screenTask = task
    this.emit({ type: 'screen', shown: true })
    this.context.look()
    this.search()
  }

  async hide(): Promise<void> {
    const task = this.screenTask
    if (!task) return
    this.screenTask = null
    this.waitingFor = undefined
    this.turnOpen = false
    // What the session does from here on is not told: the task rests until its screen is opened again.
    if (this.state !== 'stopped') this.setBase('idle')
    this.emit({ type: 'screen', shown: false })
    await task.close()
  }

  /** The program of a screen ended: the person left it (Ctrl+C twice, `/exit`), or it did not open. */
  private screenEnded(task: HermesScreen): void {
    if (this.screenTask !== task) return
    this.screenTask = null
    this.waitingFor = undefined
    this.turnOpen = false
    const said = cleanWords(task.read().text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    // A screen Hermes refused prints what it refused and ends with an error; one the person left ends well.
    if (task.code !== 0 && task.code !== 130 && said.length > 0) this.closed = said.slice(-3).join(' ').slice(0, 240)
    if (this.state !== 'stopped') this.setBase('idle')
    this.emit({ type: 'screen', shown: false })
    this.context.look()
  }

  // ---- What the screen's window title tells ----

  private marked(marker: Marker): void {
    const once = this.markedOnce
    this.markedOnce = null
    once?.()
    // The session is in Hermes's list from the turn's first words: a look when the turn begins finds it, however long the screen
    // took to start and however many looks that used up. Only a change of marker counts, so that a title set again says nothing.
    const changed = marker !== this.lastMarker
    this.lastMarker = marker
    if (changed && !this.real) this.searches = Math.min(this.searches, 6)
    if (marker === 'busy' || marker === 'waiting') this.busyMarks++
    if (marker === 'busy') {
      this.sawBusy = true
      this.turnOpen = true
      this.waitingFor = undefined
      this.stopped = false
      this.setBase('working')
      if (changed) this.search()
    } else if (marker === 'waiting') {
      this.sawBusy = true
      this.turnOpen = true
      this.waitingFor = 'approval or an answer'
      this.setBase('waiting')
      if (changed) this.search()
    } else {
      this.waitingFor = undefined
      // A task started with words is at work from the start: the idle screen that shows first is not its end.
      if (!this.sawBusy && Date.now() < this.holdUntil) return
      const ended = this.turnOpen
      this.turnOpen = false
      this.setBase(this.stopped ? 'stopped' : 'idle')
      if (ended) this.emit({ type: 'turn-ended', outcome: this.stopped ? 'interrupted' : 'completed', error: null })
      // The session shows in Hermes's list once it has a message: its id and a name of the person's own are taken then.
      this.search()
    }
    this.context.look()
  }

  /** Looks for the session in Hermes's list, a few times, until it shows. */
  private search(): void {
    if (this.real || this.searching || this.searches >= 12 || !this.id) return
    this.searching = true
    this.searches++
    void this.context.find(this).finally(() => {
      this.searching = false
      if (!this.real && this.screenTask && this.searches < 12) setTimeout(() => this.search(), this.context.findMs).unref?.()
    })
  }

  // ---- What the person does ----

  /**
   * A reply from the cards view. Hermes takes words on its screen only, so the screen is opened out of sight when it is closed,
   * and the words are typed in with Enter once its turn has ended (typed while it asks, they would answer the question). A reply
   * that starts as a command of its own is refused (see `submit`).
   */
  async send(words: string): Promise<void> {
    if (this.state === 'working' || this.state === 'waiting' || this.waitingFor) throw new Error('It is working. Reply when it has finished.')
    refuseCommand(words)
    if (!this.screenTask) await this.show()
    const screen = this.screenTask
    if (!screen) throw new Error(this.closed ?? 'Its screen could not be opened.')
    // A screen that was just opened loads the session before it takes words, with long pauses between what it prints: it is given
    // a longer quiet than a program that draws at once.
    await screen.settled(1_500, 20_000)
    const before = this.busyMarks
    await screen.submit(words)
    // At work from now: the idle screen that shows first is not the end of this turn.
    this.sawBusy = false
    this.turnOpen = false
    this.holdUntil = Date.now() + BEGIN_MS
    this.stopped = false
    this.setBase('working')
    // Hermes sets its window title to busy when a turn starts. A reply it did not take (its prompt was not ready for Enter) is
    // pressed again, twice at most, and told in words when it is still not taken: its words are on its screen.
    for (let press = 0; !(await this.took(before)); press++) {
      if (press >= 2) {
        this.holdUntil = 0
        if (this.screenTask === screen) this.setBase(this.stopped ? 'stopped' : 'idle')
        throw new Error('Hermes did not take the reply. Its words are on its screen: pick Session and press Enter there.')
      }
      screen.write('\r')
    }
  }

  /** Whether a turn began since `before`: the window title went to busy. Waits a while for it to. */
  private async took(before: number): Promise<boolean> {
    for (let waited = 0; waited < this.context.takeMs; waited += 50) {
      if (this.busyMarks > before) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return this.busyMarks > before
  }

  /**
   * Ctrl+C on its screen: Hermes ends the turn, and the command it runs, as in a terminal. A closed screen is opened first, and
   * Ctrl+C is pressed only if it then says the session works: on a screen that is idle it would only start to leave it.
   */
  async stop(): Promise<void> {
    if (!this.screenTask) {
      const told = new Promise<void>((resolve) => {
        this.markedOnce = resolve
        setTimeout(resolve, SAYS_MS).unref?.()
      })
      await this.show()
      await told
    }
    if (this.state !== 'working' && this.state !== 'waiting') return
    this.stopped = true
    this.screenTask?.write('\x03')
    this.setBase('stopped')
  }

  /** Hermes ends the command with the turn, so there is nothing left for a second press. */
  async endCommands(): Promise<number> {
    return 0
  }

  /** Lets go of the screen. The session goes on in Hermes, and Togle no longer hears it. */
  async close(): Promise<void> {
    await this.hide()
    this.emit({ type: 'ended', reason: 'closed' })
  }
}

const NAMES = 'names.json'
/** The most names that are remembered. */
const KEEP_NAMES = 200
/** The name Togle gives a session it starts, which is also the id of its task. */
const STARTED_NAME = /^togle-[0-9a-f]{8}$/
const SESSION_WORD = /^[\w][\w.:-]{0,200}$/

export class HermesBackend implements Backend {
  readonly runner = 'hermes' as const
  readonly screens = true
  private readonly tasks = new Set<HermesTask>()
  private cache: { at: number; rows: StoredRow[] } | null = null
  /** Hermes asked for its list again, behind the list it gave last. */
  private asking: Promise<void> | null = null
  private closed = false
  private resolved?: Promise<TaskContext>
  /** The name each session Togle started was started with, and the id Hermes gave it. */
  private readonly names = new Map<string, string>()
  /** The conversation of the sessions asked for lately, by the id Hermes gave, and when it was read. */
  private readonly conversations = new Map<string, { at: number; running?: Promise<LogEntry[] | null>; entries: LogEntry[] | null; details: Map<string, string> }>()
  private loaded?: Promise<void>

  constructor(private readonly options: HermesOptions) {}

  private async command(): Promise<string[]> {
    if (this.options.command?.length) return this.options.command
    const found = await findHermes()
    if (!found) throw new Error('Hermes is not installed on this computer.')
    return [found]
  }

  private context(): Promise<TaskContext> {
    this.resolved ??= this.command().then((command) => ({
      command,
      env: this.options.env ?? process.env,
      told: this.options.told,
      look: () => {
        this.cache = null
      },
      find: (task) => this.locate(task),
      findMs: this.options.findMs ?? 3_000,
      takeMs: this.options.takeMs ?? 5_000
    }))
    this.resolved.catch(() => {
      this.resolved = undefined
    })
    return this.resolved
  }

  async detect(): Promise<Detected> {
    const command = this.options.command?.length ? this.options.command : [await findHermes()].filter((found): found is string => !!found)
    if (!command.length) return { installed: false }
    const version = (await lines(command[0], [...command.slice(1), '--version']))[0]
    return { installed: true, command: command[0], ...(version ? { version } : {}) }
  }

  // ---- What Hermes lists ----

  /** The sessions Hermes keeps that came from a terminal or a screen (not its messaging platforms or its scheduled jobs). */
  private async stored(): Promise<StoredRow[]> {
    const command = await this.command()
    const env = this.options.env ?? process.env
    const asked = await Promise.all(['local', 'cli'].map((source) => exec(command[0], [...command.slice(1), 'sessions', 'list', '--source', source, '--limit', '60'], { env })))
    const seen = new Set<string>()
    return asked
      .flatMap((out) => (out.ok ? parseSessionList(out.out) : []))
      .filter((row) => !seen.has(row.id) && !!seen.add(row.id))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** Asks Hermes for its list behind the one it gave last: once at a time, and not kept if the list was dropped meanwhile. */
  private askAgain(): void {
    if (this.asking) return
    const kept = this.cache
    this.asking = this.stored()
      .then((rows) => {
        if (this.cache === kept && !this.closed) this.cache = { at: Date.now(), rows }
      })
      .catch(() => undefined)
      .finally(() => {
        this.asking = null
      })
  }

  async list(): Promise<TaskInfo[]> {
    await this.ready()
    const live = [...this.tasks].filter((task) => task.id)
    // Asking Hermes for its list starts two Python programs (about two seconds): it is asked again after a while, or when
    // something changed. Once it has answered, the list it gave is used while it is asked again behind it, so that the list of
    // tasks does not wait two seconds each time. When something changed (no list kept), it is waited for.
    const maxAge = this.options.cacheMs ?? 20_000
    if (!this.cache || (maxAge <= 0 && Date.now() - this.cache.at > maxAge)) {
      this.cache = { at: Date.now(), rows: await this.stored().catch(() => [] as StoredRow[]) }
    } else if (Date.now() - this.cache.at > maxAge) this.askAgain()
    const mine = new Set(live.map((task) => task.real).filter((id): id is string => !!id))
    // A session Togle started is listed under the name it was started with, as its task was: a to-do line that names the task finds it.
    const startedAs = new Map([...this.names].map(([name, id]) => [id, name]))
    const found: TaskInfo[] = this.cache.rows
      // A session that a task of Togle's runs is that task, and not a second row.
      .filter((row) => !mine.has(row.id))
      .map((row): TaskInfo => {
        const title = row.title || row.workspace || 'Hermes task'
        const asked = row.preview ? askedLine(row.preview, title) : undefined
        return { id: startedAs.get(row.id) ?? row.id, runner: 'hermes', title, ...(asked ? { asked } : {}), folder: '', state: 'idle', updatedAt: row.updatedAt }
      })
    for (const task of live) {
      found.push({ id: task.id as string, runner: 'hermes', title: task.title || 'Hermes task', folder: task.folder, state: task.state, updatedAt: Date.now(), job: task.job, ...(task.waitingFor ? { waitingFor: task.waitingFor } : {}) })
    }
    return found.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * A session's conversation as Hermes keeps it, for the Chat view: what was asked, what Hermes said, the commands it ran and the
   * files it changed. Hermes is asked with `sessions export`, which starts a Python program and takes a second or two, so a session
   * is asked for again only after a while. Null when Hermes has no such session or the export cannot be read.
   */
  async history(id: string, all: boolean): Promise<TaskHistory | null> {
    await this.ready()
    const real = this.sessionOf(id)
    if (!SESSION_WORD.test(real)) return null
    const held = this.conversations.get(real)
    if (held && (held.running || Date.now() - held.at < (this.options.historyMs ?? 8_000))) {
      const entries = held.running ? await held.running : held.entries
      return entries ? lastTurns(entries, all) : null
    }
    const command = await this.command()
    // What is kept is the conversation as entries, never the export: an export holds every row of the session, 25 MB for the biggest here.
    // With the entries, what their steps hold to be opened (what a command printed, a thought's words): kept as long as they are.
    const details = new Map<string, string>()
    const running = exported(command, this.options.env ?? process.env, real).then((session) => (session ? hermesEntries(session, details) : null))
    const entry: { at: number; running?: Promise<LogEntry[] | null>; entries: LogEntry[] | null; details: Map<string, string> } = { at: Date.now(), running, entries: null, details }
    this.conversations.set(real, entry)
    const entries = await running
    entry.running = undefined
    entry.entries = entries
    entry.at = Date.now()
    // Only a few sessions are kept.
    while (this.conversations.size > 4) this.conversations.delete(this.conversations.keys().next().value as string)
    return entries ? lastTurns(entries, all) : null
  }

  /** What a step of that conversation holds (what a command printed, a thought's words), as the session's last export gave it. */
  async step(id: string, more: string): Promise<StepDetail | null> {
    const raw = this.conversations.get(this.sessionOf(id))?.details.get(more)
    return isFileKey(more) ? diffOf(raw) : detailOf(raw)
  }

  /** A session by the id Hermes knows it by: one Togle started has the name it was started with as its id here. */
  private sessionOf(id: string): string {
    return this.names.get(id) ?? [...this.tasks].find((task) => task.id === id)?.real ?? id
  }

  /** Finds the id Hermes gave a session Togle started, by the name it was started with, and gives it the name of the person's words. */
  private async locate(task: HermesTask): Promise<void> {
    if (!task.id || task.real) return
    // Not asked by folder: a session whose first turn failed (its model did not answer) is in the list with no folder at all.
    const rows = await this.stored().catch(() => [] as StoredRow[])
    const row = rows.find((candidate) => candidate.title.startsWith(task.id as string))
    if (!row) return
    const command = await this.command()
    // The person's own words as its name, so that Hermes's own list reads as Togle's does. Hermes keeps one session to a name
    // (the rename then ends with an error): a name that is taken is tried again with a number, as Hermes does itself ("#2").
    if (task.title) {
      const words = task.title.slice(0, 110)
      for (let n = 1; n <= 5; n++) {
        const named = await exec(command[0], [...command.slice(1), 'sessions', 'rename', row.id, n === 1 ? words : `${words} #${n}`], { env: this.options.env ?? process.env })
        if (named.ok) break
      }
    }
    task.real = row.id
    this.cache = null
    await this.remember(task.id, row.id)
  }

  // ---- What is kept between runs ----

  private ready(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.options.keep) return
      try {
        const saved = JSON.parse(await fs.readFile(path.join(this.options.keep, NAMES), 'utf8')) as { names?: unknown }
        for (const item of Array.isArray(saved.names) ? (saved.names as unknown[]) : []) {
          const { name, id } = (item ?? {}) as { name?: unknown; id?: unknown }
          if (typeof name === 'string' && typeof id === 'string' && STARTED_NAME.test(name) && SESSION_WORD.test(id)) this.names.set(name, id)
        }
      } catch {
        // Nothing was kept yet, or what was kept cannot be read: Togle starts without it.
      }
    })()
    return this.loaded
  }

  private async remember(name: string, id: string): Promise<void> {
    await this.ready()
    this.names.delete(name)
    this.names.set(name, id)
    // The oldest are let go of when there are many.
    for (const old of [...this.names.keys()].slice(0, Math.max(0, this.names.size - KEEP_NAMES))) this.names.delete(old)
    // A write that fails is only not kept: after a restart the task is listed under the id Hermes gave it.
    const keep = this.options.keep
    if (keep) await keepJson(path.join(keep, NAMES), { names: [...this.names].map(([kept, session]) => ({ name: kept, id: session })) })
  }

  // ---- Starting and opening ----

  async start(options: StartOptions): Promise<TaskHandle> {
    if (this.closed) throw new Error('Hermes is closed.')
    if (options.prompt.length > MOST_WORDS) throw new Error('That is too long to start a task with. Put the words in a file, and ask the task to read it.')
    const context = await this.context()
    // A name of its own: Hermes would open a session that already has the name instead of starting one.
    const name = `togle-${randomBytes(4).toString('hex')}`
    const title = options.title?.trim() || options.prompt.replace(/\s+/g, ' ').trim().slice(0, 90)
    const task = new HermesTask(context, name, title, options.folder, { words: options.prompt })
    this.tasks.add(task)
    try {
      await task.show()
    } catch (error) {
      this.tasks.delete(task)
      throw error
    }
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    if (this.closed) throw new Error('Hermes is closed.')
    // A session id or name is handed to Hermes as a word of its command: one that could be read as a flag is not one.
    if (!SESSION_WORD.test(id)) throw new Error('That is not a session Hermes knows.')
    const context = await this.context()
    await this.ready()
    // A session Togle started is listed under the name it was started with, and that name opens the session Hermes gave it.
    const session = this.names.get(id) ?? id
    const find = (): HermesTask | undefined => [...this.tasks].find((task) => task.job === id || task.id === id || task.real === session)
    let known = find()
    if (!known) {
      const stored = (await this.stored().catch(() => [] as StoredRow[])).find((row) => row.id === session)
      // Another open of the same session may have finished while the list was read: one session, one task, one screen.
      known = find()
      if (!known) return this.opened(context, id, session, stored?.title || 'Hermes task', options)
    }
    await known.show()
    return known
  }

  private async opened(context: TaskContext, id: string, session: string, title: string, options: ResumeOptions): Promise<HermesTask> {
    const task = new HermesTask(context, id, title, options.folder ?? '')
    task.real = session
    this.tasks.add(task)
    try {
      await task.show()
    } catch (error) {
      this.tasks.delete(task)
      throw error
    }
    return task
  }

  /** Stops using Hermes. The sessions go on in its gateway: only the screens close here. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.tasks].map((task) => task.close()))
    this.tasks.clear()
  }
}
