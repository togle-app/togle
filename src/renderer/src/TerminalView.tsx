import { useEffect, useRef, useState } from 'react'
import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { caughtOnEnter, CLEAR_LINE, isLeftArrow, leftLeaves, LEFT_NOTE, noteFor, promptIsEmpty, TypedLine } from '@shared/screen-guard'
import { WaitLine } from './kept'

const api = window.togle

/** How long the note about a kept command stays, in milliseconds, unless it is put away. */
const NOTE_MS = 15_000

/** The kinds of picture a paste can hold that go into a screen as a file (a screenshot is a PNG; a bitmap is kept as one). */
const PICTURE = /^image\/(png|jpeg|gif|webp|bmp)$/
/** A path as it goes into a screen: in quotes when it has a space, as a terminal puts a file dropped on it. */
const pathWords = (file: string): string => (/\s/.test(file) ? `"${file}"` : file)
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The rows of the screen as it is drawn now, as text. */
const visibleRows = (term: Terminal): string[] => {
  const buffer = term.buffer.active
  return Array.from({ length: term.rows }, (_, i) => buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? '')
}

/** Whether the cell at a row and column of the screen is drawn dim: how the programs draw a prompt's placeholder. */
const isDim = (term: Terminal, row: number, column: number): boolean => {
  const buffer = term.buffer.active
  return !!buffer.getLine(buffer.viewportY + row)?.getCell(column)?.isDim()
}

/**
 * How the agent's screen is coloured: in the window's own colors, in the theme the window has (Appearance in Settings: Light, Dark, or the
 * system's), so that the screen sits in the window as one piece. What an agent draws in the terminal's own colors (its text and its background,
 * the sixteen named colors) follows the theme the moment it changes. What it draws in colors of its own (Claude Code's, in its dark theme) does not,
 * so on a light screen the terminal keeps every letter readable: a color too close to the background is moved away from it (`minimumContrastRatio`).
 */
const DARK: ITheme = { background: '#0f1217', foreground: '#e6e8ee', cursor: '#e6e8ee', selectionBackground: '#3b4a6b' }
const LIGHT: ITheme = {
  background: '#eef0f5',
  foreground: '#161a24',
  cursor: '#161a24',
  cursorAccent: '#eef0f5',
  selectionBackground: '#c5ccf8',
  selectionInactiveBackground: '#d9dcf5',
  scrollbarSliderBackground: 'rgba(22, 26, 36, 0.22)',
  scrollbarSliderHoverBackground: 'rgba(22, 26, 36, 0.36)',
  scrollbarSliderActiveBackground: 'rgba(22, 26, 36, 0.5)',
  // The sixteen named colors on a light screen: every one has 4.5:1 or more on its background (the usual ones are for a dark screen).
  black: '#161a24',
  red: '#b92d2d',
  green: '#08735c',
  yellow: '#8a5604',
  blue: '#2f43c9',
  magenta: '#a02ca0',
  cyan: '#0a7083',
  white: '#586076',
  brightBlack: '#5f6781',
  brightRed: '#c03333',
  brightGreen: '#0a7a62',
  brightYellow: '#8f5a05',
  brightBlue: '#4350cf',
  brightMagenta: '#b03db0',
  brightCyan: '#087489',
  brightWhite: '#0b0e15'
}
/** The least contrast a letter keeps with its background on a light screen (WCAG's 4.5:1 for text); a dark screen is left as the agent drew it. */
const LIGHT_CONTRAST = 4.5
const LIGHT_WINDOW = '(prefers-color-scheme: light)'

// The terminals shown here before: what they printed then had its questions to the terminal answered.
const shownBefore = new Set<string>()
// How many lines above its foot a screen was scrolled when the person left it (a plain terminal, which keeps its lines: a program that draws
// its own screen, as Claude Code and Codex do, keeps its own place, and what it drew is drawn again whole).
const scrolledUp = new Map<string, number>()

