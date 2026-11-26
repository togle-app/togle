import { createPrivateKey, createPublicKey, randomBytes, sign } from 'node:crypto'
import { recoveryText } from '@shared/courier-protocol'

const DER_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')
const KEY_FORMAT = /^togle-recovery:v1:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/

export interface RecoveryKey { owner: string; seed: string }
export const makeRecoveryKey = (owner: string): RecoveryKey => ({ owner, seed: randomBytes(32).toString('base64url') })

export const formatRecoveryKey = ({ owner, seed }: RecoveryKey): string => `togle-recovery:v1:${owner}:${seed}`

export function parseRecoveryKey(input: string): RecoveryKey {
  const match = KEY_FORMAT.exec(input.trim())
  if (!match || Buffer.from(match[2], 'base64url').toString('base64url') !== match[2]) throw new Error('Paste the complete Togle recovery key.')
  return { owner: match[1], seed: match[2] }
}

function privateKey({ seed }: RecoveryKey) {
  return createPrivateKey({ key: Buffer.concat([DER_PREFIX, Buffer.from(seed, 'base64url')]), format: 'der', type: 'pkcs8' })
}

export const recoveryPublicKey = (key: RecoveryKey): string =>
  createPublicKey(privateKey(key)).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url')

export function proveRecovery(previous: RecoveryKey, nonce: string, device: string, recovery: string): string {
  const message = recoveryText(nonce, device, previous.owner, recovery)
  return sign(null, Buffer.from(message), privateKey(previous)).toString('base64url')
}
