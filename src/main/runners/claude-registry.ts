// What Claude Code keeps of a live session's work in its own folder, which `claude agents --json` does not tell (looked at on 2.1.328):
// - `sessions/<pid>.json` is the record of a running program. Its `status` is busy, idle or waiting, and `shell` when the turn ended and
//   a command it started in the background still runs. `claude agents --json` calls that one `busy` too.
// - `jobs/<job>/state.json` is a background session's job: its `tempo` ("active", or "idle" while only a shell runs) and the `fan` of what
//   it started, the shells among them (`kind: "shell"`, the command as `label`, `startedAt`) and the monitors (`kind: "monitor"`, the
//   description as `label`: Claude Code's Monitor tool, which says something to the session when there is something). An item leaves the
//   `fan` when it ends. With the turn over and a monitor and a shell in it, the tempo is idle and the program's record says `shell` (seen on
//   2.1.328); the `fan` is what tells a monitor from a shell. A session that has a monitor is busy whatever the record says: the record and
//   the tempo only tell whether its turn is over.
// So a task whose turn had ended, with a shell still running, was shown as working: what was typed in Chat was held for a turn that was
// over, the notice that the turn ended never came, and nothing said what ran. And one that waited on a monitor was shown as plain Idle,
// with nothing said of what it waited for.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BackgroundShell } from '@shared/runner'
import { isJob, type AgentRow } from './claude-job'
import { oneLine } from './claude-requests'
import { withoutSecrets } from './claude-sessions'
import { list, rec, text } from './jsonrpc'

/** Where Claude Code keeps its own files: where its program is told to (CLAUDE_CONFIG_DIR), else ~/.claude. */
export const claudeConfigDir = (env: NodeJS.ProcessEnv): string => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

async function readObject(file: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** What a job's state file lists of one kind that still runs: `shell` (a command) or `monitor` (a watch that tells its agent when there is something). */
function runningOf(state: Record<string, unknown> | null, kind: 'shell' | 'monitor'): BackgroundShell[] {
  return list(state?.fan).flatMap((item): BackgroundShell[] => {
    const entry = rec(item)
    // One that has finished is not running: a finished item stays in the file with a doneAt (0 when its time is not told), and one still
    // running has none. Its command can hold a key or a password: it is shown without them, as every command of a task is.
    if (entry.kind !== kind || typeof entry.doneAt === 'number') return []
    const label = oneLine(withoutSecrets(text(entry.label)), 300)
    const since = typeof entry.startedAt === 'number' && entry.startedAt > 0 ? entry.startedAt : undefined
    return [{ id: text(entry.id) || label, label, ...(since ? { since } : {}) }]
  })
}

/** The commands a job started that still run, by its state file. */
export const shellsOf = (state: Record<string, unknown> | null): BackgroundShell[] => runningOf(state, 'shell')

/** The monitors a job started that still run (`kind: "monitor"`, the description as `label`), by its state file. */
export const monitorsOf = (state: Record<string, unknown> | null): BackgroundShell[] => runningOf(state, 'monitor')

/**
 * The rows `claude agents --json` gave, with what the program's own record adds: a session that is idle while a command it started
 * runs has the status `shell` (the list said busy), and the commands that run are its `shells`. A monitor it started that still runs
 * is `monitors`, and the session is not idle then: its agent goes on by itself when the monitor says something (it said "waiting on the
 * CI runs" and ended its turn), so it stays busy, as the list says; when its turn is over (`turnOver`) only the monitor keeps it busy,
 * and there is no turn for Stop to end. A row is left as it was when the files cannot be read (another version of Claude Code, or
 * none of its files at hand).
 */
export async function withShells(home: string, rows: AgentRow[]): Promise<AgentRow[]> {
  return Promise.all(
    rows.map(async (row) => {
      if (typeof row.pid !== 'number') return row
      try {
        const registry = row.status === 'busy' ? await readObject(path.join(home, 'sessions', `${row.pid}.json`)) : null
        const job = isJob(row) ? await readObject(path.join(home, 'jobs', row.id, 'state.json')) : null
        const shells = shellsOf(job)
        const monitors = monitorsOf(job)
        // Told busy; idle with a shell by the program's record (without it, by the job's: its tempo is idle and a shell runs). A monitor that
        // runs is something the agent waits on: not idle.
        const watching = monitors.length > 0 && row.status !== 'waiting'
        const quiet = !watching && row.status === 'busy' && (registry ? registry.status === 'shell' : shells.length > 0 && text(job?.tempo) === 'idle')
        // Its turn is over when the list says idle, or the program's record says `shell` (or idle), or, with no record, the job's tempo is idle: only
        // the monitor keeps it busy, so there is no turn to stop.
        const over = row.status === 'idle' || (registry ? registry.status === 'shell' || registry.status === 'idle' : text(job?.tempo) === 'idle')
        if (!quiet && !watching && !shells.length && !monitors.length) return row
        return { ...row, ...(quiet ? { status: 'shell' } : watching ? { status: 'busy' } : {}), ...(shells.length ? { shells } : {}), ...(monitors.length ? { monitors } : {}), ...(watching && over ? { turnOver: true } : {}) }
      } catch {
        return row
      }
    })
  )
}
