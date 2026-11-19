// Claude Code on this computer. Togle runs each task as one of Claude Code's own background sessions (`claude --bg`) and
// opens its screen when someone looks at it (`claude attach`, in a terminal of Togle's own): the person has the program
// they know, with its keys, its commands and its questions, and the task goes on when the screen is closed and when Togle
// quits. It never touches Claude Code's sign-in: the program is the one the person installed and signed in. What each
// command does is in claude-job.ts, and how Togle hears what a session asks is in claude-hooks.ts.
//
// Opened by what the list says of it, never by guessing:
// - a session in the background, running or stopped: its screen is opened (`attach` brings a stopped one back);
// - one the person has open in a terminal of their own: Togle ends that program first (the hub does) and goes on with the
//   same conversation in the background, as the same session;
// - one only kept on disk: the same, with `--bg --resume`.
// A conversation has one program at a time: when Claude Code says it "started a copy", Togle ends the copy and fails the
// open in words, and never goes on with a second session under the same task.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { StepDetail, TaskHistory, TaskInfo } from '@shared/runner'
import { claudeChange, claudeConversation, claudeHasSession, claudeLastSaid, claudePicture, claudeSessions, claudeStep, claudeWrittenAt } from './claude-sessions'
import { HookServer, type HookTarget } from './claude-hooks'
import { ClaudeJob, claudeEnv, isJob, rowOf, stateOfJob, type AgentRow, type JobContext, type JobRow } from './claude-job'
import { claudeConfigDir, withShells } from './claude-registry'
import { oneLine } from './claude-requests'
import { list, rec } from './jsonrpc'
import { listProcesses } from './process-tree'
import { detailOf, diffOf, isFileKey } from './step-detail'
import { loadPty, type TerminalChunk } from './terminal'
import type { Backend, Detected, ResumeOptions, StartOptions, TaskHandle } from './types'

/** A session Claude Code kept on this computer. */
export interface StoredSession {
  id: string
  title: string
  /** What was asked first, when the title is something else (claude-sessions.ts). */
  asked?: string
  cwd: string
  updatedAt: number
}

export interface ClaudeOptions {
  /** What starts Claude Code, before its flags. Found on this computer when left out. */
  command?: string[]
  env?: NodeJS.ProcessEnv
  /** The sessions it lists: `claude agents --json --all` when left out. */
  live?: () => Promise<AgentRow[]>
  /** The sessions it kept, as files under ~/.claude/projects. Read from there when left out. */
  stored?: () => Promise<StoredSession[]>
  /** Where what its screens print goes, for the window. Required: a screen whose words are not told shows only what it had printed when it was opened. */
  told: (chunk: TerminalChunk) => void
  /**
   * A folder of Togle's own, where the address Claude Code posts to, each task's settings file and the list of tasks stay
   * between runs: tasks that went on while Togle was closed are heard again. Without one, nothing is kept.
   */
  keep?: string
  /** What a session said last: read from its file when left out. */
  said?: (session: string) => Promise<string>
  /** A session's conversation, for the Chat view: read from its file when left out. */
  conversation?: (session: string, all: boolean) => Promise<TaskHistory | null>
  /** How long a task that Togle runs may do nothing before it is put to rest, in milliseconds: a day when left out. */
  restMs?: number
  /** When a session was last written (its file's time): read from the file when left out. */
  written?: (session: string) => Promise<number | undefined>
  /** How often the sessions are looked at, in milliseconds: while one works, waits or is shown, and otherwise. */
  every?: { busy: number; idle: number }
}

const exec = (file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }): Promise<{ ok: boolean; text: string; out: string }> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeout ?? 15_000, maxBuffer: 16 * 1024 * 1024, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: options.env } : {}) }, (error, stdout, stderr) =>
      resolve({ ok: !error, text: `${stdout}${stderr}`.trim(), out: String(stdout) })
    )
  })

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

const firstLine = (text: string): string => text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''

