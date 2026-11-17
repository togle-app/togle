// What opening a step of a task's conversation shows (what a command printed, the words of a thought), made fit to show: it
// comes from an agent's own record, and goes to the window only, when the person opens the step.
import type { StepDetail } from '@shared/runner'
import { withoutSecrets } from './claude-sessions'
import { cleanWords } from './terminal'

// The most that is shown: its end, which is where a command says how it went.
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
