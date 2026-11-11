// How Togle hears Claude Code ask for permission. Claude Code can post each request to a web address on this computer
// before it shows its own prompt ("hooks", documented by Anthropic), and acts on the answer: allow, deny, or nothing,
// which leaves the decision to its own prompt. Togle listens on a port only this computer can reach. Each task gets its own
// address with a secret in it, so a request is known to come from the Claude Code process Togle started.
//
// A request waits here for the person for as long as Claude Code waits for the hook (an hour here). Not answering
// never allows: when Claude Code gives up, the request ends, and a session with no prompt of its own refuses it.
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { rec } from './jsonrpc'

/** What Togle answers a permission request with. `null`: no decision, and Claude Code's own prompt decides. */
export type HookVerdict = { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string } | null

/** A task that hears its own requests. */
export interface HookTarget {
  /** One permission request. `gone` is aborted when Claude Code stops waiting for the answer. */
  permission(event: Record<string, unknown>, gone: AbortSignal): Promise<HookVerdict>
}

const WAIT_SECONDS = 3_600
const MAX_BODY = 4 * 1024 * 1024

export class HookServer {
  private server: Server | null = null
  private starting: Promise<number> | null = null
  private readonly secret = randomBytes(16).toString('hex')
  private readonly targets = new Map<string, HookTarget>()
  private folder: string | null = null

  /**
   * The settings file Claude Code is started with (`--settings`) so it asks this task's address about permission.
   * With `asks`, every command, edit and write asks, whatever the person's own allow rules say (an ask rule wins over
   * an allow rule), so the task stops at each one and Togle can show it.
   */
  async attach(target: HookTarget, asks: boolean): Promise<{ key: string; settings: string }> {
    const port = await this.listen()
    const key = randomBytes(8).toString('hex')
    this.targets.set(key, target)
    this.folder ??= await fs.mkdtemp(path.join(os.tmpdir(), 'togle-hooks-'))
    const settings = path.join(this.folder, `${key}.json`)
    const url = `http://127.0.0.1:${port}/hook/${this.secret}/${key}/permission`
    const content = {
      hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url, timeout: WAIT_SECONDS }] }] },
      ...(asks ? { permissions: { ask: ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] } } : {})
    }
    await fs.writeFile(settings, JSON.stringify(content), { mode: 0o600 })
    return { key, settings }
  }

  async detach(key: string, settings: string): Promise<void> {
    this.targets.delete(key)
    await fs.rm(settings, { force: true })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    this.starting = null
    this.targets.clear()
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    if (this.folder) await fs.rm(this.folder, { recursive: true, force: true }).catch(() => undefined)
    this.folder = null
  }

  private listen(): Promise<number> {
    this.starting ??= new Promise<number>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res))
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        this.server = server
        resolve((server.address() as { port: number }).port)
      })
    })
    return this.starting
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
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
    res.on('close', () => {
      if (!res.writableEnded) gone.abort()
    })
    let verdict: HookVerdict = null
    try {
      verdict = await target.permission(event, gone.signal)
    } catch {
      verdict = null
    }
    if (gone.signal.aborted) return
    res.setHeader('content-type', 'application/json')
    res.end(verdict ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: verdict } }) : '')
  }
}
