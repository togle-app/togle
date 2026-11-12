// Reach's cryptography, as the Togle Studio design sets it. Each device makes its own keys; Studio's servers only carry
// what devices lock for each other and hold no key that opens it.
//   identity  an Ed25519 key that signs (passes, roster changes) and an X25519 key that agrees on locks with each device
//   pairing   a code shown on the new device and typed at a computer: CPace on ristretto255, so the relay that carries the
//             exchange can't try codes offline, and a wrong code ends the exchange (one try)
//   locks     per pair of devices, AES-256-GCM under a key from X25519 and HKDF-SHA-256, bound to who sends to whom
//   passes    what a device may do (its role) and its keys, signed by a computer of the group, for a week
//   proofs    an Allow or a Start from another device, signed for that exact command by a key that needs the person
//             (a fingerprint, face or PIN), and checked by the computer that runs the agent: right key, right command, fresh
// Not reviewed yet: Reach stays out of every release until an outside review has tried to break it.
import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign as signData, timingSafeEqual, verify as verifyData, createCipheriv, createDecipheriv, type KeyObject } from 'node:crypto'
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js'

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url')
const unb64 = (text: string): Buffer => Buffer.from(text, 'base64url')
const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')

// ---- Identity ------------------------------------------------------------------------------------------------------------

/** A device's public keys and the id they make. */
export interface DeviceKeys { device: string; sign: string; agree: string }
/** A device's own keys, private halves included (kept encrypted by the system, never sent). */
export interface Identity extends DeviceKeys { signKey: string; agreeKey: string }

const raw = (key: KeyObject): Buffer => {
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer
  return der.subarray(der.length - 32)
}
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex')
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')
const publicEd25519 = (key: string): KeyObject => createPublicKey({ key: Buffer.concat([ED25519_SPKI, unb64(key)]), format: 'der', type: 'spki' })
const publicX25519 = (key: string): KeyObject => createPublicKey({ key: Buffer.concat([X25519_SPKI, unb64(key)]), format: 'der', type: 'spki' })

/** A device's id: the first 128 bits of SHA-256 over both its public keys, in 22 characters. */
export const deviceId = (sign: string, agree: string): string =>
  b64(createHash('sha256').update('togle-reach-device-v1').update(unb64(sign)).update(unb64(agree)).digest().subarray(0, 16)).slice(0, 22)

