// Connecting Claude Code to Togle: one entry in Claude Code's settings file that starts Togle's hook program for a
// PermissionRequest. Everything else in the file is kept as it was; the first change keeps a copy of the file beside it;
// a file that is not valid JSON is left alone, and said so. Taking the entry out again removes only Togle's own.
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The first Claude Code that can start a hook without a shell (`args`), which is how Togle's is started. */
export const MIN_CLAUDE_VERSION = '2.1.139'
/** What the hook may take, in seconds, before Claude Code ends it. Togle's own wait is a little less. */
const TIMEOUT_SECONDS = 600
/** How a hook of Togle's is told from the person's own. */
const MARK = '--togle-hook'

/** Where Claude Code keeps the person's settings: the folder `CLAUDE_CONFIG_DIR` names, else `.claude` in their home folder. */
export function claudeSettingsFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'), 'settings.json')
}

/** Whether a version such as "2.1.322 (Claude Code)" is at least `minimum`. */
export function versionAtLeast(version: string | undefined, minimum: string = MIN_CLAUDE_VERSION): boolean {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(version ?? '')
  if (!found) return false
  const need = minimum.split('.').map(Number)
  for (let at = 0; at < 3; at++) {
    const have = Number(found[at + 1])
    if (have !== need[at]) return have > need[at]
  }
  return true
}

export interface HookCommand {
  /** The program: Togle. */
  command: string
  /** What it is started with, the hook's own flags last. */
  args: string[]
}

export interface HookConnection {
  /** Whether the settings file holds Togle's entry. */
  installed: boolean
  /** Whether that entry starts this Togle the way it would be started now (it is out of date if Togle was moved). */
  current: boolean
  file: string
  /** Why the file could not be read or changed, in words. */
  problem?: string
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)

const isOurs = (group: unknown): boolean => isObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isObject(hook) && Array.isArray(hook.args) && hook.args.includes(MARK))

/** Whether the file's own entry is exactly the one this Togle would write. */
const sameCommand = (group: unknown, want: HookCommand): boolean =>
  isObject(group) && Array.isArray(group.hooks) && group.hooks.some((hook) => isObject(hook) && hook.command === want.command && JSON.stringify(hook.args) === JSON.stringify(want.args))

export class ClaudeSettings {
  /** `command` says how Togle is started now; asked each time, as it can change. */
  constructor(readonly file: string, private readonly command: () => HookCommand) {}

  async status(): Promise<HookConnection> {
    try {
      const { data } = await this.read()
      const ours = this.entries(data).filter(isOurs)
      const want = this.command()
      return { installed: ours.length > 0, current: ours.length > 0 && ours.every((group) => sameCommand(group, want)), file: this.file }
    } catch (error) {
      return { installed: false, current: false, file: this.file, problem: (error as Error).message }
    }
  }

  /** Puts Togle's entry in, in place of any earlier one of Togle's. */
  async connect(): Promise<HookConnection> {
    const { data, text } = await this.read()
    const want = this.command()
    const hooks = isObject(data.hooks) ? data.hooks : (data.hooks = {})
    const others = this.entries(data).filter((group) => !isOurs(group))
    ;(hooks as Json).PermissionRequest = [...others, { hooks: [{ type: 'command', command: want.command, args: want.args, timeout: TIMEOUT_SECONDS }] }]
    await this.keepCopy(text)
    await this.write(data, text)
    return this.status()
  }

  /** Takes Togle's entry out and leaves the rest. */
  async disconnect(): Promise<HookConnection> {
    const { data, text } = await this.read()
    if (text === null || !this.entries(data).some(isOurs)) return this.status()
    const hooks = data.hooks as Json
    const others = this.entries(data).filter((group) => !isOurs(group))
    if (others.length) hooks.PermissionRequest = others
    else delete hooks.PermissionRequest
    if (!Object.keys(hooks).length) delete data.hooks
    await this.write(data, text)
    return this.status()
  }

  private entries(data: Json): unknown[] {
    return isObject(data.hooks) && Array.isArray(data.hooks.PermissionRequest) ? data.hooks.PermissionRequest : []
  }

  /** The settings, and the text they were read from (null when there is no file yet). */
  private async read(): Promise<{ data: Json; text: string | null }> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { data: {}, text: null }
      throw error
    }
    if (!text.trim()) return { data: {}, text }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error("Claude Code's settings file is not valid JSON, so Togle left it alone.")
    }
    if (!isObject(parsed)) throw new Error("Claude Code's settings file is not what Togle expects, so Togle left it alone.")
    if ('hooks' in parsed && !isObject(parsed.hooks)) throw new Error("The hooks in Claude Code's settings are not what Togle expects, so Togle left them alone.")
    if (isObject(parsed.hooks) && 'PermissionRequest' in parsed.hooks && !Array.isArray(parsed.hooks.PermissionRequest)) throw new Error("The PermissionRequest hooks in Claude Code's settings are not what Togle expects, so Togle left them alone.")
    return { data: parsed, text }
  }

  /** The first time Togle changes a file that is there, a copy of it is kept beside it. */
  private async keepCopy(text: string | null): Promise<void> {
    if (text === null) return
    const copy = `${this.file}.togle-backup`
    try {
      await fs.writeFile(copy, text, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }

  /** Writes the file all at once, in the indentation it had and with the permissions it had. */
  private async write(data: Json, before: string | null): Promise<void> {
    const indent = before && /^\t/m.test(before) ? '\t' : (/^( +)"/m.exec(before ?? '')?.[1].length ?? 2)
    const text = `${JSON.stringify(data, null, indent)}\n`
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const mode = await fs.stat(this.file).then((stat) => stat.mode & 0o777, () => 0o600)
    const temp = `${this.file}.${process.pid}.tmp`
    try {
      await fs.writeFile(temp, text, { mode })
      for (let attempt = 1; ; attempt++) {
        try {
          await fs.rename(temp, this.file)
          return
        } catch (error) {
          // Windows will not replace a file another program (Claude Code reading its settings, an antivirus) has open this moment.
          const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
          if (!busy || attempt >= 6) throw error
          await new Promise((resolve) => setTimeout(resolve, 60 * attempt))
        }
      }
    } catch (error) {
      await fs.rm(temp, { force: true })
      throw error
    }
  }
}
