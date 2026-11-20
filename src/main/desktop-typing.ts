// Typing on a Mac and on Linux with X11: the words go in through the clipboard and the system's paste keys, and what was
// on the clipboard is put back. A Mac asks once, under Accessibility, before Togle may press keys in other apps; until it
// is allowed, the words are copied. On X11 the keys are pressed through the XTest extension. Neither way was tried on
// those systems yet, so anything that fails leaves the words copied, never lost.
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import koffi from 'koffi'
import { BrowserWindow, clipboard, ClipboardItem } from 'electron'
import type { DictationInsertion, DictationTarget } from '@shared/dictation'
import { lsappinfoBundle, xpropActiveWindow, xpropClasses } from './front-program'
import { isLinuxTerminal, isMacTerminal, macKeyCode, oneLine, shellQuoted, typingWay, x11Keysym, type TypingWay } from './typing-way'

/** Reading whether a key is held, for hold-to-talk. */
export interface HeldKeys { down(code: number): boolean; codeOf(keys: string): number | undefined }

interface MacInput { trusted(ask: boolean): boolean; editable(): boolean; keyDown(code: number): boolean; paste(): void }
interface X11Input { keyDown(keysym: number): boolean; paste(terminal: boolean): void }

let mac: MacInput | null | undefined
function macInput(): MacInput | null {
  if (mac !== undefined) return mac
  try {
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    const services = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices')
    const isTrusted = services.func('bool AXIsProcessTrusted()')
    const isTrustedAsking = services.func('bool AXIsProcessTrustedWithOptions(void *options)')
    const keyState = services.func('bool CGEventSourceKeyState(int32_t state, uint16_t key)')
    const keyEvent = services.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)')
    const setFlags = services.func('void CGEventSetFlags(void *event, uint64_t flags)')
    const post = services.func('void CGEventPost(uint32_t tap, void *event)')
    const release = cf.func('void CFRelease(void *object)')
    const cfString = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)')
    const equal = cf.func('uint8_t CFEqual(void *a, void *b)')
    const system = services.func('void *AXUIElementCreateSystemWide()')
    const attribute = services.func('int32_t AXUIElementCopyAttributeValue(void *element, void *key, _Out_ void **value)')
    const settable = services.func('int32_t AXUIElementIsAttributeSettable(void *element, void *key, _Out_ uint8_t *value)')
    const keys = Object.fromEntries(['AXFocusedUIElement', 'AXRole', 'AXSubrole', 'AXValue', 'AXSelectedText', 'AXSecureTextField', 'AXTextField', 'AXTextArea', 'AXComboBox'].map(key => [key, cfString(null, key, 0x08000100)]))
    const dictionary = cf.func('void *CFDictionaryCreate(void *allocator, void *keys, void *values, intptr_t count, void *keyCallBacks, void *valueCallBacks)')
    const valueOf = (lib: ReturnType<typeof koffi.load>, name: string): bigint => koffi.decode(lib.symbol(name), 'void *') as bigint
    const HID_STATE = 1, HID_TAP = 0, COMMAND = 0x100000, V = 0x09
    mac = {
      editable() {
        const root = system(), focused = [null], role = [null], subrole = [null], yes = [0]
        try {
          if (!root || attribute(root, keys.AXFocusedUIElement, focused) || !focused[0]) return false
          if (!attribute(focused[0], keys.AXSubrole, subrole) && subrole[0] && equal(subrole[0], keys.AXSecureTextField)) return false
          if (!settable(focused[0], keys.AXSelectedText, yes) && yes[0]) return true
          return !attribute(focused[0], keys.AXRole, role) && !!role[0]
            && ['AXTextField', 'AXTextArea', 'AXComboBox'].some(key => equal(role[0], keys[key]))
            && !settable(focused[0], keys.AXValue, yes) && !!yes[0]
        } finally { for (const ref of [subrole[0], role[0], focused[0], root]) if (ref) release(ref) }
      },
      trusted(ask) {
        if (!ask) return !!isTrusted()
        // The system's own question: "Togle would like to control this computer using accessibility features."
        const options = dictionary(null, new BigUint64Array([valueOf(services, 'kAXTrustedCheckOptionPrompt')]),
          new BigUint64Array([valueOf(cf, 'kCFBooleanTrue')]), 1, cf.symbol('kCFTypeDictionaryKeyCallBacks'), cf.symbol('kCFTypeDictionaryValueCallBacks'))
        try { return !!isTrustedAsking(options) } finally { if (options) release(options) }
      },
      keyDown: (code) => !!keyState(HID_STATE, code),
      paste() {
        for (const down of [true, false]) {
          const event = keyEvent(null, V, down)
          if (!event) throw new Error('The Mac did not make the paste keys.')
          try { setFlags(event, COMMAND); post(HID_TAP, event) } finally { release(event) }
        }
      }
    }
  } catch (error) {
    console.warn('[typing] the Mac input functions did not load:', (error as Error).message)
    mac = null
  }
  return mac
}

