import { app, BrowserWindow, screen } from 'electron'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './storage'
import type { DictationState } from '@shared/dictation'

/** A persistent, non-activating voice bar. The destination keeps keyboard focus, even when clicked. */
export class DictationWindow {
  window?: BrowserWindow
  private doneTimer?: NodeJS.Timeout
  private collapseTimer?: NodeJS.Timeout
  private expandTimer?: NodeJS.Timeout
  private pointerTimer?: NodeJS.Timeout
  private mustLeave = false
  private phaseCursor?: Electron.Point
  private recoveryTimer?: NodeJS.Timeout
  private expanded = false
  private passthrough = true
  private state: DictationState = { phase: 'idle' }
  private showBar = false
  private resting = false
  private stopped = false
  private unavailable = false
  private failures: number[] = []
  private displayId?: number
  private placement?: { version: 1; displayId: number; x: number; y: number }
  private positionLoaded = false
  private dragging?: { x: number; y: number; bounds: Electron.Rectangle }
  private layout?: string
  private displayLayout(display: Electron.Display): string { const a = display.workArea; return `${display.id}:${a.x}:${a.y}:${a.width}:${a.height}` }
  private readonly forwardMouse = process.platform === 'win32' || process.platform === 'darwin'
  constructor(private failed: () => void, private builtMain = __dirname, private cursor = () => screen.getCursorScreenPoint()) {}
  owns(sender: Electron.WebContents): boolean { return this.window?.webContents === sender }
  setExpanded(expanded: boolean, explicit = false): void {
    if (this.stopped || this.unavailable) return
    if (expanded && this.dragging) return
    if ((this.resting || this.state.phase === 'idle') && !this.showBar) return
    if (explicit) {
      clearTimeout(this.collapseTimer); clearTimeout(this.expandTimer); this.expandTimer = undefined
      this.mustLeave = !expanded
      this.phaseCursor = undefined
      this.applyExpanded(expanded)
      this.setPassthrough(!expanded && !this.dragging)
      this.watchPointer()
      return
    }
    const inside = this.pointerInside()
    if (!inside) {
      clearTimeout(this.expandTimer); this.expandTimer = undefined
      this.mustLeave = false; this.phaseCursor = undefined
      this.setPassthrough(!this.dragging)
      if (!this.collapseTimer) this.collapseTimer = setTimeout(() => {
        this.collapseTimer = undefined
        if (!this.pointerInside()) this.applyExpanded(false)
      }, 240)
      this.collapseTimer.unref?.()
    } else {
      // Chromium may emit mouse-leave while the CSS panel animates. Native
      // position remains authoritative so visible Copy/Close controls stay usable.
      clearTimeout(this.collapseTimer); this.collapseTimer = undefined
      this.setPassthrough(false)
      const point = this.cursor()
      const stationary = this.phaseCursor && Math.hypot(point.x-this.phaseCursor.x, point.y-this.phaseCursor.y) < 3
      if (expanded && !this.expanded && !this.expandTimer && !this.mustLeave && !stationary) {
        this.expandTimer = setTimeout(() => {
          this.expandTimer = undefined
          if (this.pointerInside() && !this.mustLeave) this.applyExpanded(true)
        }, 500)
        this.expandTimer.unref?.()
      }
    }
    this.watchPointer()
  }
  private applyExpanded(value: boolean): void {
    if (this.expanded === value) return
    this.expanded = value
    if (this.forwardMouse) this.window?.webContents.send('dictation:expanded', value)
    else this.render()
  }
  private pointerInside(): boolean {
    const win = this.window
    if (!win || win.isDestroyed()) return false
    const b = win.getContentBounds(), point = this.cursor()
    const phase = this.resting ? 'idle' : this.state.phase
    const recovery = phase === 'ready' || phase === 'error', status = phase !== 'idle' && phase !== 'recording'
    const width = Math.min(b.width, this.expanded ? recovery ? 352 : 280 : status ? 156 : 64)
    const height = Math.min(b.height, this.expanded ? recovery ? 264 : phase === 'recording' && this.state.inCall ? 100 : 76 : status ? 44 : 28)
    return point.x >= b.x+(b.width-width)/2 && point.x < b.x+(b.width+width)/2 && point.y >= b.y+b.height-height && point.y < b.y+b.height
  }
  private watchPointer(): void {
    if (this.pointerTimer) return
    // Only monitor a pending/open interaction; the resting bar does not poll.
    this.pointerTimer = setInterval(() => {
      if (this.stopped || !this.window || this.window.isDestroyed()) { clearInterval(this.pointerTimer); this.pointerTimer = undefined; return }
      if (!this.pointerInside() && !this.dragging) {
        this.setExpanded(false)
        if (!this.expanded && !this.expandTimer) { clearInterval(this.pointerTimer); this.pointerTimer = undefined }
      }
    }, 80)
    this.pointerTimer.unref?.()
  }
  drag(action: string, x: number, y: number): void {
    const win = this.window
    if (this.stopped || !win || win.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 100000 || Math.abs(y) > 100000) return
    if (action === 'start') { this.dragging = { x, y, bounds: win.getBounds() }; this.setExpanded(false, true); return }
    const drag = this.dragging
    if (!drag || action !== 'move' && action !== 'end') return
    const display = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }), area = display.workArea
    const left = Math.max(area.x, Math.min(area.x + area.width - drag.bounds.width, Math.round(drag.bounds.x + x - drag.x)))
    const top = Math.max(area.y, Math.min(area.y + area.height - drag.bounds.height, Math.round(drag.bounds.y + y - drag.y)))
    win.setBounds({ x: left, y: top, width: drag.bounds.width, height: drag.bounds.height })
    this.displayId = display.id
    const moved = win.getContentBounds()
    this.placement = { version: 1, displayId: display.id, x: (moved.x + moved.width / 2 - area.x) / area.width, y: (moved.y + moved.height - area.y) / area.height }
    if (action === 'end') {
      this.dragging = undefined
      this.setExpanded(false)
      void writeFileAtomic(path.join(app.getPath('userData'), 'voice-bar.json'), JSON.stringify(this.placement)).catch(error => console.warn('[voice bar position]', (error as Error).message))
    }
  }
  private setPassthrough(ignore: boolean): void {
    if (this.passthrough === ignore) return
    this.passthrough = ignore
    if (this.forwardMouse) this.window?.setIgnoreMouseEvents(ignore, { forward: true })
  }
  setIndicator(visible: boolean): void {
    if(visible && !this.showBar){this.phaseCursor=this.cursor();clearTimeout(this.expandTimer);this.expandTimer=undefined}
    this.showBar = visible; if (visible) this.unavailable = false; this.render()
  }
  update(state: DictationState): void {
    const newRecording = state.phase === 'recording' && state.id !== this.state.id
    if (state.phase !== this.state.phase || state.id !== this.state.id) {
      clearTimeout(this.expandTimer); this.expandTimer = undefined
      if (!this.expanded) this.phaseCursor = this.cursor()
    }
    this.state = state; this.resting = false
    if (state.phase === 'starting' || newRecording) this.unavailable = false
    clearTimeout(this.doneTimer)
    // Keep the bar on one display during a dictation, regardless of later pointer movement.
    if (!this.placement && (state.phase === 'starting' || newRecording || this.displayId === undefined)) this.displayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id
    this.render()
    if (state.phase === 'done') {
      this.doneTimer = setTimeout(() => { this.resting = true; this.render() }, 1800)
      this.doneTimer.unref?.()
    }
  }
  /** Reposition only on display changes, not with every mouse movement or audio frame. */
  private displayChanged = (): void => { this.phaseCursor=this.cursor();clearTimeout(this.expandTimer);this.expandTimer=undefined;this.render() }
  /** Another Togle window may have been raised above this non-activating overlay. */
  keepAbove(): void {
    const win = this.window
    if (this.stopped || !win || win.isDestroyed() || !win.isVisible() || this.headless()) return
    win.moveTop()
  }
  private recover(): void {
    clearTimeout(this.recoveryTimer)
    if (this.stopped || !this.showBar && (this.resting || this.state.phase === 'idle')) return
    this.recoveryTimer = setTimeout(() => {
      if (this.stopped) return
      this.unavailable = false
      this.render()
    }, this.failures.length < 2 ? 1000 : 30_000)
    this.recoveryTimer.unref?.()
  }
  private render(): void {
    if (this.stopped || this.unavailable) return
    const state = this.resting ? { ...this.state, phase: 'idle' as const } : this.state
    if (state.phase === 'idle' && !this.showBar) {
      clearTimeout(this.collapseTimer); clearTimeout(this.expandTimer); this.expandTimer = undefined
      clearInterval(this.pointerTimer); this.pointerTimer = undefined; this.expanded = false
      this.setPassthrough(true)
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send('dictation:expanded', false)
        this.window.webContents.send('dictation:state', state); this.window.hide()
      }
      return
    }
    if (!this.window || this.window.isDestroyed()) this.create()
    const win = this.window!
    const display = screen.getAllDisplays().find(item => item.id === this.displayId) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    this.displayId = display.id
    const area = display.workArea
    // Keep the native surface fixed. Resizing a transparent Windows window under
    // the cursor produces mouse-leave events and intermediate stretched frames.
    // Only CSS changes the pill's size; the unused canvas passes clicks through.
    // Linux does not forward ignored mouse movement, so retain a small native
    // window there instead of leaving an invisible surface above other apps.
    const recovery = state.phase === 'ready' || state.phase === 'error'
    const status = state.phase !== 'idle' && state.phase !== 'recording'
    const current = win.getBounds()
    const width = this.forwardMouse ? current.width : Math.min(this.expanded ? recovery ? 352 : 280 : status ? 156 : 64, area.width - 16)
    const height = this.forwardMouse ? current.height : Math.min(this.expanded ? recovery ? 264 : state.phase === 'recording' && state.inCall ? 100 : 76 : status ? 44 : 40, area.height - 16)
    const bounds = { width, height, x: this.placement ? Math.round(area.x + area.width * this.placement.x - width / 2) : area.x + Math.round((area.width - width) / 2), y: this.placement ? Math.round(area.y + area.height * this.placement.y - height) : area.y + area.height - height - 12 }
    const layout = this.displayLayout(display)
    if (!this.forwardMouse || this.layout !== layout) {
      if (current.width !== width || current.height !== height) win.setBounds(bounds)
      else if (current.x !== bounds.x || current.y !== bounds.y) win.setPosition(bounds.x, bounds.y)
      this.layout = layout
    }
    win.webContents.send('dictation:expanded', this.expanded)
    win.webContents.send('dictation:state', state)
    if (!win.webContents.isLoading() && !win.isVisible() && !this.headless()) {
      win.showInactive()
      // Give the nonactivating overlay a native topmost level when first shown.
      // Do not raise or reshow it again during hover and status updates.
      win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating')
    }
  }
  private create(): void {
    if (!this.positionLoaded) {
      this.positionLoaded = true
      try {
        const saved = JSON.parse(readFileSync(path.join(app.getPath('userData'), 'voice-bar.json'), 'utf8'))
        if (saved.version === 1 && Number.isFinite(saved.displayId) && Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.x >= 0 && saved.x <= 1 && saved.y >= 0 && saved.y <= 1) { this.placement = saved; this.displayId = saved.displayId }
      } catch { /* Default position until explicitly moved. */ }
    }
    const display = screen.getAllDisplays().find(item => item.id === this.displayId) ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const area = display.workArea
    this.displayId = display.id; this.layout = this.displayLayout(display)
    const x = this.placement ? Math.round(area.x + area.width * this.placement.x - 176) : area.x + Math.round((area.width - 352) / 2)
    const y = this.placement ? Math.round(area.y + area.height * this.placement.y - 264) : area.y + area.height - 264 - 12
    const win = this.window = new BrowserWindow({ x, y, width: 352, height: 264, show: false, frame: false, thickFrame: false, transparent: true,
      focusable: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, minimizable: false, maximizable: false,
      title: 'Togle voice bar', backgroundColor: '#00000000', hasShadow: false,
      webPreferences: { preload: path.join(this.builtMain, '../preload/index.js'), sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: this.headless() }
    })
    this.passthrough = true
    if (this.forwardMouse) win.setIgnoreMouseEvents(true, { forward: true })
    if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setContentProtection(true)
    win.on('page-title-updated', event => event.preventDefault())
    // Show Desktop and display/session changes can hide an otherwise healthy bar.
    win.on('hide', () => this.recover())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', event => event.preventDefault())
    win.once('ready-to-show', () => {
      // Preserve the visible bar’s center/bottom across monitor DPI rounding and renderer recovery.
      if (this.placement) {
        const actual = win.getContentBounds()
        const left = Math.round(area.x + area.width * this.placement.x - actual.width / 2)
        const top = Math.round(area.y + area.height * this.placement.y - actual.height)
        if (actual.x !== left || actual.y !== top) win.setPosition(left, top)
      }
      this.render()
    })
    const fail = (): void => {
      const now = Date.now()
      this.failures = this.failures.filter(at => now - at < 60_000); this.failures.push(now)
      this.unavailable = true
      win.destroy(); this.failed(); this.recover()
    }
    win.webContents.on('render-process-gone', fail)
    win.on('unresponsive', fail)
    screen.on('display-removed', this.displayChanged)
    screen.on('display-metrics-changed', this.displayChanged)
    win.on('closed', () => {
      clearTimeout(this.collapseTimer); clearTimeout(this.expandTimer); clearInterval(this.pointerTimer); this.pointerTimer = undefined; this.expandTimer = undefined; this.expanded = false; this.passthrough = true; this.dragging = undefined; this.mustLeave = false
      if (this.window === win) this.window = undefined
      screen.removeListener('display-removed', this.displayChanged)
      screen.removeListener('display-metrics-changed', this.displayChanged)
      this.recover()
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      const url = new URL(process.env.ELECTRON_RENDERER_URL); url.searchParams.set('surface', 'dictation')
      void win.loadURL(url.toString())
    } else void win.loadFile(path.join(this.builtMain, '../renderer/index.html'), { query: { surface: 'dictation' } })
  }
  private headless(): boolean { return !app.isPackaged && process.env.TOGLE_HEADLESS === '1' }
  close(): void { this.stopped = true; clearTimeout(this.doneTimer); clearTimeout(this.collapseTimer); clearTimeout(this.expandTimer); clearInterval(this.pointerTimer); clearTimeout(this.recoveryTimer); this.window?.destroy(); this.window = undefined }
}
