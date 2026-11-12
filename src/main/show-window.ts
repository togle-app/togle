import { app, BrowserWindow, desktopCapturer, screen } from 'electron'
import path from 'node:path'

/** The screen the pointer was on when F8 was pressed, as the overlay shows it: in device pixels. */
export interface ShowPicture {
  dataUrl: string
  width: number
  height: number
}

/** A PNG starts with these bytes; anything else from the window is not a picture. */
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// More than a screen's worth of picture is not one Togle made.
const LARGEST = 60 * 1024 * 1024

export const isPng = (bytes: Uint8Array): boolean => bytes.length > PNG.length && bytes.length <= LARGEST && PNG.every((byte, at) => bytes[at] === byte)

/**
 * F8 Show: the screen the pointer is on, frozen, over everything, to drag over a part of it and draw on while talking.
 * Enter gives back the picture; Esc gives back nothing. It takes the keyboard while it is open (that is what it is for),
 * and like Togle's other windows it is kept out of screen shares and recordings.
 */
export class ShowWindow {
  private window?: BrowserWindow
  private shot?: ShowPicture
  private settle?: (png: Buffer | null) => void

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
  async show(): Promise<Buffer | null> {
    if (this.open) return null
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const size = { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor) }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const source = sources.find((item) => item.display_id === String(display.id)) ?? (sources.length === 1 ? sources[0] : undefined)
    if (!source || source.thumbnail.isEmpty()) throw new Error("Togle couldn't take a picture of the screen.")
    this.shot = { dataUrl: source.thumbnail.toDataURL(), width: size.width, height: size.height }
    const win = (this.window = new BrowserWindow({
      ...display.bounds, show: false, frame: false, thickFrame: false, resizable: false, movable: false, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, enableLargerThanScreen: true, backgroundColor: '#000000', title: 'Togle show',
      webPreferences: { preload: path.join(this.builtMain, '../preload/index.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false }
    }))
    win.setContentProtection(true)
    win.on('page-title-updated', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('render-process-gone', () => this.settle?.(null))
    win.once('ready-to-show', () => {
      if (win.isDestroyed()) return
      win.setBounds(display.bounds)
      win.show()
      win.setAlwaysOnTop(true, 'screen-saver')
      win.focus()
    })
    const picked = new Promise<Buffer | null>((resolve) => {
      this.settle = (png) => {
        this.settle = undefined
        resolve(png)
        this.close()
      }
    })
    win.on('closed', () => this.settle?.(null))
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL)
      url.searchParams.set('surface', 'show')
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: 'show' } })
    return picked
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
