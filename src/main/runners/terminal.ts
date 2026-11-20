// An agent that does not speak ACP, run in a terminal of Togle's own (a pseudo-terminal, through node-pty): the person
// sees it and types into it in Togle's window, as in any terminal. Togle cannot read what the agent asks there, so its
// task shows working while the program runs, and done or stopped when it ends; the agent's questions and commands are
// answered in its terminal.
import { randomUUID } from 'node:crypto'
import { accessSync, constants, promises as fs } from 'node:fs'
import path from 'node:path'
import type { IPty } from 'node-pty'
import { filePathsForTerminal } from '@shared/pasted-pictures'
import { TASK_WORDS, type RunnerKind, type TaskInfo } from '@shared/runner'
import { commandWords, exists, forCmd, whereIs } from './acp'
import { endTree } from './process-tree'
import { TaskBase } from './task-base'
import { safeCut, TerminalModes } from './terminal-modes'
import type { Backend, Detected, StartOptions, TaskHandle, TerminalSide } from './types'

/** Part of what a terminal printed, as the window is sent it: `at` is where it starts among all the terminal printed. */
export interface TerminalChunk {
  key: string
  at: number
  data: string
  /** Which screen printed it, for a task that opens a new screen each time (one that runs in the background). */
  screen?: string
}

/** An added agent that runs in a terminal: its name, and the command that starts it, with {task} where its words go. */
export interface TerminalAgent {
  runner: RunnerKind
  name: string
  command: string
}

// What is kept of what a terminal printed, for the window to show when it opens the task.
const KEEP = 512 * 1024
// What it printed goes to the window this often at most, in one piece.
const FLUSH_MS = 16
// A Ctrl+C this recent makes the program's end a stop the person asked for, not an error.
const STOP_COUNTS_MS = 10_000

type NodePty = typeof import('node-pty')
let nodePty: Promise<NodePty | null> | undefined

/** node-pty, loaded when a terminal is first needed: a computer where it cannot load still runs the rest of Togle. */
export function loadPty(): Promise<NodePty | null> {
  nodePty ??= import('node-pty').then(
    (module) => ((module as { default?: NodePty }).default ?? module) as NodePty,
    (error: Error) => {
      console.warn('[terminal] node-pty could not load:', error.message)
      return null
    }
  )
  return nodePty
}

/**
 * The words without what a terminal would take as keys of their own: escape sequences (colored text piped in) and
 * control characters (Ctrl+C is one). Line breaks and tabs stay, for an argument.
 */
