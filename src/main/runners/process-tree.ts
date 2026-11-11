// Finding and ending the programs an agent started. Codex's Stop ends its turn but lets a command that is already
// running finish; ending that command takes a second press, and this is what the second press does: find the command
// among the programs below the agent's own, and end it with everything it started.
import { execFile } from 'node:child_process'

export interface Proc {
  pid: number
  ppid: number
  command: string
}

const run = (file: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })

/** Every program running on this computer, with the one that started it and the command line it was started with. */
export async function listProcesses(): Promise<Proc[]> {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p = [int]$_.ProcessId; pp = [int]$_.ParentProcessId; c = [string]$_.CommandLine } } | ConvertTo-Json -Compress'
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    const rows = JSON.parse(out.trim() || '[]') as { p: number; pp: number; c: string | null }[] | { p: number; pp: number; c: string | null }
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({ pid: row.p, ppid: row.pp, command: row.c ?? '' }))
  }
  const out = await run('ps', ['-A', '-o', 'pid=,ppid=,args='])
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) procs.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return procs
}

/** Everything below `root`: what it started, and what that started. */
export function descendantsOf(all: readonly Proc[], root: number): Proc[] {
  const below = new Map<number, Proc[]>()
  for (const proc of all) below.set(proc.ppid, [...(below.get(proc.ppid) ?? []), proc])
  const found: Proc[] = []
  const seen = new Set<number>([root])
  const queue = [root]
  while (queue.length) {
    for (const child of below.get(queue.shift() as number) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/**
 * The programs below `root` whose command line holds `needle`, outermost only: a command is found by the words it
 * was started with, and what it started in turn goes down with it.
 */
export function matching(all: readonly Proc[], root: number, needle: string): Proc[] {
  const key = needle.trim()
  if (!key) return []
  const hits = descendantsOf(all, root).filter((proc) => proc.command.includes(key))
  const ids = new Set(hits.map((proc) => proc.pid))
  return hits.filter((proc) => {
    for (let at = proc.ppid, hops = 0; at && hops < 64; hops++) {
      if (ids.has(at)) return false
      at = all.find((other) => other.pid === at)?.ppid ?? 0
    }
    return true
  })
}

/** Ends a program and everything it started. */
export async function endTree(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', '/F']).catch(() => undefined)
    return
  }
  const below = descendantsOf(await listProcesses(), pid).map((proc) => proc.pid).reverse()
  for (const target of [...below, pid]) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** The commands below `root` that were started with `needle`, ended. How many were found. */
export async function endCommandsMatching(root: number, needle: string): Promise<number> {
  const hits = matching(await listProcesses(), root, needle)
  await Promise.all(hits.map((proc) => endTree(proc.pid)))
  return hits.length
}

// What a shell command is, without its wrapping: Codex sends `"…\powershell.exe" -Command '<script>'` and runs it that
// way, and the person should read the script.
const POWERSHELL = /^\s*(?:"[^"]*(?:powershell|pwsh)(?:\.exe)?"|\S*(?:powershell|pwsh)(?:\.exe)?)\s+(?:-\w+\s+(?:Bypass|Unrestricted|RemoteSigned|Hidden|Normal|Minimized)\s+|-(?:NoProfile|NonInteractive|NoLogo|NoExit|NoProfileLoadTime)\s+)*-(?:Command|c)\s+([\s\S]*)$/i
const SHELL = /^\s*(?:"[^"]*[\\/]?(?:ba|z|da|k|fi)?sh(?:\.exe)?"|\S*[\\/]?(?:ba|z|da|k|fi)?sh(?:\.exe)?)\s+(?:-[a-z]+\s+)*?-[a-z]*c[a-z]*\s+([\s\S]*)$/i
const CMD = /^\s*(?:"[^"]*cmd(?:\.exe)?"|\S*cmd(?:\.exe)?)\s+(?:\/[a-z]\s+)*?\/[ck]\s+([\s\S]*)$/i

function unquote(rest: string, doubled: boolean): string {
  const body = rest.trim()
  const quote = body[0]
  if ((quote === "'" || quote === '"') && body.endsWith(quote) && body.length >= 2) {
    const inner = body.slice(1, -1)
    return quote === "'" && doubled ? inner.replace(/''/g, "'") : inner.replace(new RegExp(`\\\\${quote}`, 'g'), quote)
  }
  return body
}

/** The script a shell command runs, for reading. A command that is not wrapped comes back as it was. */
export function unwrapShell(command: string): string {
  const ps = POWERSHELL.exec(command)
  if (ps) return unquote(ps[1], true)
  const sh = SHELL.exec(command)
  if (sh) return unquote(sh[1], false)
  const cmd = CMD.exec(command)
  if (cmd) return unquote(cmd[1], false)
  return command.trim()
}
