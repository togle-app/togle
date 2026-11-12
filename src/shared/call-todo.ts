/** A call that left something on the person's day: names to confirm, or notes that are ready. */
export interface CallOffer {
  id: string
  title: string
  startedAt: number
  /** The notes were written today. */
  notes: boolean
  /** How many voices wait for a name. */
  toConfirm: number
}

/** One to-do from a call's notes that the person took, offered on their list. */
export interface TodoOffer {
  callId: string
  title: string
  text: string
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim()
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/
const TODO_HEADING = /^(?:to[- ]?dos?|action items?|next steps?|follow[- ]ups?)$/
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/
const OWNED = /^\**([^:*\n]{1,40}?)\**\s*:\s+(.+)$/
const CITATION = /\s*\[\d{1,3}:\d{2}(?:\s*[-–,]\s*\d{1,3}:\d{2})*\]\s*/g
const MAX_ITEMS = 8
const MAX_LENGTH = 160

/**
 * The to-dos of a call's notes that the person took: items under a "To do" (or "Action items", "Next steps") heading that
 * start with their name or "You" ("- You: send the API timeline to Dario"). Items for other people, and items nobody
 * owns, are not offered: they stay in the notes. Citations of the transcript are dropped.
 */
export function myTodoItems(notes: string, names: string[]): string[] {
  const mine = new Set(['you', ...names.flatMap(name => [name, name.split(/\s+/)[0]])].map(fold).filter(Boolean))
  const found: string[] = []
  let inside = false
  for (const line of notes.split(/\r?\n/)) {
    const heading = HEADING.exec(line)
    if (heading) {
      inside = TODO_HEADING.test(fold(heading[1].replace(/[*_`:]/g, '')))
      continue
    }
    if (!inside) continue
    const item = ITEM.exec(line)?.[1]
    const owned = item && OWNED.exec(item)
    if (!owned || !mine.has(fold(owned[1]))) continue
    const text = owned[2].replace(CITATION, ' ').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
    if (text && !found.some(other => fold(other) === fold(text))) found.push(text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH - 1).trimEnd() + '…' : text)
    if (found.length >= MAX_ITEMS) break
  }
  return found
}