export const cleanWords = (text: string): string =>
  text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[\]P^_][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')

/** Text as one line, for a terminal: there, a line break would press Enter. */
const oneLine = (text: string): string => cleanWords(filePathsForTerminal(text)).replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim()

/**
 * A reply sent to a screen that nobody looks at is only words: one that starts as a command of the agent's own ("/", "!") would
 * ask things there, on a screen the person does not see. Says so, in words, for the person to read.
 */
export function refuseCommand(text: string): void {
  if (/^[/!]/.test(oneLine(text))) throw new Error('A command is typed on the agent’s screen. Pick Terminal, and type it there.')
}

/**
 * One argument for a Windows command line, quoted the way programs read their arguments back (the C runtime's rules),
 * whatever it holds: quotes, spaces, backslashes. node-pty's own quoting leaves an argument that starts and ends with a
 * quote unquoted, which splits words like `"Fix it" --yolo` into several arguments.
 */
export function windowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg
  let out = '"'
  let slashes = 0
  for (const char of arg) {
    if (char === '\\') {
      slashes++
      continue
    }
    out += char === '"' ? `${'\\'.repeat(slashes * 2 + 1)}"` : `${'\\'.repeat(slashes)}${char}`
    slashes = 0
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`
}

/**
 * What an npm or pnpm shim (a .cmd, on Windows) starts: Node and the agent's script, or the agent's own program. Started
 * so, without cmd.exe, the task's words can go in its command. Null for any other .cmd.
 */
export async function shimTarget(file: string): Promise<string[] | null> {
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  if (!text || text.length > 16_000) return null
  const found = /"%~?dp0%?\\([^"%]+)"\s+%\*/i.exec(text)
  if (!found) return null
  const dir = path.dirname(file)
  const target = path.resolve(dir, found[1])
  if (!(await exists(target))) return null
  if (/\.exe$/i.test(target)) return [target]
  if (!/\.[cm]?js$/i.test(target)) return null
  const bundled = path.join(dir, 'node.exe')
  const node = (await exists(bundled)) ? bundled : await whereIs('node')
  return node ? [node, target] : null
}

/**
 * The words of a command started through cmd.exe, with the task's place taken out (the words wait to be typed in): the
 * word with {task}, and the flag before it when {task} was that flag's value ("--message {task}"), or the program would
 * start with a flag that has lost its value.
 */
export function withoutTaskWords(words: string[]): string[] {
  const kept: string[] = []
  for (const word of words) {
    if (!word.includes(TASK_WORDS)) {
      kept.push(word)
      continue
    }
    const before = kept.at(-1)
    if (word === TASK_WORDS && before && /^-/.test(before) && !before.includes('=')) kept.pop()
  }
  return kept
}

interface InnerSocket {
  destroy(): void
  on?(event: 'error', listener: (error: Error) => void): void
}

interface WindowsInside {
  _agent?: {
    _ptyNative?: { kill(pty: unknown, useConptyDll: unknown): void }
    _pty?: unknown
    _useConptyDll?: unknown
    _conoutSocketWorker?: { dispose(): void; _worker?: { on?(event: 'error', listener: (error: Error) => void): void } }
    _inSocket?: InnerSocket
    _outSocket?: InnerSocket
  }
}

// node-pty ends its output worker this long after it is told to (FLUSH_DATA_INTERVAL in node-pty 1.1.0), and a little more.
const WORKER_ENDS_MS = 1_500

/**
 * On Windows, node-pty's two pipes to the console, and the worker that reads the console's output, can fail once the
 * program is gone ("ended by the other party"), with nothing of node-pty's own listening: in Togle's main process that
 * would be an error the person sees. They are listened to from the start; a terminal that ended has nothing left to say.
 */
function quietPipes(term: IPty): void {
  if (process.platform !== 'win32') return
  const inside = (term as unknown as WindowsInside)._agent
  for (const pipe of [inside?._inSocket, inside?._outSocket]) pipe?.on?.('error', () => undefined)
  inside?._conoutSocketWorker?._worker?.on?.('error', () => undefined)
}

/** A program started in a terminal of Togle's own, 120 by 32 until the window says how big it is. `file` must be a program, not a shim. */
export function openTerminal(pty: NodePty, file: string, args: string[], cwd: string, env: Record<string, string>): IPty {
  // Windows says at once that a program is not there. Elsewhere node-pty starts a child that then fails on its own, and the screen would open
  // and end with nothing said here: a program that is not there, or not one that can be run, is said before.
  if (process.platform !== 'win32' && path.isAbsolute(file)) {
    try { accessSync(file, constants.X_OK) } catch { throw new Error(`${path.basename(file)} is not there, or cannot be run.`) }
  }
  const size = { name: 'xterm-256color', cols: 120, rows: 32, cwd, env }
  const term = process.platform === 'win32' ? pty.spawn(file, args.map(windowsArg).join(' '), size) : pty.spawn(file, args, size)
  quietPipes(term)
  return term
}

/**
 * On Windows, node-pty (1.1.0) keeps the console host, a worker and two pipes after the program in its terminal ended,
 * and its own kill starts a helper process that fails once the program is gone. They are let go here instead: the
 * console host is closed and the worker and the pipes go, so nothing is left behind each task. Elsewhere the terminal
 * closes with its program.
 */
function release(term: IPty): void {
  if (process.platform !== 'win32') return
  const inside = (term as unknown as WindowsInside)._agent
  if (!inside) return
  const step = (what: () => void): void => {
    try {
      what()
    } catch {
      // Already gone.
    }
  }
  step(() => inside._ptyNative?.kill(inside._pty, inside._useConptyDll))
  step(() => inside._conoutSocketWorker?.dispose())
  step(() => inside._inSocket?.destroy())
  // The worker may still be writing the console's last output into this pipe: it goes once the worker has ended.
  const later = setTimeout(() => step(() => inside._outSocket?.destroy()), WORKER_ENDS_MS)
  later.unref?.()
}

export class TerminalTask extends TaskBase implements TerminalSide {
  readonly runner: RunnerKind
  /**
   * Whether the task is over for the hub when its program ends, however it ends: the agent keeps the conversation, and
   * the hub lets the task go, so the agent's own list shows it again. An agent that lives only in Togle's terminal keeps
   * its task, which says what it printed.
   */
  protected releases = false
  private output = ''
  private printed = 0
  // The modes the program had set where what is kept begins (what went before it is not kept, and the program sets them once).
  private readonly modesBefore = new TerminalModes()
  // Printed and not sent to the window yet, and where that starts.
  private unsent = ''
  private unsentAt = 0
  private timer?: NodeJS.Timeout
  private ended = false
  private ending = false
  private closing = false
  private stoppedAt = 0
  /** When it last printed anything. */
  private lastPrinted = 0
  /** When this screen began. */
  private readonly openedAt = Date.now()
  words?: string

  constructor(
    runner: RunnerKind,
    id: string,
    title: string,
    folder: string,
    private readonly name: string,
    private readonly term: IPty,
    words: string | undefined,
    private readonly told: (chunk: TerminalChunk) => void,
    /** It ended: its backend lets go of it. */
    private readonly gone: () => void
  ) {
    super()
    this.runner = runner
    this.id = id
    this.title = title
    this.folder = folder
    this.words = words
    term.onData((data) => this.printedMore(data))
    term.onExit(({ exitCode, signal }) => this.exited(exitCode, signal))
    this.setBase('working')
  }

  get terminal(): TerminalSide {
    return this
  }

  /** Names this terminal among those a task opens one after the other, so that the window takes only the one it shows. */
  protected get tag(): string | undefined {
    return undefined
  }

  /** The program's id on this computer, while it runs: what tells its row in the agent's own list as this task. */
  get program(): number | null {
    return this.ended ? null : (this.term.pid ?? null)
  }

  private printedMore(data: string): void {
    this.lastPrinted = Date.now()
    const all = this.output + data
    if (all.length > KEEP) {
      // What goes is read for the modes it set, and the cut is not made inside a sequence.
      const cut = safeCut(all, all.length - KEEP)
      this.modesBefore.feed(all.slice(0, cut))
      this.output = all.slice(cut)
    } else this.output = all
    if (!this.unsent) this.unsentAt = this.printed
    this.printed += data.length
    this.unsent += data
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.unsent || !this.id) return
    const chunk: TerminalChunk = { key: `${this.runner}:${this.id}`, at: this.unsentAt, data: this.unsent, ...(this.tag ? { screen: this.tag } : {}) }
    this.unsent = ''
    this.told(chunk)
  }

  protected exited(code: number, signal?: number): void {
    if (this.ended) return
    this.ended = true
    this.flush()
    release(this.term)
    this.gone()
    // Let go (or its agent removed): stopped.
    if (this.closing) {
      this.setBase('stopped')
      this.emit({ type: 'ended', reason: 'closed' })
      return
    }
    // Ended by Stop (Ctrl+C) or End it: stopped, as the person asked. Ended by itself: done, or why it stopped (on a Mac
    // and Linux a program killed by a signal reports exit code 0, with the signal apart).
    if (Date.now() - this.stoppedAt < STOP_COUNTS_MS) {
      this.emit({ type: 'turn-ended', outcome: 'interrupted', error: null })
      this.setBase('stopped')
      if (this.releases) this.emit({ type: 'ended', reason: 'closed' })
    } else if (code === 0 && !signal) {
      this.emit({ type: 'turn-ended', outcome: 'completed', error: null })
      this.setBase('idle')
      if (this.releases) this.emit({ type: 'ended', reason: 'closed' })
    } else {
      this.setBase('failed')
      this.emit({ type: 'error', message: signal ? `${this.name} stopped (signal ${signal}).` : `${this.name} stopped (exit code ${code}).` })
      this.emit({ type: 'ended', reason: 'crashed' })
    }
  }

  /**
   * What it printed, for a window that opens the screen: the last part (see KEEP), preceded by the modes the program had set where that
   * part begins, so that the screen asks of the window what it asked at its start (the other screen, the mouse, bracketed paste).
   */
  read(): { text: string; end: number } {
    const gone = this.printed > this.output.length
    return { text: (gone ? this.modesBefore.restore() : '') + this.output, end: this.printed }
  }

  write(data: string): void {
    if (!this.ended) this.term.write(data)
  }

  resize(cols: number, rows: number): void {
    if (this.ended) return
    try {
      this.term.resize(cols, rows)
    } catch {
      // It ended as it was resized.
    }
  }

  typeWords(): void {
    if (!this.words || this.ended) return
    this.write(oneLine(this.words))
    this.words = undefined
  }

  /** Words from elsewhere in Togle (a reply) are typed in as one line, without Enter: the person presses it. */
  async send(text: string): Promise<void> {
    this.write(oneLine(text))
  }

  /**
   * Resolves once the program has drawn its screen: it printed something, and then nothing for `quietMs`. Gives up after `maxMs`
   * (a program that keeps printing, or never does), so that what waits is typed in all the same.
   */
  async settled(quietMs = 700, maxMs = 8_000): Promise<void> {
    const began = Date.now()
    while (!this.ended && Date.now() - began < maxMs) {
      if (this.printed > 0 && Date.now() - this.lastPrinted >= quietMs) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * Resolves once the program has drawn its screen and had a moment to take keys: for one that is at work, which never goes quiet (so
   * `settled` would wait out its limit). A screen opened a moment ago is given `minMs` from its start (Claude Code takes about that long
   * to put up its prompt when a screen attaches); one that has been open longer takes keys now. Gives up after `maxMs`, so that what
   * waits is typed in all the same.
   */
  async drawn(minMs = 3_000, maxMs = 9_000): Promise<void> {
    const began = Date.now()
    while (!this.ended && Date.now() - began < maxMs) {
      if (this.printed > 0 && Date.now() - this.openedAt >= minMs) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  /**
   * A reply sent from a view that has no screen on it: the words as one line, and Enter, as the person would on the screen.
   * A line that starts as a command of the agent's own ("/", "!") is not sent: it asks things on the screen that nobody is looking at.
   */
  async submit(text: string): Promise<void> {
    const line = oneLine(text)
    if (!line) return
    refuseCommand(line)
    this.write(line)
    // Enter a moment after the words: a program that takes a burst of keys as pasted text would hold the Enter in it.
    await new Promise((resolve) => setTimeout(resolve, 150))
    this.write('\r')
  }

  /** The first press: Ctrl+C, as in any terminal. The agent decides what that stops. */
  async stop(): Promise<void> {
    if (this.ended) return
    this.stoppedAt = Date.now()
    this.write('\x03')
  }

  /** End it: the program and what it started. */
  async endCommands(): Promise<number> {
    if (this.ended) return 0
    this.stoppedAt = Date.now()
    await this.end()
    return 1
  }

  async close(): Promise<void> {
    if (this.ended) return
    this.closing = true
    await this.end()
  }

  /** Ends the program and what it started, once; the terminal is let go when it has ended (exited). */
  private async end(): Promise<void> {
    if (this.ending) return
    this.ending = true
    const pid = this.term.pid
    if (process.platform !== 'win32') {
      try {
        this.term.kill()
      } catch {
        // Already gone.
      }
    }
    if (pid) await endTree(pid).catch(() => undefined)
  }
}

export class TerminalBackend implements Backend {
  readonly runner: RunnerKind
  readonly name: string
  private readonly tasks = new Map<string, TerminalTask>()

  constructor(
    private readonly agent: TerminalAgent,
    private readonly told: (chunk: TerminalChunk) => void = () => undefined
  ) {
    this.runner = agent.runner
    this.name = agent.name
  }

  async detect(): Promise<Detected> {
    const [program] = commandWords(this.agent.command)
    const found = program ? await whereIs(program) : null
    if (!found || !(await loadPty())) return { installed: false }
    return { installed: true, command: found }
  }

  /** Its tasks end with Togle: the ones running now are Togle's own, and listed from there. */
  async list(): Promise<TaskInfo[]> {
    return []
  }

  async start(options: StartOptions): Promise<TaskHandle> {
    const pty = await loadPty()
    if (!pty) throw new Error('Togle cannot open a terminal on this computer.')
    const [program, ...rest] = commandWords(this.agent.command)
    const found = program ? await whereIs(program) : null
    if (!found) throw new Error(`${this.agent.name} is not on this computer: ${program ?? 'its command'} was not found.`)
    const windows = process.platform === 'win32'
    // On Windows a .cmd or .bat (an agent installed with npm or pnpm) is read for what it starts, which then starts without
    // cmd.exe. Any other .cmd only starts through cmd.exe, which would read the task's words as commands: there they are
    // not put in its command, and wait to be typed in.
    let file = found
    let first: string[] = []
    let shim = false
    if (windows && /\.(cmd|bat)$/i.test(found)) {
      const target = await shimTarget(found)
      if (target) [file, ...first] = target
      else shim = true
    }
    // Windows starts a program (.exe, .com) and nothing else: anything else is said here, before a console is made for it.
    if (windows && !shim && !/\.(exe|com)$/i.test(file)) throw new Error(`${this.agent.name} cannot be started: ${path.basename(file)} is not a program. Give the command that starts it in a terminal.`)
    const words = cleanWords(options.prompt)
    const placed = !shim && rest.some((word) => word.includes(TASK_WORDS))
    const args = shim ? withoutTaskWords(rest) : rest.map((word) => word.split(TASK_WORDS).join(words))
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    const size = { name: 'xterm-256color', cols: 120, rows: 32, cwd: options.folder, env }
    let term: IPty
    try {
      term = shim
        ? pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${[found, ...args].map(forCmd).join(' ')}"`, size)
        : windows
          ? pty.spawn(file, [...first, ...args].map(windowsArg).join(' '), size)
          : pty.spawn(file, [...first, ...args], size)
    } catch (error) {
      throw new Error(`${this.agent.name} could not be started: ${(error as Error).message}`)
    }
    quietPipes(term)
    const id = randomUUID()
    const title = options.title?.trim() || oneLine(options.prompt).slice(0, 90)
    const task = new TerminalTask(this.runner, id, title, options.folder, this.agent.name, term, placed ? undefined : words, this.told, () => this.tasks.delete(id))
    this.tasks.set(id, task)
    return task
  }

  async resume(): Promise<TaskHandle> {
    throw new Error(`A task in a terminal ends with its program. Start a new one with ${this.agent.name}.`)
  }

  async close(): Promise<void> {
    await Promise.all([...this.tasks.values()].map((task) => task.close()))
    this.tasks.clear()
  }

  /** How many of its tasks still run: what it holds on to. */
  get running(): number {
    return this.tasks.size
  }
}
