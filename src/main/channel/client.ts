// The other end of the local channel: connects, makes Togle prove it holds the secret before saying anything, asks one
// thing, and waits for the answer. Used by the hook that asks about a command, and by the terminal command that starts a
// task.
import net from 'node:net'
import { answerMac, askMac, isNonce, LineReader, line, newNonce, PROTOCOL, sameMac, welcomeMac, type Ask } from './protocol'

/** Togle is not there (not running, or not listening): ask nothing. */
export class ChannelUnavailable extends Error {}
/** What answered could not prove it is Togle, or broke the rules: nothing was told to it. */
export class ChannelRefused extends Error {}

export interface AskOptions {
  address: string
  secret: Buffer
  kind: string
  body: string
  /** How long to wait for an answer, in milliseconds. */
  timeoutMs?: number
}

export function askChannel(options: AskOptions): Promise<{ ok: boolean; result: string }> {
  const { address, secret, kind, body } = options
  return new Promise((resolve, reject) => {
    const socket = net.connect(address)
    const nc = newNonce()
    let stage: 'welcome' | 'answer' = 'welcome'
    let ns = ''
    let ask = ''
    let done = false
    const finish = (error: Error | null, value?: { ok: boolean; result: string }): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value as { ok: boolean; result: string })
    }
    const timer = setTimeout(() => finish(new ChannelUnavailable('No answer came in time.')), options.timeoutMs ?? 600_000)
    socket.on('error', (error) => finish(new ChannelUnavailable(error.message)))
    socket.on('close', () => finish(new ChannelUnavailable('Togle closed the channel.')))
    socket.on('connect', () => socket.write(line({ t: 'hello', v: PROTOCOL, nc })))
    const reader = new LineReader(
      (value) => {
        const message = (value ?? {}) as Record<string, unknown>
        if (stage === 'welcome') {
          if (message.t !== 'welcome' || !isNonce(message.ns) || !sameMac(message.mac, welcomeMac(secret, nc, message.ns))) return finish(new ChannelRefused('What answered could not prove it is Togle.'))
          ns = message.ns
          ask = askMac(secret, ns, kind, body)
          stage = 'answer'
          const asking: Ask = { t: 'ask', kind, body, mac: ask }
          socket.write(line(asking))
          return
        }
        if (message.t !== 'answer' || typeof message.ok !== 'boolean' || typeof message.result !== 'string' || !sameMac(message.mac, answerMac(secret, nc, ns, ask, message.ok, message.result))) return finish(new ChannelRefused('The answer could not be checked.'))
        finish(null, { ok: message.ok, result: message.result })
      },
      () => finish(new ChannelRefused('What answered broke the rules.'))
    )
    socket.on('data', (chunk) => reader.push(chunk))
  })
}