/** The program that starts Claude Code, or null when it is not on this computer. `TOGLE_CLAUDE_PATH` names it by hand. */
export async function findClaude(): Promise<string | null> {
  const forced = process.env.TOGLE_CLAUDE_PATH
  if (forced && (await exists(forced))) return forced
  const found = (await exec(process.platform === 'win32' ? 'where' : 'which', ['claude'], {})).out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (process.platform !== 'win32') return found[0] ?? null
  const exe = found.find((file) => /\.exe$/i.test(file))
  if (exe) return exe
  // npm's claude.cmd shim: Node cannot start it without a shell, so the program it starts is used.
  for (const file of found.filter((f) => /\.(cmd|bat)$/i.test(f))) {
    const native = path.join(path.dirname(file), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')
    if (await exists(native)) return native
  }
  return null
}

async function storedSessions(): Promise<StoredSession[]> {
  return (await claudeSessions(100)).map((session) => ({ id: session.id, title: session.title, ...(session.asked ? { asked: session.asked } : {}), cwd: session.cwd ?? '', updatedAt: session.updatedAt }))
}

/** A task Togle ran and that goes on without it: what is needed to hear it and to open it again. */
interface Known {
  /** The id its screen is opened with. */
  job: string
  /** The session it was first known by: the task's own id. */
  id: string
  /** Its hook address, when Togle gave it one. */
  key?: string
  folder: string
  title: string
  asks: boolean
}

const KNOWN = 'jobs.json'
/** The most words a task is started with: a Windows command line holds about 32,000 characters. */
const MOST_WORDS = 20_000
/** How long a task Togle runs may do nothing before it is put to rest, and how often one that was looked at is looked at again. */
const REST_MS = 24 * 3600_000
const LOOK_AGAIN_MS = 60_000
const STILL_OPEN = 'It is still open in a terminal. End that Claude Code first: a conversation goes on in one program at a time.'
const BACKGROUNDED = /backgrounded\s+·\s+([0-9a-f]{8})/
const COPY = /started a copy as ([0-9a-f]{8})/

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The words for a start Claude Code refused, in the person's terms. */
function refusal(text: string, folder: string): string {
  if (/workspace not trusted/i.test(text)) return `Claude Code has not been opened in ${folder} yet, and it asks once whether to trust a folder. Run claude there, say yes, and start the task again.`
  const said = firstLine(text.replace(/^error:\s*/i, ''))
  return `Claude Code could not start the task in the background${said ? `: ${said.slice(0, 200)}` : '.'}`
}

export class ClaudeBackend implements Backend {
  readonly runner = 'claude' as const
  readonly screens = true
  private readonly hooks: HookServer
  /** The tasks being run: by the id its screen is opened with. */
  private readonly jobs = new Map<string, ClaudeJob>()
  private readonly known = new Map<string, Known>()
  private adopt?: (task: TaskHandle) => void
  private rowsAt: { at: number; rows: AgentRow[] } | null = null
  private asking: Promise<AgentRow[]> | null = null
  private timer: NodeJS.Timeout | null = null
  private soon: NodeJS.Timeout | null = null
  private closed = false
  private loaded?: Promise<void>
  private resolved?: Promise<JobContext>
  private background?: Promise<string | undefined>

  constructor(private readonly options: ClaudeOptions) {
    this.hooks = new HookServer(options.keep)
  }

  private async command(): Promise<string[]> {
    if (this.options.command?.length) return this.options.command
    const found = await findClaude()
    if (!found) throw new Error('Claude Code is not installed on this computer.')
    return [found]
  }

  private context(): Promise<JobContext> {
    this.resolved ??= this.command().then((command) => ({
      command,
      env: this.options.env ?? process.env,
      told: this.options.told,
      run: (args, cwd) => this.run(command, args, cwd),
      look: () => this.look(),
      said: (session) => (this.options.said ?? claudeLastSaid)(session),
      over: (job) => void this.finished(job),
      openElsewhere: async (session) => {
        const open = (await this.rows(0, true).catch(() => [] as AgentRow[])).find((row) => row.sessionId === session && row.kind !== 'background' && row.pid)
        return open?.pid && alive(open.pid) ? STILL_OPEN : undefined
      }
    }))
    this.resolved.catch(() => { this.resolved = undefined })
    return this.resolved
  }

  private async run(command: string[], args: string[], cwd: string): Promise<{ ok: boolean; text: string }> {
    const { ok, text } = await exec(command[0], [...command.slice(1), ...args], { cwd, env: claudeEnv(this.options.env ?? process.env), timeout: 60_000 })
    return { ok, text }
  }

  async detect(): Promise<Detected> {
    const command = this.options.command?.length ? this.options.command : [await findClaude()].filter((found): found is string => !!found)
    if (!command.length) return { installed: false }
    const version = firstLine((await exec(command[0], [...command.slice(1), '--version'], { env: claudeEnv(this.options.env ?? process.env) })).out)
    return { installed: true, command: command[0], ...(version ? { version } : {}) }
  }

  /** Why Claude Code cannot run a task in the background here, in words, or nothing when it can. */
  private cannotRunInBackground(): Promise<string | undefined> {
    this.background ??= (async () => {
      const command = await this.command()
      const help = await exec(command[0], [...command.slice(1), '--help'], { env: claudeEnv(this.options.env ?? process.env) })
      return !help.ok || /--bg\b/.test(help.text) ? undefined : 'This version of Claude Code cannot run a task in the background. Update it, and Togle will use it.'
    })()
    return this.background
  }

  // ---- What Claude Code lists ----

  /**
   * The sessions as Claude Code lists them. Asked at most once at a time, and reused for `maxAge` milliseconds. A list that
   * must be fresh (what decides whether a conversation may be opened) is never one that was asked before the call.
   */
  private async rows(maxAge = 0, fresh = false): Promise<AgentRow[]> {
    if (!fresh && this.rowsAt && Date.now() - this.rowsAt.at <= maxAge) return this.rowsAt.rows
    if (fresh && this.asking) await this.asking.catch(() => undefined)
    this.asking ??= (async () => {
      try {
        let rows: AgentRow[]
        if (this.options.live) rows = await this.options.live()
        else {
          const command = await this.command()
          const out = await exec(command[0], [...command.slice(1), 'agents', '--json', '--all'], { env: claudeEnv(this.options.env ?? process.env) })
          if (!out.ok) throw new Error(firstLine(out.text) || 'Claude Code did not list its sessions.')
          // What the list calls busy while only a command in the background runs is told apart by the program's own record (claude-registry.ts).
          rows = await withShells(claudeConfigDir(this.options.env ?? process.env), list(JSON.parse(out.out) as unknown).map(rec).map(rowOf))
        }
        this.rowsAt = { at: Date.now(), rows }
        return rows
      } finally {
        this.asking = null
      }
    })()
    return this.asking
  }

  async list(): Promise<TaskInfo[]> {
    await this.ready()
    const rows = await this.rows(1_500).catch(() => [] as AgentRow[])
    const stored = await (this.options.stored ?? storedSessions)().catch(() => [] as StoredSession[])
    const found = new Map<string, TaskInfo>()
    for (const session of stored) found.set(session.id, { id: session.id, runner: 'claude', title: session.title, ...(session.asked ? { asked: session.asked } : {}), folder: session.cwd, state: 'idle', updatedAt: session.updatedAt })
    // One session can be listed twice: as a background session that was stopped, and as the program in a terminal that has
    // it open now. The program that runs is the one to take over, and the background session is the one that opens after.
    for (const row of [...rows.filter(isJob), ...rows.filter((candidate) => !isJob(candidate))]) {
      if (!row.sessionId) continue
      const before = found.get(row.sessionId)
      const job = isJob(row)
      // Claude Code names a session it resumed by its id, which is no name.
      const named = row.name && row.name !== row.id && !/^[0-9a-f]{8}$/.test(row.name) ? row.name : ''
      found.set(row.sessionId, {
        id: row.sessionId,
        runner: 'claude',
        title: before?.title || (job ? this.known.get(row.id)?.title : '') || named || path.basename(row.cwd ?? '') || 'Claude Code task',
        ...(before?.asked ? { asked: before.asked } : {}),
        folder: row.cwd ?? before?.folder ?? '',
        state: stateOfJob(row),
        updatedAt: before?.updatedAt ?? row.startedAt ?? 0,
        // A task in the background has no program of its own to take over: its screen is opened.
        ...(row.pid && !job ? { pid: row.pid } : {}),
        ...(job ? { job: row.id } : before?.job ? { job: before.job } : {}),
        ...(row.status === 'waiting' && row.waitingFor ? { waitingFor: row.waitingFor } : {}),
        ...(row.shells?.length ? { shells: row.shells } : {})
      })
    }
    for (const task of this.jobs.values()) {
      if (!task.id) continue
      // After "/clear" Claude Code keeps the task in another session: that one is this task, and not a second row.
      if (task.session() !== task.id) found.delete(task.session())
      const before = found.get(task.id)
      found.set(task.id, { id: task.id, runner: 'claude', title: task.title || before?.title || 'Claude Code task', ...(before?.asked ? { asked: before.asked } : {}), folder: task.folder || before?.folder || '', state: task.state, updatedAt: before?.updatedAt ?? Date.now(), job: task.screen.job, ...(before?.pid ? { pid: before.pid } : {}), ...(task.waitingFor ? { waitingFor: task.waitingFor } : {}), ...(task.shells.length ? { shells: [...task.shells] } : {}) })
    }
    return [...found.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  // ---- Starting and opening ----

  async start(options: StartOptions): Promise<TaskHandle> {
    const problem = await this.cannotRunInBackground()
    if (problem) throw new Error(problem)
    // The words go in the command that starts it, and a command line is only so long.
    if (options.prompt.length > MOST_WORDS) throw new Error('That is too long to start a task with. Put the words in a file, and ask the task to read it.')
    await this.ready()
    const context = await this.context()
    const asks = options.asks ?? false
    const title = options.title ?? oneLine(options.prompt)
    const hook = await this.hooks.attach(this.waiting(), asks)
    let job: string
    try {
      job = (await this.backgrounded(context, ['--bg', '--settings', hook.settings, ...(title ? [`--name=${title}`] : []), ...(options.prompt ? ['--', options.prompt] : [])], options.folder)).job
    } catch (error) {
      await this.hooks.forget(hook.key)
      throw error
    }
    const row = await this.appears(job)
    const task = this.make(context, row, { key: hook.key, title, folder: options.folder })
    this.hooks.retarget(hook.key, task)
    await this.remember({ job, id: task.id as string, key: hook.key, folder: options.folder, title, asks })
    if (options.prompt) task.began()
    // A screen that cannot open does not undo the task: it goes on, and its screen says why it is closed.
    await task.show().catch(() => undefined)
    return task
  }

  async resume(id: string, options: ResumeOptions = {}): Promise<TaskHandle> {
    await this.ready()
    const context = await this.context()
    const rows = await this.rows(0, true)
    // What the list says decides how it opens: a session in the background has its screen opened, whatever its state.
    const row = rows.filter(isJob).find((candidate) => (options.job ? candidate.id === options.job : candidate.sessionId === id))
    if (options.job && !row) throw new Error('That task is gone.')
    // A conversation goes on in one program at a time: one open in a terminal is ended first (by the hub, with the person's
    // yes), or this would split the saved conversation in two.
    const open = rows.find((candidate) => candidate.sessionId === (row?.sessionId ?? id) && candidate.kind !== 'background' && candidate.pid)
    if (open?.pid && alive(open.pid)) throw new Error(STILL_OPEN)
    let task = row ? this.jobs.get(row.id) : undefined
    if (row && !task) task = this.take(context, row, options.folder)
    task ??= await this.begin(context, id, options)
    await task.show()
    return task
  }

  /**
   * Why Claude Code's own screen cannot be opened for a session here, in words, or nothing when it can: asked before a
   * program the person is using is ended for it.
   */
  async screenProblem(id: string): Promise<string | undefined> {
    const problem = await this.cannotRunInBackground().catch(() => undefined)
    if (problem) return problem
    if (!(await loadPty())) return 'Togle cannot open a terminal on this computer, so the Claude Code in its terminal was left as it is.'
    // A session that has had no message has no conversation to open: it was left as it is, and can be used where it is.
    const kept = this.options.stored ? (await this.options.stored().catch(() => [])).some((session) => session.id === id) : await claudeHasSession(id)
    return kept ? undefined : 'This Claude Code has not had a message yet, so there is no conversation to open here. It was left as it is.'
  }

  /** A session's conversation as its file keeps it: what the Chat view shows, also of what was said before Togle opened it. */
  history(id: string, all: boolean): Promise<TaskHistory | null> {
    return (this.options.conversation ?? claudeConversation)(id, all)
  }

  /** A picture the person put in that conversation (pasted, a screenshot), read again from the session's file. */
  picture(id: string, key: string): Promise<{ type: string; data: string } | null> {
    return claudePicture(id, key)
  }

  /** What a step of that conversation holds (what a command printed, a thought's words, how a file changed), read again from the session's file. */
  async step(id: string, more: string): Promise<StepDetail | null> {
    if (isFileKey(more)) return diffOf(await claudeChange(id, more).catch(() => null))
    return detailOf(await claudeStep(id, more).catch(() => null))
  }

  /** A session that is not in the background yet goes there, as the same session. */
  private async begin(context: JobContext, id: string, options: ResumeOptions): Promise<ClaudeJob> {
    const problem = await this.cannotRunInBackground()
    if (problem) throw new Error(problem)
    // A session id is a UUID: anything else could be read as a flag.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('That is not a session Claude Code knows.')
    const info = (await this.list()).find((task) => task.id === id)
    const folder = options.folder ?? info?.folder ?? os.homedir()
    const hook = await this.hooks.attach(this.waiting(), false)
    let started: { job: string; copy: boolean }
    try {
      started = await this.backgrounded(context, ['--bg', '--resume', id, '--settings', hook.settings, ...(options.flags ?? [])], folder)
    } catch (error) {
      await this.hooks.forget(hook.key)
      throw error
    }
    // The same session, or none: a second session under the one task would split the conversation in two.
    const copied = async (): Promise<never> => {
      await this.discard(context, started.job, folder)
      await this.hooks.forget(hook.key)
      throw new Error('Claude Code started a copy of that conversation instead of going on with it, so the copy was ended and nothing was changed.')
    }
    if (started.copy) return copied()
    const row = await this.appears(started.job)
    if (row.sessionId !== id) return copied()
    const title = info?.title ?? ''
    const task = this.make(context, row, { key: hook.key, title, folder })
    this.hooks.retarget(hook.key, task)
    await this.remember({ job: started.job, id, key: hook.key, folder, title, asks: false })
    return task
  }

  /** Runs `claude --bg ...` and says which session it made. Claude Code's refusal is told in words. */
  private async backgrounded(context: JobContext, args: string[], folder: string): Promise<{ job: string; copy: boolean }> {
    const out = await context.run(args, folder)
    const job = BACKGROUNDED.exec(out.text)?.[1]
    if (!out.ok || !job) throw new Error(refusal(out.text, folder))
    const copy = COPY.exec(out.text)?.[1]
    return { job: copy ?? job, copy: !!copy }
  }

  /** A session Claude Code started appears in its list a moment later. */
  private async appears(job: string): Promise<JobRow & { sessionId: string }> {
    for (let waited = 0; waited < 20_000; waited += 300) {
      const row = (await this.rows(0).catch(() => [] as AgentRow[])).filter(isJob).find((candidate) => candidate.id === job)
      if (row?.sessionId) return { ...row, sessionId: row.sessionId }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error('Claude Code started the task, but it did not show in its list. Open the Agents list again in a moment.')
  }

  private async discard(context: JobContext, job: string, folder: string): Promise<void> {
    await context.run(['stop', job], folder)
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    await context.run(['rm', job], folder)
  }

  // ---- Tasks ----

  /** The task a hook key is for, found when something asks: a session that went on while Togle was closed, or was opened again. */
  private slot(job: string): HookTarget {
    return {
      permission: async (event, gone) => {
        const task = await this.hearing(job)
        return task ? task.permission(event, gone) : null
      }
    }
  }

  /** For a key made before its task is: nothing is decided until the task is there. */
  private waiting(): HookTarget {
    return { permission: () => Promise.resolve(null) }
  }

  private async hearing(job: string): Promise<ClaudeJob | undefined> {
    const have = this.jobs.get(job)
    if (have) return have
    const row = (await this.rows(0).catch(() => [] as AgentRow[])).filter(isJob).find((candidate) => candidate.id === job)
    if (!row) return undefined
    const task = this.take(await this.context(), row)
    this.adopt?.(task)
    return task
  }

  /** A session in the background that Togle takes up: one it ran before, or one the person started themselves (which has no hook to hear it by). */
  private take(context: JobContext, row: JobRow, folder?: string): ClaudeJob {
    const known = this.known.get(row.id)
    const named = row.name && row.name !== row.id && !/^[0-9a-f]{8}$/.test(row.name) ? row.name : ''
    return this.make(context, row, { key: known?.key, title: known?.title || named || path.basename(row.cwd ?? folder ?? '') || 'Claude Code task', folder: row.cwd ?? known?.folder ?? folder ?? os.homedir(), id: known?.id })
  }

  private make(context: JobContext, row: JobRow, task: { key?: string; title: string; folder: string; id?: string }): ClaudeJob {
    const job = new ClaudeJob(context, row.id, task.id ?? row.sessionId ?? row.id, task.title, task.folder, task.key)
    this.jobs.set(row.id, job)
    job.seen(row)
    this.ticking()
    return job
  }

  /** Picks up the tasks Togle ran before and that went on without it, and listens for the ones that ask later. */
  async restore(adopt: (task: TaskHandle) => void): Promise<void> {
    this.adopt = adopt
    await this.ready()
    let rows: AgentRow[]
    try {
      rows = await this.rows(0)
    } catch {
      // Claude Code could not list its sessions now: what Togle knows of them is kept.
      return
    }
    const context = await this.context().catch(() => undefined)
    if (!context) return
    for (const known of [...this.known.values()]) {
      const row = rows.filter(isJob).find((candidate) => candidate.id === known.job)
      if (!row) {
        await this.dismiss(known)
        continue
      }
      // The same address, its settings file written again: a session that comes back from a stop reads it once more.
      if (known.key) await this.hooks.attach(this.slot(known.job), known.asks, known.key)
      if (row.pid) adopt(this.take(context, row))
    }
    this.ticking()
  }

  // ---- Looking at the sessions ----

  private ticking(): void {
    if (this.timer || this.closed) return
    const busy = [...this.jobs.values()].some((job) => job.state === 'working' || job.state === 'waiting' || job.open)
    const every = this.options.every ?? { busy: 1_500, idle: 5_000 }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.tick()
    }, busy ? every.busy : every.idle)
    this.timer.unref?.()
  }

  /** Something changed: the sessions are looked at in a moment, and not once for each change. */
  private look(): void {
    if (this.soon || this.closed) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.tick()
    }, 150)
    this.soon.unref?.()
  }

  private async tick(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.closed) return
    try {
      const rows = (await this.rows(0)).filter(isJob)
      for (const task of [...this.jobs.values()]) task.seen(rows.find((row) => row.id === task.job))
      await this.rest()
      // A task of Togle's that came back to life (the person opened it in their own terminal) is Togle's again.
      for (const known of this.known.values()) {
        const row = rows.find((candidate) => candidate.id === known.job)
        if (row?.pid && !this.jobs.has(known.job)) {
          const task = this.take(await this.context(), row)
          this.adopt?.(task)
        }
      }
    } catch {
      // The list could not be asked now: the next look tries again, and nothing is taken for gone.
    }
    if (this.jobs.size || this.known.size) this.ticking()
  }

  /**
   * A task Togle runs that has done nothing for a day is put to rest: its program ends and its conversation stays, the task is still
   * Done in the list, and opening it brings the same session back. Without this each task Togle ever started would keep a program
   * and its memory. Only a task that is idle, with no screen of Togle's open on it and no `claude attach` of the person's own in a
   * terminal: ending that would end their screen under them. Quiet is counted from the latest of what Togle saw the task do, when it
   * started, and when its file was last written, which a restart of Togle does not change.
   */
  private async rest(): Promise<void> {
    const limit = this.options.restMs ?? REST_MS
    const again = Math.min(LOOK_AGAIN_MS, limit)
    for (const task of [...this.jobs.values()]) {
      const now = Date.now()
      if (!task.restable || now - task.restTried < again) continue
      const seen = Math.max(task.lastActive, task.startedAt)
      if (now - seen < limit) continue
      task.restTried = now
      try {
        const written = await (this.options.written ?? claudeWrittenAt)(task.session()).catch(() => undefined)
        if (now - Math.max(seen, written ?? 0) < limit) continue
        if (await this.attachedElsewhere(task.job)) continue
        await task.rest()
      } catch {
        // Not put to rest this time: it is looked at again later, and nothing is lost.
      }
    }
  }

  /** Whether a terminal of the person's own has the session open (`claude attach <id>`). */
  private async attachedElsewhere(job: string): Promise<boolean> {
    const attach = new RegExp(`\\battach\\s+${job}\\b`)
    return (await listProcesses().catch(() => [])).some((program) => attach.test(program.command))
  }

  // ---- What is kept between runs ----

  private ready(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.options.keep) return
      try {
        const saved = rec(JSON.parse(await fs.readFile(path.join(this.options.keep, KNOWN), 'utf8')) as unknown)
        for (const item of list(saved.jobs).map(rec)) {
          const job = typeof item.job === 'string' ? item.job : ''
          const id = typeof item.id === 'string' ? item.id : ''
          if (!/^[0-9a-f]{8}$/.test(job) || !id) continue
          this.known.set(job, { job, id, ...(typeof item.key === 'string' && /^[0-9a-f]{16}$/.test(item.key) ? { key: item.key } : {}), folder: typeof item.folder === 'string' ? item.folder : '', title: typeof item.title === 'string' ? item.title : '', asks: item.asks === true })
        }
      } catch {
        // Nothing was kept yet, or what was kept cannot be read: Togle starts without it.
      }
    })()
    return this.loaded
  }

  private async remember(known: Known): Promise<void> {
    this.known.set(known.job, known)
    await this.save()
  }

  private async save(): Promise<void> {
    const keep = this.options.keep
    if (!keep) return
    const file = path.join(keep, KNOWN)
    const temp = `${file}.${process.pid}.tmp`
    try {
      await fs.mkdir(keep, { recursive: true })
      await fs.writeFile(temp, JSON.stringify({ jobs: [...this.known.values()] }), { mode: 0o600 })
      await fs.rename(temp, file)
    } catch {
      // Not kept this time: the task goes on, and is found again from Claude Code's own list.
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }

  /** The session is gone for good (removed with `claude rm`): nothing of it is kept. */
  private async dismiss(known: Known): Promise<void> {
    this.known.delete(known.job)
    if (known.key) await this.hooks.forget(known.key)
    await this.save()
  }

  private async finished(job: ClaudeJob): Promise<void> {
    this.jobs.delete(job.job)
    const known = this.known.get(job.job)
    if (known) await this.dismiss(known)
  }

  /** Stops using Claude Code. The tasks go on in the background: only their screens close here, and what waits is left to their own screens. */
  async close(): Promise<void> {
    this.closed = true
    for (const timer of [this.timer, this.soon]) if (timer) clearTimeout(timer)
    this.timer = null
    this.soon = null
    await Promise.all([...this.jobs.values()].map((task) => task.close()))
    await this.hooks.close()
  }
}