/**
 * The terminal a task runs in, inside Togle: what the agent prints, and the person's keys sent to it, as in any terminal.
 * It starts from what was printed so far, then follows; a part it already has is not written twice. A task that opens a
 * new screen each time (one in the background) names it with `screenId`: what another screen prints is not taken.
 *
 * `guard` names the agent whose own screen this is (Claude Code, Codex, Hermes): /resume and /exit are not run on it. When Enter is
 * pressed with one of them on the line (see screen-guard.ts), Enter is not sent, the line is emptied, and a note says what to do.
 */
export function TerminalView({ taskKey, screenId, guard, active = true }: { taskKey: string; screenId?: string; guard?: string; active?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  // The screen stays in the page while the person is in the other view (Chat) of the task: it goes on reading what the agent prints, and is where it
  // was left when they are back. `active` says it is the one in view: its keys go to it again.
  const screen = useRef<Terminal | null>(null)
  const inView = useRef(active)
  inView.current = active
  useEffect(() => {
    if (active) screen.current?.focus()
  }, [active])
  const [note, setNote] = useState<{ title: string; body: string } | null>(null)
  // Until what the screen printed so far has come: a quiet sign that it is on its way, instead of a black screen.
  const [drawn, setDrawn] = useState(false)
  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(null), NOTE_MS)
    return () => clearTimeout(timer)
  }, [note])
  // Another screen starts with no note.
  useEffect(() => setNote(null), [taskKey, screenId])
  useEffect(() => {
    const element = host.current
    if (!element) return
    // The window's theme, now and when it changes: the screen is painted again at once, with no new screen and nothing typed.
    const windowTheme = window.matchMedia(LIGHT_WINDOW)
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: windowTheme.matches ? LIGHT : DARK,
      minimumContrastRatio: windowTheme.matches ? LIGHT_CONTRAST : 1
    })
    const recolor = (): void => {
      term.options.theme = windowTheme.matches ? LIGHT : DARK
      term.options.minimumContrastRatio = windowTheme.matches ? LIGHT_CONTRAST : 1
    }
    windowTheme.addEventListener('change', recolor)
    screen.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(element)
    let end = -1
    const early: { at: number; data: string }[] = []
    const write = (at: number, data: string): void => {
      if (at + data.length <= end) return
      term.write(at < end ? data.slice(end - at) : data)
      end = at + data.length
    }
    const stop = api.onTerminalData((chunk) => {
      if (chunk.key !== taskKey) return
      if (screenId && chunk.screen && chunk.screen !== screenId) return
      if (end < 0) early.push(chunk)
      else write(chunk.at, chunk.data)
    })
    let alive = true
    // An agent asks the terminal things as it prints (where the cursor is, what kind of terminal it is), and the terminal
    // answers as keys. Shown again, what it printed is not answered again: those answers would reach it as typed keys.
    // Shown the first time, it is: the agent may still wait for them.
    const shown = `${taskKey}#${screenId ?? ''}`
    const again = shownBefore.has(shown)
    shownBefore.add(shown)
    let replaying = false
    setDrawn(false)
    void api.terminalRead(taskKey).then(
      (printed) => {
        if (!alive) return
        replaying = again
        term.write(printed.text, () => {
          replaying = false
          // Back on a screen that was read higher up: it goes back to where it was read.
          const up = scrolledUp.get(shown)
          if (alive && up && term.buffer.active.type === 'normal') term.scrollToLine(Math.max(0, term.buffer.active.baseY - up))
        })
        end = printed.end
        for (const chunk of early.splice(0)) write(chunk.at, chunk.data)
        setDrawn(true)
      },
      () => {
        if (alive) setDrawn(true)
      }
    )
    // On Windows, Ctrl+V pastes, as in the system's own terminal: the terminal would send the key itself, which pastes nothing.
    // The paste comes as the page's own, below.
    const windows = api.platform === 'win32'
    term.attachCustomKeyEventHandler((event) => !(windows && event.type === 'keydown' && event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'v'))
    // What is pasted. A picture with no words (a screenshot) is kept as a file, and its path goes in: Claude Code and Codex
    // attach it as a picture, and any other agent can open it. Words go in as they are when the screen takes a paste as one
    // (Claude Code, Codex and Hermes do), and as one line when it does not, since a line break would press Enter there.
    const pasted = (event: ClipboardEvent): void => {
      const data = event.clipboardData
      if (!data || replaying) return
      const text = data.getData('text/plain')
      const picture = text ? null : (Array.from(data.items).find((item) => item.kind === 'file' && PICTURE.test(item.type))?.getAsFile() ?? null)
      if (picture) {
        event.preventDefault()
        event.stopImmediatePropagation()
        void picture
          .arrayBuffer()
          .then((bytes) => api.savePastedPicture(new Uint8Array(bytes), picture.type))
          .then(
            (file) => {
              if (alive) term.paste(pathWords(file))
            },
            (error: unknown) => {
              if (alive) setNote({ title: 'The picture was not pasted.', body: errorText(error) })
            }
          )
        return
      }
      if (text && !term.modes.bracketedPasteMode && /[\r\n]/.test(text)) {
        event.preventDefault()
        event.stopImmediatePropagation()
        term.paste(text.replace(/\r\n|\r|\n/g, ' '))
      }
    }
    element.addEventListener('paste', pasted, true)
    const line = new TypedLine()
    const typed = term.onData((data) => {
      if (replaying) return
      // The Left arrow at an empty prompt takes Claude Code's and Codex's screens to their list of every session, as /exit does:
      // not sent. With text in the prompt it only moves the cursor, and goes through.
      if (guard && leftLeaves(guard) && isLeftArrow(data) && promptIsEmpty(visibleRows(term), (row, column) => isDim(term, row, column)) === true) {
        setNote(LEFT_NOTE)
        return
      }
      // Enter with /resume or /exit on the line (or highlighted in the agent's command list): not sent. The line is emptied, so
      // that the next Enter does not send it either, and the note says what to do instead.
      if (guard && data === '\r') {
        const caught = caughtOnEnter(guard, visibleRows(term), line.text())
        if (caught) {
          line.feed('\x15')
          setNote(noteFor(caught))
          void api.terminalWrite(taskKey, CLEAR_LINE).catch(() => undefined)
          return
        }
      }
      line.feed(data)
      void api.terminalWrite(taskKey, data).catch(() => undefined)
    })
    const size = (): void => {
      try {
        fit.fit()
      } catch {
        return
      }
      void api.terminalResize(taskKey, term.cols, term.rows).catch(() => undefined)
    }
    const observer = new ResizeObserver(() => size())
    observer.observe(element)
    size()
    if (inView.current) term.focus()
    return () => {
      alive = false
      stop()
      windowTheme.removeEventListener('change', recolor)
      element.removeEventListener('paste', pasted, true)
      typed.dispose()
      observer.disconnect()
      if (screen.current === term) screen.current = null
      const buffer = term.buffer.active
      const up = buffer.type === 'normal' ? buffer.baseY - buffer.viewportY : 0
      if (up > 0) scrolledUp.set(shown, up)
      else scrolledUp.delete(shown)
      term.dispose()
    }
  }, [taskKey, screenId, guard])
  return (
    <>
      <WaitLine waiting={!drawn} label="Opening the screen" words="Opening the screen…" />
      <div className="terminal-view" ref={host} role="group" aria-label="The agent's terminal" />
      {note && (
        <div className="terminal-note" role="status">
          <span>
            <b>{note.title}</b> {note.body}
          </span>
          <button type="button" className="ghost small" aria-label="Put this note away" onClick={() => setNote(null)}>
            ×
          </button>
        </div>
      )}
    </>
  )
}
