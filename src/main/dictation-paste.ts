import type { DictationState } from '@shared/dictation'

/** A paste only acknowledges the dictation that still owns the clipboard. Never intercept the paste shortcut. */
export class DictationPaste {
  private held?: { id: string; plain: string; sequence?: number }
  private poll?: NodeJS.Timeout
  private keysDown = false
  private mouseDown = false
  private pressed?: { x: number; y: number; paste: Promise<boolean> }
  private checking?: typeof this.held
  constructor(private options: {
    sequence(): number | undefined
    readText(): Promise<string>
    pasted(id: string): void
    shortcut?(): boolean
    shortcutTarget?(): Promise<boolean>
    mouse?(): boolean
    pointer?(): { x: number; y: number }
    pasteCommandAt?(x: number, y: number): Promise<boolean>
  }) {}

  remember(id: string | undefined, plain: string): void {
    this.clear()
    if (id) this.held = { id, plain, sequence: this.options.sequence() }
  }

  update(state: DictationState): void {
    if (!this.held) return
    if (this.held.id !== state.id || state.phase === 'idle') { this.clear(); return }
    if (this.poll || !this.options.shortcut || state.outcome !== 'copied' || !['ready', 'done'].includes(state.phase)) return
    this.keysDown = this.options.shortcut()
    this.mouseDown = !!this.options.mouse?.()
    this.poll = setInterval(() => {
      const down = !!this.options.shortcut?.()
      if (down && !this.keysDown) {
        const held = this.held
        if (!this.options.shortcutTarget) void this.observed()
        else void this.options.shortcutTarget().then(accepts => {
          if (accepts && this.held === held) void this.observed()
        }).catch(() => {})
      }
      this.keysDown = down
      const mouse = !!this.options.mouse?.()
      if (mouse && !this.mouseDown && this.options.pointer && this.options.pasteCommandAt) {
        const { x, y } = this.options.pointer()
        this.pressed = { x, y, paste: this.options.pasteCommandAt(x, y).catch(() => false) }
      } else if (!mouse && this.mouseDown && this.pressed && this.options.pointer) {
        const pressed = this.pressed, at = this.options.pointer(), held = this.held
        this.pressed = undefined
        if (Math.hypot(at.x - pressed.x, at.y - pressed.y) <= 6) void pressed.paste.then(paste => {
          if (paste && this.held === held) void this.observed()
        })
      }
      this.mouseDown = mouse
    }, 25)
    this.poll.unref?.()
  }

  async observed(): Promise<void> {
    const held = this.held
    if (!held || this.checking === held) return
    this.checking = held
    try {
      // Windows may advance the sequence when another app requests a delayed clipboard format.
      // In that case check the actual plain-text representation when a paste happens.
      if (held.sequence === undefined || this.options.sequence() !== held.sequence) {
        const text = await this.options.readText()
        if (text.replace(/\r\n/g, '\n') !== held.plain.replace(/\r\n/g, '\n')) return
      }
      if (this.held === held) this.options.pasted(held.id)
    } catch { /* A temporarily unavailable clipboard leaves the result in the widget. */ }
    finally { if (this.checking === held) this.checking = undefined }
  }

  clear(): void {
    clearInterval(this.poll); this.poll = undefined
    this.pressed = undefined
    this.held = undefined
  }
}
