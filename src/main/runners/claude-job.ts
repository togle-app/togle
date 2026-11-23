// A Claude Code task that runs in the background, and its screen. Claude Code can run a session with no window of its own
// (`claude --bg`) and open its screen in any terminal when someone looks (`claude attach <id>`): the session goes on when
// the screen is closed, and when Togle quits. Togle runs the session this way, so a task opens as the agent's own screen,
// as in a terminal, and is not lost with the window.
//
// What trying Claude Code 2.1.323 on Windows showed, which this follows:
// - `claude agents --json --all` lists each session with the id its other commands take (`id`: eight characters, not the
//   session's own id), its program (`pid`, gone once it is stopped), its `status` (idle, busy, waiting) and what it waits
//   for. `state` alone says "blocked" for a session that only waits for its first message. Its `sessionId` changes when
//   the person empties the conversation ("/clear"); `id` does not.
// - A screen is a client of the session: `claude attach <id>` in a pseudo-terminal. Killing it leaves the session running.
//   A session has one screen at a time: a second one ends the first ("Session opened in another window"). Esc on the screen
//   interrupts the turn, as in any terminal, and the session goes on (measured on 2.1.328: idle 0.3 s later, same job and session).
//   A key typed before the screen takes keys is lost (an Esc 0.3 s after the attach did nothing, one at 1.5 s worked). Esc twice
//   within a moment on an idle prompt opens the rewind menu, which takes the next words as its own.
// - A session that was stopped (`claude stop <id>`, which ends the command it was running too) comes back with `claude
//   attach <id>`, the same session and conversation, with what it was given at its start, the hook included.
// - The same hook as for any session (claude-hooks.ts) works here. The program posts a request, shows its own question at
//   the same time, and acts on whichever answer comes first. An answer on the screen does NOT end the request: Claude Code
//   keeps the hook's connection open. What shows it is `claude agents`: the status is "waiting" while the question is up and
//   "busy" about a second after it was answered.
// - The person's own settings apply (their permission mode, their rules): nothing is forced, so Togle hears only what
//   Claude Code asks. A person whose Claude Code never asks sees no card.
import type { IPty } from 'node-pty'
import type { BackgroundShell, TaskState } from '@shared/runner'
import type { HookTarget, HookVerdict } from './claude-hooks'
import { requestOf, verdictOf } from './claude-requests'
import { rec, text } from './jsonrpc'
import { cleanWords, loadPty, openTerminal, refuseCommand, TerminalTask, type TerminalChunk } from './terminal'
import { TaskBase } from './task-base'
import type { ScreenSide, TerminalSide } from './types'

/** A session as `claude agents --json` lists it: one running in a terminal, or one in the background. */
export interface AgentRow {
  /** What `attach`, `stop` and `logs` take: only a session in the background has one. */
  id?: string
  sessionId?: string
  cwd?: string
  kind?: string
  status?: string
  state?: string
  pid?: number
  name?: string
  waitingFor?: string
  startedAt?: number
  /** The commands it started that still run in the background (claude-registry.ts adds them; the list does not tell). */
  shells?: BackgroundShell[]
  /** The monitors it started that still run, which say something to it when there is something (claude-registry.ts adds them too). */
  monitors?: BackgroundShell[]
  /** Only a monitor keeps it busy: its turn is over (the program's record or the job's tempo says so). claude-registry.ts sets it with the monitors. */
  turnOver?: boolean
}

/** A session in the background. */
export type JobRow = AgentRow & { id: string }

/** Whether a row is a session in the background, which has the id its screen is opened with. */
export const isJob = (row: AgentRow): row is JobRow => row.kind === 'background' && /^[0-9a-f]{8}$/.test(row.id ?? '')

/** A row as Claude Code gives it: the fields Togle uses, as they are. */
export function rowOf(told: Record<string, unknown>): AgentRow {
  const pid = typeof told.pid === 'number' && told.pid > 0 ? told.pid : undefined
  return {
    ...(text(told.id) ? { id: text(told.id) } : {}),
    ...(text(told.sessionId) ? { sessionId: text(told.sessionId) } : {}),
    ...(text(told.cwd) ? { cwd: text(told.cwd) } : {}),
    ...(text(told.kind) ? { kind: text(told.kind) } : {}),
    ...(text(told.status) ? { status: text(told.status) } : {}),
    ...(text(told.state) ? { state: text(told.state) } : {}),
    ...(pid ? { pid } : {}),
    ...(text(told.name) ? { name: text(told.name) } : {}),
    ...(text(told.waitingFor) ? { waitingFor: text(told.waitingFor) } : {}),
    ...(typeof told.startedAt === 'number' ? { startedAt: told.startedAt } : {})
  }
}