export function makeIdentity(): Identity {
  const signing = generateKeyPairSync('ed25519'), agreeing = generateKeyPairSync('x25519')
  const sign = b64(raw(signing.publicKey)), agree = b64(raw(agreeing.publicKey))
  return {
    device: deviceId(sign, agree), sign, agree,
    signKey: (signing.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64url'),
    agreeKey: (agreeing.privateKey.export({ type: 'pkcs8', format: 'der' }) as Buffer).toString('base64url')
  }
}
export const publicKeys = ({ device, sign, agree }: DeviceKeys): DeviceKeys => ({ device, sign, agree })
const privateKey = (pkcs8: string): KeyObject => createPrivateKey({ key: unb64(pkcs8), format: 'der', type: 'pkcs8' })

/** Canonical JSON: keys sorted at every level, so a signature covers one exact text. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export const signWith = (identity: Identity, what: string, value: unknown): string =>
  b64(signData(null, utf8(`${what}\n${canonical(value)}`), privateKey(identity.signKey)))
export const signedBy = (sign: string, what: string, value: unknown, signature: string): boolean => {
  try { return verifyData(null, utf8(`${what}\n${canonical(value)}`), publicEd25519(sign), unb64(signature)) } catch { return false }
}

// ---- Pairing: CPace on ristretto255 ------------------------------------------------------------------------------------

// Crockford's base32 without the letters people misread: 8 of them make about 40 bits, shown as 7F3K-92QD.
const CODE_LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export function pairingCode(): string {
  const bytes = randomBytes(8)
  const letters = [...bytes].map((byte) => CODE_LETTERS[byte & 31]).join('')
  return `${letters.slice(0, 4)}-${letters.slice(4)}`
}
/** A code as typed: case, spaces, dashes and look-alike letters forgiven. */
export const normalCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V')

const DSI = utf8('togle-reach-cpace-v1')
const Point = ristretto255.Point
const lengthPrefixed = (...parts: Uint8Array[]): Buffer => Buffer.concat(parts.flatMap((part) => [Buffer.from([part.length >> 8, part.length & 255]), Buffer.from(part)]))
const randomScalar = (): bigint => {
  for (;;) {
    const scalar = BigInt('0x' + randomBytes(64).toString('hex')) % Point.Fn.ORDER
    if (scalar !== 0n) return scalar
  }
}

/**
 * One side of CPace. The new device (responder) shows the code and a session id; the computer (initiator) has the code
 * typed in. Each sends its share; both get the same key only with the same code. The confirmations prove that before
 * anything else is sent, and a wrong one ends the exchange: the code is used up either way.
 */
export class Cpace {
  private readonly scalar = randomScalar()
  private readonly generator: InstanceType<typeof Point>
  readonly share: Uint8Array
  private secret?: Buffer
  private transcript?: Buffer

  constructor(code: string, private readonly session: Uint8Array, private readonly role: 'initiator' | 'responder') {
    if (session.length < 16) throw new Error('The pairing session id is too short.')
    this.generator = ristretto255_hasher.hashToCurve(lengthPrefixed(DSI, utf8(normalCode(code)), session), { DST: 'togle-reach-cpace-generator-v1' })
    this.share = this.generator.multiply(this.scalar).toBytes()
  }

  /** The key both sides now share, and this side's confirmation to send. */
  finish(peerShare: Uint8Array): { key: Buffer; confirm: Buffer } {
    const peer = Point.fromBytes(peerShare)
    if (peer.equals(Point.ZERO)) throw new Error('The other device sent no share.')
    const shared = peer.multiply(this.scalar).toBytes()
    const [first, second] = this.role === 'initiator' ? [this.share, peerShare] : [peerShare, this.share]
    this.transcript = lengthPrefixed(DSI, this.session, first, second)
    this.secret = createHash('sha512').update(lengthPrefixed(utf8('ISK'), this.transcript, shared)).digest()
    return { key: this.secret.subarray(0, 32), confirm: this.confirmation(this.role) }
  }

  private confirmation(role: 'initiator' | 'responder'): Buffer {
    if (!this.secret || !this.transcript) throw new Error('Finish the exchange first.')
    return createHmac('sha256', this.secret.subarray(32)).update(lengthPrefixed(utf8(`confirm-${role}`), this.transcript)).digest()
  }

  /** Whether the other side had the same code. */
  confirmed(peerConfirm: Uint8Array): boolean {
    const expected = this.confirmation(this.role === 'initiator' ? 'responder' : 'initiator')
    return peerConfirm.length === expected.length && timingSafeEqual(expected, Buffer.from(peerConfirm))
  }
}

// ---- Locks between two devices -----------------------------------------------------------------------------------------

/** The key two devices lock for each other with: the same on both sides, and different for every pair. */
export function pairKey(identity: Identity, peer: DeviceKeys): Buffer {
  const shared = diffieHellman({ privateKey: privateKey(identity.agreeKey), publicKey: publicX25519(peer.agree) })
  const ids = [identity.device, peer.device].sort().join('|')
  return Buffer.from(hkdfSync('sha256', shared, utf8(ids), utf8('togle-reach-lock-v1'), 32))
}

export interface Locked { from: string; to: string; nonce: string; box: string }

/** Locks a message from one device to another; only the pair's key opens it, and it says who sent it to whom. */
export function lock(key: Uint8Array, from: string, to: string, message: unknown): Locked {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(utf8(`togle-reach-v1|${from}|${to}`))
  const box = Buffer.concat([cipher.update(utf8(JSON.stringify(message))), cipher.final(), cipher.getAuthTag()])
  return { from, to, nonce: b64(nonce), box: b64(box) }
}

export function unlock<T = unknown>(key: Uint8Array, locked: Locked): T {
  const box = unb64(locked.box)
  if (box.length < 16) throw new Error('A locked message too short to be one.')
  const decipher = createDecipheriv('aes-256-gcm', key, unb64(locked.nonce))
  decipher.setAAD(utf8(`togle-reach-v1|${locked.from}|${locked.to}`))
  decipher.setAuthTag(box.subarray(box.length - 16))
  return JSON.parse(Buffer.concat([decipher.update(box.subarray(0, box.length - 16)), decipher.final()]).toString('utf8')) as T
}

// ---- Passes --------------------------------------------------------------------------------------------------------------

/** What a device is: a computer you sit at, a server that only runs agents, or a phone. */
export type Role = 'computer' | 'server' | 'phone'

/** The key that needs the person (fingerprint, face or PIN): its kind and its public half. */
export interface PresenceKey { kind: 'ed25519' | 'rsa-pkcs1-sha256'; key: string }

export interface Pass extends DeviceKeys {
  v: 1
  name: string
  role: Role
  presence?: PresenceKey
  /** A phone may type to agents and start tasks only with this switched on when it was added. */
  starts?: boolean
  issuedAt: number
  expiresAt: number
  /** The computer that signed it. */
  issuer: string
  signature: string
}

export const PASS_DAYS = 7

export function issuePass(issuer: Identity, device: Omit<Pass, 'v' | 'issuedAt' | 'expiresAt' | 'issuer' | 'signature'>, now = Date.now()): Pass {
  const body = { ...device, v: 1 as const, issuedAt: now, expiresAt: now + PASS_DAYS * 86_400_000, issuer: issuer.device }
  return { ...body, signature: signWith(issuer, 'togle-reach-pass', body) }
}

/** Whether a pass holds now: signed by a computer this device trusts, not run out, and naming its own keys. */
export function passHolds(pass: Pass, issuers: Pick<Pass, 'device' | 'sign' | 'role'>[], now = Date.now()): boolean {
  const { signature, ...body } = pass
  const issuer = issuers.find((entry) => entry.device === pass.issuer && entry.role === 'computer')
  return !!issuer && pass.v === 1 && now >= pass.issuedAt - 60_000 && now < pass.expiresAt
    && pass.device === deviceId(pass.sign, pass.agree) && signedBy(issuer.sign, 'togle-reach-pass', body, signature)
}

// ---- Proofs --------------------------------------------------------------------------------------------------------------

/** What another device asks a computer to do, that needs the person there. */
export interface Act { kind: 'allow' | 'start'; task: string; request?: string; command: string; folder?: string; at: number; device: string }

export const PROOF_SECONDS = 60

/** Checks a proof: made by that device's presence key, for exactly this act, seconds ago. */
export function proofHolds(act: Act, proof: string, pass: Pass, expected: Pick<Act, 'kind' | 'task' | 'command'> & { request?: string }, now = Date.now()): boolean {
  if (act.device !== pass.device || !pass.presence) return false
  if (act.kind !== expected.kind || act.task !== expected.task || act.command !== expected.command || (act.request ?? '') !== (expected.request ?? '')) return false
  if (now - act.at > PROOF_SECONDS * 1000 || act.at - now > 10_000) return false
  const text = utf8(`togle-reach-act\n${canonical(act)}`)
  try {
    if (pass.presence.kind === 'ed25519') return verifyData(null, text, publicEd25519(pass.presence.key), unb64(proof))
    return verifyData('sha256', text, createPublicKey({ key: unb64(pass.presence.key), format: 'der', type: 'spki' }), unb64(proof))
  } catch { return false }
}

/** The text a presence key signs for an act (the phone and Windows Hello sign exactly this). */
export const actText = (act: Act): Buffer => utf8(`togle-reach-act\n${canonical(act)}`)
