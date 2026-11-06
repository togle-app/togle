// What an edit of a text did, line by line: the lines it put in and the ones it took out, between the lines both
// have before and after. The agent's instructions and what it knows about me are a line each (a rule, a fact), so
// this is what a change line says, and what undoing it takes back even after later changes.

export interface LineEdit {
  /** The lines the edit put in, in order (none: it only took lines out). */
  added: string[]
  /** The lines it took out. */
  removed: string[]
}

// Lines with something on them, as they read (blank lines and indentation aside).
const filled = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

/** The lines put in and taken out between `before` and `after`: those between the lines both start and end with. */
export function lineEdit(before: string, after: string): LineEdit {
  const a = filled(before)
  const b = filled(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return { added: b.slice(start, b.length - end), removed: a.slice(start, a.length - end) }
}

/**
 * The text as it is now with an earlier edit taken back: the lines it put in replaced by the ones it took out, if
 * those lines are still there together, and only once; the rest stays as it is. Null when they aren't (changed or
 * taken out since), or when the edit only took lines out (where they'd go back can't be told).
 */
export function undoLines(now: string, edit: LineEdit): string | null {
  if (!edit.added.length) return null
  const raw = now.split('\n')
  // The lines with something on them, and where each is in the text.
  const lines = raw.flatMap((line, i) => (line.trim() ? [{ text: line.trim(), i }] : []))
  const found: number[] = []
  for (let k = 0; k + edit.added.length <= lines.length; k++) {
    if (edit.added.every((line, j) => lines[k + j].text === line)) found.push(k)
  }
  if (found.length !== 1) return null
  const first = lines[found[0]].i
  const last = lines[found[0] + edit.added.length - 1].i
  return [...raw.slice(0, first), ...edit.removed, ...raw.slice(last + 1)]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
