import { Menu, nativeImage, Tray } from 'electron'
import type { DictationState } from '@shared/dictation'

interface TrayActions {
  open(): void
  settings(): void
  toggle(): void
  cancel(): void
  copy(): void
  indicator(visible: boolean): void
  quit(): void
}

/** The tray is the one place to reopen or quit a Togle running in the background. */
export class TogleTray {
  private tray?: Tray
  constructor(icon: string, private actions: TrayActions) {
    const image = nativeImage.createFromPath(icon)
    if (image.isEmpty()) throw new Error('Togle tray icon is missing.')
    this.tray = new Tray(process.platform === 'win32' ? icon : image.resize({ width: 20, height: 20 }))
    this.tray.on('click', actions.open)
  }
  get available(): boolean { return !!this.tray && !this.tray.isDestroyed() }
  update(state: DictationState, keys: string, showBar: boolean, inCall: boolean): void {
    if (!this.available) return
    const recording = state.phase === 'recording'
    const busy = ['starting', 'finishing', 'polishing', 'inserting'].includes(state.phase)
    const status = recording ? 'Listening to dictation' : state.phase === 'starting' ? 'Preparing dictation' : state.phase === 'finishing' ? 'Transcribing dictation' : state.phase === 'polishing' ? 'Cleaning up dictation' : state.phase === 'inserting' ? 'Entering dictated text'
      : state.phase === 'error' ? 'Dictation needs attention' : state.phase === 'ready' ? 'Dictation ready to review' : inCall ? 'Call assistance is on' : 'Ready to dictate'
    this.tray!.setToolTip(`Togle · ${status}${keys ? ` · ${keys}` : ''}`)
    this.tray!.setContextMenu(Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: inCall ? 'Open Togle · call in progress' : 'Open Togle', click: this.actions.open },
      // The bar keeps the destination focused. Starting from a system menu cannot guarantee that.
      { label: recording ? `Finish dictation${keys ? ` (${keys})` : ''}` : keys ? `Dictate with ${keys}` : 'Click the voice bar to dictate', enabled: recording, click: this.actions.toggle },
      ...(recording || busy ? [{ label: 'Cancel dictation', enabled: state.phase !== 'inserting', click: this.actions.cancel }] : []),
      { label: 'Show voice bar', type: 'checkbox', checked: showBar, click: item => this.actions.indicator(item.checked) },
      ...(state.lastText && !recording && !busy ? [{ label: 'Copy last dictation', click: this.actions.copy }] : []),
      { label: 'Dictation settings', click: this.actions.settings },
      { type: 'separator' },
      { label: 'Quit Togle', click: this.actions.quit }
    ]))
  }
  close(): void { this.tray?.destroy(); this.tray = undefined }
}
