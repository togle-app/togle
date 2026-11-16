// What Togle keeps off an agent's own screen: /resume and /exit. A screen in Togle is a window on a task that goes on without it,
// so a command that puts another conversation under the task, or takes the screen out of it, is not run there. What the real
// programs do with them (Claude Code 2.1.325, Codex 0.166, Hermes 0.22, tried on Windows, Nov 16 2026):
// - /exit and /quit: Claude Code detaches to its list of every session on the computer (where Ctrl+X removes them); Codex closes the
//   screen ("Disconnected from this task"); Hermes closes it too, and `/exit --delete` also deletes the session's history.
// - /resume (and /continue in Claude Code, /sessions in Hermes): a picker of other conversations, and choosing one puts it under the
//   task; Claude Code's task then has another session id, as after /clear.
// - Typing only the start of a command and pressing Enter: Claude Code and Codex run the item their command list highlights (the
//   highlighted row is on the screen); Hermes only fills the line, and the next Enter runs it. Arrow keys through the list do the same.
// - Ctrl+E then Ctrl+U empties the line in all three.
// So what Enter is about to run is read from the screen: the prompt's line, or the highlighted item of an open list, with what was
// typed beside it, because a screen can be a moment behind the keys.

/** What a kept command would do: leave the screen or the task (`exit`), or put another conversation in its place (`resume`). */
export type Kept = 'exit' | 'resume'

// By the agent whose screen it is: its own names for the two. Any other name, and any other agent, is let through.
const NAMES: Readonly<Record<string, Readonly<Record<string, Kept>>>> = {
  claude: { exit: 'exit', quit: 'exit', resume: 'resume', continue: 'resume' },
  codex: { exit: 'exit', quit: 'exit', resume: 'resume' },
  hermes: { exit: 'exit', quit: 'exit', resume: 'resume', sessions: 'resume' }
}

/** Whether Togle keeps commands off this agent's screen (an agent it has measured). */
export const hasGuard = (runner: string): boolean => Object.hasOwn(NAMES, runner)

/** The empty line: to the end of it (Ctrl+E), then everything before the cursor (Ctrl+U). */
export const CLEAR_LINE = '\x05\x15'

/**
 * The name a line would run: its first word after the slash, in lower case ("/Exit --delete" is "exit"). The whole word: "/exit-codes",
 * a skill that only starts like /exit, is not "exit". Null for a line that is not a command.
 */
export function commandIn(text: string): string | null {
  const found = /^\s*\/([A-Za-z][\w:.-]*)(?=\s|$)/.exec(text)
  return found ? found[1].toLowerCase() : null
}

/** What kind of kept command this is on this agent's screen, if it is one. */
export function keptBy(runner: string, command: string | null): Kept | null {
  if (!command || !hasGuard(runner)) return null
  const names = NAMES[runner]
  return Object.hasOwn(names, command) ? names[command] : null
}

// The live prompt: its mark at the start of a row (Claude Code and Hermes draw ❯, Codex ›), maybe after a space or two.
const PROMPT = /^\s{0,3}[❯›]\s?(.*)$/u
// A row of the open command list that is highlighted: the same mark, then the command, then its description after two spaces or more.
const LISTED = /^\s{0,4}[❯›]\s+(\/[A-Za-z][\w:.-]*)\s{2,}\S/u
const BLANK = /^[\s─━-]*$/u
// How far above the prompt the highlighted item of a list is looked for: a list is a dozen rows or so.
const LIST_ROWS = 14

/**
 * What the rows of a screen say Enter would run: the text of the live prompt (the bottom-most row that starts with the agent's
 * prompt mark: the same mark starts earlier messages and the highlighted row of a list, all above it), and, when that text is a
 * command and a list is open, the command the list has highlighted. Nulls where the screen shows neither.
 */
export function readScreen(rows: readonly string[]): { prompt: string | null; listed: string | null } {
  let at = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (PROMPT.test(rows[i])) {
      at = i
      break
    }
  }
  if (at < 0) return { prompt: null, listed: null }
  const prompt = (PROMPT.exec(rows[at]) as RegExpExecArray)[1].trim()
  if (!prompt.startsWith('/')) return { prompt, listed: null }
  for (let i = at - 1; i >= Math.max(0, at - LIST_ROWS); i--) {
    if (BLANK.test(rows[i])) continue
    const found = LISTED.exec(rows[i])
    if (found) return { prompt, listed: found[1] }
  }
  return { prompt, listed: null }
}

/** A kept command that Enter is about to run: which kind, and the name as it was written. */
export interface Caught {
  kept: Kept
  command: string
}

/**
 * Whether Enter, pressed now on this agent's screen, would run a command Togle keeps off it. By the screen (the highlighted item
 * of an open list, else the prompt's line) and by what was typed since the line was last empty (`typed`, null when it cannot be
 * told what the line holds: an arrow key or Tab was pressed). Either is enough.
 */
export function caughtOnEnter(runner: string, rows: readonly string[], typed: string | null): Caught | null {
  if (!hasGuard(runner)) return null
  const screen = readScreen(rows)
  for (const line of [screen.listed, screen.prompt, typed]) {
    const command = commandIn(line ?? '')
    const kept = keptBy(runner, command)
    if (kept && command) return { kept, command }
  }
  return null
}

/** What the person is told when a command is kept off: a title and what to do instead. */
export function noteFor(caught: Caught): { title: string; body: string } {
  const title = `/${caught.command} is not run here`
  return caught.kept === 'exit'
    ? { title, body: 'Togle keeps this screen on the task. Hand back closes the screen, and the task goes on.' }
    : { title, body: 'It would put another conversation under this task. To go on with another one, pick it in the list and press Continue here.' }
}

/**
 * What has been typed on a line since it was last empty, from the keys the terminal sends, for the moment a screen has not drawn them
 * yet. It is sure of the line only while the keys were letters, Backspace, Ctrl+U or Enter: an arrow, Tab, Esc or another control key
 * can change the line in ways the keys do not say, and then the screen is all there is.
 */
export class TypedLine {
  private line = ''
  private sure = true

  feed(data: string): void {
    if (data.startsWith('\x1b')) {
      // A paste arrives between two marks; any other escape sequence is a key that moves or completes.
      const pasted = /^\x1b\[200~([\s\S]*?)(?:\x1b\[201~)?$/.exec(data)
      if (pasted) this.line += pasted[1].replace(/\s*[\r\n]+\s*/g, ' ')
      else this.sure = false
      return
    }
    for (const key of data) {
      if (key === '\r' || key === '\n' || key === '\x15') {
        this.line = ''
        this.sure = true
      } else if (key === '\x7f' || key === '\b') this.line = this.line.slice(0, -1)
      else if (key < ' ') this.sure = false
      else this.line += key
    }
  }

  /** What the line holds, or null when that cannot be told. */
  text(): string | null {
    return this.sure ? this.line : null
  }
}