let x11: X11Input | null | undefined
function x11Input(): X11Input | null {
  if (x11 !== undefined) return x11
  try {
    const xlib = koffi.load('libX11.so.6')
    const xtest = koffi.load('libXtst.so.6')
    const open = xlib.func('void *XOpenDisplay(const char *name)')
    const queryKeymap = xlib.func('int XQueryKeymap(void *display, void *keys)')
    const keycodeOf = xlib.func('uint8_t XKeysymToKeycode(void *display, unsigned long keysym)')
    const flush = xlib.func('int XFlush(void *display)')
    const fake = xtest.func('int XTestFakeKeyEvent(void *display, unsigned int keycode, int press, unsigned long delay)')
    const display = open(null)
    if (!display) throw new Error('No X display.')
    const keys = Buffer.alloc(32)
    const codes = new Map<number, number>()
    const code = (keysym: number): number => {
      let found = codes.get(keysym)
      if (found === undefined) { found = Number(keycodeOf(display, keysym)) || 0; codes.set(keysym, found) }
      return found
    }
    const CONTROL = 0xffe3, SHIFT = 0xffe1, V = 0x76
    x11 = {
      keyDown(keysym) {
        const key = code(keysym)
        if (!key) return false
        queryKeymap(display, keys)
        return !!(keys[key >> 3] & (1 << (key & 7)))
      },
      paste(terminal) {
        // Terminals paste with Ctrl+Shift+V; Ctrl+V there is a key of its own.
        const held = (terminal ? [CONTROL, SHIFT] : [CONTROL]).map(code)
        const v = code(V)
        if (!v || held.some((key) => !key)) throw new Error('This keyboard has no paste keys Togle can press.')
        for (const key of held) fake(display, key, 1, 0)
        fake(display, v, 1, 0); fake(display, v, 0, 0)
        for (const key of [...held].reverse()) fake(display, key, 0, 0)
        flush(display)
      }
    }
  } catch (error) {
    console.warn('[typing] X11 typing did not load:', (error as Error).message)
    x11 = null
  }
  return x11
}

/** What a small program prints, given half a second at most. */
function quick(file: string, args: string[]): string {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 500, stdio: ['ignore', 'pipe', 'ignore'] }) } catch { return '' }
}

/** The app in front: an id that changes when another comes to the front, its name and whether it is a terminal. */
interface Front { id: string; name?: string; terminal: boolean; checkShowField?: boolean }
function front(way: TypingWay): Front | undefined {
  if (way === 'mac') {
    const app = quick('lsappinfo', ['front']).trim()
    if (!app) return undefined
    const bundle = lsappinfoBundle(quick('lsappinfo', ['info', '-only', 'bundleid', app])) ?? ''
    const name = /"LSDisplayName"\s*=\s*"([^"]+)"/.exec(quick('lsappinfo', ['info', '-only', 'name', app]))?.[1]
    return { id: app, name, terminal: isMacTerminal(bundle) }
  }
  if (way === 'x11') {
    const window = xpropActiveWindow(quick('xprop', ['-root', '_NET_ACTIVE_WINDOW']))
    if (!window) return undefined
    const classes = xpropClasses(quick('xprop', ['-id', window, 'WM_CLASS']))
    return { id: window, name: classes.at(-1), terminal: isLinuxTerminal(classes) }
  }
  return undefined
}

