// Adding a device by its code, on both sides. The new device shows a code: two letters that name a room on Studio's
// courier, and six secret ones. The person types it into a computer of the group. The two run CPace on the whole code
// through the room, and each proves it got the same key before anything else is said, so the courier, which carries
// every word, learns nothing it can use, and one wrong code ends the exchange. Then, locked with that key, the new
// device says who it is, the computer shows the person, and on their yes sends its pass and the group's book.
import { randomBytes } from 'node:crypto'
import { CODE_LETTERS } from '@shared/courier-protocol'
import { Cpace, deviceId, lock, normalCode, unlock, type DeviceKeys, type Pass, type PresenceKey, type Role } from './crypto'
import { isPass, type BookData } from './book'

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url')

/** A code for a room: its two letters, then six secret ones, shown as 7F3K-92QD. */
export function codeFor(room: string): string {
  const letters = room + [...randomBytes(6)].map((byte) => CODE_LETTERS[byte & 31]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}
export const isCode = (code: string): boolean => /^[0-9A-HJKMNP-TV-Z]{8}$/.test(normalCode(code))
export const roomOf = (code: string): string => normalCode(code).slice(0, 2)

/** What the new device says about itself, inside the exchange. */
export interface Candidate extends DeviceKeys { kind: Role; name: string; presence?: PresenceKey }
/** What the computer gives the new device once the person said yes. */
export interface Welcome { pass: Pass; adder: Pass; book: BookData }

export const WRONG_CODE = 'That code didn’t match. Check it on the other device and type it again, or show a new one there.'

// The two labels a lock in the exchange carries, so a message from one side can't be passed off as the other's.
const NEW = 'pairing-new-device'
const COMPUTER = 'pairing-computer'

type Step =
  | { step: 'share'; share: string; confirm?: string }
  | { step: 'confirm'; confirm: string }
  | { step: 'me'; nonce: string; box: string }
  | { step: 'welcome'; nonce: string; box: string }
  | { step: 'done' }
  | { step: 'wrong' }
  | { step: 'no' }

function read(data: string): Step | undefined {
  try {
    const step = JSON.parse(data) as Step
    return step && typeof step === 'object' && typeof step.step === 'string' ? step : undefined
  } catch { return undefined }
}
const isB64 = (value: unknown, min: number, max: number): value is string => typeof value === 'string' && value.length >= min && value.length <= max && /^[A-Za-z0-9_-]+$/.test(value)

function isCandidate(value: unknown): value is Candidate {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  const presence = candidate.presence as Record<string, unknown> | undefined
  return typeof candidate.device === 'string' && typeof candidate.sign === 'string' && typeof candidate.agree === 'string'
    && candidate.device === deviceId(candidate.sign, candidate.agree)
    && (candidate.kind === 'computer' || candidate.kind === 'server' || candidate.kind === 'phone')
    && typeof candidate.name === 'string' && candidate.name.trim().length > 0 && candidate.name.length <= 60
    && (presence === undefined || (!!presence && (presence.kind === 'ed25519' || presence.kind === 'rsa-pkcs1-sha256') && typeof presence.key === 'string' && presence.key.length <= 2048))
}

/** What one message from the other side leads to. */
export interface Outcome<T> { say?: string; result?: T; failed?: string }

/** The new device's side: it showed the code, and answers the computer the code was typed into. */
export class Joining {
  readonly code: string
  private readonly cpace: Cpace
  private readonly me: Candidate
  private key?: Buffer
  private state: 'waiting' | 'exchanging' | 'confirmed' | 'done' | 'failed' = 'waiting'

  constructor(code: string, session: Uint8Array, me: Candidate) {
    this.code = code
    this.me = me
    this.cpace = new Cpace(code, session, 'responder')
  }

  get finished(): boolean { return this.state === 'done' || this.state === 'failed' }

  receive(data: string): Outcome<Welcome> {
    const message = read(data)
    if (!message) return this.fail('The computer sent something this device can’t read.')
    if (message.step === 'wrong') return this.fail(WRONG_CODE)
    if (message.step === 'no') return this.fail('The device wasn’t added: the person at the computer said no.')
    if (message.step === 'share' && this.state === 'waiting' && isB64(message.share, 40, 48)) {
      let finished: { key: Buffer; confirm: Buffer }
      try { finished = this.cpace.finish(unb64(message.share)) } catch { return this.fail(WRONG_CODE) }
      this.key = finished.key
      this.state = 'exchanging'
      return { say: JSON.stringify({ step: 'share', share: b64(this.cpace.share), confirm: b64(finished.confirm) }) }
    }
    if (message.step === 'confirm' && this.state === 'exchanging' && isB64(message.confirm, 40, 48)) {
      if (!this.cpace.confirmed(unb64(message.confirm))) return this.fail(WRONG_CODE)
      this.state = 'confirmed'
      const locked = lock(this.key!, NEW, COMPUTER, this.me)
      return { say: JSON.stringify({ step: 'me', nonce: locked.nonce, box: locked.box }) }
    }
    if (message.step === 'welcome' && this.state === 'confirmed' && isB64(message.nonce, 16, 16) && isB64(message.box, 16, 400_000)) {
      let welcome: Welcome
      try { welcome = unlock<Welcome>(this.key!, { from: COMPUTER, to: NEW, nonce: message.nonce, box: message.box }) } catch { return this.fail('The computer’s answer didn’t open.') }
      const pass = welcome?.pass
      if (!isPass(pass) || !isPass(welcome.adder) || pass.device !== this.me.device || pass.sign !== this.me.sign || pass.agree !== this.me.agree || pass.issuer !== welcome.adder.device) {
        return this.fail('The computer’s answer wasn’t a pass for this device.')
      }
      this.state = 'done'
      return { say: JSON.stringify({ step: 'done' }), result: welcome }
    }
    return this.fail('The exchange went out of order, so it stopped.')
  }

  private fail(why: string): Outcome<Welcome> {
    this.state = 'failed'
    return { failed: why }
  }
}

/** The computer's side: the person typed the code, and the computer joined its room. */
export class Adding {
  private readonly cpace: Cpace
  private key?: Buffer
  private state: 'started' | 'confirmed' | 'candidate' | 'welcomed' | 'done' | 'failed' = 'started'
  candidate?: Candidate

  constructor(code: string, session: Uint8Array) {
    this.cpace = new Cpace(code, session, 'initiator')
  }

  get finished(): boolean { return this.state === 'done' || this.state === 'failed' }

  /** The first message, sent once the room is joined. */
  open(): string { return JSON.stringify({ step: 'share', share: b64(this.cpace.share) }) }

  receive(data: string): Outcome<Candidate | 'done'> {
    const message = read(data)
    if (!message) return this.fail('The new device sent something this computer can’t read.')
    if (message.step === 'wrong') return this.fail(WRONG_CODE)
    if (message.step === 'share' && this.state === 'started' && isB64(message.share, 40, 48) && isB64(message.confirm, 40, 48)) {
      let finished: { key: Buffer; confirm: Buffer }
      try { finished = this.cpace.finish(unb64(message.share)) } catch { return { ...this.fail(WRONG_CODE), say: JSON.stringify({ step: 'wrong' }) } }
      if (!this.cpace.confirmed(unb64(message.confirm))) return { ...this.fail(WRONG_CODE), say: JSON.stringify({ step: 'wrong' }) }
      this.key = finished.key
      this.state = 'confirmed'
      return { say: JSON.stringify({ step: 'confirm', confirm: b64(finished.confirm) }) }
    }
    if (message.step === 'me' && this.state === 'confirmed' && isB64(message.nonce, 16, 16) && isB64(message.box, 16, 8000)) {
      let candidate: unknown
      try { candidate = unlock(this.key!, { from: NEW, to: COMPUTER, nonce: message.nonce, box: message.box }) } catch { return this.fail('The new device’s answer didn’t open.') }
      if (!isCandidate(candidate)) return this.fail('The new device didn’t say who it is in a way this computer can check.')
      this.candidate = { device: candidate.device, sign: candidate.sign, agree: candidate.agree, kind: candidate.kind, name: candidate.name.trim(), ...(candidate.presence ? { presence: candidate.presence } : {}) }
      this.state = 'candidate'
      return { result: this.candidate }
    }
    if (message.step === 'done' && this.state === 'welcomed') {
      this.state = 'done'
      return { result: 'done' }
    }
    return this.fail('The exchange went out of order, so it stopped.')
  }

  /** The person said yes: the welcome to send, locked with the exchange's key. */
  welcome(welcome: Welcome): string {
    if (this.state !== 'candidate') throw new Error('There is no device waiting to be added.')
    this.state = 'welcomed'
    const locked = lock(this.key!, COMPUTER, NEW, welcome)
    return JSON.stringify({ step: 'welcome', nonce: locked.nonce, box: locked.box })
  }

  /** The person said no. */
  refuse(): string {
    this.state = 'failed'
    return JSON.stringify({ step: 'no' })
  }

  private fail(why: string): Outcome<Candidate | 'done'> {
    this.state = 'failed'
    return { failed: why }
  }
}
