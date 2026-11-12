import { Menu, nativeImage, Tray } from 'electron'
import type { DictationState } from '@shared/dictation'
import { orderFromProbe, paintDot } from './tray-dot'
import { recentLabel } from './recent-dictations'

interface TrayActions {
  open(): void
  /** Opens Togle on its Tasks screen. */
  tasks(): void
  settings(): void
  toggle(): void
  cancel(): void
  copy(): void
  /** Copies one of the last dictations. */
  copyText(text: string): void
  indicator(visible: boolean): void
  quit(): void
}

/** The icon with an amber dot, or nothing when it cannot be made: the tray then shows its icon as it was. */
function markedIcon(image: Electron.NativeImage): Electron.NativeImage | undefined {
  try {
    const side = process.platform === 'win32' ? 32 : 20
    const sized = image.resize({ width: side, height: side, quality: 'best' })
    const bitmap = Buffer.from(sized.toBitmap())
    const probe = nativeImage.createFromBitmap(Buffer.from([0, 0, 255, 255]), { width: 1, height: 1 })
    paintDot(bitmap, side, side, orderFromProbe(probe.toPNG()))
    return nativeImage.createFromBitmap(bitmap, { width: side, height: side })
  } catch {
    return undefined
  }
}

/** The tray is the one place to reopen or quit a Togle running in the background. */
export class TogleTray {
  private tray?: Tray
  private readonly plain: Electron.NativeImage | string
  private readonly marked?: Electron.NativeImage
  private waiting = 0
  private lastUpdate?: Parameters<TogleTray['update']>
  constructor(icon: string, private actions: TrayActions) {
    const image = nativeImage.createFromPath(icon)
    if (image.isEmpty()) throw new Error('Togle tray icon is missing.')
    this.plain = process.platform === 'win32' ? icon : image.resize({ width: 20, height: 20 })
    this.marked = markedIcon(image)
    this.tray = new Tray(this.plain)
    this.tray.on('click', actions.open)
  }
  get available(): boolean { return !!this.tray && !this.tray.isDestroyed() }
  /** How many tasks wait for the person: the icon carries an amber dot until none does. */
  setWaiting(count: number): void {
    if (!this.available || count === this.waiting) return
    this.waiting = count
    this.tray!.setImage(count > 0 && this.marked ? this.marked : this.plain)
    if (this.lastUpdate) this.update(...this.lastUpdate)
  }
  update(state: DictationState, keys: string, showBar: boolean, inCall: boolean, recent: string[] = []): void {
    if (!this.available) return
    this.lastUpdate = [state, keys, showBar, inCall, recent]
    const recording = state.phase === 'recording'
    const busy = ['starting', 'finishing', 'polishing', 'inserting'].includes(state.phase)
    const status = recording ? 'Listening to dictation' : state.phase === 'starting' ? 'Preparing dictation' : state.phase === 'finishing' ? 'Transcribing dictation' : state.phase === 'polishing' ? 'Cleaning up dictation' : state.phase === 'inserting' ? 'Entering dictated text'
      : state.phase === 'error' ? 'Dictation needs attention' : state.phase === 'ready' ? 'Dictation ready to review' : inCall ? 'Call assistance is on' : 'Ready to dictate'
    const waiting = this.waiting ? `${this.waiting} task${this.waiting === 1 ? '' : 's'} waiting for you` : ''
    this.tray!.setToolTip(`Togle · ${waiting ? `${waiting} · ` : ''}${status}${keys ? ` · ${keys}` : ''}`)
    this.tray!.setContextMenu(Menu.buildFromTemplate([
      ...(waiting ? [{ label: waiting, click: this.actions.tasks }, { type: 'separator' as const }] : []),
      { label: status, enabled: false },
      { type: 'separator' },
      { label: inCall ? 'Open Togle · call in progress' : 'Open Togle', click: this.actions.open },
      // The bar keeps the destination focused. Starting from a system menu cannot guarantee that.
      { label: recording ? `Finish dictation${keys ? ` (${keys})` : ''}` : keys ? `Dictate with ${keys}` : 'Click the voice bar to dictate', enabled: recording, click: this.actions.toggle },
      ...(recording || busy ? [{ label: 'Cancel dictation', enabled: state.phase !== 'inserting', click: this.actions.cancel }] : []),
      { label: 'Show voice bar', type: 'checkbox', checked: showBar, click: item => this.actions.indicator(item.checked) },
      ...(state.lastText && !recording && !busy ? [{ label: 'Copy last dictation', click: this.actions.copy }] : []),
      // When typing them failed, the last ten are here to copy (kept in memory until Togle closes).
      ...(recent.length > 1 ? [{ label: 'Copy a recent dictation', submenu: recent.map(text => ({ label: recentLabel(text), click: () => this.actions.copyText(text) })) }] : []),
      { label: 'Dictation settings', click: this.actions.settings },
      { type: 'separator' },
      { label: 'Quit Togle', click: this.actions.quit }
    ]))
  }
  close(): void { this.tray?.destroy(); this.tray = undefined }
}