/**
 * Everything on the clipboard, read out in full, to put back after a paste: the items Electron gives point at the
 * clipboard itself, which the paste is about to change.
 */
async function saveClipboard(): Promise<ClipboardItem[]> {
  const items = await clipboard.read()
  return Promise.all(items.map(async (item) => new ClipboardItem(Object.fromEntries(
    await Promise.all(item.types.map(async (type) => [type, await item.getType(type)] as const))
  ))))
}
async function restoreClipboard(saved: ClipboardItem[]): Promise<void> {
  if (saved.length) await clipboard.write(saved)
  else clipboard.clear()
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
// The app reads the clipboard when it handles the paste keys, a moment after they were pressed.
const PASTE_SETTLE_MS = 450

/** Togle's own renderers can identify the actual field even on desktops without an accessibility service. */
export async function localShowField(): Promise<boolean | undefined> {
  const win = BrowserWindow.getFocusedWindow()
  if (!win) return undefined
  return win.webContents.executeJavaScript(`(() => {
    const field = document.activeElement
    if (!field || field.matches(':disabled, [readonly], [aria-readonly="true"], [aria-disabled="true"]')) return false
    return field.isContentEditable || field instanceof HTMLTextAreaElement ||
      (field instanceof HTMLInputElement && ['text', 'search', 'url', 'tel', 'email'].includes(field.type))
  })()`).catch(() => false)
}

// Look only for the focused editable control in the foreground X11 process. Some desktops do not expose AT-SPI.
const x11Focus = `import gi, sys
gi.require_version('Atspi', '2.0')
from gi.repository import Atspi
desktop = Atspi.get_desktop(0)
def children(node):
    return (node.get_child_at_index(i) for i in range(node.get_child_count()))
app = next((node for node in children(desktop) if node and node.get_process_id() == int(sys.argv[1])), None)
stack = [node for node in children(app) if node and node.get_state_set().contains(Atspi.StateType.ACTIVE)] if app else []
while stack:
    node = stack.pop()
    states = node.get_state_set()
    if states.contains(Atspi.StateType.FOCUSED) and states.contains(Atspi.StateType.EDITABLE) and node.get_role() != Atspi.Role.PASSWORD_TEXT:
        print('editable')
        break
    stack.extend(child for child in children(node) if child)
`
const runFile = promisify(execFile)
async function showField(way: TypingWay, noted: Front): Promise<boolean> {
  const own = await localShowField()
  if (own !== undefined) return own
  if (noted.terminal) return true
  if (way === 'mac') return macInput()?.editable() ?? false
  const pid = /=\s*(\d+)\s*$/.exec(quick('xprop', ['-id', noted.id, '_NET_WM_PID']))?.[1]
  if (!pid) return false
  try { return (await runFile('python3', ['-c', x11Focus, pid], { timeout: 1000 })).stdout.trim() === 'editable' }
  catch { return false }
}

/** One clipboard item that rich editors, image-only targets, and text fields can each paste. */
export async function copyShowResult(file: string, words: string, terminal = false): Promise<string> {
  const png = await readFile(file)
  const text = '"' + file + '"' + (words ? ' ' + (terminal ? oneLine(words) : words) : '')
  const caption = words.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/\r\n|\r|\n/g, '<br>')
  const html = '<img alt="Screenshot" src="data:image/png;base64,' + png.toString('base64') + '">' + (caption ? '<p>' + caption + '</p>' : '')
  await clipboard.write([new ClipboardItem({
    'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
    'text/html': new Blob([html], { type: 'text/html' }),
    'text/plain': new Blob([text], { type: 'text/plain' })
  })])
  return text
}

export class DesktopTyping {
  private noted = new Map<string, Front>()
  private asked = false
  constructor(private readonly way: TypingWay = typingWay()) {}

  /** Reading the hold key, where this system allows it. */
  keys(): HeldKeys | undefined {
    if (this.way === 'mac') { const input = macInput(); return input ? { down: (code) => input.keyDown(code), codeOf: macKeyCode } : undefined }
    if (this.way === 'x11') { const input = x11Input(); return input ? { down: (code) => input.keyDown(code), codeOf: x11Keysym } : undefined }
    return undefined
  }

