import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'
import type { CallApp } from '@shared/call-apps'

const WIDTH = 372
const HEIGHT = 124
// From the edge of the screen's work area. The corner is the top right: a task that waits shows at the bottom right.
const MARGIN = 16

export interface CallNotice {
  app: CallApp
  name: string
}

/**
 * A small window in the top right corner of the screen with one thing to say and a choice: a call started in another app
 * (write it down?), or one of Togle's keys was pressed in a code editor that uses it too (change keys?). It never takes
 * the keyboard, and it is kept out of screen shares and recordings. `surface` is its page, and its messages' name.
 */
export class CornerNoticeWindow<T> {
  window?: BrowserWindow
  private current: T | null = null
  private ready = false
  private stopped = false
  private hideTimer?: NodeJS.Timeout

  /**
   * `slot` is its place in the corner, counted from the top: the keys notice sits under the call notice's, so a call that
   * starts while it shows does not cover it.
   */
  constructor(
    private readonly builtMain = __dirname,
    private readonly kind: { surface: string; title: string; slot?: number } = { surface: 'callnotice', title: 'Togle call' }
  ) {}

  owns(sender: Electron.WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.webContents === sender
  }

  /** What is on show now. */
  get shown(): T | null {
    return this.current
  }

  /** Shows the notice for `forMs`, or puts it away when there is none. */
  show(notice: T | null, forMs?: number): void {
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
    if (this.ready) win.webContents.send(`${this.kind.surface}:state`, null)
    if (win.isVisible()) win.hide()
  }

  private place(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    win.setBounds({ x: area.x + area.width - WIDTH - MARGIN, y: area.y + MARGIN + (this.kind.slot ?? 0) * (HEIGHT + 8), width: WIDTH, height: HEIGHT })
  }

  private render(): void {
    const win = this.window
    if (!win || win.isDestroyed() || !this.ready) return
    win.webContents.send(`${this.kind.surface}:state`, this.current)
    this.place()
    if (!win.isVisible() && !this.headless()) {
      win.showInactive()
      win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    }
  }

  private create(): void {
    this.ready = false
    const win = (this.window = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, thickFrame: false, transparent: true, focusable: false, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, minimizable: false, maximizable: false, title: this.kind.title, backgroundColor: '#00000000', hasShadow: false,
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
      url.searchParams.set('surface', this.kind.surface)
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: this.kind.surface } })
  }
}

/** A call started in another app: write it down? */
export class CallNoticeWindow extends CornerNoticeWindow<CallNotice> {}
