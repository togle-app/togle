import { desktopCapturer, nativeImage, screen, type BrowserWindow, type DesktopCapturerSource, type Display, type NativeImage } from 'electron'
import type { CaptureSource, ScreenOption } from '@shared/types'

// Wide enough to read code on a 4K screen exactly (at 1600 a model misreads some characters).
const MAX_WIDTH = 2560
const THUMB_WIDTH = 320
// The screen picker's pictures.
const PICK_SIZE = { width: 320, height: 180 }

export const displayUnderCursor = (): Display => screen.getDisplayNearestPoint(screen.getCursorScreenPoint())

/** The display with this id, or the one under the cursor when no id is given. */
function displayFor(id?: number): Display {
  if (id === undefined) return displayUnderCursor()
  const display = screen.getAllDisplays().find((d) => d.id === id)
  if (!display) throw new Error('That screen is no longer connected')
  return display
}

/**
 * A display's size in pixels. The picture is scaled to fit the size it's asked for, up or down, so a screen at
 * 150% asked for in its scaled units came back at two thirds of its pixels, and one asked for a pixel off comes
 * back resampled. Converting the units can be a pixel off (1707 units at 150% are 2560.5, and dipToScreenRect
 * says 2561): screens have an even number of pixels each way.
 */
function pixelSize(display: Display): { width: number; height: number } {
  const even = (units: number): number => 2 * Math.round((units * display.scaleFactor) / 2)
  return { width: even(display.bounds.width), height: even(display.bounds.height) }
}

/**
 * The capture source showing a display: by its id, or where the system gives sources no ids (remote desktops,
 * some virtual machines), the one screen of that shape. Their order doesn't help: it can differ from the displays'
 * (on a PC with two screens it did).
 */
function sourceFor(sources: DesktopCapturerSource[], display: Display): DesktopCapturerSource | undefined {
  const byId = sources.find((s) => s.display_id === String(display.id))
  if (byId) return byId
  // One screen: it's that one, whatever id it was given.
  if (sources.length === 1) return sources[0]
  if (sources.some((s) => s.display_id)) return undefined
  const shape = display.bounds.width / display.bounds.height
  const alike = sources.filter((s) => {
    const { width, height } = s.thumbnail.getSize()
    return height > 0 && Math.abs(width / height / shape - 1) < 0.01
  })
  return alike.length === 1 ? alike[0] : undefined
}

async function grab(display: Display, width: number): Promise<NativeImage | null> {
  const size = pixelSize(display)
  const scale = Math.min(1, width / size.width)
  const thumbnailSize = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize })
  const source = sourceFor(sources, display)
  if (!source && sources.length) throw new Error("Couldn't tell your screens apart to capture that one")
  return source && !source.thumbnail.isEmpty() ? source.thumbnail : null
}

/** Paints Togle's own window dark in a BGRA bitmap, so it never appears in its own snapshots. */
function maskOverlay(image: NativeImage, win: BrowserWindow | null, display: Display): Buffer {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  if (!win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) return bitmap
  const b = win.getBounds()
  const d = display.bounds
  const s = width / d.width
  const x0 = Math.max(0, Math.floor((Math.max(b.x, d.x) - d.x) * s))
  const y0 = Math.max(0, Math.floor((Math.max(b.y, d.y) - d.y) * s))
  const x1 = Math.min(width, Math.ceil((Math.min(b.x + b.width, d.x + d.width) - d.x) * s))
  const y1 = Math.min(height, Math.ceil((Math.min(b.y + b.height, d.y + d.height) - d.y) * s))
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      bitmap[i] = bitmap[i + 1] = bitmap[i + 2] = 0x22
      bitmap[i + 3] = 0xff
    }
  }
  return bitmap
}

/**
 * A snapshot of a display (the one with this id, else the one under the cursor): full JPEG plus a thumbnail.
 * Togle is blanked out, unless captures already leave it out (`hidden`); then the picture holds what's behind
 * it, which is worth keeping.
 */
export async function captureFrame(win: BrowserWindow | null, hidden: boolean, displayId?: number): Promise<{ image: Buffer; thumb: Buffer }> {
  const display = displayFor(displayId)
  const grabbed = await grab(display, MAX_WIDTH)
  if (!grabbed) throw new Error('No screen available to capture')
  const shot = hidden ? grabbed : nativeImage.createFromBitmap(maskOverlay(grabbed, win, display), grabbed.getSize())
  return { image: shot.toJPEG(82), thumb: shot.resize({ width: THUMB_WIDTH, quality: 'good' }).toJPEG(70) }
}

/**
 * The screens, left to right as they're arranged, to pick one for a picture. Each comes with a small picture
 * of what's on it when there's more than one; with a single screen there's nothing to pick.
 */
export async function listScreens(win: BrowserWindow | null): Promise<ScreenOption[]> {
  const displays = screen.getAllDisplays().toSorted((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const sources = displays.length > 1 ? await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: PICK_SIZE }) : []
  const primary = screen.getPrimaryDisplay().id
  const togle = win && !win.isDestroyed() ? screen.getDisplayMatching(win.getBounds()).id : undefined
  return displays.map((d, i) => {
    const source = sourceFor(sources, d)
    return {
      id: d.id,
      name: source?.name ?? `Screen ${i + 1}`,
      primary: d.id === primary,
      togle: d.id === togle,
      thumbUrl: source && !source.thumbnail.isEmpty() ? source.thumbnail.toDataURL() : undefined
    }
  })
}

/** Screens and windows the recorder can follow. */
export async function listCaptureSources(previews = false): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: previews ? PICK_SIZE : { width: 0, height: 0 } })
  return sources
    .filter((s) => s.name && !/^togle$/i.test(s.name))
    .map((s) => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen') ? 'screen' : 'window', thumbUrl: previews && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : undefined }))
}

/** Resolves a recorder source: a source id, or "cursor" for the screen under the mouse right now. */
export async function resolveCaptureSource(id: string): Promise<Electron.DesktopCapturerSource | undefined> {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
  if (id !== 'cursor') return sources.find((s) => s.id === id)
  const display = displayUnderCursor()
  return sources.find((s) => s.display_id === String(display.id)) ?? sources.find((s) => s.id.startsWith('screen'))
}
