import type { BrowserWindow } from 'electron'
import koffi, { type TypeObject } from 'koffi'

// SetWindowDisplayAffinity values: shown in captures, or left out of every capture (Windows 10 2004 and later).
const WDA_NONE = 0
const WDA_EXCLUDEFROMCAPTURE = 0x11
// WinEvents (for this process only) that mean windows appeared, changed state or moved. Delivered on the
// main thread's message loop.
const WATCHED_EVENTS: [number, number][] = [
  [0x0003, 0x0017], // foreground, menus, move/size, minimize/restore
  [0x8000, 0x8004], // created, destroyed, shown, hidden, z-order changed
  [0x800b, 0x800b] // moved or resized
]
const EVENT_OBJECT_CREATE = 0x8000
const EVENT_OBJECT_SHOW = 0x8002
const WINEVENT_OUTOFCONTEXT = 0
const OBJID_WINDOW = 0
const GA_ROOT = 2

type Hwnd = number | bigint

interface User32 {
  getAffinity: (hwnd: Hwnd, affinity: number[]) => boolean
  setAffinity: (hwnd: Hwnd, affinity: number) => boolean
  rootOf: (hwnd: Hwnd, flags: number) => number
  processOf: (hwnd: Hwnd, pid: number[]) => number
  enumWindows: (each: (hwnd: number, param: number) => boolean, param: number) => boolean
  setHook: (eventMin: number, eventMax: number, module: number, proc: bigint, pid: number, thread: number, flags: number) => number
  unhook: (hook: number) => boolean
  winEventProc: TypeObject
}
let user32: User32 | null | undefined

function load(): User32 | null {
  if (user32 !== undefined) return user32
  if (process.platform !== 'win32') return (user32 = null)
  try {
    const lib = koffi.load('user32.dll')
    koffi.proto('bool __stdcall TogleEnumWindowsProc(intptr_t hwnd, intptr_t param)')
    const winEventProc = koffi.proto(
      'void __stdcall TogleWinEventProc(intptr_t hook, uint32_t event, intptr_t hwnd, int32_t idObject, int32_t idChild, uint32_t thread, uint32_t time)'
    )
    user32 = {
      getAffinity: lib.func('bool __stdcall GetWindowDisplayAffinity(intptr_t hWnd, _Out_ uint32_t *affinity)'),
      setAffinity: lib.func('bool __stdcall SetWindowDisplayAffinity(intptr_t hWnd, uint32_t affinity)'),
      rootOf: lib.func('intptr_t __stdcall GetAncestor(intptr_t hWnd, uint32_t flags)'),
      processOf: lib.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *pid)'),
      enumWindows: lib.func('bool __stdcall EnumWindows(TogleEnumWindowsProc *proc, intptr_t param)'),
      setHook: lib.func(
        'intptr_t __stdcall SetWinEventHook(uint32_t eventMin, uint32_t eventMax, intptr_t module, TogleWinEventProc *proc, uint32_t pid, uint32_t thread, uint32_t flags)'
      ),
      unhook: lib.func('bool __stdcall UnhookWinEvent(intptr_t hook)'),
      winEventProc
    }
  } catch (err) {
    console.warn('[window] cannot manage capture protection directly:', (err as Error).message)
    user32 = null
  }
  return user32
}

const excluded = (api: User32, hwnd: Hwnd): boolean => {
  const affinity = [0]
  return api.getAffinity(hwnd, affinity) && affinity[0] === WDA_EXCLUDEFROMCAPTURE
}

/** Top-level windows of this process: the main window, and Chromium's tooltips and dropdown lists. */
function ownWindows(api: User32): number[] {
  const found: number[] = []
  api.enumWindows((hwnd) => {
    const pid = [0]
    api.processOf(hwnd, pid)
    if (pid[0] === process.pid) found.push(hwnd)
    return true
  }, 0)
  return found
}

/**
 * Keeps Togle out of screenshots, recordings and screen sharing, or lets it back in.
 *
 * Electron's setContentProtection alone isn't enough on Windows:
 * - Chromium applies it when the window shows, and sometimes that doesn't happen (seen at startup, and when
 *   an always-on-top window is hidden and shown again). So this sets it on the window directly too, when the
 *   protection is turned on or off (at startup and on a settings change) and again whenever the window is
 *   shown. It does not poll to keep re-asserting it: if something outside Togle switches it off, it stays off
 *   until the next of those moments.
 * - Tooltips and dropdown lists are separate windows it doesn't cover: an open agent list showed up in a
 *   capture of a hidden Togle. So every window this process creates is protected as it appears.
 */
export class CaptureProtection {
  private on = false
  private readonly hwnd: bigint
  private failed = false

  constructor(private readonly win: BrowserWindow) {
    // A window handle on Windows; elsewhere the handle is another kind (and size) of thing, and isn't used.
    this.hwnd = process.platform === 'win32' ? win.getNativeWindowHandle().readBigInt64LE() : 0n
    win.on('show', () => this.enforce())
    win.on('restore', () => this.enforce())
    const api = load()
    if (!api) return
    const callback = koffi.register(
      (_hook: number, event: number, hwnd: number, idObject: number, idChild: number) => this.onWindowEvent(api, event, hwnd, idObject, idChild),
      koffi.pointer(api.winEventProc)
    )
    const hooks = WATCHED_EVENTS.map(([min, max]) => api.setHook(min, max, 0, callback, process.pid, 0, WINEVENT_OUTOFCONTEXT))
    if (hooks.some((hook) => !hook)) console.warn('[window] cannot watch Togle\'s windows; tooltips and lists may show in screen shares')
    win.on('closed', () => {
      for (const hook of hooks) if (hook) api.unhook(hook)
      koffi.unregister(callback)
    })
  }

  set(on: boolean): void {
    if (this.win.isDestroyed()) return
    this.win.setContentProtection(on)
    if (on === this.on) return
    this.on = on
    // Windows already open (a tooltip, a dropdown list) follow at once.
    const api = load()
    if (api) for (const hwnd of ownWindows(api)) if (excluded(api, hwnd) !== on) api.setAffinity(hwnd, on ? WDA_EXCLUDEFROMCAPTURE : WDA_NONE)
    this.enforce()
  }

  /** Whether captures leave the main window out right now: the affinity Windows has, not just what was asked for. */
  isHiddenFromCapture(): boolean {
    const api = load()
    return !!api && !this.win.isDestroyed() && excluded(api, this.hwnd)
  }

  /** Sets the affinity on the main window directly, in case Chromium's flag didn't take. */
  private enforce(): void {
    const api = load()
    if (!this.on || !api || this.win.isDestroyed() || excluded(api, this.hwnd)) return
    if (!api.setAffinity(this.hwnd, WDA_EXCLUDEFROMCAPTURE) && !this.failed) console.warn('[window] could not hide the window from captures')
    this.failed ||= !excluded(api, this.hwnd)
  }

  /** Called by Windows on the main thread's message loop when one of this process's windows changes. */
  private onWindowEvent(api: User32, event: number, hwnd: number, idObject: number, idChild: number): void {
    try {
      if (!this.on || idObject !== OBJID_WINDOW || idChild !== 0 || !hwnd) return
      // A new tooltip or dropdown list: protect it before it has anything on screen.
      if ((event === EVENT_OBJECT_CREATE || event === EVENT_OBJECT_SHOW) && api.rootOf(hwnd, GA_ROOT) === hwnd && !excluded(api, hwnd)) {
        api.setAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
      }
      this.enforce()
    } catch (err) {
      // Never throw back into native code.
      console.warn('[window] protecting a window failed:', (err as Error).message)
    }
  }
}