/**
 * What a background session is doing, by its program and then its status: with a program, `busy` is working, `waiting` is
 * waiting for the person and anything else is idle: `shell` too, the turn is over while a command it started still runs
 * (claude-registry.ts says so; the list says busy). (`state` says "blocked" for a session that waits for its first message,
 * and "working" a moment after an interrupt.) Without a program the session is stopped: by the person (`stopped`), or
 * because it failed.
 */
export function stateOfJob(row: AgentRow, stopped = false): TaskState {
  if (typeof row.pid !== 'number') return row.state === 'failed' ? 'failed' : stopped || row.state === 'stopped' ? 'stopped' : 'idle'
  if (row.status === 'busy') return 'working'
  if (row.status === 'waiting') return 'waiting'
  return 'idle'
}

/** What marks a Claude Code a person started from inside Claude Code: with it, the new program would not save its conversation. */
const NESTED = /^(CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*)$/

const MODE_FLAGS = new Set(['--model', '--permission-mode', '--effort'])

/**
 * The flags a Claude Code was started with that decide what it does: its model, effort and permission mode, and the
 * flag that skips permission checks. The session that replaces it is started with them, so that it goes on the same way.
 * Read from the command line it ran under; only a plain value is taken (`opus`, `plan`, `sonnet[1m]`).
 */
export function carriedFlags(command: string): string[] {
  const words = (command.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"|"$/g, ''))
  const carried: string[] = []
  for (let at = 0; at < words.length; at++) {
    const [name, inline] = words[at].split(/=(.*)/s)
    if (words[at] === '--dangerously-skip-permissions') carried.push(words[at])
    else if (MODE_FLAGS.has(name)) {
      const value = inline ?? words[++at]
      if (value && /^[\w.:[\]-]+$/.test(value)) carried.push(name, value)
    }
  }
  return carried
}

/** The environment Claude Code is run in: this computer's, as a terminal gives it, without the marks of a Claude Code inside Claude Code. */
export function claudeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !NESTED.test(key) && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  return env
}

