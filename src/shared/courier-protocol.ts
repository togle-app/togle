// What Togle and Togle Studio's courier say to each other. This file is kept identical in Togle
// (src/shared/courier-protocol.ts) and in the courier (courier/src/protocol.ts): change both together.
//
// The courier is the computer Studio rents to carry boxes between one person's devices. A device locks each box for one
// other device (Togle's src/main/reach/crypto.ts), so the courier reads only the outside of a box: who it is from, who
// it is for, and its size. It keeps a box for a device that is off for one day at most. It also opens short-lived rooms
// where a new device and a computer agree on a key from the code the person types. The courier sees the room's two
// letters and never the six that make the secret.

export const COURIER_VERSION = 1
/** The most one frame may carry, in bytes. */
export const MAX_FRAME_BYTES = 256 * 1024
/** The most one message in a room may carry, in characters. */
export const MAX_ROOM_SAY = 16 * 1024
/** How long a box waits for a device that is off. */
export const KEEP_MS = 24 * 3600_000
/** How long a room for adding a device stays open. */
export const ROOM_MS = 10 * 60_000

export type DeviceKind = 'computer' | 'server' | 'phone'

/** A box one device locked for another. The courier reads from and to; nonce and box open only on the two devices. */
export interface Box { from: string; to: string; nonce: string; box: string }

/** A device of the account, as the courier knows it: no name, and nothing about what it does. */
export interface DeviceSeen { device: string; kind: DeviceKind; online: boolean; addedAt: number }

/** The account's connection: on, waiting for Pro, or switched off by the account. */
export type Connection = 'on' | 'needs-pro' | 'off'

/** From a device to the courier. `id` ties an answer to its question. */
export type Up =
  /** The first frame: the device's public keys and what it is. */
  | { t: 'hello'; v: number; device: string; sign: string; agree: string; kind: DeviceKind }
  /** The challenge, signed with the device's key. A computer signing in also gives the account's access token. */
  | { t: 'prove'; signature: string; account?: string; restart?: boolean }
  | { t: 'send'; id: string; box: Box }
  /** A computer adds a device to the account, once the person added it there. */
  | { t: 'enroll'; id: string; device: string; sign: string; agree: string; kind: DeviceKind }
  /** A computer removes a device from the account. */
  | { t: 'forget'; id: string; device: string }
  | { t: 'devices'; id: string }
  /** A device about to be added opens a room and shows its code. `session` is its random id for the exchange. */
  | { t: 'room-open'; id: string; session: string }
  /** A computer the code was typed into joins the room by the code's first two letters. A room takes one join, ever. */
  | { t: 'room-join'; id: string; room: string }
  | { t: 'room-say'; room: string; data: string }
  | { t: 'room-close'; room: string }

/** From the courier to a device. */
export type Down =
  | { t: 'challenge'; nonce: string }
  /**
   * The device proved its key. A `member` belongs to an account, and is told which of the account's devices are online
   * and whether the connection is on. `first`: a computer signing in started the account's devices. `group`: a computer
   * signed in to an account that has devices already, so it is added from one of them.
   */
  | { t: 'welcome'; member: boolean; first?: boolean; group?: boolean; online: string[]; connection?: Connection }
  | { t: 'refused'; code: RefusedCode; message: string }
  | { t: 'box'; box: Box; at: number }
  | { t: 'ok'; id: string; queued?: boolean; devices?: DeviceSeen[]; room?: string; session?: string; expiresAt?: number }
  | { t: 'error'; id?: string; code: ErrorCode; message: string }
  | { t: 'online'; device: string; online: boolean }
  /** To the device that opened a room: a computer joined, and the exchange can start. */
  | { t: 'room-peer'; room: string }
  | { t: 'room-say'; room: string; data: string }
  | { t: 'room-closed'; room: string; reason: 'closed' | 'expired' | 'left' }
  /** This device was added to an account. A welcome follows. */
  | { t: 'enrolled' }
  /** This device was removed from its account, or the account started again from another computer. */
  | { t: 'forgotten' }

export type RefusedCode = 'version' | 'bad-hello' | 'bad-proof' | 'account' | 'elsewhere' | 'busy'
export type ErrorCode = 'bad-frame' | 'not-member' | 'not-computer' | 'not-yours' | 'connection' | 'no-room' | 'room-used' | 'too-many' | 'full' | 'later'

/** What a device signs to prove it holds its key: the text Togle's signWith makes for HELLO_PURPOSE and { device, nonce }. */
export const HELLO_PURPOSE = 'togle-courier-hello'
export const helloText = (nonce: string, device: string): string => `${HELLO_PURPOSE}\n{"device":${JSON.stringify(device)},"nonce":${JSON.stringify(nonce)}}`

/** The letters codes are made of (Crockford's base32). A room is named by two of them. */
export const CODE_LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const isRoom = (value: unknown): value is string => typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{2}$/.test(value)
export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{22}$/.test(value)
/** A 32-byte public key in base64url. */
export const isKey = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
export const isKind = (value: unknown): value is DeviceKind => value === 'computer' || value === 'server' || value === 'phone'
