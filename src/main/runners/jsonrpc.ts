// JSON-RPC over a program's standard input and output, one JSON message per line: how Codex's app server and Hermes
// (over ACP) are spoken to. Either side can ask. Togle asks the agent to start a turn, and the agent asks Togle to
// allow a command: that answer may wait for the person, and the agent waits with it.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

export type Id = number | string

/** An error sent as the answer to a request, or one that came back as the answer to ours. */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(message: string, code = -32603, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

/** A value of unknown shape, looked into: what the other side sent is not trusted to be what it should be. */
export const rec = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
export const text = (value: unknown): string => (typeof value === 'string' ? value : '')
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

interface Wire {
  id?: Id | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

export interface PeerHandlers {
  /** The agent asks something (`id` is how it numbered the question). What this returns is the answer, and it may take as long as the person does. */
  request(method: string, params: unknown, id: Id): Promise<unknown>
  notification(method: string, params: unknown): void
  /** The program ended or could not start. Called once. */
  closed(code: number | null): void
}

interface Waiting {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class JsonRpcPeer {
  private nextId = 1
  private readonly waiting = new Map<Id, Waiting>()
  private ended = false
  /** The last of what the program wrote to its error output: what to show when it will not start. */
  readonly errors: string[] = []

  /** `tagged`: whether each message carries `"jsonrpc": "2.0"` (ACP does, Codex's app server leaves it out). */
  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    private readonly handlers: PeerHandlers,
    private readonly tagged: boolean
  ) {
    createInterface({ input: proc.stdout }).on('line', (line) => void this.onLine(line))
    proc.stderr.on('data', (chunk: Buffer) => {
      this.errors.push(String(chunk))
      if (this.errors.length > 40) this.errors.shift()
    })
    proc.stdin.on('error', () => undefined)
    proc.on('error', () => this.end(null))
    proc.on('exit', (code) => this.end(code))
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  get running(): boolean {
    return !this.ended
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    if (this.ended) return Promise.reject(new RpcError('The agent is not running.', -32000))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new RpcError(`The agent did not answer ${method}.`, -32001))
      }, timeoutMs)
      this.waiting.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.ended) this.write(params === undefined ? { method } : { method, params })
  }

  /** Ends the conversation: closes the program's input, and stops it if it is still there a moment later. */
  close(): void {
    if (this.ended) return
    try {
      this.proc.stdin.end()
    } catch {
      // already closed
    }
    const timer = setTimeout(() => {
      if (!this.ended) this.proc.kill()
    }, 3_000)
    timer.unref()
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.proc.stdin.write(`${JSON.stringify(this.tagged ? { jsonrpc: '2.0', ...message } : message)}\n`)
    } catch {
      // The program is gone: its exit settles what is waiting.
    }
  }

  private async onLine(line: string): Promise<void> {
    let message: Wire
    try {
      message = JSON.parse(line) as Wire
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null) return
    const hasId = message.id !== undefined && message.id !== null
    if (typeof message.method === 'string') {
      if (!hasId) {
        this.handlers.notification(message.method, message.params)
        return
      }
      const id = message.id as Id
      try {
        const result = await this.handlers.request(message.method, message.params, id)
        this.write({ id, result: result ?? {} })
      } catch (error) {
        const failure = error instanceof RpcError ? error : new RpcError(error instanceof Error ? error.message : String(error))
        this.write({ id, error: { code: failure.code, message: failure.message, ...(failure.data === undefined ? {} : { data: failure.data }) } })
      }
      return
    }
    if (!hasId) return
    const waiting = this.waiting.get(message.id as Id)
    if (!waiting) return
    this.waiting.delete(message.id as Id)
    clearTimeout(waiting.timer)
    if (message.error) waiting.reject(new RpcError(message.error.message ?? 'The agent refused.', message.error.code, message.error.data))
    else waiting.resolve(message.result)
  }

  private end(code: number | null): void {
    if (this.ended) return
    this.ended = true
    for (const [, waiting] of this.waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new RpcError('The agent stopped.', -32000))
    }
    this.waiting.clear()
    this.handlers.closed(code)
  }
}
