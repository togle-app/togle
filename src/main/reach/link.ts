// Togle's connection to Studio's courier: one WebSocket, kept open while Reach is on, tried again after it drops (a
// second, then longer, up to a minute). It says hello with this device's public keys and signs the courier's challenge
// with its key. An account-bound connection also proves account sign-in.
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { COURIER_VERSION, HELLO_PURPOSE, MAX_FRAME_BYTES, type Box, type DeviceKind, type Down, type ErrorCode } from '@shared/courier-protocol'
import { signWith, type Identity } from './crypto'
import { proveRecovery, type RecoveryKey } from './recovery'

export type LinkState = 'off' | 'connecting' | 'guest' | 'member' | 'refused'

/** An error the courier answered with, or one of the connection's own ('later'). */
export class CourierError extends Error {
  readonly code: ErrorCode
  constructor(code: ErrorCode, message: string) {
    super(message)
    this.code = code
  }
}

type Welcome = Extract<Down, { t: 'welcome' }>
type Refused = Extract<Down, { t: 'refused' }>
type Ok = Extract<Down, { t: 'ok' }>

export interface LinkEvents {
  state: [LinkState]
  welcome: [Welcome]
  refused: [Refused]
  box: [Box, number]
  online: [string, boolean]
  'room-peer': [string]
  'room-say': [string, string]
  'room-closed': [string, 'closed' | 'expired' | 'left']
  enrolled: []
  forgotten: []
}

export interface LinkOptions {
  url: string
  identity: Identity
  kind: DeviceKind
  accountToken?: () => Promise<string | undefined>
  /** Opens a socket (a test can hand its own). */
  open?: (url: string) => WebSocket
  /** How long to wait before each try after a drop. */
  delays?: number[]
}

const DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]
/** Refusals that another try would only repeat. */
const FINAL: Refused['code'][] = ['elsewhere', 'bad-hello', 'bad-proof', 'version', 'account', 'recovery']

