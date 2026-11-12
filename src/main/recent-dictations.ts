/**
 * The last dictations, newest first: what the tray offers to copy when Togle could not type the words where they were
 * meant to go. Kept in memory only, until Togle closes.
 */
export const RECENT_DICTATIONS = 10
const LABEL_LENGTH = 48

/** The list with this dictation first (once), cut to the last ten. */
export function withRecent(list: readonly string[], text: string | undefined): string[] {
  const value = text?.trim()
  if (!value) return [...list]
  return [value, ...list.filter(item => item !== value)].slice(0, RECENT_DICTATIONS)
}

/** A dictation as a menu item: on one line, cut short. */
export function recentLabel(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > LABEL_LENGTH ? flat.slice(0, LABEL_LENGTH - 1).trimEnd() + '…' : flat
}
