import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { TaskNotice } from '@shared/runner'

const WIDTH = 392
// From the edge of the screen's work area.
const MARGIN = 16

/**
 * A small window in the corner of the screen that tells of a task: one waits for the person, or one finished. It never
 * takes the keyboard (what the person is typing in keeps it), and it is kept out of screen shares and recordings, as it
 * can show a command.
 */
export class NoticeWindow {
  window?: BrowserWindow
  private current: TaskNotice | null = null
  private height = 160
  private ready = false
  private stopped = false
  private hideTimer?: NodeJS.Timeout

  constructor(private readonly builtMain = __dirname) {}

  owns(sender: Electron.WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.webContents === sender
  }

  /** What is on show now. */
  get shown(): TaskNotice | null {
    return this.current
  }

  /** Shows a notice, for `forMs` if it is only news, or hides the window when there is none. */
  show(notice: TaskNotice | null, forMs?: number): void {
    if (this.stopped) return
    clearTimeout(this.hideTimer)
    this.hideTimer = undefined
    this.current = notice
    if (!notice) {
      this.hide()
      return
    }
    if (forMs) {
      this.hideTimer = setTimeout(() => this.show(null), forMs)
      this.hideTimer.unref?.()
    }
    if (!this.window || this.window.isDestroyed()) this.create()
    this.render()
  }

  /** The page says how tall it is, so the window is no taller. */
  resize(height: number): void {
    if (!Number.isFinite(height)) return
    this.height = Math.min(480, Math.max(60, Math.round(height)))
    this.place()
  }

  close(): void {
    this.stopped = true
    clearTimeout(this.hideTimer)
    this.window?.destroy()
    this.window = undefined
  }

  private headless(): boolean {
    return !app.isPackaged && process.env.TOGLE_HEADLESS === '1'
  }

  private hide(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    if (this.ready) win.webContents.send('notice:state', null)
    if (win.isVisible()) win.hide()
  }

  private place(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    win.setBounds({ x: area.x + area.width - WIDTH - MARGIN, y: area.y + area.height - this.height - MARGIN, width: WIDTH, height: this.height })
  }

  private render(): void {
    const win = this.window
    if (!win || win.isDestroyed() || !this.ready) return
    win.webContents.send('notice:state', this.current)
    this.place()
    if (!win.isVisible() && !this.headless()) {
      win.showInactive()
      // Above full-screen apps and the taskbar, as a notice should be, without taking focus from anything.
      win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    }
  }

  private create(): void {
    this.ready = false
    const win = (this.window = new BrowserWindow({
      width: WIDTH, height: this.height, show: false, frame: false, thickFrame: false, transparent: true, focusable: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, title: 'Togle notice', backgroundColor: '#00000000', hasShadow: false,
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
    // A page that broke is thrown away; the next notice makes a new one.
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
      url.searchParams.set('surface', 'notice')
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: 'notice' } })
  }
}