export class CourierLink extends EventEmitter<LinkEvents> {
  state: LinkState = 'off'
  welcome?: Welcome
  refusal?: Refused
  private readonly options: LinkOptions
  private socket?: WebSocket
  private wanted = false
  private tries = 0
  private retry?: ReturnType<typeof setTimeout>
  private signIn?: { account: string; pairOnly?: boolean; recovery?: string; previous?: RecoveryKey }
  private ids = 0
  private readonly waiting = new Map<string, { resolve: (frame: Ok) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(options: LinkOptions) {
    super()
    this.options = options
  }

  /** Connects, and keeps the connection until stop(). */
  start(): void {
    this.wanted = true
    if (!this.socket) this.connect()
  }

  /**
   * Connects using the account token and an optional explicit activation or recovery.
   */
  signInWith(account: string, purpose: { pairOnly?: boolean; recovery?: string; previous?: RecoveryKey } = {}): void {
    this.signIn = { account, ...purpose }
    this.wanted = true
    this.refusal = undefined
    const old = this.socket
    this.socket = undefined
    old?.removeAllListeners()
    old?.on('error', () => {})
    old?.close()
    this.failWaiting()
    this.connect()
  }

  stop(): void {
    this.signIn = undefined
    this.welcome = undefined
    this.wanted = false
    clearTimeout(this.retry)
    const old = this.socket
    this.socket = undefined
    old?.removeAllListeners()
    old?.on('error', () => {})
    old?.close()
    this.failWaiting()
    this.refusal = undefined
    this.set('off')
  }

  /** Asks the courier something and waits for its answer. */
  request(frame: Record<string, unknown>, ms = 15_000): Promise<Ok> {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN || (this.state !== 'member' && this.state !== 'guest')) {
      return Promise.reject(new CourierError('later', 'The device connection is unavailable right now.'))
    }
    const id = `r${++this.ids}`
    return new Promise<Ok>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new CourierError('later', 'The device connection timed out.'))
      }, ms)
      timer.unref?.()
      this.waiting.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ ...frame, id }))
    })
  }

  /** Says something that needs no answer (in a room). */
  say(frame: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
  }

  private connect(): void {
    clearTimeout(this.retry)
    this.set('connecting')
    const { identity, kind } = this.options
    const socket = this.options.open?.(this.options.url) ?? new WebSocket(this.options.url, { maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false, handshakeTimeout: 15_000 })
    this.socket = socket
    socket.on('open', () => socket.send(JSON.stringify({ t: 'hello', v: COURIER_VERSION, device: identity.device, sign: identity.sign, agree: identity.agree, kind })))
    socket.on('message', (data, binary) => {
      if (binary || socket !== this.socket) return
      let frame: Down
      try { frame = JSON.parse(String(data)) as Down } catch { return }
      this.receive(socket, frame)
    })
    socket.on('close', () => this.closed(socket))
    socket.on('error', () => { /* close follows */ })
  }

  private async prove(socket: WebSocket, nonce: string): Promise<void> {
    const explicit = this.signIn
    const account = explicit ? undefined : await this.options.accountToken?.()
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return
    const signature = signWith(this.options.identity, HELLO_PURPOSE, { device: this.options.identity.device, nonce })
    const auth = explicit?.account ?? account
    const recovery = explicit?.recovery
    const previous = explicit?.previous
    const operation = recovery && (previous
      ? { recover: { owner: previous.owner, recovery, proof: proveRecovery(previous, nonce, this.options.identity.device, recovery) } }
      : { activate: { recovery } })
    socket.send(JSON.stringify({
      t: 'prove', signature, ...(auth ? { account: auth } : {}),
      ...(explicit?.pairOnly ? { pairOnly: true } : {}), ...(operation || {})
    }))
  }

  private receive(socket: WebSocket, frame: Down): void {
    switch (frame.t) {
      case 'challenge': {
        void this.prove(socket, frame.nonce).catch(() => socket.close())
        return
      }
      case 'welcome':
        // Each reconnect fetches a current token for an account-bound desktop.
        this.signIn = undefined
        this.tries = 0
        this.welcome = frame
        this.refusal = undefined
        this.set(frame.member ? 'member' : 'guest')
        this.emit('welcome', frame)
        return
      case 'refused':
        this.refusal = frame
        if (frame.code === 'account' || frame.code === 'recovery') this.signIn = undefined
        if (FINAL.includes(frame.code)) { this.wanted = false; this.set('refused') }
        this.emit('refused', frame)
        return
      case 'ok': {
        const waiter = this.waiting.get(frame.id)
        if (!waiter) return
        this.waiting.delete(frame.id)
        clearTimeout(waiter.timer)
        waiter.resolve(frame)
        return
      }
      case 'error': {
        const waiter = frame.id ? this.waiting.get(frame.id) : undefined
        if (!waiter || !frame.id) return
        this.waiting.delete(frame.id)
        clearTimeout(waiter.timer)
        waiter.reject(new CourierError(frame.code, frame.message))
        return
      }
      case 'box': this.emit('box', frame.box, frame.at); return
      case 'online': this.emit('online', frame.device, frame.online); return
      case 'room-peer': this.emit('room-peer', frame.room); return
      case 'room-say': this.emit('room-say', frame.room, frame.data); return
      case 'room-closed': this.emit('room-closed', frame.room, frame.reason); return
      case 'enrolled': this.emit('enrolled'); return
      case 'forgotten': this.emit('forgotten'); return
    }
  }

  private closed(socket: WebSocket): void {
    if (socket !== this.socket) return
    this.socket = undefined
    this.failWaiting()
    if (!this.wanted) { if (this.state !== 'refused') this.set('off'); return }
    this.set('connecting')
    const delays = this.options.delays ?? DELAYS
    const delay = delays[Math.min(this.tries, delays.length - 1)] * (0.8 + Math.random() * 0.4)
    this.tries++
    this.retry = setTimeout(() => { if (this.wanted && !this.socket) this.connect() }, delay)
    this.retry.unref?.()
  }

  private failWaiting(): void {
    for (const [id, waiter] of this.waiting) {
      clearTimeout(waiter.timer)
      waiter.reject(new CourierError('later', 'The device connection closed.'))
      this.waiting.delete(id)
    }
  }

  private set(state: LinkState): void {
    if (this.state === state) return
    this.state = state
    this.emit('state', state)
  }
}
