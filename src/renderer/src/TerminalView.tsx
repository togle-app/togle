import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const api = window.togle

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
    void api.terminalRead(taskKey).then(
      (printed) => {
        if (!alive) return
        term.write(printed.text)
        end = printed.end
        for (const chunk of early.splice(0)) write(chunk.at, chunk.data)
      },
      () => undefined
    )
    const typed = term.onData((data) => void api.terminalWrite(taskKey, data).catch(() => undefined))
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
