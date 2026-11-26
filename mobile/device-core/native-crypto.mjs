// The desktop protocol's crypto interfaces backed by Noble and the system random source.
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { sha256, sha512 } from '@noble/hashes/sha2.js'
import { hmac } from '@noble/hashes/hmac.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { Bytes } from './bytes.mjs'
import { gcm } from '@noble/ciphers/aes.js'
import { equalBytes } from '@noble/ciphers/utils.js'

export const randomBytes = size => globalThis.crypto.getRandomValues(new Bytes(size))
const hashFor = name => {
  if (name === 'sha256') return sha256
  if (name === 'sha512') return sha512
  throw new Error('Unsupported hash.')
}
function digest(hash) {
  return {
    update(chunk) { hash.update(Bytes.from(chunk)); return this },
    digest() { return Bytes.from(hash.digest()) }
  }
}
export const createHash = name => digest(hashFor(name).create())
export const createHmac = (name, key) => digest(hmac.create(hashFor(name), key))
export const hkdfSync = (name, key, salt, info, length) => hkdf(hashFor(name), key, salt, info, length)
export const timingSafeEqual = equalBytes

// RFC 8410: fixed DER prefixes for 32-byte RFC 8032/7748 private seeds and public keys.
const keys = {
  ed25519: { curve: ed25519, spki: '302a300506032b6570032100', pkcs8: '302e020100300506032b657004220420' },
  x25519: { curve: x25519, spki: '302a300506032b656e032100', pkcs8: '302e020100300506032b656e04220420' }
}
function keyObject(algorithm, type, raw) {
  return {
    algorithm, raw, type,
    export(spec) {
      if (spec.format !== 'der' || spec.type !== type) throw new Error('Unsupported key format.')
      return Bytes.concat([Bytes.from(keys[algorithm][type], 'hex'), raw])
    }
  }
}
function parseKey(spec, type) {
  if (spec.format !== 'der' || spec.type !== type) throw new Error('Unsupported key format.')
  for (const [algorithm, entry] of Object.entries(keys)) {
    const prefix = Bytes.from(entry[type], 'hex')
    if (spec.key.length === prefix.length + 32 && prefix.every((b, i) => b === spec.key[i]))
      return keyObject(algorithm, type, spec.key.subarray(prefix.length))
  }
  throw new Error('Unsupported key.')
}
export const createPrivateKey = spec => parseKey(spec, 'pkcs8')
export const createPublicKey = spec => parseKey(spec, 'spki')
export function generateKeyPairSync(algorithm) {
  const { curve } = keys[algorithm]
  const secret = randomBytes(32)
  return { privateKey: keyObject(algorithm, 'pkcs8', secret), publicKey: keyObject(algorithm, 'spki', curve.getPublicKey(secret)) }
}
function checked(key, algorithm, type) {
  if (key.algorithm !== algorithm || key.type !== type) throw new Error('Wrong key for operation.')
  return key.raw
}
export function sign(digest, data, key) {
  if (digest !== null) throw new Error('Unsupported signature algorithm.')
  return ed25519.sign(data, checked(key, 'ed25519', 'pkcs8'))
}
export function verify(digest, data, key, signature) {
  if (digest !== null) return false
  return ed25519.verify(signature, data, checked(key, 'ed25519', 'spki'), { zip215: false })
}
export function diffieHellman({ privateKey, publicKey }) {
  return x25519.getSharedSecret(checked(privateKey, 'x25519', 'pkcs8'), checked(publicKey, 'x25519', 'spki'))
}

function aesGcm(encrypt, name, key, nonce) {
  if (name !== 'aes-256-gcm' || key.length !== 32 || nonce.length !== 12) throw new Error('Unsupported cipher parameters.')
  let aad = new Bytes(), tag
  const chunks = []
  return {
    setAAD(data) { aad = data },
    setAuthTag(data) { if (data.length !== 16) throw new Error('Invalid tag.'); tag = data },
    getAuthTag() { if (!tag) throw new Error('Missing tag.'); return tag },
    update(data) { chunks.push(data); return new Bytes() },
    final() {
      if (!encrypt && !tag) throw new Error('Missing tag.')
      const data = Bytes.concat(encrypt ? chunks : [...chunks, tag])
      const cipher = gcm(key, nonce, aad)
      const result = new Bytes(encrypt ? cipher.encrypt(data) : cipher.decrypt(data))
      if (!encrypt) return result
      tag = result.subarray(-16)
      return result.subarray(0, -16)
    }
  }
}
export const createCipheriv = (name, key, nonce) => aesGcm(true, name, key, nonce)
export const createDecipheriv = (name, key, nonce) => aesGcm(false, name, key, nonce)
