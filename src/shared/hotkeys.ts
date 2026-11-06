// Togle's shortcuts, which work from any app: the keys as Electron writes them ("Ctrl+Alt+Space"), what can be one,
// and the keys pressed as they're recorded in Settings.

/** Each thing a shortcut does. */
export type HotkeyId = 'dictate' | 'suggest' | 'suggest-screen' | 'deeper' | 'listen' | 'snapshot' | 'record' | 'show' | 'ask' | 'copy'

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'] as const
type Modifier = (typeof MODIFIERS)[number]

// What each modifier is written as, however a settings file or Electron's own spelling has it.
const SPELLINGS: Record<Modifier, RegExp> = {
  Ctrl: /^(?:ctrl|control|commandorcontrol|cmdorctrl)$/i,
  Alt: /^(?:alt|option)$/i,
  Shift: /^shift$/i,
  Super: /^(?:super|meta|win|windows|cmd|command)$/i
}

/** The keys, as written the same way whatever the order or case: "alt+ctrl+space" is "Ctrl+Alt+space". */
function parts(keys: string): { mods: Set<Modifier>; key: string } {
  const all = keys
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean)
  const mods = new Set<Modifier>()
  let key = ''
  for (const part of all) {
    const mod = MODIFIERS.find((m) => SPELLINGS[m].test(part))
    if (mod) mods.add(mod)
    else key = part
  }
  return { mods, key }
}

/** Whether two ways of writing keys are the same keys. */
export function sameKeys(a: string, b: string): boolean {
  if (!a || !b) return false
  const x = parts(a)
  const y = parts(b)
  return x.key.toLowerCase() === y.key.toLowerCase() && x.mods.size === y.mods.size && [...x.mods].every((m) => y.mods.has(m))
}

const F_KEY = /^F(?:[1-9]|1\d|2[0-4])$/
// The keys a shortcut can be on, besides letters, digits and F keys.
const NAMED = new Set(['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'Up', 'Down', 'Left', 'Right'])
const NUMPAD = /^num(?:\d|add|sub|mult|div|dec)$/

/**
 * Why these keys can't be a shortcut that works from every app (it would take them from every other app too), or
 * undefined when they can be. Whether another app has them already only trying them tells.
 */
export function hotkeyProblem(keys: string): string | undefined {
  const { mods, key } = parts(keys)
  if (!key) return 'Press a key too, with Ctrl or Alt.'
  if (key === 'Esc' || key === 'Escape') return 'Esc closes things in every app: pick another key.'
  if (!F_KEY.test(key) && !NAMED.has(key) && !NUMPAD.test(key) && !/^[A-Z0-9]$/.test(key)) return "That key can't be a shortcut: use a letter, a digit, an F key, Space, Enter or an arrow."
  const ctrl = mods.has('Ctrl')
  const alt = mods.has('Alt')
  const shift = mods.has('Shift')
  const win = mods.has('Super')
  const typing = /^[A-Z0-9]$/.test(key)
  if (!F_KEY.test(key) && !ctrl && !alt && !win) return 'Add Ctrl or Alt: without them, that key would stop working in every other app.'
  if (typing && ctrl && alt && !shift && !win) return 'On many keyboards Ctrl+Alt with a letter types a character (AltGr, as @ or €): add Shift, or pick another key.'
  if (typing && ctrl && !alt && !win) return 'Ctrl with a letter or a digit is a shortcut in most apps (Ctrl+C copies): add Alt, or pick another key.'
  if (typing && alt && !ctrl && !shift && !win) return 'Alt with a letter opens menus in most apps: add Ctrl, or pick another key.'
  return undefined
}

/** A key as it's pressed, as far as a recorder of shortcuts needs it. */
export interface PressedKey {
  key: string
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

const BY_CODE: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/**
 * The keys pressed, written as a shortcut ("Ctrl+Alt+Shift+K"); `key` is empty while only modifiers are down. A
 * letter goes by what the keyboard writes (Z on a German or Croatian keyboard is where Y is on an English one), the
 * rest by where it is.
 */
export function keysPressed(e: PressedKey): { keys: string; key: string } {
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Super')
  const key = /^[a-z]$/i.test(e.key)
    ? e.key.toUpperCase()
    : (/^Key([A-Z])$/.exec(e.code)?.[1] ??
      /^Digit(\d)$/.exec(e.code)?.[1] ??
      (/^Numpad(\d)$/.exec(e.code) ? `num${e.code.slice(6)}` : undefined) ??
      (F_KEY.test(e.code) ? e.code : undefined) ??
      BY_CODE[e.code] ??
      // A modifier on its own, or a key of punctuation: none that a shortcut can be on.
      (/^(?:Control|Alt|Shift|Meta|OS|AltGraph)/.test(e.key) ? '' : e.key.length === 1 ? e.key : ''))
  return { keys: [...mods, ...(key ? [key] : [])].join('+'), key }
}
