// The local channel between Togle and the small programs that talk to it (a hook that asks about a command, a terminal
// command that starts a task). Both ends hold one secret, kept in a file only the person can read, and each proves it
// knows it before anything else is believed: a program that took the pipe's name before Togle did cannot answer a
// hook, so it cannot allow a command; a program that never read the secret cannot ask Togle anything.
//
//   client → hello   { nc }                     a fresh number
//   server → welcome { ns, mac(server, nc, ns) }   the server proves itself, and offers a fresh number
//   client → ask     { kind, body, mac(client, ns, kind, body) }
//   server → answer  { ok, result, mac(answer, nc, ns, ask mac, ok, result) }   bound to that one ask
//
// One line of JSON each way. Nothing here touches the network or an electron module, so the hook, which must start
// fast, loads only this.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const PROTOCOL = 1
/** The longest line either side accepts, in bytes. */
export const MAX_LINE = 1_000_000

export interface Hello {
  t: 'hello'
  v: number
  nc: string
}
export interface Welcome {
  t: 'welcome'
  ns: string
  mac: string
}
export interface Ask {
  t: 'ask'
  kind: string
  /** Text, exactly as it was signed. */
  body: string
  mac: string
}
export interface Answer {
  t: 'answer'
  ok: boolean
  /** Text: the result of the ask, or why it was refused. */
  result: string
  mac: string
}

const sign = (secret: Buffer, ...parts: string[]): string => createHmac('sha256', secret).update(parts.join('\u0000')).digest('hex')

/** Whether two signatures are the same, compared in a way that does not tell how much of them matched. */
export function sameMac(a: unknown, b: unknown): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export const newNonce = (): string => randomBytes(16).toString('hex')
export const isNonce = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)

export const welcomeMac = (secret: Buffer, nc: string, ns: string): string => sign(secret, 'server', nc, ns)
export const askMac = (secret: Buffer, ns: string, kind: string, body: string): string => sign(secret, 'client', ns, kind, body)
export const answerMac = (secret: Buffer, nc: string, ns: string, ask: string, ok: boolean, result: string): string => sign(secret, 'answer', nc, ns, ask, ok ? '1' : '0', result)

export const secretOf = (hex: string): Buffer => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error('The channel secret is damaged.')
  return Buffer.from(hex, 'hex')
}

/** Reads lines of JSON from what arrives in pieces; one that is too long, or not JSON, ends the conversation. */
export class LineReader {
  private buffer = ''
  constructor(private readonly onLine: (value: unknown) => void, private readonly onBad: (reason: string) => void) {}

  push(chunk: string | Buffer): void {
    this.buffer += chunk.toString('utf8')
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end === -1) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (Buffer.byteLength(line) > MAX_LINE) return this.onBad('too long')
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        return this.onBad('not JSON')
      }
      this.onLine(value)
    }
    if (Buffer.byteLength(this.buffer) > MAX_LINE) this.onBad('too long')
  }
}

export const line = (message: Hello | Welcome | Ask | Answer): string => `${JSON.stringify(message)}\n`
