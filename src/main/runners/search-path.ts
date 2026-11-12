// Where the agents are looked for. Togle keeps the PATH it started with, so an agent installed while it runs is not
// found, and an app opened from the Dock on a Mac gets only the system's short PATH, without the folders the agents
// install to. When an agent is not found, this adds what the person's own terminal would see: on Windows the PATH saved
// in the registry (where installers put their folders), elsewhere the PATH their login shell sets up, and the usual
// folders. Whatever this process starts afterwards (the agents too) has the wider PATH.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import koffi from 'koffi'

/** The folders of a PATH value, with the %NAMES% in it filled in; a folder whose name is not set is left out. */
export function pathFolders(value: string, env: NodeJS.ProcessEnv = process.env): string[] {
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

/**
 * What a program prints, read until `enough` says it has what is needed, it ends, or `timeoutMs` passes. It gets no
 * input, and on the timeout it and whatever it started are killed: a login shell that waits on something cannot hold
 * Togle up. Never waits longer than `timeoutMs`.
 */
export function outputOf(file: string, args: string[], timeoutMs: number, enough: (output: string) => boolean = () => false): Promise<string> {
  return new Promise((resolve) => {
    let output = ''
    let done = false
    const posix = process.platform !== 'win32'
    let child: ReturnType<typeof spawn>
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      child?.stdout?.destroy()
      resolve(output)
    }
    const timer = setTimeout(() => {
      try {
        // On a Mac and Linux it leads a group of its own: the whole group goes.
        if (posix && child?.pid) process.kill(-child.pid, 'SIGKILL')
        else child?.kill('SIGKILL')
      } catch {
        // Already gone.
      }
      finish()
    }, timeoutMs)
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: posix, windowsHide: true })
    } catch {
      finish()
      return
    }
    child.unref()
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      output += chunk
      if (output.length > 1 << 20 || enough(output)) finish()
    })
    child.on('error', finish)
    // What it printed last may still be on its way when it exits.
    child.on('exit', () => setTimeout(finish, 100))
  })
}

type RegGetValue = (key: number, subKey: string, value: string, flags: number, type: null, data: Buffer, size: number[]) => number
let regGetValue: RegGetValue | null | undefined

/**
 * The PATH saved in the registry, for this computer or for the person, read as Windows keeps it (UTF-16, so a folder
 * named with any letters comes back as it is), with its %NAMES% not filled in yet. Empty when it cannot be read.
 */
function savedPath(machine: boolean): string {
  if (regGetValue === undefined) {
    try {
      regGetValue = koffi.load('advapi32.dll').func('int32_t __stdcall RegGetValueW(intptr_t key, str16 subKey, str16 value, uint32_t flags, void *type, void *data, _Inout_ uint32_t *size)') as RegGetValue
    } catch {
      regGetValue = null
    }
  }
  if (!regGetValue) return ''
  const data = Buffer.alloc(65536)
  const size = [data.length]
  // HKEY_LOCAL_MACHINE and HKEY_CURRENT_USER as Windows defines them; a string value as it is stored, of either kind.
  const key = machine ? -2147483646 : -2147483647
  const subKey = machine ? 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment' : 'Environment'
  try {
    if (regGetValue(key, subKey, 'Path', 0x2 | 0x4 | 0x10000000, null, data, size) !== 0) return ''
  } catch {
    return ''
  }
  return data.toString('utf16le', 0, Math.min(size[0], data.length)).replace(/\0+$/, '')
}

// The registry is quick to read; a login shell runs the person's own start-up files, so it is asked far less often.
const REGISTRY_EVERY_MS = 30_000
const SHELL_EVERY_MS = 10 * 60_000
let shellAsked = 0
let shellFolders: string[] = []

/** The folders the person's terminal would have that this process may not. */
async function terminalFolders(): Promise<string[]> {
  if (process.platform === 'win32') return [...pathFolders(savedPath(true)), ...pathFolders(savedPath(false))]
  if (Date.now() - shellAsked >= SHELL_EVERY_MS) {
    shellAsked = Date.now()
    const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    const printed = await outputOf(shell, ['-ilc', 'printf "__TOGLE_PATH__%s__TOGLE_PATH__" "$PATH"'], 5_000, (output) => shellPath(output).length > 0)
    shellFolders = shellPath(printed)
  }
  const usual = [path.join(os.homedir(), '.local', 'bin'), ...(process.platform === 'darwin' ? ['/opt/homebrew/bin'] : []), '/usr/local/bin'].filter((dir) => existsSync(dir))
  return [...shellFolders, ...usual]
}

let looked = 0
let looking: Promise<boolean> | null = null

/**
 * Adds to this process's PATH the folders the person's terminal would have, at most every 30 seconds. True when it
 * added any, so a look for an agent that was not found is worth making again.
 */
export function widenSearchPath(): Promise<boolean> {
  if (looking) return looking
  if (Date.now() - looked < REGISTRY_EVERY_MS) return Promise.resolve(false)
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

/** For a check of this computer: the PATH folders saved in its registry, as Togle reads them. Windows only. */
export const savedPathFolders = (): string[] => (process.platform === 'win32' ? [...pathFolders(savedPath(true)), ...pathFolders(savedPath(false))] : [])
