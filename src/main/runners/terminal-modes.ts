// The modes a program sets on its terminal (ESC [ ? n h sets one, ESC [ ? n l clears it) that decide what the screen it draws asks of
// the window: which of the two screens it draws on, whether it wants the mouse (and with it the wheel), bracketed paste, focus
// reports and application cursor keys. A program sets them once, when it starts. A window that opens the screen later is sent only
// the last part of what it printed, so the modes have to be told to it again, as the program had them where that part starts:
// without them the wheel would scroll nothing (Claude Code draws on the other screen and asks for the mouse), a paste would not be
// bracketed and the arrows would not be the program's, until the program happened to set them again.

/** The modes that matter to the window. 47, 1047 and 1049 are the other screen (1049 also saves the cursor). */
const TRACKED = new Set([1, 9, 47, 1000, 1001, 1002, 1003, 1004, 1005, 1006, 1015, 1016, 1047, 1049, 2004])
const OTHER_SCREEN = [47, 1047, 1049]
/** What sets a mode or clears one (ESC [ ? 1000 ; 1006 h), a full reset (ESC c) and a soft one (ESC [ ! p), in the order they come. */
const SEQUENCE = /\x1b(?:\[\?([0-9;]+)([hl])|c|\[!p)/g
/** The start of a sequence that is not all there yet. */
const UNFINISHED = /\x1b(?:\[(?:\?[0-9;]*|!)?)?$/

export class TerminalModes {
  /** The modes that are on, in the order they were last set: the last of several mouse modes is the one in force. */
  private readonly on = new Map<number, true>()
  private carry = ''

  /** Reads the next part of what the program printed. A sequence cut at the end of a part is finished by the next. */
  feed(data: string): void {
    const text = this.carry + data
    const cut = UNFINISHED.exec(text)
    this.carry = cut ? cut[0] : ''
    const seen = cut ? text.slice(0, cut.index) : text
    for (const match of seen.matchAll(SEQUENCE)) {
      if (match[1] === undefined) {
        this.on.clear()
        continue
      }
      for (const part of match[1].split(';')) {
        const mode = Number(part)
        if (!TRACKED.has(mode)) continue
        this.on.delete(mode)
        if (match[2] === 'h') this.on.set(mode, true)
      }
    }
  }

  /** Whether the program has this mode on now: it set it, and has not cleared it (or reset the terminal) since. */
  has(mode: number): boolean {
    return this.on.has(mode)
  }

  /** The sequences that set the modes again on a terminal that has none set: the other screen first, as the program draws on it. */
  restore(): string {
    const other = OTHER_SCREEN.some((mode) => this.on.has(mode))
    const rest = [...this.on.keys()].filter((mode) => !OTHER_SCREEN.includes(mode))
    return (other ? '\x1b[?1049h' : '') + rest.map((mode) => `\x1b[?${mode}h`).join('')
  }
}

/**
 * Where to cut `text` to keep its end, when `cut` characters of its start are to go: not in the middle of a sequence (the part kept
 * would start with its tail, printed as words). A sequence that starts before `cut` and ends after it goes with the start.
 */
export function safeCut(text: string, cut: number): number {
  const from = text.lastIndexOf('\x1b', cut - 1)
  if (from < 0 || cut - from > 48) return cut
  const sequence = /^\x1b(?:\[[0-9;?<=>!]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[ -/]*[0-~])/.exec(text.slice(from, from + 4096))
  return sequence && from + sequence[0].length > cut ? from + sequence[0].length : cut
}
