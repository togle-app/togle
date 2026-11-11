// The tray icon with an amber dot in its corner, for when something waits for the person. The picture is painted at
// run time from the icon Togle already has, so no second icon has to ship.
import { inflateSync } from 'node:zlib'

/** The order of the bytes of a pixel: Chromium's raw bitmaps are blue first on Windows and macOS, red first on Linux. */
export type PixelOrder = 'bgra' | 'rgba'

const AMBER: readonly [number, number, number] = [0xf5, 0xa5, 0x24]
// A ring in the colour of the window around the dot keeps it apart from the icon behind it.
const RING: readonly [number, number, number] = [0x16, 0x1a, 0x21]

/** Lays a colour over what a pixel holds, in premultiplied bytes, as much as `cover` (0 to 1) says. */
function lay(bitmap: Uint8Array, at: number, order: PixelOrder, colour: readonly [number, number, number], cover: number): void {
  if (cover <= 0) return
  const [r, g, b] = order === 'bgra' ? [2, 1, 0] : [0, 1, 2]
  const keep = 1 - cover
  bitmap[at + r] = Math.round(colour[0] * cover + bitmap[at + r] * keep)
  bitmap[at + g] = Math.round(colour[1] * cover + bitmap[at + g] * keep)
  bitmap[at + b] = Math.round(colour[2] * cover + bitmap[at + b] * keep)
  bitmap[at + 3] = Math.round(255 * cover + bitmap[at + 3] * keep)
}

/** Paints the dot in the lower right corner of a bitmap, in place. */
export function paintDot(bitmap: Uint8Array, width: number, height: number, order: PixelOrder): void {
  if (bitmap.length < width * height * 4) throw new Error('The picture is smaller than its size says.')
  const radius = Math.max(3, width * 0.24)
  const ring = Math.max(1, width * 0.07)
  const cx = width - radius - 0.5
  const cy = height - radius - 0.5
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distance = Math.hypot(x - cx, y - cy)
      const at = (y * width + x) * 4
      lay(bitmap, at, order, RING, Math.min(1, Math.max(0, radius + ring + 0.5 - distance)))
      lay(bitmap, at, order, AMBER, Math.min(1, Math.max(0, radius + 0.5 - distance)))
    }
  }
}

/** Which byte comes first in a raw bitmap, told from the one pixel of a picture written as blue, green, red, alpha. */
export function orderFromProbe(png: Uint8Array): PixelOrder {
  const data = Buffer.from(png)
  const parts: Buffer[] = []
  for (let at = 8; at + 8 <= data.length; ) {
    const length = data.readUInt32BE(at)
    if (data.toString('latin1', at + 4, at + 8) === 'IDAT') parts.push(data.subarray(at + 8, at + 8 + length))
    at += 12 + length
  }
  // The first byte of a row says how it is filtered; with one pixel there is nothing to filter against, so the next is red.
  const red = inflateSync(Buffer.concat(parts))[1]
  return red === 255 ? 'bgra' : 'rgba'
}
