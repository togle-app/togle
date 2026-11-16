import { useEffect, useState, type ReactNode } from 'react'
import { stepsLine, type LogEntry, type TaskHistory, type TaskView } from '@shared/runner'
import { Markdown } from './Markdown'

const api = window.togle

/** How often the conversation of a task that works is read again, in milliseconds. */
const READ_AGAIN_MS = 3_000

/**
 * A task's conversation as its agent keeps it, read when the task changes and every few seconds while it works, and only while
 * the Web view is on screen (`on`): in Terminal nothing reads it, and a Codex or Hermes conversation is not small. `history` is
 * null when the agent keeps none to read: the window then shows what happened while Togle watched. `showAll` brings the turns
 * before the last ones.
 */
export function useHistory(task: Pick<TaskView, 'key' | 'state' | 'updatedAt'>, on: boolean): { history: TaskHistory | null; loaded: boolean; all: boolean; showAll: () => void } {
  const [history, setHistory] = useState<TaskHistory | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [all, setAll] = useState(false)
  // Not while it waits for you: nothing is being said then.
  const working = task.state === 'working'
  useEffect(() => {
    if (!on) return
    let live = true
    const read = (): void => {
      void api.runnerHistory(task.key, all).then(
        (found) => {
          if (!live) return
          setHistory(found && Array.isArray(found.entries) ? found : null)
          setLoaded(true)
        },
        () => {
          if (!live) return
          setHistory(null)
          setLoaded(true)
        }
      )
    }
    read()
    const timer = working ? setInterval(read, READ_AGAIN_MS) : undefined
    return () => {
      live = false
      if (timer) clearInterval(timer)
    }
  }, [task.key, task.updatedAt, all, working, on])
  return { history, loaded, all, showAll: () => setAll(true) }
}

const COMMAND_MARK: Record<NonNullable<LogEntry['status']>, string> = { running: '▶', finished: '✓', declined: '✕', failed: '✕' }
const COMMAND_WORD: Record<NonNullable<LogEntry['status']>, string> = { running: 'running', finished: 'done', declined: 'refused', failed: 'failed' }

export function LogLine({ entry }: { entry: LogEntry }) {
  switch (entry.kind) {
    case 'you':
      return <div className="task-you">{entry.text}</div>
    case 'agent':
      return (
        <div className="task-agent">
          <Markdown text={entry.text} />
        </div>
      )
    case 'command':
      return (
        <div className="task-cmd" data-status={entry.status}>
          <span aria-hidden="true">{COMMAND_MARK[entry.status ?? 'finished']}</span>
          <code>{entry.text}</code>
          <span className="hint">{COMMAND_WORD[entry.status ?? 'finished']}</span>
        </div>
      )
    case 'asked':
      return <div className="task-note">It asked about {entry.text}</div>
    default:
      return <div className="task-note">{entry.text}</div>
  }
}

/**
 * A conversation as a thread: what was asked and what the agent answered, in the open, and what it did between (commands run,
 * files changed) folded to one line for each stretch of work. The stretch the agent is at now stays open while it works.
 */
export function Thread({ entries, working }: { entries: LogEntry[]; working: boolean }) {
  const blocks: ReactNode[] = []
  let steps: LogEntry[] = []
  const flush = (last: boolean): void => {
    if (!steps.length) return
    const run = steps
    steps = []
    const said = stepsLine(run)
    // Only notes in between ("You allowed it."): said as they are, with nothing to fold.
    if (!said) {
      for (const entry of run) blocks.push(<LogLine key={entry.id} entry={entry} />)
      return
    }
    blocks.push(
      <details key={`steps-${run[0].id}`} className="task-steps" open={last && working ? true : undefined}>
        <summary>{said}</summary>
        {run.map((entry) => (
          <LogLine key={entry.id} entry={entry} />
        ))}
      </details>
    )
  }
  for (const entry of entries) {
    if (entry.kind === 'you' || entry.kind === 'agent') {
      flush(false)
      blocks.push(<LogLine key={entry.id} entry={entry} />)
    } else steps.push(entry)
  }
  flush(true)
  return <>{blocks}</>
}
