import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app, screen, type BrowserWindow, type Rectangle } from 'electron'

// Where Togle's window was left, and its size: a plain file, as nothing in it is private.
const file = (): string => path.join(app.getPath('userData'), 'window.json')
// Saved this long after it stops moving or resizing.
const SAVE_DELAY_MS = 500
// This much of its title bar on a screen, it can be grabbed again.
const GRAB_PX = 80
const TITLE_PX = 32

/**
 * Where the window was last, if that's still on one of the screens: one unplugged since, or a smaller one, and it
 * opens where it always did, or fitted to the screen it's on. `maximized`: it was left maximized, and opens so (the place
 * is the one it goes back to).
 */
export function lastPlace(min: { width: number; height: number }): (Rectangle & { maximized?: true }) | undefined {
  let saved: Rectangle & { layout?: string; maximized?: unknown }
  try {
    saved = JSON.parse(readFileSync(file(), 'utf8')) as Rectangle
  } catch {
    return undefined
  }
  const { x, y, width, height } = saved ?? {}
  if (![x, y, width, height].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  const display = screen
    .getAllDisplays()
    .find(({ workArea: a }) => x + width - GRAB_PX >= a.x && x + GRAB_PX <= a.x + a.width && y >= a.y - TITLE_PX / 4 && y + TITLE_PX <= a.y + a.height)
  if (!display) return undefined
  const area = display.workArea
  // Widen old compact layouts once. Subsequent manual sizes, including compact call windows, are preserved.
  const migrate = saved.layout !== 'agent-sidebar' && width < 760 && area.width >= 800
  const restoredWidth = migrate ? Math.min(960, area.width - 40) : Math.min(Math.max(width, min.width), area.width)
  return {
    x: migrate ? Math.max(area.x, Math.min(x, area.x + area.width - restoredWidth - 20)) : x,
    y: Math.max(y, area.y),
    width: restoredWidth,
    height: Math.min(Math.max(height, min.height), area.y + area.height - Math.max(y, area.y)),
    ...(saved.maximized === true ? { maximized: true as const } : {})
  }
}

/** Keeps where the window is, its size, and whether it is maximized, as it's moved or resized: Togle opens so the next time. */
export function keepPlace(win: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = (): void => {
    clearTimeout(timer)
    // Minimized or full screen, what is kept is what it had before. Maximized, it is kept so, with the place it goes back to.
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return
    const maximized = win.isMaximized()
    try {
      writeFileSync(file(), JSON.stringify({ ...(maximized && win.getNormalBounds ? win.getNormalBounds() : win.getBounds()), layout: 'agent-sidebar', ...(maximized ? { maximized: true } : {}) }))
    } catch (err) {
      console.warn('[window] place not kept:', (err as Error).message)
    }
  }
  const later = (): void => {
    clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }
  win.on('move', later)
  win.on('resize', later)
  win.on('maximize', later)
  win.on('unmaximize', later)
  win.on('close', save)
}
