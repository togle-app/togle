// Togle's end of the local channel: listens on the pipe (or socket), proves it holds the secret, and answers what is
// asked, by kind. See protocol.ts for what is said and why.
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { answerMac, askMac, isNonce, LineReader, line, newNonce, PROTOCOL, sameMac, welcomeMac, type Answer, type Welcome } from './protocol'

/** Answers one kind of ask: told the text asked, and when the one who asked has gone. */
export type Handler = (body: string, call: { signal: AbortSignal }) => Promise<unknown>

export interface ServerOptions {
  secret: Buffer
  address: string
  handlers: Record<string, Handler>
  /** How many conversations at once. Past that, a new one is dropped. */
  limit?: number
  /** How long a new conversation may stay silent, in milliseconds. */
  helloMs?: number
  /** How long an ask may wait for its answer, in milliseconds. */
  askMs?: number
}

export class ChannelServer {
  private server?: net.Server
  private readonly open = new Set<net.Socket>()

  constructor(private readonly options: ServerOptions) {}

  async listen(): Promise<void> {
    const { address } = this.options
    if (process.platform !== 'win32') await this.clearOld(address)
    const server = net.createServer((socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(address, () => {
        server.off('error', reject)
        resolve()
      })
    })
    server.on('error', () => undefined)
    this.server = server
    // A socket is a file: only this person may use it.
    if (process.platform !== 'win32') await fs.chmod(address, 0o600).catch(() => undefined)
  }

  async close(): Promise<void> {
    for (const socket of this.open) socket.destroy()
    this.open.clear()
    const server = this.server
    this.server = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (process.platform !== 'win32') await fs.rm(this.options.address, { force: true }).catch(() => undefined)
  }

  /** A socket file left by a Togle that ended badly is removed; one that something answers on is left alone. */
  private async clearOld(address: string): Promise<void> {
    if (!(await fs.stat(address).then(() => true, () => false))) return
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(address)
      probe.once('connect', () => {
        probe.destroy()
        resolve(true)
      })
      probe.once('error', () => resolve(false))
    })
    if (alive) throw new Error('Something already answers on the channel.')
    await fs.rm(address, { force: true })
  }

  private accept(socket: net.Socket): void {
    if (this.open.size >= (this.options.limit ?? 64)) {
      socket.destroy()
      return
    }
    this.open.add(socket)
    const { secret, handlers } = this.options
    const gone = new AbortController()
    const ns = newNonce()
    let stage: 'hello' | 'ask' | 'busy' = 'hello'
    let nc = ''
    const silent = setTimeout(() => socket.destroy(), this.options.helloMs ?? 5_000)
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(silent)
      this.open.delete(socket)
      gone.abort()
    })

    const reader = new LineReader(
      (value) => {
        const message = (value ?? {}) as Record<string, unknown>
        if (stage === 'hello') {
          if (message.t !== 'hello' || message.v !== PROTOCOL || !isNonce(message.nc)) return void socket.destroy()
          nc = message.nc
          stage = 'ask'
          const welcome: Welcome = { t: 'welcome', ns, mac: welcomeMac(secret, nc, ns) }
          socket.write(line(welcome))
          return
        }
        if (stage === 'ask') {
          // Believed only once signed with the secret: before that, nothing in it is looked at.
          if (message.t !== 'ask' || typeof message.kind !== 'string' || typeof message.body !== 'string' || !sameMac(message.mac, askMac(secret, ns, message.kind, message.body))) return void socket.destroy()
          stage = 'busy'
          clearTimeout(silent)
          void this.answer(socket, gone.signal, nc, ns, message.mac as string, handlers[message.kind], message.body)
          return
        }
        socket.destroy()
      },
      () => socket.destroy()
    )
    socket.on('data', (chunk) => reader.push(chunk))
  }

  private async answer(socket: net.Socket, signal: AbortSignal, nc: string, ns: string, ask: string, handler: Handler | undefined, body: string): Promise<void> {
    let ok = false
    let result = ''
    if (!handler) result = 'Togle does not know that.'
    else {
      let timer: NodeJS.Timeout | undefined
      let leave: (() => void) | undefined
      try {
        const value = await Promise.race([
          handler(body, { signal }),
          // Not waited for longer than agreed, nor once the one who asked has gone.
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error('No answer came in time.')), this.options.askMs ?? 15 * 60_000)
            timer.unref?.()
            leave = () => reject(new Error('The one who asked has gone.'))
            if (signal.aborted) leave()
            else signal.addEventListener('abort', leave, { once: true })
          })
        ])
        ok = true
        result = JSON.stringify(value ?? null)
      } catch (error) {
        result = (error as Error).message || 'Togle could not do that.'
      } finally {
        clearTimeout(timer)
        if (leave) signal.removeEventListener('abort', leave)
      }
    }
    if (socket.destroyed || signal.aborted) return
    const reply: Answer = { t: 'answer', ok, result, mac: answerMac(this.options.secret, nc, ns, ask, ok, result) }
    socket.end(line(reply))
  }
}
