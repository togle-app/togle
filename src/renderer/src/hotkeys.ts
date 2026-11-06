import { useSyncExternalStore } from 'react'
import type { HotkeyId, HotkeyInfo } from '@shared/types'

const api = window.togle

// The shortcuts as Togle has them now, for what the window says of them (a button's tip, a menu); changed in Settings,
// what shows them is drawn again.
let current: HotkeyInfo[] = []
const listeners = new Set<() => void>()
const changed = (list: HotkeyInfo[]): void => {
  current = list
  for (const listener of listeners) listener()
}
void api.listHotkeys().then(changed)
api.onHotkeysChanged(changed)

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** All the shortcuts, as they are now. */
export const useHotkeys = (): HotkeyInfo[] => useSyncExternalStore(subscribe, () => current)

/** A shortcut's keys as they are now ("Ctrl+Alt+Space"); empty when it's off, or another app has them. */
export function useHotkey(id: HotkeyId): string {
  return useSyncExternalStore(subscribe, () => {
    const hotkey = current.find((h) => h.id === id)
    return hotkey?.ok ? hotkey.keys : ''
  })
}

/** "Suggest a reply (Ctrl+Alt+Space)", or just what it does when it has no keys. */
export const withKeys = (text: string, keys: string): string => (keys ? `${text} (${keys})` : text)
