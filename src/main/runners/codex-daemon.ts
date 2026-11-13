// Codex's shared server, controlled from here: is it running, and start it. Codex keeps one server per computer (its
// "daemon") that every Codex screen joins, and that goes on with the work when a screen closes. A plain `codex` starts it when it
// is not running, so starting it here is nothing Codex does not do on its own; the server also keeps itself up to date: it may
// fetch a new release (hundreds of megabytes) and restart.
//
// What Codex 0.169 on Windows does, which this follows:
// - `codex app-server daemon version` prints one line of JSON (`status: "running"`, versions, the socket's path) when the server
//   answers, and fails with "failed to connect to … refused it" when nothing runs.
// - `codex app-server daemon start` starts it detached and prints one line of JSON with its process id; its progress goes to
//   the error output as JSON lines, and a failure is an `Error:` line.
// - The server is a `codex app-server --listen unix:// … --managed-daemon` process.
import { execFile } from 'node:child_process'
import { listProcesses } from './process-tree'

export interface DaemonState {
  running: boolean
  /** The version of the server that runs, as Codex says it. */
  version?: string
}

interface Out {
  ok: boolean
  out: string
  err: string
  /** Why the program could not be run at all (it is not there), when that is why. */
  launch?: string
}

const exec = (file: string, args: string[], env: NodeJS.ProcessEnv | undefined, timeout: number): Promise<Out> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, ...(env ? { env } : {}) }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code
      resolve({ ok: !error, out: String(stdout), err: String(stderr), ...(typeof code === 'string' && /^(ENOENT|EACCES|EPERM)$/.test(code) ? { launch: error?.message ?? code } : {}) })
    })
  })

/** The first line of JSON a program printed, or an empty object. */
function jsonLine(out: string): Record<string, unknown> {
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue
    try {
      const value = JSON.parse(line) as unknown
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>
    } catch {
      // not JSON: the next line
    }
  }
  return {}
}

/** Why a command failed, in words: its own `Error:` line, else the first line it printed that is not progress. */
function whyNot(out: Out): string {
  const lines = `${out.err}\n${out.out}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('{'))
  const error = lines.find((line) => /^Error:/i.test(line))
  return (error ?? lines[0] ?? 'it gave no reason').replace(/^Error:\s*/i, '').slice(0, 240)
}

/** Whether the shared server answers now. Starts nothing. */
export async function daemonState(command: string[], env?: NodeJS.ProcessEnv): Promise<DaemonState> {
  const out = await exec(command[0], [...command.slice(1), 'app-server', 'daemon', 'version'], env, 20_000)
  if (!out.ok) return { running: false }
  const told = jsonLine(out.out)
  const version = typeof told.appServerVersion === 'string' ? told.appServerVersion : undefined
  return { running: told.status === 'running', ...(version ? { version } : {}) }
}

/** Starts the shared server when it is not running, and waits until it answers. Says in words why it could not. */
export async function startDaemon(command: string[], env?: NodeJS.ProcessEnv): Promise<DaemonState> {
  const now = await daemonState(command, env)
  if (now.running) return now
  const out = await exec(command[0], [...command.slice(1), 'app-server', 'daemon', 'start'], env, 120_000)
  if (out.launch) throw new Error(`Codex did not start: ${out.launch.split(/\r?\n/)[0]}`)
  if (!out.ok) throw new Error(`Codex's shared server did not start: ${whyNot(out)}`)
  for (let waited = 0; waited < 20_000; waited += 500) {
    const state = await daemonState(command, env)
    if (state.running) return state
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('Codex started its shared server, but it did not answer.')
}

/** The process that is Codex's shared server, when one runs here: what the commands of a thread are started below. */
export async function daemonPid(): Promise<number | null> {
  const found = (await listProcesses()).filter((proc) => /\bapp-server\b/.test(proc.command) && /--managed-daemon\b/.test(proc.command) && /--listen\b/.test(proc.command))
  // The one the others are not below: a server does not start another.
  const top = found.find((proc) => !found.some((other) => other.pid === proc.ppid))
  return top?.pid ?? null
}
