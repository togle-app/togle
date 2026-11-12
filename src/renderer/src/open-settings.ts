// Settings opened from anywhere in the window, at the part that fixes what's wrong: the window listens for it and opens
// Settings scrolled there.

/** A part of Settings: the AI plan (under Accounts), speech recognition, or voice typing. */
export type SettingsPart = 'ai' | 'speech' | 'dictation'

const EVENT = 'togle:open-settings'

export const openSettings = (at?: SettingsPart): void => void window.dispatchEvent(new CustomEvent<SettingsPart | undefined>(EVENT, { detail: at }))

export function onOpenSettings(open: (at?: SettingsPart) => void): () => void {
  const listener = (e: Event): void => open((e as CustomEvent<SettingsPart | undefined>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** An error that says to fix something in Settings ("…first, in Settings."): it gets a link there. */
export const pointsToSettings = (text: string): boolean => /\bin Settings\b[^.]*\.?\s*$/.test(text.trim())
