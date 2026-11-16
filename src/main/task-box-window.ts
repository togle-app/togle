import { app, BrowserWindow, dialog, screen } from 'electron'
import path from 'node:path'
import type { TaskBoxOpen } from '@shared/runner'

const WIDTH = 600
// As tall as what is in it, within these: the two chips and one line of words; more as the words grow (with a to-do item, a
// call and an error under them, 310); and while a list of agents or folders is open over it, as far down as the list goes
// (the longest list is seven folders and Choose…, 347).
const LOWEST = 84
const HEIGHT = 360

/**
 * The small box that opens over whatever the person is doing, to start a task: they type it, or say it with the dictation
 * key, and press Enter. It takes the keyboard (that is what it is for), goes away when they click elsewhere (what they
 * wrote stays for next time), and is kept out of screen shares and recordings.
 */
export class TaskBoxWindow {
  window?: BrowserWindow
  private ready = false
  private stopped = false
  /** A folder dialog is open: the box losing focus to it is not the person leaving. */
  private picking = false
  /** It was asked for, and has not been put away: it shows as soon as its page is there. */
  private opened = false
  /** What it opened with (a saved call to work from, a to-do item, an agent and a folder). Gone when it is put away. */
  private opening: TaskBoxOpen | null = null
  /** How tall its page last asked it to be. */
  private height = LOWEST

  constructor(private readonly builtMain = __dirname) {}

  owns(sender: Electron.WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.webContents === sender
  }

  get visible(): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.isVisible()
  }

  /** What it is open with now, for its page to ask when it loads: the message sent on loading can come before the page listens. */
  get current(): TaskBoxOpen | null {
    return this.opened ? this.opening : null
  }

  /** Opens it, ready to type in; asked while it is open, it closes. */
  toggle(): void {
    if (this.visible) this.hide()
    else this.show()
  }

  show(opening: TaskBoxOpen | null = null): void {
    if (this.stopped) return
    if (!this.window || this.window.isDestroyed()) this.create()
    this.opened = true
    this.opening = opening
    this.render()
  }

  hide(): void {
    this.opened = false
    this.opening = null
    const win = this.window
    if (win && !win.isDestroyed() && win.isVisible()) win.hide()
  }

  /** As tall as its page asks, within LOWEST and HEIGHT, where it is. */
  resize(height: number): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    this.height = Math.round(Math.min(HEIGHT, Math.max(LOWEST, height)))
    const bounds = win.getBounds()
    if (bounds.height !== this.height) win.setBounds({ ...bounds, height: this.height })
  }

  close(): void {
    this.stopped = true
    this.window?.destroy()
    this.window = undefined
  }

  /** Asks for a folder, with the box as the dialog's parent. */
  async pickFolder(): Promise<string | null> {
    const win = this.window
    this.picking = true
    try {
      const chosen = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return chosen.canceled ? null : (chosen.filePaths[0] ?? null)
    } finally {
      this.picking = false
      if (this.opened && this.window && !this.window.isDestroyed() && !this.headless()) this.window.focus()
    }
  }

  private headless(): boolean {
    return !app.isPackaged && process.env.TOGLE_HEADLESS === '1'
  }

  private place(): void {
    const win = this.window
    if (!win || win.isDestroyed()) return
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    win.setBounds({ x: Math.round(area.x + (area.width - WIDTH) / 2), y: Math.round(area.y + area.height * 0.16), width: WIDTH, height: this.height })
  }

  private render(): void {
    const win = this.window
    if (!win || win.isDestroyed() || !this.ready) return
    this.place()
    win.webContents.send('taskbox:shown', this.opening)
    if (this.headless()) return
    win.show()
    win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    win.focus()
  }

  private create(): void {
    this.ready = false
    const win = (this.window = new BrowserWindow({
      width: WIDTH, height: LOWEST, show: false, frame: false, thickFrame: false, resizable: false, minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true,
      title: 'Togle task', backgroundColor: '#171b23', hasShadow: true,
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
      if (this.opened) this.render()
    })
    // Clicking elsewhere puts it away; what was typed stays in it.
    win.on('blur', () => {
      if (this.picking || this.headless()) return
      this.hide()
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
      url.searchParams.set('surface', 'taskbox')
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: 'taskbox' } })
  }
}