  async capture(forShow = false): Promise<DictationTarget> {
    if (this.way === 'copy') return { label: 'Your text box', copy: true, copyReason: "on this desktop Togle can't type into other apps." }
    const now = front(this.way)
    const label = now?.name || 'Your text box'
    const terminal = !!now?.terminal
    if (this.way === 'mac') {
      const input = macInput()
      if (!input) return { label, copy: true, terminal, copyReason: "Togle couldn't type on this Mac." }
      if (!input.trusted(false)) {
        // The system asks once; after that, the bar says where to allow it.
        if (!this.asked) { this.asked = true; try { input.trusted(true) } catch { /* The words are still copied. */ } }
        return { label, copy: true, terminal, copyReason: 'Togle types here once you allow it in System Settings, under Privacy & Security, Accessibility.' }
      }
    } else if (!x11Input()) return { label, copy: true, terminal, copyReason: "Togle couldn't type on this desktop." }
    if (!now) return { label, copy: true, terminal, copyReason: "Togle couldn't tell which window is in front." }
    if (forShow && !await showField(this.way, now)) return { label, terminal }
    now.checkShowField = forShow
    const token = randomUUID()
    this.noted.set(token, now)
    while (this.noted.size > 8) this.noted.delete(this.noted.keys().next().value!)
    return { token, label, terminal }
  }

  async insert(token: string, text: string): Promise<DictationInsertion> {
    const noted = this.noted.get(token)
    this.noted.delete(token)
    if (!noted) return { inserted: false, message: 'The text box is gone. Your words are ready to copy.' }
    const words = noted.terminal ? oneLine(text) : text
    return this.paste(noted, () => clipboard.writeText(words), async () => (await clipboard.readText()) === words)
  }

  /** F8 Show: the picture into the noted box, or its path into a terminal. The words follow in the same box. */
  async insertPicture(token: string, file: string): Promise<DictationInsertion> {
    const noted = this.noted.get(token)
    if (!noted) return { inserted: false, message: `The picture is saved at ${file}.` }
    if (noted.terminal) {
      const typed = `${shellQuoted(file)} `
      return this.paste(noted, () => clipboard.writeText(typed), async () => (await clipboard.readText()) === typed, file)
    }
    let png: Buffer
    try { png = await readFile(file) } catch { return { inserted: false, message: `The picture is saved at ${file}.` } }
    const pathText = `"${file}" `
    const picture = new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }), 'text/plain': new Blob([pathText], { type: 'text/plain' }) })
    return this.paste(noted, () => clipboard.write([picture]), async () => {
      const [item] = await clipboard.read()
      return !!item?.types.includes('image/png') && await clipboard.readText() === pathText
    }, file)
  }

  private async paste(noted: Front, write: () => Promise<void>, stillOurs: () => Promise<boolean>, picture?: string): Promise<DictationInsertion> {
    const kept = picture ? ` The picture is saved at ${picture}.` : ''
    if (front(this.way)?.id !== noted.id || (noted.checkShowField && !await showField(this.way, noted))) return { inserted: false, message: `The original text box is unavailable. Your words are ready to copy.${kept}` }
    let saved: ClipboardItem[] = []
    try { saved = await saveClipboard() } catch { /* Nothing readable to put back. */ }
    try {
      await write()
      await wait(40)
      if (this.way === 'mac') macInput()?.paste()
      else x11Input()?.paste(noted.terminal)
    } catch (error) {
      try { await restoreClipboard(saved) } catch { /* What was copied before is lost only if the system refuses it back. */ }
      return { inserted: false, message: `${(error as Error).message || 'Togle could not press the paste keys.'} Your words are ready to copy.${kept}` }
    }
    await wait(PASTE_SETTLE_MS)
    // Put back what was there, unless something new was copied meanwhile.
    try { if (await stillOurs()) await restoreClipboard(saved) } catch { /* The pasted words stay on the clipboard. */ }
    return { inserted: true }
  }
}
