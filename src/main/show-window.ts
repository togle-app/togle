import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import path from 'node:path'
import { MAX_SHOW_PNG_BYTES } from '@shared/pasted-pictures'

/** The screen the pointer was on when F8 was pressed, as the overlay shows it: in device pixels. */
export interface ShowPicture {
  dataUrl: string
  width: number
  height: number
  shortcut: string
}

/** A PNG starts with these bytes; anything else from the window is not a picture. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export const isPng = (bytes: Uint8Array): boolean => bytes.length > PNG.length && bytes.length <= MAX_SHOW_PNG_BYTES && PNG.every((byte, at) => bytes[at] === byte)

/**
 * F8 Show: the screen the pointer is on, frozen, over everything, to drag over a part of it and draw on while talking.
 * The Show shortcut or Enter gives back the picture. Esc cancels. It takes the keyboard while it is open,
 * and like Togle's other windows it is kept out of screen shares and recordings.
 */
export class ShowWindow {
  private window?: BrowserWindow
  private shot?: ShowPicture
  private settle?: (png: Buffer | null) => void
  private ready = false
  private finishRequested = false

  constructor(private readonly builtMain = __dirname) {}

  get open(): boolean {
    return !!this.window && !this.window.isDestroyed()
  }

  owns(sender: Electron.WebContents): boolean {
    return this.open && this.window!.webContents === sender
  }

  /** What the overlay shows, for the overlay only. */
  picture(): ShowPicture | null {
    return this.shot ?? null
  }

  /** Freezes the screen under the pointer and waits for the picture (null: cancelled, or the window went away). */
  show(targetReady: Promise<unknown>, shortcut: string): Promise<Buffer | null> {
    if (this.settle) return Promise.resolve(null)
    this.ready = this.finishRequested = false
    return new Promise(resolve => {
      const settle = (png: Buffer | null) => {
        if (this.settle !== settle) return
        this.settle = undefined
        this.close()
        resolve(png)
      }
      this.settle = settle
      void this.capture(targetReady, shortcut, settle).catch(error => {
        console.warn('[show]', (error as Error).message)
        settle(null)
      })
    })
  }

  private async capture(targetReady: Promise<unknown>, shortcut: string, settle: (png: Buffer | null) => void): Promise<void> {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    if (this.settle !== settle) return
    const source = sources.find((item) => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
    if (!source || source.thumbnail.isEmpty()) throw new Error("Togle couldn't take a picture of the screen.")
    this.shot = { dataUrl: source.thumbnail.toDataURL(), ...source.thumbnail.getSize(), shortcut }
    const win = (this.window = new BrowserWindow({
      ...display.bounds, show: false, frame: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, enableLargerThanScreen: true, backgroundColor: '#000000', title: 'Togle show',
      webPreferences: { preload: path.join(this.builtMain, '../preload/index.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
    }))
    win.setContentProtection(true)
    win.on('page-title-updated', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('render-process-gone', () => settle(null))
    win.once('ready-to-show', async () => {
      await targetReady
      if (win.isDestroyed()) return
      win.setBounds(display.bounds)
      win.show()
      win.setAlwaysOnTop(true, 'screen-saver')
      win.focus()
    })
    win.on('closed', () => settle(null))
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL)
      url.searchParams.set('surface', 'show')
      await win.loadURL(url.toString())
    } else await win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: 'show' } })
  }

  /** A quick second press can arrive before Chromium has decoded the screenshot. */
  finish(): void {
    if (!this.settle) return
    this.finishRequested = true
    if (this.ready && this.open) this.window!.webContents.send('show:finish')
  }
  rendererReady(): void {
    this.ready = true
    if (this.finishRequested) this.finish()
  }

  /** The picture the person made: kept only if it is a PNG of a sensible size. */
  done(bytes: Uint8Array): void {
    if (!isPng(bytes)) return
    this.settle?.(Buffer.from(bytes))
  }

  cancel(): void {
    this.settle?.(null)
  }

  /** Puts it away first, so the app the person was in is in front again when the picture goes in. */
  close(): void {
    const win = this.window
    this.window = undefined
    this.shot = undefined
    if (win && !win.isDestroyed()) {
      win.hide()
      win.destroy()
    }
  }
}
