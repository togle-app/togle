import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { caughtOnEnter, CLEAR_LINE, isLeftArrow, leftLeaves, LEFT_NOTE, noteFor, promptIsEmpty, TypedLine } from '@shared/screen-guard'

const api = window.togle

/** How long the note about a kept command stays, in milliseconds, unless it is put away. */
const NOTE_MS = 15_000

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

// The terminals shown here before: what they printed then had its questions to the terminal answered.
const shownBefore = new Set<string>()

/**
 * The terminal a task runs in, inside Togle: what the agent prints, and the person's keys sent to it, as in any terminal.
 * It starts from what was printed so far, then follows; a part it already has is not written twice. A task that opens a
 * new screen each time (one in the background) names it with `screenId`: what another screen prints is not taken.
 *
 * `guard` names the agent whose own screen this is (Claude Code, Codex, Hermes): /resume and /exit are not run on it. When Enter is
 * pressed with one of them on the line (see screen-guard.ts), Enter is not sent, the line is emptied, and a note says what to do.
 */
export function TerminalView({ taskKey, screenId, guard }: { taskKey: string; screenId?: string; guard?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState<{ title: string; body: string } | null>(null)
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
    const term = new Terminal({
      fontFamily: "'Cascadia Mono', Consolas, ui-monospace, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0f1217', foreground: '#e6e8ee', cursor: '#e6e8ee', selectionBackground: '#3b4a6b' }
    })
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
    void api.terminalRead(taskKey).then(
      (printed) => {
        if (!alive) return
        replaying = again
        term.write(printed.text, () => {
          replaying = false
        })
        end = printed.end
        for (const chunk of early.splice(0)) write(chunk.at, chunk.data)
      },
      () => undefined
    )
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
    term.focus()
    return () => {
      alive = false
      stop()
      typed.dispose()
      observer.disconnect()
      term.dispose()
    }
  }, [taskKey, screenId, guard])
  return (
    <>
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
