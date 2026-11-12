// How Togle gets words into another app on this system. The design: hold F9 and the words go in where the cursor is, on
// Windows, a Mac (once the system has asked before Togle may type into other apps) and Linux on X11. On the newer Linux
// desktops (Wayland) an app can't hold a key or type into another app, so there F9 starts and stops and Togle copies.

export type TypingWay = 'windows' | 'mac' | 'x11' | 'copy'

/** Whether this Linux desktop runs on Wayland, by what the session says of itself. */
export function onWayland(env: NodeJS.ProcessEnv = process.env): boolean {
  const session = (env.XDG_SESSION_TYPE ?? '').toLowerCase()
  if (session) return session === 'wayland'
  return !!env.WAYLAND_DISPLAY
}

export function typingWay(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): TypingWay {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') return onWayland(env) || !env.DISPLAY ? 'copy' : 'x11'
  return 'copy'
}

/** Whether F9 is held to talk here by default, or pressed once to start and once to stop. */
export const holdsByDefault = (platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): boolean =>
  typingWay(platform, env) !== 'copy'

/** The last key of a shortcut ("Ctrl+Alt+F9" → "f9"). */
const lastKey = (keys: string): string => keys.split('+').at(-1)?.trim().toLowerCase() ?? ''

// A Mac's own codes for keys (kVK_* in Carbon's Events.h). Letters and digits follow the US layout's positions.
const MAC_KEYS: Readonly<Record<string, number>> = {
  a: 0x00, s: 0x01, d: 0x02, f: 0x03, h: 0x04, g: 0x05, z: 0x06, x: 0x07, c: 0x08, v: 0x09, b: 0x0b, q: 0x0c, w: 0x0d, e: 0x0e,
  r: 0x0f, y: 0x10, t: 0x11, 1: 0x12, 2: 0x13, 3: 0x14, 4: 0x15, 6: 0x16, 5: 0x17, 9: 0x19, 7: 0x1a, 8: 0x1c, 0: 0x1d, o: 0x1f,
  u: 0x20, i: 0x22, p: 0x23, l: 0x25, j: 0x26, k: 0x28, n: 0x2d, m: 0x2e,
  enter: 0x24, tab: 0x30, space: 0x31, backspace: 0x33, delete: 0x75, insert: 0x72, home: 0x73, end: 0x77, pageup: 0x74,
  pagedown: 0x79, left: 0x7b, right: 0x7c, down: 0x7d, up: 0x7e,
  f1: 0x7a, f2: 0x78, f3: 0x63, f4: 0x76, f5: 0x60, f6: 0x61, f7: 0x62, f8: 0x64, f9: 0x65, f10: 0x6d, f11: 0x67, f12: 0x6f,
  f13: 0x69, f14: 0x6b, f15: 0x71, f16: 0x6a, f17: 0x40, f18: 0x4f, f19: 0x50, f20: 0x5a,
  num0: 0x52, num1: 0x53, num2: 0x54, num3: 0x55, num4: 0x56, num5: 0x57, num6: 0x58, num7: 0x59, num8: 0x5b, num9: 0x5c,
  numadd: 0x45, numsub: 0x4e, nummult: 0x43, numdiv: 0x4b, numdec: 0x41
}

/** A Mac's code for a shortcut's last key, as CGEventSourceKeyState reads it. */
export const macKeyCode = (keys: string): number | undefined => MAC_KEYS[lastKey(keys)]

// X11 keysyms (X11/keysymdef.h) for keys that are not a letter, a digit or F1 to F24.
const X_KEYS: Readonly<Record<string, number>> = {
  space: 0x20, enter: 0xff0d, tab: 0xff09, backspace: 0xff08, delete: 0xffff, insert: 0xff63, home: 0xff50, end: 0xff57,
  pageup: 0xff55, pagedown: 0xff56, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54,
  numadd: 0xffab, numsub: 0xffad, nummult: 0xffaa, numdiv: 0xffaf, numdec: 0xffae
}

/** The X11 keysym of a shortcut's last key. */
export function x11Keysym(keys: string): number | undefined {
  const key = lastKey(keys)
  if (/^[a-z0-9]$/.test(key)) return key.charCodeAt(0)
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(key)) return 0xffbd + Number(key.slice(1))
  if (/^num\d$/.test(key)) return 0xffb0 + Number(key.slice(3))
  return X_KEYS[key]
}

// Terminals, where pasted words go in as one line (a line break would run what came before it).
const MAC_TERMINALS = new Set([
  'com.apple.terminal', 'com.googlecode.iterm2', 'dev.warp.warp-stable', 'dev.warp.warp', 'net.kovidgoyal.kitty', 'org.alacritty',
  'io.alacritty', 'com.github.wez.wezterm', 'co.zeit.hyper', 'com.mitchellh.ghostty', 'com.raphaelamorim.rio', 'org.tabby'
])
export const isMacTerminal = (bundleId: string): boolean => MAC_TERMINALS.has(bundleId.trim().toLowerCase())

const LINUX_TERMINALS = new Set([
  'gnome-terminal', 'gnome-terminal-server', 'org.gnome.terminal', 'org.gnome.console', 'kgx', 'org.gnome.ptyxis', 'ptyxis', 'konsole',
  'xterm', 'uxterm', 'urxvt', 'rxvt', 'alacritty', 'kitty', 'tilix', 'com.gexperts.tilix', 'terminator', 'xfce4-terminal', 'lxterminal',
  'qterminal', 'mate-terminal', 'terminology', 'wezterm', 'org.wezfurlong.wezterm', 'foot', 'st', 'st-256color', 'sakura', 'guake',
  'tilda', 'yakuake', 'ghostty', 'com.mitchellh.ghostty', 'blackbox', 'com.raggesilver.blackbox', 'deepin-terminal', 'cool-retro-term',
  'hyper', 'tabby', 'warp', 'dev.warp.warp'
])
/** Whether a Linux window is a terminal, by its classes (WM_CLASS: "gnome-terminal-server", "Gnome-terminal"). */
export const isLinuxTerminal = (classes: string[]): boolean => classes.some((name) => LINUX_TERMINALS.has(name.trim().toLowerCase()))

/** Words for a terminal: one line, so pasting them runs nothing. */
export const oneLine = (text: string): string => text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim()

/** A file's path as a POSIX shell reads it whole, between single quotes. */
export const shellQuoted = (file: string): string => `'${file.replace(/'/g, `'\\''`)}'`