/** The environment of a screen: the same, for a terminal. */
export function screenEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  return { ...claudeEnv(base), TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

/** One screen: `claude attach` in a terminal of Togle's own. It is over with its program, and the session goes on. */
export class AttachScreen extends TerminalTask {
  constructor(id: string, title: string, folder: string, term: IPty, told: (chunk: TerminalChunk) => void, gone: () => void, readonly screenId: string) {
    super('claude', id, title, folder, 'Claude Code', term, undefined, told, gone)
  }

  // Claude Code asks that a paste is marked as one, and takes a long reply whole that way (a long burst of keys it cuts into pieces, mid-word).
  protected override readonly pastesLongReplies: boolean = true

  protected override get tag(): string {
    return this.screenId
  }
}

/** What a job asks of the backend that runs Claude Code. */
export interface JobContext {
  /** What starts Claude Code, before its flags. */
  command: string[]
  env: NodeJS.ProcessEnv
  /** Where what a screen prints goes, for the window. */
  told: (chunk: TerminalChunk) => void
  /** Runs `claude <args>` in the folder, and says what it printed. */
  run(args: string[], cwd: string): Promise<{ ok: boolean; text: string }>
  /** Something changed: the sessions are looked at soon. */
  look(): void
  /** What the session said last, in words: for the notice that its turn ended. Empty when there is nothing. */
  said(session: string): Promise<string>
  /** The session is gone for good. */
  over(job: ClaudeJob): void
  /** Why a stopped session may not be opened now, in words: a terminal has its conversation open. Nothing when it may. */
  openElsewhere(session: string): Promise<string | undefined>
}

/** How long a task started with words is shown as working before the list can say it is not: the program takes a moment to begin. */
const BEGIN_MS = 6_000

/**
 * How long after its screen began Esc is pressed on it: Claude Code loses a key that comes before its screen takes keys (2.1.328 on
 * Windows: an Esc 0.3 s after the attach was lost, one at 1.5 s and one at 4 s ended the turn within 0.3 s).
 */
const ESC_AFTER_MS = 2_000

/** How soon after one Esc another may be pressed: two within the window of a double press open Claude Code's rewind menu (measured: 0.3 s apart). */
const ESC_APART_MS = 2_000

/**
 * Taking back Claude Code's queue (measured on 2.1.328): the Up arrow on its screen gives all of what is queued back to its prompt (a
 * `popAll` line in the session's file for each message), one message to a line; Enter there would queue them again as one message. A prompt of
 * several lines is emptied from its end, a line at a time: Ctrl+A (to the start of the line), Ctrl+K (to its end) and Backspace (the line break
 * before it) take one line away (tried on a prompt of three lines; Ctrl+U alone takes only the last line, and Esc or Ctrl+C would stop the turn
 * that is running). More of them than there are lines do nothing to an empty prompt, and a line that wraps is taken in as many steps as it has rows.
 */
const UP_KEY = '\x1b[A'
const DOWN_KEY = '\x1b[B'
const ONE_LINE_BACK = '\x01\x0b\x7f'
/**
 * How long its record is given to show that the arrow gave the queue back (the `popAll` lines are written within a moment of the key). Where nothing
 * was queued any more (the turn took it in first), the arrow recalls the previous prompt of the folder, or moves the cursor in a draft of several
 * lines, and Down puts that back (tried on 2.1.328: Up on an empty prompt showed the earlier prompt, and Down emptied it again; over a draft of one
 * line Up showed the earlier prompt and Down brought the draft back; over a draft of two lines both only moved the cursor).
 */
const POP_CONFIRM_MS = 3_000

/** What a task's record says now: what waits in the agent's own queue, and everything the person said in the conversation. */
export interface QueueRecord {
  queued: readonly string[]
  said: readonly string[]
}

/** The words that were said more times in `now` than in `was`: what the conversation gained, whatever the order or the ids. */
function gained(now: readonly string[], was: readonly string[]): Set<string> {
  const count = (list: readonly string[]): Map<string, number> => {
    const counts = new Map<string, number>()
    for (const words of list) counts.set(words, (counts.get(words) ?? 0) + 1)
    return counts
  }
  const before = count(was)
  const more = new Set<string>()
  for (const [words, times] of count(now)) if (times > (before.get(words) ?? 0)) more.add(words)
  return more
}
/** A screen's width, as least as it is in Togle's window, to count the rows a long line takes (more than are needed is harmless). */
const NARROWEST_COLUMNS = 40

/**
 * The keys that empty the prompt after the Up arrow gave it `words` (one message to a line, and as many lines as each has of its own; a long
 * line wraps into several rows): a line at a time from the end, one step more than there are rows, and then one to empty what the last step
 * left (a first line has no break before it for the Backspace). Steps past an empty prompt do nothing.
 */
export function clearKeys(words: readonly string[]): string {
  const all = words.join('\n')
  const steps = all.split('\n').length + Math.ceil(all.length / NARROWEST_COLUMNS) + 2
  return ONE_LINE_BACK.repeat(steps) + '\x01\x0b'
}

/** How many of the clearing keys go in one write, and how long the next write waits. */
const CLEAR_PIECE = 30
const CLEAR_GAP_MS = 25

/**
 * Keys written in small pieces, a moment apart. Claude Code takes a long run of keys in one write as pasted text, and a key in pasted text is not
 * pressed: the 239 keys that empty a prompt holding a long reply (it is a pasted-text chip, "[Pasted text #1 +28 lines]") left the chip there (measured
 * on 2.1.330); the same keys, 15 or 30 in a write and 25 ms apart, emptied it. A key is one character, so the cut can fall anywhere.
 */
export async function typeApart(write: (keys: string) => void, keys: string, piece = CLEAR_PIECE, gapMs = CLEAR_GAP_MS): Promise<void> {
  for (let at = 0; at < keys.length; at += piece) {
    if (at) await new Promise((resolve) => setTimeout(resolve, gapMs))
    write(keys.slice(at, at + piece))
  }
}

const NOTICED_ELSEWHERE = /opened in another window/i

export class ClaudeJob extends TaskBase implements HookTarget, ScreenSide {
  readonly runner = 'claude' as const
  /** Its own queue takes a line typed while it works, and takes it in at its next step. */
  readonly takesWordsWhileWorking = true
  private current: string
  private row?: JobRow
  /** What the list last said it was. */
  private last: TaskState = 'idle'
  private settling = false
  /** The commands it runs in the background as the list last said them, by their ids: the window is told when they change. */
  private shellKey = ''
  private screenTask: AttachScreen | null = null
  private screens = 0
  private requests = 0
  private sawWaiting = false
  private stopped = false
  /** When Esc was last pressed (or is being pressed) for Stop. */
  private escapedAt = 0
  private over = false
  private holdWorkingUntil = 0
  /** Put to rest after a quiet day (see `rest`): its program is gone, and it is still Done, not stopped. */
  private rested = false
  /** When it was last seen at work, waiting, or open on a screen here; 0 until then (the session's own file says more). */
  lastActive = 0
  /** When resting it was last tried, so that one that cannot be put to rest is not tried at every look. */
  restTried = 0
  closed: string | undefined
  waitingFor: string | undefined

  /**
   * `job` is the id Claude Code gives the session; `id` the session it was first known by, which is the task's own id
   * from then on (the session changes with "/clear", and the job does not). `key` names its hook address, when Togle gave it one.
   */
  constructor(private readonly context: JobContext, readonly job: string, id: string, title: string, folder: string, readonly key?: string) {
    super()
    this.id = id
    this.current = id
    this.title = title
    this.folder = folder
  }

  get screen(): ScreenSide {
    return this
  }

  get terminal(): TerminalSide | undefined {
    return this.screenTask ?? undefined
  }

  get pid(): number | null {
    return this.row?.pid ?? null
  }

  /** What it started that still runs in the background. */
  get shells(): readonly BackgroundShell[] {
    return this.row?.shells ?? []
  }

  /** What it watches in the background, for it to go on with. */
  get monitors(): readonly BackgroundShell[] {
    return this.row?.monitors ?? []
  }

  /**
   * It is Working only because it waits on a monitor: its turn is over, so Stop has no turn to end (Esc on its screen would do nothing), the
   * words typed go in as after any turn, and its screen is quiet. It goes on by itself when the monitor says something.
   */
  get turnOver(): boolean {
    return this.state === 'working' && this.monitors.length > 0 && !!this.row?.turnOver
  }

  get open(): boolean {
    return this.screenTask !== null
  }

  get screenId(): string | undefined {
    return this.screenTask?.screenId
  }

  get line(): string {
    return `claude attach ${this.job}`
  }

  /** The session it is in now. Every request says which: the person may clear the conversation or pick another. */
  session(): string {
    return this.current
  }

  /** The list says what the session is doing: its state, what it waits for, and which session it is in. */
  seen(row: JobRow | undefined): void {
    if (this.over) return
    if (!row) {
      void this.lost()
      return
    }
    this.row = row
    // What it runs in the background changed (a command began, or ended): the window is told, though no state changed to carry it.
    const shellKey = (row.shells ?? []).map((shell) => shell.id).join(',') + '|' + (row.monitors ?? []).map((monitor) => monitor.id).join(',')
    if (shellKey !== this.shellKey) {
      this.shellKey = shellKey
      this.emit({ type: 'shells' })
    }
    if (row.sessionId && row.sessionId !== this.current) {
      // The person emptied the conversation: the program goes on in another session, and the task goes on with it.
      this.current = row.sessionId
      this.emit({ type: 'cleared' })
    }
    const alive = typeof row.pid === 'number'
    if (alive) {
      this.stopped = false
      // It is running again (someone opened it): it is no longer at rest.
      this.rested = false
      if (row.status === 'busy' || row.status === 'waiting') this.lastActive = Date.now()
    }
    const waiting = alive && row.status === 'waiting'
    // A request that waits goes once the program says it waits no more, after it did: it was answered on the screen.
    if (this.pending.length) {
      if (waiting) this.sawWaiting = true
      else if (this.sawWaiting) this.cancelRequests()
    }
    // Waiting with no request of Togle's own (it came while Togle was not running, or it is not one the hook tells of): the
    // task says what it waits for, and it is answered on its screen.
    this.waitingFor = waiting && !this.pending.length ? row.waitingFor || 'something' : undefined
    if (row.status === 'busy') this.holdWorkingUntil = 0
    // A task at rest has no program, as one the person stopped has not: but it is Done, and waits for nothing.
    const next = this.rested && !alive ? 'idle' : stateOfJob(row, this.stopped)
    if (next === 'idle' && Date.now() < this.holdWorkingUntil) return
    // A turn that ended is told with what Claude Code said last, before the task is done: the notice shows those words.
    if (next === 'idle' && (this.last === 'working' || this.last === 'waiting')) {
      if (this.settling) return
      this.settling = true
      void this.context
        .said(this.current)
        .then(
          (words) => {
            if (words) this.emit({ type: 'message', text: words })
          },
          () => undefined
        )
        .finally(() => {
          this.settling = false
          if (!this.over) this.set(this.row ? stateOfJob(this.row, this.stopped) : next)
        })
      return
    }
    this.set(next)
  }

  private set(next: TaskState): void {
    this.last = next
    this.setBase(next)
  }

  /** The task was started with words: it works from now, before the list shows it. */
  began(): void {
    this.holdWorkingUntil = Date.now() + BEGIN_MS
    this.lastActive = Date.now()
    this.set('working')
  }

  /**
   * Whether it may be put to rest: its program runs and has nothing to do, no screen of Togle's is open on it, and it waits for
   * nothing, and no command it started still runs and no monitor still watches (ending its program ends those too). Whether it has been
   * quiet long enough, and whether the person has a screen of their own on it, is for the backend.
   */
  get restable(): boolean {
    return !this.over && this.pid !== null && this.state === 'idle' && !this.screenTask && !this.pending.length && !this.waitingFor && !this.shells.length && !this.monitors.length
  }

  /** The time it started, when its row says (in milliseconds): a session that never said a word is not quiet from before it began. */
  get startedAt(): number {
    return typeof this.row?.startedAt === 'number' ? this.row.startedAt : 0
  }

  /**
   * Ends its program because it has done nothing for a long time: they pile up, and each one keeps a program and its memory. The
   * conversation is kept, and the task stays in the list as Done: opening it brings the same session back. False when Claude Code
   * did not end it.
   */
  async rest(): Promise<boolean> {
    if (!this.restable) return false
    const out = await this.context.run(['stop', this.job], this.folder)
    if (!out.ok) return false
    this.rested = true
    this.context.look()
    return true
  }

  /** The row is gone (removed with `claude rm`): the task is over. */
  private async lost(): Promise<void> {
    if (this.over) return
    this.over = true
    this.cancelRequests()
    await this.hide()
    this.emit({ type: 'ended', reason: 'closed' })
    this.context.over(this)
  }

  async permission(event: Record<string, unknown>, gone: AbortSignal): Promise<HookVerdict> {
    const session = text(event.session_id)
    if (session) this.current = session
    // Claude Code shows one question at a time and posts a request as its question is shown: one that comes now means the
    // one before it is over, answered on the screen, and not yet noticed.
    this.cancelRequests()
    const id = `claude-${++this.requests}`
    const { request, rule } = requestOf(id, event, this.folder)
    gone.addEventListener('abort', () => this.dropRequest(id, 'cancelled'), { once: true })
    const asked = this.ask(request)
    this.lastActive = Date.now()
    // Its own wait for the program to say it waits, from the start: what was seen of the one before does not count.
    this.sawWaiting = false
    // A turn that is asked about is a turn at work: its end is told, however quickly the list sees it, and it shows Working once the card is dealt
    // with (answered before the list left idle, the task would fall back to Idle at once, ahead of its words, while it goes on with the command).
    if (this.last === 'idle') this.set('working')
    this.context.look()
    const answer = await asked
    // Dropped (answered on the screen, the task stopped, Togle quit): Claude Code has its answer or decides on its own screen.
    if (answer.kind === 'cancelled') return null
    return verdictOf(answer, request, rule, rec(event.tool_input), text(event.tool_name)).verdict
  }

  // ---- The screen ----

  async show(): Promise<void> {
    if (this.screenTask || this.over) return
    // Opening a session that is stopped brings it back, and a conversation goes on in one program at a time: with a terminal
    // that has it open, it would split in two.
    if (this.pid === null) {
      const elsewhere = await this.context.openElsewhere(this.current)
      if (elsewhere) {
        this.closed = elsewhere
        throw new Error(elsewhere)
      }
    }
    const pty = await loadPty()
    if (!pty) {
      this.closed = 'Togle cannot open a terminal on this computer.'
      throw new Error(`${this.closed} The task goes on: ${this.line} opens it in your own terminal.`)
    }
    this.closed = undefined
    this.lastActive = Date.now()
    const task: AttachScreen = new AttachScreen(
      this.id ?? this.job,
      this.title,
      this.folder,
      openTerminal(pty, this.context.command[0], [...this.context.command.slice(1), 'attach', this.job], this.folder, screenEnv(this.context.env)),
      this.context.told,
      () => this.screenEnded(task),
      `${this.job}-${++this.screens}`
    )
    this.screenTask = task
    this.emit({ type: 'screen', shown: true })
    this.context.look()
  }

  async hide(): Promise<void> {
    const task = this.screenTask
    if (!task) return
    this.screenTask = null
    // The quiet starts when its screen closes.
    this.lastActive = Date.now()
    this.emit({ type: 'screen', shown: false })
    await task.close()
  }

  /** The program of a screen ended: closed here, taken by another window, or the session could not be opened. */
  private screenEnded(task: AttachScreen): void {
    if (this.screenTask !== task) return
    this.screenTask = null
    this.lastActive = Date.now()
    const said = cleanWords(task.read().text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    if (said.some((line) => NOTICED_ELSEWHERE.test(line))) this.closed = 'It is open in another window.'
    // A screen that could not open prints a line or two and ends ("Settings file not found"); one the person closed had
    // printed all of Claude Code's own.
    else if (said.length > 0 && said.length <= 6) this.closed = said.at(-1)?.slice(0, 200)
    this.emit({ type: 'screen', shown: false })
    this.context.look()
  }

  // ---- What the person does ----

  /**
   * A reply from the cards view. Claude Code takes words on its screen only, so the screen is opened out of sight when it is closed,
   * and the words are typed in with Enter, as the person would. While it works its own queue takes them and takes them in as it goes
   * (the same queue as words typed on its screen in Terminal); while it asks or waits on its screen they would answer its question,
   * so they are not typed then (the hub holds them). A reply that starts as a command of its own is refused (see `submit`).
   */
  async send(words: string): Promise<void> {
    if (this.over) throw new Error('That task is over.')
    if (this.state === 'waiting' || this.waitingFor) throw new Error('It waits for you on its screen. Reply when that is answered.')
    refuseCommand(words)
    if (!this.screenTask) await this.show()
    const screen = this.screenTask
    if (!screen) throw new Error(this.closed ?? 'Its screen could not be opened.')
    // A key typed before a screen takes keys is lost (an Esc 0.3 s after an attach was): a screen just opened gets `ESC_AFTER_MS` from its start.
    // A screen at work does not go quiet, so it is not waited on to settle: it is typed on once it has drawn and had a moment. One that only
    // waits on a monitor is quiet, as an idle one is.
    const working = this.state === 'working' && !this.turnOver
    await screen.drawn(working ? undefined : ESC_AFTER_MS)
    if (!working) await screen.settled()
    await screen.submit(words)
    this.began()
  }

  /**
   * Stop, as Esc is on the session's screen in a terminal: the turn it is on ends (and the command it runs, if it runs one), and the
   * session goes on with what it was told. What was queued starts as the next turns: Claude Code does that on Esc, here as in a
   * terminal. The screen is opened out of sight when it is closed, and Esc is pressed once it takes keys (a key that comes before is
   * lost). Nothing is pressed for a session that is not at work (on a prompt with words in it Esc asks to clear them), nor for one that
   * only waits on a monitor (its turn is over: there is nothing for Esc to end, and the monitor goes on), nor twice within `ESC_APART_MS`
   * (two close together open the rewind menu on an idle prompt, which takes the next words as its own). Where the screen cannot be
   * used, the session is ended instead (`end`), and opening it brings it back.
   */
  async stop(): Promise<void> {
    if (this.over) return
    // What it was doing when Stop was pressed: a card of Togle's that waits counts (taking it away changes the state).
    const atWork = (this.state === 'working' && !this.turnOver) || this.state === 'waiting' || !!this.waitingFor
    this.cancelRequests()
    // No program runs, or it has nothing to stop.
    if (this.pid === null || !atWork) return
    if (Date.now() - this.escapedAt < ESC_APART_MS) return
    this.escapedAt = Date.now()
    const screen = await this.screenForKeys(ESC_AFTER_MS)
    if (!screen) {
      this.escapedAt = 0
      await this.end()
      return
    }
    screen.write('\x1b')
    this.escapedAt = Date.now()
    this.lastActive = Date.now()
    this.context.look()
  }

  /**
   * Gives the queue back, as the Up arrow does on the screen in a terminal: all that was typed while the session works comes out of its queue
   * into its prompt, and the prompt is emptied again, so that the words are the person's to change in Chat. The screen is opened out of sight
   * when it is closed, and the queue is read (`read`) once it takes keys, so that the arrow follows what waits then. The arrow is believed
   * only when the record shows it: words that left the queue and are not words the turn took in are the ones that came back, and only those
   * are returned. When none did, Down puts back what the arrow did (see UP_KEY) and the person is told, with nothing changed. Nothing is
   * pressed for a session that is over, one that has nothing queued, or one that waits on its screen for a question or a permission (the
   * arrow would move its choice).
   */
  async takeBackQueue(read: () => Promise<QueueRecord>): Promise<string[]> {
    if (this.over) throw new Error('That task is over.')
    if (this.state === 'waiting' || this.waitingFor) throw new Error('It waits for you on its screen. Take the queue back when that is answered.')
    const screen = await this.screenForKeys(ESC_AFTER_MS)
    if (!screen) throw new Error(this.closed ?? 'Its screen could not be opened.')
    const first = await read()
    if (!first.queued.length) return []
    screen.write(UP_KEY)
    let given: string[] = []
    for (let waited = 0; waited < POP_CONFIRM_MS && !given.length; waited += 150) {
      await new Promise((resolve) => setTimeout(resolve, 150))
      const now = await read()
      const tookIn = gained(now.said, first.said)
      given = first.queued.filter((words) => !now.queued.includes(words) && !tookIn.has(words))
    }
    this.lastActive = Date.now()
    this.context.look()
    if (!given.length) {
      screen.write(DOWN_KEY)
      throw new Error('Claude Code did not give its queue back: it may have taken it in by then. Nothing was changed.')
    }
    await typeApart((keys) => screen.write(keys), clearKeys(first.queued))
    return given
  }

  /**
   * The screen, opened out of sight when it is closed and given `settleMs` from its start to take keys; null when it cannot be used
   * (it did not open, or it ended meanwhile: another window took the session).
   */
  private async screenForKeys(settleMs: number): Promise<AttachScreen | null> {
    if (!this.screenTask) {
      try {
        await this.show()
      } catch {
        return null
      }
    }
    const screen = this.screenTask
    if (!screen) return null
    await screen.drawn(settleMs)
    return this.screenTask === screen ? screen : null
  }

  /** Ends the session and the commands it runs (`claude stop`). Its conversation is kept: opening its screen brings it back. */
  private async end(): Promise<void> {
    this.stopped = true
    this.cancelRequests()
    const out = await this.context.run(['stop', this.job], this.folder)
    // Not stopped, and still running as far as Togle knows: it was not done, and the person is told.
    if (!out.ok && this.pid !== null) {
      this.stopped = false
      throw new Error(`Claude Code could not stop it: ${out.text.split(/\r?\n/)[0] ?? 'no reason given'}`)
    }
    // Its screen is a client of the session that is gone: it closes, and opening the screen again brings the session back.
    await this.hide()
    this.set('stopped')
    this.context.look()
  }

  /** Ends the session and what it started, the commands it runs in the background too (Esc, which is Stop, does not end those). */
  async endCommands(): Promise<number> {
    await this.end()
    return 1
  }

  /** Lets go of the screen and of what waits. The session goes on, and Togle hears it again when it asks. */
  async close(): Promise<void> {
    this.cancelRequests()
    await this.hide()
  }
}
