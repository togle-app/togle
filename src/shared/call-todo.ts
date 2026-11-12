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
  startedAt: number
  text: string
}

const fold = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase().trim()
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const TODO_HEADING = /^(?:to[- ]?dos?|action items?|next steps?|follow[- ]ups?)$/
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/
// "You: send it", "**You**: send it", "**You:** send it".
const OWNED = /^\**([^:*\n]{1,40}?)\**\s*:\**\s+(.+)$/
// One or two capitalized words before a colon read as a person's name.
const NAMELIKE = /^\p{Lu}[\p{L}'’-]*(?:\s+\p{Lu}[\p{L}'’-]*)?$/u
// A name alone on a line, in bold: the items under it are that person's.
const ALONE =/^\*\*([^*:\n]{1,40}):?\*\*:?$/
const CITATION = /\s*\[\d{1,3}:\d{2}(?:\s*[-–,]\s*\d{1,3}:\d{2})*\]\s*/g
const MAX_ITEMS = 8
const MAX_LENGTH = 160

/**
 * The to-dos of a call's notes that the person took: items under a "To do" (or "Action items", "Next steps") heading that
 * start with their name or "You" ("- You: send the API timeline to Dario"), or sit under a sub-heading or a line in bold
 * with their name. Items for other people, and items nobody owns, are not offered: they stay in the notes. Citations of
 * the transcript are dropped.
 */
export function myTodoItems(notes: string, names: string[]): string[] {
  const mine = new Set(['you', ...names.flatMap(name => [name, name.split(/\s+/)[0]])].map(fold).filter(Boolean))
  const found: string[] = []
  // The level of the to-do heading the lines are under (0: not under one), and whose items a sub-heading says follow.
  let level = 0
  let group: string | undefined
  for (const line of notes.split(/\r?\n/)) {
    const heading = HEADING.exec(line)
    if (heading) {
      const title = fold(heading[2].replace(/[*_`:]/g, ''))
      if (TODO_HEADING.test(title)) { level = heading[1].length; group = undefined } else if (level && heading[1].length > level) group = title
      else { level = 0; group = undefined }
      continue
    }
    if (!level) continue
    const alone = ALONE.exec(line.trim())
    if (alone) { group = fold(alone[1]); continue }
    const item = ITEM.exec(line)?.[1]
    if (!item) continue
    const owned = OWNED.exec(item)
    // Under a name, a line that says it is someone else's ("Marta: ...") is not.
    if (group && owned && !mine.has(fold(owned[1])) && NAMELIKE.test(owned[1].trim())) continue
    // Under a sub-heading or a name in bold, the whole line is the task; otherwise the name is at its start.
    const owner = group ?? (owned && fold(owned[1]))
    const task = group ? item : owned?.[2]
    if (!owner || !task || !mine.has(owner)) continue
    const text = task.replace(CITATION, ' ').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()
    if (text && !found.some(other => fold(other) === fold(text))) found.push(text.length > MAX_LENGTH ? text.slice(0, MAX_LENGTH - 1).trimEnd() + '…' : text)
    if (found.length >= MAX_ITEMS) break
  }
  return found
}
