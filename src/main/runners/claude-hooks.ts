// How Togle hears Claude Code ask for permission. Claude Code can post each request to a web address on this computer
// before it shows its own prompt ("hooks", documented by Anthropic), and acts on the answer: allow, deny, or nothing,
// which leaves the decision to its own prompt. Togle listens on a port only this computer can reach. Each task gets its own
// address with a secret in it, so a request is known to come from the Claude Code session Togle started.
//
// A request waits here for the person for as long as Claude Code waits for the hook (an hour here). Not answering
// never allows: when Claude Code gives up, or when Togle quits, the request ends with no decision, and Claude Code's own
// prompt decides.
//
// A task that runs in the background goes on when Togle quits, and what Claude Code was given at its start stays what it
// has (checked with 2.1.323): a running session keeps the address it began with, and one that is stopped and opened again
// reads its settings file once more, from the same path. So with a folder to keep things in, the port and the secret stay
// the same from one run of Togle to the next, and each task's settings file stays until the task is removed. Only the
// permission hook is given: Claude Code prints nothing when that address is dead (it asks on its own screen), while a
// hook for the end of a turn would print "Stop hook error" under every turn while Togle is closed.
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { rec } from './jsonrpc'

/** What Togle answers a permission request with. `null`: no decision, and Claude Code's own prompt decides. */
export type HookVerdict = { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: Record<string, unknown>[] } | { behavior: 'deny'; message: string } | null

/** A task that hears its own requests. */
export interface HookTarget {
  /** One permission request. `gone` is aborted when Claude Code stops waiting for the answer. */
  permission(event: Record<string, unknown>, gone: AbortSignal): Promise<HookVerdict>
}

const WAIT_SECONDS = 3_600
const MAX_BODY = 4 * 1024 * 1024
/** What asks about every use with `asks`: whatever the person's own allow rules say (an ask rule wins over an allow rule). */
const ASKING = ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']

interface Address {
  port: number
  secret: string
}

async function readAddress(file: string): Promise<Address | null> {
  try {
    const saved = rec(JSON.parse(await fs.readFile(file, 'utf8')) as unknown)
    const { port, secret } = saved
    return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 && typeof secret === 'string' && /^[0-9a-f]{32}$/.test(secret) ? { port, secret } : null
  } catch {
    return null
  }
}

export class HookServer {
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private secret = randomBytes(16).toString('hex')
  private readonly targets = new Map<string, HookTarget>()
  /** Requests that wait for an answer: told "no decision" when the server closes. */
  private readonly waiting = new Set<{ res: ServerResponse; gone: AbortController }>()
  private folder: string | null = null
  private taken = false

  /**
   * `keep` is a folder of Togle's own where the address and the settings files stay between runs (see the top). Without
   * one, the address is new each time and the settings files are temporary, removed when the server closes.
   */
  constructor(private readonly keep?: string) {}

  /** Whether the port the last run used was taken by something else, so a task still running from before cannot be heard. */
  get portMoved(): boolean {
    return this.taken
  }

  /**
   * The settings file Claude Code is started with (`--settings`) so it asks this task's address about permission. With
   * `key`, a task Togle knew before: the same address, and its settings file written again. With `asks`, every command, edit
   * and write asks, so the task stops at each one and Togle can show it.
   */
  async attach(target: HookTarget, asks: boolean, key?: string): Promise<{ key: string; settings: string }> {
    const port = await this.listen()
    const id = key ?? randomBytes(8).toString('hex')
    if (!/^[0-9a-f]{16}$/.test(id)) throw new Error('That is not a task key.')
    this.targets.set(id, target)
    const settings = path.join(await this.where(), `${id}.json`)
    const at = `http://127.0.0.1:${port}/hook/${this.secret}/${id}/permission`
    const content = {
      hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url: at, timeout: WAIT_SECONDS }] }] },
      ...(asks ? { permissions: { ask: ASKING } } : {})
    }
    await fs.writeFile(settings, JSON.stringify(content), { mode: 0o600 })
    return { key: id, settings }
  }

  /** The task that hears what this key's address is asked, from now on: what is asked meanwhile goes to the one before. */
  retarget(key: string, target: HookTarget): void {
    if (this.targets.has(key)) this.targets.set(key, target)
  }

  /** The task is not heard any more. Its settings file stays when the session may still be opened again. */
  detach(key: string): void {
    this.targets.delete(key)
  }

  /** The task is gone for good: its settings file goes too. */
  async forget(key: string): Promise<void> {
    this.targets.delete(key)
    if (this.folder || this.keep) await fs.rm(path.join(await this.where(), `${key}.json`), { force: true }).catch(() => undefined)
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.starting = null
    // Each request that waits ends with no decision before the connection does: Claude Code then asks on its own screen.
    for (const request of [...this.waiting]) {
      request.gone.abort()
      if (!request.res.writableEnded) request.res.end()
    }
    this.waiting.clear()
    this.targets.clear()
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    if (!this.keep && this.folder) await fs.rm(this.folder, { recursive: true, force: true }).catch(() => undefined)
    if (!this.keep) this.folder = null
  }

  private async where(): Promise<string> {
    if (!this.folder) {
      this.folder = this.keep ? path.join(this.keep, 'hooks') : await fs.mkdtemp(path.join(os.tmpdir(), 'togle-hooks-'))
      await fs.mkdir(this.folder, { recursive: true })
    }
    return this.folder
  }

  private listen(): Promise<number> {
    this.starting ??= (async (): Promise<number> => {
      const file = this.keep ? path.join(this.keep, 'address.json') : null
      const saved = file ? await readAddress(file) : null
      if (saved) this.secret = saved.secret
      const tries = saved ? [saved.port, 0] : [0]
      let last: Error | undefined
      for (const wanted of tries) {
        try {
          const port = await this.bind(wanted)
          if (saved && wanted === 0) this.taken = true
          if (file) {
            await fs.mkdir(path.dirname(file), { recursive: true })
            await fs.writeFile(file, JSON.stringify({ port, secret: this.secret }), { mode: 0o600 })
          }
          return port
        } catch (error) {
          last = error as Error
        }
      }
      throw last ?? new Error('Togle could not listen for Claude Code.')
    })()
    // A failed start can be tried again.
    this.starting.catch(() => { this.starting = null })
    return this.starting
  }

  private bind(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', () => undefined)
        this.server = server
        resolve((server.address() as { port: number }).port)
      })
    })
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const parts = (req.url ?? '').split('/').filter(Boolean)
    // /hook/<secret>/<task>/permission
    if (req.method !== 'POST' || parts.length !== 4 || parts[0] !== 'hook' || parts[1] !== this.secret || parts[3] !== 'permission') {
      res.statusCode = 404
      res.end()
      return
    }
    const target = this.targets.get(parts[2])
    if (!target) {
      res.statusCode = 404
      res.end()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > MAX_BODY) {
        res.statusCode = 413
        res.end()
        return
      }
      chunks.push(chunk)
    }
    let event: Record<string, unknown>
    try {
      event = rec(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    } catch {
      res.statusCode = 400
      res.end()
      return
    }
    const gone = new AbortController()
    const open = { res, gone }
    this.waiting.add(open)
    res.on('close', () => {
      this.waiting.delete(open)
      if (!res.writableEnded) gone.abort()
    })
    let verdict: HookVerdict = null
    try {
      verdict = await target.permission(event, gone.signal)
    } catch {
      verdict = null
    }
    this.waiting.delete(open)
    if (gone.signal.aborted || res.writableEnded) return
    res.setHeader('content-type', 'application/json')
    res.end(verdict ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict } }) : '')
  }
}
