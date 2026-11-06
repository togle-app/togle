// The files in a zip, and one of them read as it unpacks: an export of their chats can be gigabytes (the pictures in
// it), and only the part of it that holds their conversations is read, never the whole file into memory.
import { createReadStream, promises as fs } from 'node:fs'
import { pipeline, Readable } from 'node:stream'
import { createInflateRaw } from 'node:zlib'

export interface ZipEntry {
  name: string
  /** How it's packed: 0 stored, 8 deflated (no other way is read). */
  method: number
  size: number
  packed: number
  /** Where its own header is in the zip. */
  offset: number
  encrypted: boolean
}

const END = 0x06054b50
const ZIP64_LOCATOR = 0x07064b50
const ZIP64_END = 0x06064b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const FULL16 = 0xffff
const FULL32 = 0xffffffff
// A list of files longer than this is no export's (that's millions of files).
const MAX_LIST_BYTES = 64 * 1048576

type Handle = Awaited<ReturnType<typeof fs.open>>

async function readAt(handle: Handle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buf, 0, length, position)
  return buf.subarray(0, bytesRead)
}

/** The files a zip holds, from the list at its end; null when it isn't a zip, or not a whole one. */
export async function zipEntries(file: string): Promise<ZipEntry[] | null> {
  const handle = await fs.open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const { size } = await handle.stat()
    if (size < 22) return null
    // The record that ends a zip, after which only a comment (of 64 KB at most) comes.
    const tail = await readAt(handle, size - Math.min(size, 22 + FULL16), Math.min(size, 22 + FULL16))
    let end = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === END) {
        end = i
        break
      }
    }
    if (end < 0) return null
    let count = tail.readUInt16LE(end + 10)
    let listBytes = tail.readUInt32LE(end + 12)
    let listAt = tail.readUInt32LE(end + 16)
    if (count === FULL16 || listBytes === FULL32 || listAt === FULL32) {
      // A zip of more than 4 GB (or 65,535 files) says where its list is in a record of its own, just before.
      const locator = end - 20
      if (locator < 0 || tail.readUInt32LE(locator) !== ZIP64_LOCATOR) return null
      const record = await readAt(handle, Number(tail.readBigUInt64LE(locator + 8)), 56)
      if (record.length < 56 || record.readUInt32LE(0) !== ZIP64_END) return null
      count = Number(record.readBigUInt64LE(32))
      listBytes = Number(record.readBigUInt64LE(40))
      listAt = Number(record.readBigUInt64LE(48))
    }
    if (listBytes > MAX_LIST_BYTES || listAt + listBytes > size) return null
    const list = await readAt(handle, listAt, listBytes)
    const entries: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (p + 46 > list.length || list.readUInt32LE(p) !== CENTRAL) return null
      const flags = list.readUInt16LE(p + 8)
      let packed = list.readUInt32LE(p + 20)
      let unpacked = list.readUInt32LE(p + 24)
      const nameBytes = list.readUInt16LE(p + 28)
      const extraBytes = list.readUInt16LE(p + 30)
      const commentBytes = list.readUInt16LE(p + 32)
      let offset = list.readUInt32LE(p + 42)
      const name = list.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameBytes)
      // What doesn't fit in 4 bytes is in an extra field, in this order (a zip of more than 4 GB).
      const extraEnd = p + 46 + nameBytes + extraBytes
      for (let e = p + 46 + nameBytes; e + 4 <= extraEnd; ) {
        const id = list.readUInt16LE(e)
        const bytes = list.readUInt16LE(e + 2)
        if (id === 0x0001) {
          let q = e + 4
          const next = (): number => {
            const value = q + 8 <= e + 4 + bytes ? Number(list.readBigUInt64LE(q)) : FULL32
            q += 8
            return value
          }
          if (unpacked === FULL32) unpacked = next()
          if (packed === FULL32) packed = next()
          if (offset === FULL32) offset = next()
        }
        e += 4 + bytes
      }
      entries.push({ name, method: list.readUInt16LE(p + 10), size: unpacked, packed, offset, encrypted: (flags & 1) === 1 })
      p = extraEnd + commentBytes
    }
    return entries
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** One file of a zip as it unpacks: only its part of the zip is read. */
export async function entryStream(file: string, entry: ZipEntry): Promise<Readable> {
  if (entry.encrypted || (entry.method !== 0 && entry.method !== 8)) throw new Error(`${entry.name} is packed in a way Togle doesn't read`)
  const handle = await fs.open(file, 'r')
  let header: Buffer
  try {
    header = await readAt(handle, entry.offset, 30)
  } finally {
    await handle.close()
  }
  if (header.length < 30 || header.readUInt32LE(0) !== LOCAL) throw new Error('the zip is damaged')
  if (!entry.packed) return Readable.from([])
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const raw = createReadStream(file, { start, end: start + entry.packed - 1, highWaterMark: 1 << 20 })
  if (entry.method === 0) return raw
  // Stopped early (the chat it's read for found), the file closes too.
  const out = createInflateRaw()
  pipeline(raw, out, () => {})
  return out
}
