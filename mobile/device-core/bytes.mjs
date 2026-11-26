// The Buffer operations used by the shared device protocol.
import { Buffer } from 'buffer'

export class Bytes extends Uint8Array {
  static from(value, encoding = 'utf8') {
    if (typeof value !== 'string') return new Bytes(value)
    return new Bytes(Buffer.from(value, encoding === 'base64url' ? 'base64' : encoding))
  }

  static concat(parts) {
    const result = new Bytes(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) { result.set(part, offset); offset += part.length }
    return result
  }

  toString(encoding = 'utf8') {
    const bytes = Buffer.from(this)
    return encoding === 'base64url'
      ? bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      : bytes.toString(encoding)
  }
}
