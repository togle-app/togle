import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { CallStripState } from '@shared/call-strip'

const WIDTH = 380
const HEIGHT = 46
const MARGIN = 12

/**
 * A small strip at the top of the screen while a call is written down and Togle's window is closed: the clock, Mark,
 * Stop, and the reminder to tell the others. It never takes the keyboard, and it is kept out of screen shares and
 * recordings.
 */
export class CallStripWindow {
  window?: BrowserWindow
  private current: CallStripState | null = null
  private sent = ''
  private ready = false
  private stopped = false

  constructor(private readonly builtMain = __dirname) {}

  owns(sender: Electron.WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.webContents === sender
  }

  get visible(): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.isVisible()
  }

  /** Shows the strip with this state, or puts it away when there is none. Said again only when something changed. */
  show(state: CallStripState | null): void {
    if (this.stopped) return
    this.current = state
    if (!state) {
      this.sent = ''
      const win = this.window
      if (win && !win.isDestroyed() && win.isVisible()) win.hide()
      return
    }
    if (!this.window || this.window.isDestroyed()) this.create()
    this.render()
  }

  close(): void {
    this.stopped = true
    this.window?.destroy()
    this.window = undefined
  }

  private headless(): boolean {
    return !app.isPackaged && process.env.TOGLE_HEADLESS === '1'
  }

  private place(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: area.y + MARGIN, width: WIDTH, height: HEIGHT })
  }

  private render(): void {
    const win = this.window
    if (!win || win.isDestroyed() || !this.ready || !this.current) return
    const text = JSON.stringify(this.current)
    if (text !== this.sent) { this.sent = text; win.webContents.send('callstrip:state', this.current) }
    if (!win.isVisible() && !this.headless()) {
      this.place()
      win.showInactive()
      win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    }
  }

  private create(): void {
    this.ready = false
    this.sent = ''
    const win = (this.window = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, thickFrame: false, transparent: true, focusable: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, title: 'Togle call', backgroundColor: '#00000000', hasShadow: false,
      webPreferences: { preload: path.join(this.builtMain, '../preload/index.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: this.headless() }
    }))
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setContentProtection(true)
    win.on('page-title-updated', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('did-finish-load', () => {
      if (this.window !== win) return
      this.ready = true
      if (this.current) this.render()
    })
    win.webContents.on('render-process-gone', () => {
      if (this.window === win) {
        this.window = undefined
        this.ready = false
      }
      win.destroy()
    })
    win.on('closed', () => {
      if (this.window === win) {
        this.window = undefined
        this.ready = false
      }
    })
    if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL)
      url.searchParams.set('surface', 'callstrip')
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: 'callstrip' } })
  }
}
