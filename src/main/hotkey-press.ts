/** One action per physical press, with an optional release action and no polling while idle. */
export class HotkeyPress {
  private held = false
  private timer?: ReturnType<typeof setInterval>
  constructor(private down: (key: number) => boolean) {}
  run(keys: string, action: () => void, released?: () => void): void {
    if (this.held) return
    const key = virtualKey(keys)
    if (key !== undefined && this.down(key)) {
      this.held = true
      // Only while this shortcut is down; no idle polling or global keyboard hook.
      this.timer = setInterval(() => { if (!this.down(key)) { this.reset(); released?.() } }, 25)
      this.timer.unref?.()
    }
    action()
    if (!this.held) released?.()
  }
  reset(): void { clearInterval(this.timer); this.timer = undefined; this.held = false }
}

export function virtualKey(keys: string): number | undefined {
  const key = keys.split('+').at(-1)?.toLowerCase() ?? ''
  if (/^[a-z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(key)) return 111 + Number(key.slice(1))
  if (/^num\d$/.test(key)) return 96 + Number(key.slice(3))
  return ({ space: 32, enter: 13, tab: 9, backspace: 8, delete: 46, insert: 45, home: 36, end: 35,
    pageup: 33, pagedown: 34, up: 38, down: 40, left: 37, right: 39,
    numadd: 107, numsub: 109, nummult: 106, numdiv: 111, numdec: 110 } as Record<string, number>)[key]
}
