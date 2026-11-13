// A connection to Codex's shared server (its "daemon"), from here. The server listens on a unix socket in the person's
// Codex folder; `codex app-server proxy` carries bytes between its standard input and output and that socket, which is how a
// program of ours reaches it on Windows (Node opens no unix socket there). What crosses is a WebSocket: an HTTP upgrade, then
// one JSON message in each frame, in the same words `codex app-server` speaks on its standard input and output (Codex 0.169
// on Windows). The `ws` package speaks the WebSocket over the two pipes.
//
// Closing a link never ends the server or the work in it: the server goes on, and the work with it.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Duplex } from 'node:stream'
import WebSocket from 'ws'
import { NO_ANSWER, RpcError, type Id, type PeerHandlers, type RpcPeer } from './jsonrpc'

interface Wire {
  id?: Id | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code?: number; message?: string; data?: unknown }
}

interface Waiting {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** How long the server may take to accept the connection. */
const OPEN_MS = 15_000

export class WsRpcPeer implements RpcPeer {
  private nextId = 1
  private readonly waiting = new Map<Id, Waiting>()
  private ended = false
  private readonly proc: ChildProcessWithoutNullStreams
  private readonly socket: WebSocket
  readonly errors: string[] = []
  /** Resolves when the connection is open; rejects, in words, when the server did not accept it. */
  readonly opened: Promise<void>

  /** `command` starts the proxy: `codex app-server proxy`, in full. */
  constructor(
    command: string[],
    env: NodeJS.ProcessEnv | undefined,
    private readonly handlers: PeerHandlers
  ) {
    this.proc = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...(env ? { env } : {}) })
    const pipe = new Duplex({
      read() {
        // What the proxy prints is pushed as it comes.
      },
      write: (chunk: Buffer, _encoding, done) => {
        try {
          this.proc.stdin.write(chunk, done)
        } catch (error) {
          done(error as Error)
        }
      },
      final: (done) => {
        try {
          this.proc.stdin.end()
        } catch {
          // already closed
        }
        done()
      }
    })
    // The shape of a socket that the HTTP client and `ws` ask for; a pipe has no timeout, delay or keep-alive of its own.
    for (const name of ['setTimeout', 'setNoDelay', 'setKeepAlive', 'ref', 'unref'] as const) (pipe as unknown as Record<string, () => Duplex>)[name] = () => pipe
    this.proc.stdout.on('data', (chunk: Buffer) => pipe.push(chunk))
    this.proc.stdout.on('end', () => pipe.push(null))
    this.proc.stdin.on('error', () => undefined)
    this.proc.stderr.on('data', (chunk: Buffer) => {
      this.errors.push(String(chunk))
      if (this.errors.length > 40) this.errors.shift()
    })
    this.socket = new WebSocket('ws://localhost/', { createConnection: () => pipe as never, perMessageDeflate: false, handshakeTimeout: OPEN_MS })
    this.opened = new Promise<void>((resolve, reject) => {
      // The pipe has no timeout of its own (see above), so `ws` cannot time the handshake out: a server that never answers the
      // upgrade is given up on here.
      const late = setTimeout(() => reject(new RpcError('Codex’s shared server did not answer.', -32000)), OPEN_MS)
      late.unref?.()
      this.socket.once('open', () => {
        clearTimeout(late)
        resolve()
      })
      this.socket.once('error', (error) => {
        clearTimeout(late)
        reject(new RpcError(this.whyNot(error), -32000))
      })
    })
    // A rejection nobody waits for (the link closed before anyone looked) is not an error of Togle's.
    this.opened.catch(() => undefined)
    this.socket.on('message', (data) => void this.onMessage(String(data)))
    this.socket.on('close', () => this.end())
    this.socket.on('error', () => this.end())
    this.proc.on('error', () => this.end())
    this.proc.on('exit', () => this.end())
  }

  /** What went wrong, in words: the proxy's own last line when it printed one ("failed to connect to … refused it"). */
  private whyNot(error: Error): string {
    const said = this.errors.join('').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('{')).find((line) => /^Error:/i.test(line))
    return said ? said.replace(/^Error:\s*/i, '') : error.message
  }

  get pid(): number | undefined {
    return this.proc.pid
  }

  get running(): boolean {
    return !this.ended
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 60_000): Promise<T> {
    if (this.ended) return Promise.reject(new RpcError('Codex is not running.', -32000))
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new RpcError(`Codex did not answer ${method}.`, -32001))
      }, timeoutMs)
      this.waiting.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    if (!this.ended) this.write(params === undefined ? { method } : { method, params })
  }

  /** Closes the connection and the proxy. The server, and what it runs, are left as they are. */
  close(): void {
    if (this.ended) {
      this.stopProxy()
      return
    }
    try {
      this.socket.close()
    } catch {
      // already closed
    }
    this.stopProxy()
  }

  private stopProxy(): void {
    try {
      this.proc.stdin.end()
    } catch {
      // already closed
    }
    const timer = setTimeout(() => {
      if (this.proc.exitCode === null && !this.proc.killed) this.proc.kill()
    }, 1_500)
    timer.unref()
  }

  private write(message: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      // The connection is gone: its end settles what is waiting.
    }
  }

  private async onMessage(text: string): Promise<void> {
    let message: Wire
    try {
      message = JSON.parse(text) as Wire
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
        if (result !== NO_ANSWER) this.write({ id, result: result ?? {} })
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
    if (message.error) waiting.reject(new RpcError(message.error.message ?? 'Codex refused.', message.error.code, message.error.data))
    else waiting.resolve(message.result)
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    for (const [, waiting] of this.waiting) {
      clearTimeout(waiting.timer)
      waiting.reject(new RpcError('Codex stopped.', -32000))
    }
    this.waiting.clear()
    this.stopProxy()
    this.handlers.closed(this.proc.exitCode)
  }
}
