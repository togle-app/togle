import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MAX_SHOW_PNG_BYTES, splitPictures, withFilePaths } from '@shared/pasted-pictures'
import { list, rec, text } from './jsonrpc'

/** A picture key identifies one block of a recorded user message. The renderer never supplies a file path to this reader. */
const prefix = 'codex-image:'
export function codexPicturePosition(key: string): { turnId: string; itemId: string; index: number } | null {
  if (!key.startsWith(prefix)) return null
  try {
    const position: unknown = JSON.parse(key.slice(prefix.length))
    if (!Array.isArray(position) || position.length !== 3) return null
    const [turnId, itemId, index] = position
    if (typeof turnId === 'string' && turnId && typeof itemId === 'string' && itemId && Number.isSafeInteger(index) && index >= 0) return { turnId, itemId, index }
  } catch { /* Unknown or incomplete key. */ }
  return null
}

/** Codex records the spans of its terminal chips as UTF-8 byte offsets, even when the caption contains Unicode. */
function caption(block: Record<string, unknown>, count: number): string {
  const words = text(block.text)
  if (!count) return words
  const elements = list(block.text_elements ?? block.textElements).map(rec)
  if (!elements.length) {
    // Older messages may only have the numbered chips at the start of their caption.
    let rest = words
    for (let n = 1; n <= count && rest.startsWith('[Image #' + n + ']'); n++) rest = rest.slice(('[Image #' + n + ']').length).trimStart()
    return rest
  }
  const bytes = Buffer.from(words), pieces: string[] = []
  let last = 0
  for (const element of elements) {
    const { start, end } = rec(element.byteRange ?? element.byte_range)
    if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < last || end <= start || end > bytes.length) continue
    const marker = bytes.toString('utf8', start, end)
    if (!/^\[Image #[1-9]\d*\]$/.test(marker) || (element.placeholder != null && element.placeholder !== marker)) continue
    pieces.push(bytes.toString('utf8', last, start))
    last = end
    if (bytes[start - 1] === 32 && bytes[last] === 32) last++
  }
  return pieces.join('') + bytes.toString('utf8', last)
}

const fileKey = (file: string): string => process.platform === 'win32' ? path.normalize(file).toLowerCase() : path.normalize(file)

export function codexUserMessage(turnId: string, item: Record<string, unknown>): { words: string; images: string[] } {
  const content = list(item.content).map(rec), images: string[] = [], files = new Set<string>()
  content.forEach((block, index) => {
    if (block.type !== 'localImage' && block.type !== 'image') return
    images.push(prefix + JSON.stringify([turnId, item.id, index]))
    if (block.type === 'localImage' && typeof block.path === 'string') files.add(fileKey(block.path))
  })
  let words = content.filter(block => block.type === 'text').map(block => caption(block, images.length)).join('\n').trim()
  if (files.size) {
    // A managed paste can be recorded both as an attachment and as its path in the caption.
    const split = splitPictures(words)
    const remaining = split.files.filter(file => !files.has(fileKey(file)))
    if (remaining.length !== split.files.length) words = withFilePaths(split.words, remaining)
  }
  return { words, images }
}

function rasterType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return 'image/gif'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return undefined
}

export async function readCodexPicture(input: unknown): Promise<{ type: string; data: string } | null> {
  const block = rec(input)
  if (block.type === 'image') {
    const url = text(block.url)
    const header = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i.exec(url)
    if (!header || url.length - header[0].length > 4 * Math.ceil(MAX_SHOW_PNG_BYTES / 3)) return null
    const data = url.slice(header[0].length), type = rasterType(Buffer.from(data.slice(0, 24), 'base64'))
    return type === header[1].toLowerCase() ? { type, data } : null
  }
  const file = text(block.path)
  if (block.type !== 'localImage' || !path.isAbsolute(file) || /^[\\/]{2}/.test(file)) return null
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || !stat.size || stat.size > MAX_SHOW_PNG_BYTES) return null
    const bytes = await fs.readFile(file), type = rasterType(bytes)
    return type && bytes.length <= MAX_SHOW_PNG_BYTES ? { type, data: bytes.toString('base64') } : null
  } catch { return null }
}
