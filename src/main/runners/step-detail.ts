// What opening a step of a task's conversation shows (what a command printed, the words of a thought, how a file changed), made
// fit to show: it comes from an agent's own record, and goes to the window only, when the person opens the step.
import type { StepDetail } from '@shared/runner'
import { withoutSecrets } from './claude-sessions'
import { cleanWords } from './terminal'

// The most that is shown: of what was printed its end, which is where a command says how it went; of a change its start.
const SHOWN_MOST = 24_000

/**
 * A text from an agent's record as the window may show it: without what a terminal takes as keys of its own (colors, control
 * characters), with the keys and passwords in it taken out, with one kind of line break, and no longer than a few screens.
 * Null when nothing is left of it.
 */
export function detailOf(raw: string | null | undefined): StepDetail | null {
  if (!raw) return null
  const clean = withoutSecrets(cleanWords(raw.replace(/\r\n?/g, '\n')))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  if (!clean) return null
  return clean.length > SHOWN_MOST ? { text: clean.slice(-SHOWN_MOST).replace(/^[^\n]*\n/, ''), cut: true } : { text: clean, cut: false }
}

/**
 * How a file changed, as the window may show it: its lines as they are (a line's first letter says what it is: " " kept, "+"
 * added, "-" taken out, "@@" where), with only what a terminal takes as keys of its own and the keys and passwords in it taken
 * out, and its start when it is long, cut at the end of a line. Null when nothing is left of it.
 */
export function diffOf(raw: string | null | undefined): StepDetail | null {
  if (!raw) return null
  const clean = withoutSecrets(cleanWords(raw.replace(/\r\n?/g, '\n'))).replace(/\n+$/, '')
  if (!clean.replace(/\s/g, '')) return null
  if (clean.length <= SHOWN_MOST) return { text: clean, cut: false, diff: true }
  const end = clean.lastIndexOf('\n', SHOWN_MOST)
  return { text: clean.slice(0, end > 0 ? end : SHOWN_MOST), cut: true, diff: true }
}

/** A file's whole text as a change that added all of it: each line marked "+". */
export const addedLines = (text: string): string => text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((line) => `+${line}`).join('\n')

/** The key of one file's change, of a change of several: the change's key and the file's place among its files. */
export const fileKey = (more: string, index: number): string => `${more}#${index}`

/** Whether a step's key names one file's change. */
export const isFileKey = (more: string): boolean => /#\d+$/.test(more)
