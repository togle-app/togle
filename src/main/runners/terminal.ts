// An agent that does not speak ACP, run in a terminal of Togle's own (a pseudo-terminal, through node-pty): the person
// sees it and types into it in Togle's window, as in any terminal. Togle cannot read what the agent asks there, so its
// task shows working while the program runs, and done or stopped when it ends; the agent's questions and commands are
// answered in its terminal.
import { randomUUID } from 'node:crypto'
import type { IPty } from 'node-pty'
import { TASK_WORDS, type RunnerKind, type TaskInfo } from '@shared/runner'
import { commandWords, forCmd, whereIs } from './acp'
import { endTree } from './process-tree'
import { TaskBase } from './task-base'
import type { Backend, Detected, StartOptions, TaskHandle, TerminalSide } from './types'

/** Part of what a terminal printed, as the window is sent it: `at` is where it starts among all the terminal printed. */
export interface TerminalChunk {
  key: string
  at: number
  data: string
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
function loadPty(): Promise<NodePty | null> {
  nodePty ??= import('node-pty').then(
    (module) => ((module as { default?: NodePty }).default ?? module) as NodePty,
    (error: Error) => {
      console.warn('[terminal] node-pty could not load:', error.message)
      return null
    }
  )
  return nodePty
}

/** Text as one line, for a terminal: there, a line break would press Enter. */
const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim()

interface WindowsInside {
  _agent?: {
    _ptyNative?: { kill(pty: unknown, useConptyDll: unknown): void }
    _pty?: unknown
    _useConptyDll?: unknown
    _conoutSocketWorker?: { dispose(): void }
    _inSocket?: { destroy(): void }
    _outSocket?: { destroy(): void }
  }
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
  step(() => inside._outSocket?.destroy())
}

class TerminalTask extends TaskBase implements TerminalSide {
  readonly runner: RunnerKind
  private output = ''
  private printed = 0
  // Printed and not sent to the window yet, and where that starts.
  private unsent = ''
  private unsentAt = 0
  private timer?: NodeJS.Timeout
  private ended = false
  private closing = false
  private stoppedAt = 0
  words?: string

  constructor(
    runner: RunnerKind,
    id: string,
    title: string,
    folder: string,
    private readonly name: string,
    private readonly term: IPty,
    words: string | undefined,
    private readonly told: (chunk: TerminalChunk) => void
  ) {
    super()
    this.runner = runner
    this.id = id
    this.title = title
    this.folder = folder
    this.words = words
    term.onData((data) => this.printedMore(data))
    term.onExit(({ exitCode }) => this.exited(exitCode))
    this.setBase('working')
  }

  get terminal(): TerminalSide {
    return this
  }

  private printedMore(data: string): void {
    this.output = (this.output + data).slice(-KEEP)
    if (!this.unsent) this.unsentAt = this.printed
    this.printed += data.length
    this.unsent += data
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS)
  }

  private flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.unsent || !this.id) return
    const chunk = { key: `${this.runner}:${this.id}`, at: this.unsentAt, data: this.unsent }
    this.unsent = ''
    this.told(chunk)
  }

  private exited(code: number): void {
    if (this.ended) return
    this.ended = true
    this.flush()
    release(this.term)
    if (this.closing) {
      this.emit({ type: 'ended', reason: 'closed' })
      return
    }
    // Ended by Stop (Ctrl+C) or End it: stopped, as the person asked. Ended by itself: done, or why it stopped.
    if (Date.now() - this.stoppedAt < STOP_COUNTS_MS) {
      this.emit({ type: 'turn-ended', outcome: 'interrupted', error: null })
      this.setBase('stopped')
    } else if (code === 0) {
      this.emit({ type: 'turn-ended', outcome: 'completed', error: null })
      this.setBase('idle')
    } else {
      this.setBase('failed')
      this.emit({ type: 'error', message: `${this.name} stopped (exit code ${code}).` })
      this.emit({ type: 'ended', reason: 'crashed' })
    }
  }

  read(): { text: string; end: number } {
    return { text: this.output, end: this.printed }
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

  /** Ends the program and what it started; the terminal is let go when it has ended (exited). */
  private async end(): Promise<void> {
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
    // A .cmd or .bat (an agent installed with npm, on Windows) only starts through cmd.exe, which would read the task's
    // words as commands: there they are not put in the command, and wait to be typed in.
    const shim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(found)
    const placed = !shim && rest.some((word) => word.includes(TASK_WORDS))
    const args = rest.flatMap((word) => (!word.includes(TASK_WORDS) ? [word] : placed ? [word.split(TASK_WORDS).join(options.prompt)] : []))
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as Record<string, string>
    const size = { name: 'xterm-256color', cols: 120, rows: 32, cwd: options.folder, env }
    const term = shim
      ? pty.spawn(process.env.ComSpec || 'cmd.exe', `/d /s /c "${[found, ...args].map(forCmd).join(' ')}"`, size)
      : pty.spawn(found, args, size)
    const id = randomUUID()
    const title = options.title?.trim() || oneLine(options.prompt).slice(0, 90)
    const task = new TerminalTask(this.runner, id, title, options.folder, this.agent.name, term, placed ? undefined : options.prompt, this.told)
    this.tasks.set(id, task)
    task.on((event) => {
      if (event.type === 'ended') this.tasks.delete(id)
    })
    return task
  }

  async resume(): Promise<TaskHandle> {
    throw new Error(`A task in a terminal ends with its program. Start a new one with ${this.agent.name}.`)
  }

  async close(): Promise<void> {
    await Promise.all([...this.tasks.values()].map((task) => task.close()))
    this.tasks.clear()
  }
}
