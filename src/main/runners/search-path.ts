// Where the agents are looked for. Togle keeps the PATH it started with, so an agent installed while it runs is not
// found, and an app opened from the Dock on a Mac gets only the system's short PATH, without the folders the agents
// install to. When an agent is not found, this adds what the person's own terminal would see: on Windows the PATH saved
// in the registry (where installers put their folders), elsewhere the PATH their login shell sets up, and the usual
// folders. Whatever this process starts afterwards (the agents too) has the wider PATH.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const run = (file: string, args: string[], timeout: number): Promise<string> =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout, encoding: 'utf8', maxBuffer: 1 << 20 }, (_error, stdout) => resolve(String(stdout ?? '')))
  })

/** The folders of a PATH value `reg query … /v Path` printed, with the %NAMES% in it filled in. */
export function registryPath(output: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const value = /^\s+Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/im.exec(output)?.[1] ?? ''
  return value
    .split(';')
    .map((part) => part.trim().replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole))
    .filter((part) => part && !part.includes('%'))
}

/** The folders of the PATH a login shell printed between two marks; whatever else it prints when it starts is left out. */
export function shellPath(output: string): string[] {
  return (/__TOGLE_PATH__(.*?)__TOGLE_PATH__/s.exec(output)?.[1] ?? '').split(':').filter(Boolean)
}

/** `base`, then each folder of `more` it does not have yet, in order. Windows compares without case. */
export function mergedPath(base: string[], more: string[], windows = process.platform === 'win32'): string[] {
  const key = (dir: string): string => {
    const clean = dir.trim().replace(/[\\/]+$/, '')
    return windows ? clean.toLowerCase() : clean
  }
  const seen = new Set(base.map(key))
  const out = [...base]
  for (const dir of more) {
    const id = key(dir)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(dir)
  }
  return out
}

/** The folders the person's terminal would have that this process may not. */
async function terminalFolders(): Promise<string[]> {
  if (process.platform === 'win32') {
    const [machine, user] = await Promise.all([
      run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'Path'], 4_000),
      run('reg', ['query', 'HKCU\\Environment', '/v', 'Path'], 4_000)
    ])
    return [...registryPath(machine), ...registryPath(user)]
  }
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const fromShell = shellPath(await run(shell, ['-ilc', 'printf "__TOGLE_PATH__%s__TOGLE_PATH__" "$PATH"'], 5_000))
  const usual = [path.join(os.homedir(), '.local', 'bin'), ...(process.platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin'].filter((dir) => existsSync(dir))
  return [...fromShell, ...usual]
}

let looked = 0
let looking: Promise<boolean> | null = null

/**
 * Adds to this process's PATH the folders the person's terminal would have, at most every 30 seconds. True when it
 * added any, so a look for an agent that was not found is worth making again.
 */
export function widenSearchPath(): Promise<boolean> {
  if (looking) return looking
  if (Date.now() - looked < 30_000) return Promise.resolve(false)
  looking = (async () => {
    try {
      const separator = process.platform === 'win32' ? ';' : ':'
      const now = (process.env.PATH ?? '').split(separator).filter(Boolean)
      const merged = mergedPath(now, await terminalFolders())
      if (merged.length === now.length) return false
      process.env.PATH = merged.join(separator)
      return true
    } catch {
      return false
    } finally {
      looked = Date.now()
      looking = null
    }
  })()
  return looking
}
