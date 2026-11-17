import { useEffect, useRef, useState, type ReactNode } from 'react'
import { changedFiles, stepsLine, type LogEntry, type TaskHistory, type TaskState, type TaskView } from '@shared/runner'
import { Icon } from './Icon'
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

// ---- Times ----

/** Whether a time is one an agent's record gave: a record that has none says 0. */
export const realTime = (at: number | undefined): at is number => typeof at === 'number' && at > 946_684_800_000

/** How long something took, as a person says it: "8s", "2m 14s", "1h 5m". */
export function took(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

/** A clock that runs: "0:42", "12:05", "1:02:10". */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const two = (value: number): string => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds / 60) % 60
  return hours ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`
}

const sameDay = (a: number, b: number): boolean => new Date(a).toDateString() === new Date(b).toDateString()
const timeOf = (at: number): string => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
/** A day as To-do writes it ("Monday, November 16"), or the word for it when it is today or the day before. */
function dayOf(at: number, now: number): string {
  if (sameDay(at, now)) return 'Today'
  const before = new Date(now)
  before.setDate(before.getDate() - 1)
  if (sameDay(at, before.getTime())) return 'Yesterday'
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

function When({ at }: { at: number }): ReactNode {
  return (
    <time className="said-at" dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>
      {timeOf(at)}
    </time>
  )
}

/** When the turn a conversation is at began: when the person last said something, if its time is known. */
export function turnStart(entries: readonly LogEntry[]): number | undefined {
  for (let at = entries.length - 1; at >= 0; at--) {
    if (entries[at].kind === 'you') return realTime(entries[at].at) ? entries[at].at : undefined
  }
  return undefined
}

// ---- The parts ----

const STATE_WORD: Record<NonNullable<LogEntry['status']>, string> = { running: 'running', finished: 'done', declined: 'refused', failed: 'failed' }
// The most files of one change listed, each on its line: the rest are counted.
const FILES_SHOWN = 6

const baseOf = (file: string): string => file.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || file
const folderOf = (file: string): string => {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut > 0 ? file.slice(0, cut) : ''
}

/** One thing the agent did, as a line on the rail of its work: a command with how it ended, a file it changed, a note. */
function StepRows({ entry }: { entry: LogEntry }): ReactNode {
  switch (entry.kind) {
    case 'command': {
      const status = entry.status ?? 'finished'
      return (
        <div className="task-cmd step" data-status={status}>
          <span className="step-node" aria-hidden="true">
            {status === 'running' ? <i className="step-spin" /> : <Icon name={status === 'finished' ? 'check' : status === 'declined' ? 'refused' : 'close'} size={11} />}
          </span>
          {/* One line for each command it ran: a long one is shortened here and whole on the pointer. */}
          <code title={entry.text}>{entry.text}</code>
          {/* A command that ended well has its tick: the word is for a screen reader. */}
          <span className={status === 'finished' ? 'hint sr-only' : 'hint'}>{STATE_WORD[status]}</span>
        </div>
      )
    }
    case 'files': {
      const files = entry.paths ?? []
      if (!files.length) return <Note icon="pencil" text={entry.text} />
      return (
        <>
          {files.slice(0, FILES_SHOWN).map((file) => (
            <div key={file} className="task-file step" title={file}>
              <span className="step-node" aria-hidden="true">
                <Icon name="pencil" size={10} />
              </span>
              <span className="sr-only">Changed </span>
              <span className="file-name">{baseOf(file)}</span>
              {folderOf(file) && <span className="file-folder">{folderOf(file)}</span>}
            </div>
          ))}
          {files.length > FILES_SHOWN && <Note icon="pencil" text={`and ${files.length - FILES_SHOWN} more ${files.length - FILES_SHOWN === 1 ? 'file' : 'files'}`} />}
        </>
      )
    }
    case 'asked':
      return <Note icon="ask" text={`It asked about ${entry.text}`} />
    default:
      return <Note text={entry.text} />
  }
}

function Note({ icon, text }: { icon?: 'pencil' | 'ask'; text: string }): ReactNode {
  return (
    <div className="task-note step">
      <span className={icon ? 'step-node' : 'step-node dot'} aria-hidden="true">
        {icon && <Icon name={icon} size={10} />}
      </span>
      <span className="step-words">{text}</span>
    </div>
  )
}

/** A stretch of what the agent did, one line for each thing, joined by a rail. */
function Steps({ entries }: { entries: LogEntry[] }): ReactNode {
  return (
    <div className="steps">
      {entries.map((entry) => (
        <StepRows key={entry.id} entry={entry} />
      ))}
    </div>
  )
}

function Said({ entry }: { entry: LogEntry }): ReactNode {
  return (
    <div className="task-agent">
      <Markdown text={entry.text} />
    </div>
  )
}

const count = (many: number, one: string, more: string): string => `${many} ${many === 1 ? one : more}`

/**
 * Work folded to one line of small chips: the files it changed, the commands it ran (and how many failed or were refused) and,
 * when it is known, how long it took. Read out, it is the one sentence ("3 steps: edited 1 file, ran 2 commands"). It opens and
 * closes as the person chooses; until they do, it is open only while it is the work going on now.
 */
function Fold({ work, time, open: byDefault, children }: { work: LogEntry[]; time?: string; open: boolean; children: ReactNode }): ReactNode {
  const [chosen, setChosen] = useState<boolean | undefined>(undefined)
  const open = chosen ?? byDefault
  const commands = work.filter((entry) => entry.kind === 'command')
  const refused = commands.filter((entry) => entry.status === 'declined').length
  const failed = commands.filter((entry) => entry.status === 'failed').length
  const ran = commands.length - refused
  const files = changedFiles(work)
  return (
    <details
      className="task-steps"
      open={open}
      onToggle={(event) => {
        const now = event.currentTarget.open
        if (now !== open) setChosen(now)
      }}
    >
      <summary>
        <Icon name="chevron" size={12} />
        <span className="fold-words sr-only">{stepsLine(work)}</span>
        <span className="fold-chips" aria-hidden="true">
          {files > 0 && (
            <span className="fold-chip">
              <Icon name="pencil" size={11} />
              {count(files, 'file', 'files')}
            </span>
          )}
          {ran > 0 && (
            <span className="fold-chip">
              <Icon name="terminal" size={11} />
              {count(ran, 'command', 'commands')}
            </span>
          )}
          {failed > 0 && <span className="fold-chip bad">{failed} failed</span>}
          {refused > 0 && <span className="fold-chip bad">{refused} refused</span>}
        </span>
        {time && <span className="fold-took">{time}</span>}
      </summary>
      {/* Closed, it holds no rows at all: a long task has hundreds of steps, and none is drawn until it is opened. */}
      {open && <div className="fold-body">{children}</div>}
    </details>
  )
}

/** Under an answer: when it was said, and a way to copy it as the agent wrote it. */
function Meta({ at, text }: { at?: number; text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      },
      () => undefined
    )
  }
  return (
    <div className="said-meta">
      {at !== undefined && <When at={at} />}
      <button type="button" className="link" onClick={copy} aria-label={copied ? 'Answer copied' : 'Copy the answer'}>
        <Icon name={copied ? 'check' : 'copy'} size={11} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// ---- The conversation ----

const isStep = (entry: LogEntry): boolean => entry.kind === 'command' || entry.kind === 'files'

interface Turn {
  key: number
  you?: LogEntry
  rest: LogEntry[]
}

/** A conversation as its turns: each starts with what the person said (the first may start with the agent). */
function turnsOf(entries: readonly LogEntry[]): Turn[] {
  const turns: Turn[] = []
  for (const entry of entries) {
    if (entry.kind === 'you') turns.push({ key: entry.id, you: entry, rest: [] })
    else {
      if (!turns.length) turns.push({ key: entry.id, rest: [] })
      turns[turns.length - 1].rest.push(entry)
    }
  }
  return turns
}

/** What the agent said, in the open, and between its words each stretch of what it did. `stretch` draws a stretch. */
function inOrder(entries: LogEntry[], stretch: (run: LogEntry[], last: boolean) => ReactNode): ReactNode[] {
  const blocks: ReactNode[] = []
  let run: LogEntry[] = []
  const flush = (last: boolean): void => {
    if (!run.length) return
    blocks.push(stretch(run, last))
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === 'agent') {
      flush(false)
      blocks.push(<Said key={entry.id} entry={entry} />)
    } else run.push(entry)
  }
  flush(true)
  return blocks
}

const plain = (run: LogEntry[]): ReactNode => <Steps key={`steps-${run[0].id}`} entries={run} />

/** The turn a conversation is at, by what it starts with: to tell a new turn from the one that was there. */
export function lastTurnKey(entries: readonly LogEntry[]): number | undefined {
  const turns = turnsOf(entries)
  return turns[turns.length - 1]?.key
}

/**
 * A conversation as a thread. A turn that is over and was answered shows what was asked, one line for all the work between
 * (its steps and what the agent said along the way, to open) and the answer, with when it came and a way to copy it. The turn
 * going on now, and one that ended with no answer, show what the agent said in the open, with each stretch of steps folded to a
 * line; the stretch it is at stays open while it works.
 *
 * `settled` is the turn that was the last one when the task last stood still. A reply makes the task work at once, and the
 * agent's record has the reply a moment later: until then the turn that was over is drawn as over, so nothing unfolds and
 * folds again.
 */
export function Thread({ entries, state, settled }: { entries: LogEntry[]; state: TaskState; settled?: number }) {
  const now = Date.now()
  const turns = turnsOf(entries)
  const blocks: ReactNode[] = []
  let day: number | undefined
  turns.forEach((turn, index) => {
    const last = index === turns.length - 1
    const live = last && (state === 'working' || state === 'waiting') && turn.key !== settled
    const asked = turn.you && realTime(turn.you.at) ? turn.you.at : undefined
    // The day, where the conversation goes over one, and at its start when that was not today.
    if (asked !== undefined && !sameDay(asked, day ?? now)) {
      blocks.push(
        <div key={`day-${turn.key}`} className="thread-day" role="separator">
          {dayOf(asked, now)}
        </div>
      )
    }
    if (asked !== undefined) day = asked
    if (turn.you) {
      blocks.push(
        <div key={turn.you.id} className="you-row">
          {asked !== undefined && <When at={asked} />}
          <div className="task-you">{turn.you.text}</div>
        </div>
      )
    }
    // The work of a turn: all of it up to what the agent said after its last step. (A note right after a step, "You allowed it.",
    // belongs to the step. A turn with no step has no work to fold.)
    let lastStep = -1
    turn.rest.forEach((entry, at) => {
      if (isStep(entry)) lastStep = at
    })
    let cut = lastStep < 0 ? 0 : turn.rest.length
    for (let at = lastStep + 1; lastStep >= 0 && at < turn.rest.length; at++) {
      if (turn.rest[at].kind === 'agent') {
        cut = at
        break
      }
    }
    const work = turn.rest.slice(0, cut)
    const after = turn.rest.slice(cut)
    const answer = after.filter((entry) => entry.kind === 'agent')
    const answered = !live && answer.length > 0
    if (work.length) {
      if (answered) {
        const done = answer[0].at
        const time = asked !== undefined && realTime(done) && done - asked >= 1000 ? took(done - asked) : undefined
        blocks.push(
          <Fold key={`work-${work[0].id}`} work={work} time={time} open={false}>
            {inOrder(work, plain)}
          </Fold>
        )
      } else {
        blocks.push(
          ...inOrder(work, (run, lastRun) => {
            // Only notes in between ("You allowed it."): said as they are, with nothing to fold.
            if (!stepsLine(run)) return plain(run)
            return (
              <Fold key={`steps-${run[0].id}`} work={run} open={lastRun && !after.length && live && state === 'working'}>
                <Steps entries={run} />
              </Fold>
            )
          })
        )
      }
    }
    blocks.push(...inOrder(after, plain))
    if (answered) {
      const end = answer[answer.length - 1]
      blocks.push(<Meta key={`meta-${end.id}`} at={realTime(end.at) ? end.at : undefined} text={answer.map((entry) => entry.text).join('\n\n')} />)
    }
  })
  return <>{blocks}</>
}
