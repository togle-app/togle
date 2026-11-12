import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const api = window.togle

// The tasks whose terminal was shown here before: what they printed then had its questions to the terminal answered.
const shownBefore = new Set<string>()

/**
 * The terminal a task runs in when its agent has no ACP, inside Togle: what the agent prints, and the person's keys sent
 * to it, as in any terminal. It starts from what was printed so far, then follows; a part it already has is not written
 * twice.
 */
export function TerminalView({ taskKey }: { taskKey: string }) {
  const host = useRef<HTMLDivElement>(null)
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
      if (end < 0) early.push(chunk)
      else write(chunk.at, chunk.data)
    })
    let alive = true
    // An agent asks the terminal things as it prints (where the cursor is, what kind of terminal it is), and the terminal
    // answers as keys. Shown again, what it printed is not answered again: those answers would reach it as typed keys.
    // Shown the first time, it is: the agent may still wait for them.
    const again = shownBefore.has(taskKey)
    shownBefore.add(taskKey)
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
    const typed = term.onData((data) => {
      if (!replaying) void api.terminalWrite(taskKey, data).catch(() => undefined)
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
  }, [taskKey])
  return <div className="terminal-view" ref={host} role="group" aria-label="The agent's terminal" />
}
