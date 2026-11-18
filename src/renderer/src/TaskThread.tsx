import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { LogEntry, PlanItem, StepDetail, TaskHistory, TaskState, TaskView } from '@shared/runner'
import { Icon, type IconName } from './Icon'
import { Markdown } from './Markdown'
import { PictureOver } from './Rows'

const api = window.togle

/** How often the conversation of a task that works is read again, in milliseconds. */
const READ_AGAIN_MS = 3_000

/** The conversations read last, by task (and whether all of it was read): one opened again shows at once and is read again behind it. */
const readBefore = new Map<string, TaskHistory | null>()
/** How many are kept: a long conversation is not small. */
const KEEP_READINGS = 8
function keepReading(key: string, history: TaskHistory | null): void {
  readBefore.delete(key)
  readBefore.set(key, history)
  while (readBefore.size > KEEP_READINGS) readBefore.delete(readBefore.keys().next().value as string)
}

/**
 * A task's conversation as its agent keeps it, read when the task changes and every few seconds while it works, and only while
 * the Chat view is on screen (`on`): in Terminal nothing reads it, and a Codex or Hermes conversation is not small. `history` is
 * null when the agent keeps none to read: the window then shows what happened while Togle watched. `showAll` brings the turns
 * before the last ones. A conversation read before shows at once (`loaded`) while it is read again; a read that fails keeps
 * what is shown.
 */
export function useHistory(task: Pick<TaskView, 'key' | 'state' | 'updatedAt'>, on: boolean): { history: TaskHistory | null; loaded: boolean; all: boolean; showAll: () => void } {
  const [all, setAll] = useState(false)
  const reading = `${task.key}${all ? ' all' : ''}`
  const [read, setRead] = useState<{ reading: string; history: TaskHistory | null } | null>(() => (readBefore.has(reading) ? { reading, history: readBefore.get(reading) ?? null } : null))
  // Not while it waits for you: nothing is being said then.
  const working = task.state === 'working'
  useEffect(() => {
    if (!on) return
    let live = true
    const again = (): void => {
      void api.runnerHistory(task.key, all).then(
        (found) => {
          if (!live) return
          const history = found && Array.isArray(found.entries) ? found : null
          keepReading(reading, history)
          setRead({ reading, history })
        },
        () => {
          // Kept as it is: what was read before stays, and with nothing read before, there is nothing to show.
          if (!live) return
          setRead((was) => was ?? { reading, history: null })
        }
      )
    }
    again()
    const timer = working ? setInterval(again, READ_AGAIN_MS) : undefined
    return () => {
      live = false
      if (timer) clearInterval(timer)
    }
  }, [task.key, task.updatedAt, all, working, on, reading])
  // Asked for all of it: the turns shown stay until all of it is read, unless all of it was read before.
  const shown = read?.reading === reading ? read : readBefore.has(reading) ? { reading, history: readBefore.get(reading) ?? null } : read
  return { history: shown?.history ?? null, loaded: !!shown, all, showAll: () => setAll(true) }
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

/** How long a step took, as finely as is worth reading ("3.2s", "42s", "1m 12s"). Under a second it is not said. */
function stepTime(ms: number): string | undefined {
  if (!(ms >= 1000)) return undefined
  if (ms >= 10_000) return took(ms)
  const tenths = Math.floor(ms / 100) / 10
  return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}s`
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

/** The time, again every second while `on`. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [on])
  return now
}

// ---- What a step holds ----

// What the steps opened lately hold, once read: by task, step, and how the step stood (a command that ran is asked again once it
// has ended, when what it printed is whole).
const DETAILS_KEPT = 200
const details = new Map<string, StepDetail | null>()
function keepDetail(id: string, detail: StepDetail | null): void {
  details.delete(id)
  details.set(id, detail)
  while (details.size > DETAILS_KEPT) details.delete(details.keys().next().value as string)
}

/** What a step holds (what a command printed, a thought's words, how a file changed), asked for once the step is opened. */
function useDetail(taskKey: string, more: string | undefined, version: string, open: boolean): { detail: StepDetail | null; loading: boolean } {
  const id = more ? `${taskKey}\u0000${more}\u0000${version}` : ''
  const [, setRead] = useState(0)
  const has = id !== '' && details.has(id)
  useEffect(() => {
    if (!open || !more || details.has(id)) return
    let live = true
    const done = (found: StepDetail | null): void => {
      keepDetail(id, found)
      if (live) setRead((n) => n + 1)
    }
    void api.runnerStep(taskKey, more).then((found) => done(found && typeof found.text === 'string' ? found : null), () => done(null))
    return () => {
      live = false
    }
  }, [open, id, more, taskKey])
  return { detail: has ? (details.get(id) ?? null) : null, loading: open && !!more && !has }
}

/** Copies a text, and says so for a moment. */
function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
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
    <button type="button" className="link copy-text" onClick={copy} aria-label={copied ? 'Copied' : label}>
      <Icon name={copied ? 'check' : 'copy'} size={11} />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

// ---- One step, as a row ----

// Whether a step of this task can be running now: while the task works or waits, or a command it started outlives a Stop. A step
// whose result never came (the task was stopped under it) is drawn as stopped then, not turning.
const StepsRun = createContext(true)

// The most files of one change listed, each on its line: the rest are counted.
const FILES_SHOWN = 6

const nameOf = (file: string): string => file.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || file
const folderOf = (file: string): string => {
  const cut = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return cut > 0 ? file.slice(0, cut) : ''
}
/** A command as it is read: without the `cd <folder> &&` it so often starts with. The whole command is on the pointer. */
const shortCommand = (command: string): string => command.replace(/^\s*cd\s+(?:"[^"]*"|'[^']*'|[^\s&;]+)\s*(?:&&|;)\s*/i, '') || command
const isAddress = (text: string): boolean => /^https?:\/\//i.test(text)
/** A web address as it is read: its host and path, without the scheme and "www.". */
function shortAddress(text: string): string {
  try {
    const url = new URL(text)
    return `${url.host.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}${url.search}`
  } catch {
    return text
  }
}

function FileName({ file }: { file: string }): ReactNode {
  const folder = folderOf(file)
  return (
    <>
      <span className="file-name">{nameOf(file)}</span>
      {folder && <span className="row-dim"> {folder}</span>}
    </>
  )
}

/** How a step reads: its mark, what it did (a verb) and what it did it to, and all of it for the pointer. */
interface Look {
  icon: IconName
  verb: string
  what?: ReactNode
  whole: string
}

function lookOf(entry: LogEntry, running: boolean): Look {
  const text = entry.text
  if (entry.kind === 'command') return { icon: 'terminal', verb: running ? 'Running' : 'Ran', what: <code>{shortCommand(text)}</code>, whole: text }
  // Code it ran (Hermes runs Python): its first line, the whole of it on the pointer and when opened.
  if (entry.step === 'code') return { icon: 'terminal', verb: running ? 'Running code' : 'Ran code', what: <code>{text.split('\n').find((line) => line.trim())?.trim() ?? ''}</code>, whole: text }
  if (entry.kind === 'asked') return { icon: 'ask', verb: 'It asked about', what: text, whole: text }
  switch (entry.step) {
    case 'read': {
      const files = entry.paths?.length ? entry.paths : [text]
      if (files.length === 1) return { icon: 'file', verb: 'Read', what: <FileName file={files[0]} />, whole: files[0] }
      return {
        icon: 'file',
        verb: 'Read',
        what: (
          <>
            <span className="file-name">{files.length} files</span>
            <span className="row-dim"> {files.map(nameOf).join(', ')}</span>
          </>
        ),
        whole: files.join('\n')
      }
    }
    case 'search':
      return { icon: 'search', verb: running ? 'Searching for' : 'Searched for', what: <code>{text}</code>, whole: text }
    case 'web':
      return isAddress(text)
        ? { icon: 'globe', verb: running ? 'Opening' : 'Opened', what: shortAddress(text), whole: text }
        : { icon: 'globe', verb: running ? 'Searching the web for' : 'Searched the web for', what: <q>{text}</q>, whole: text }
    case 'helper':
      return { icon: 'agents', verb: running ? 'Asking a helper:' : 'Asked a helper:', what: text, whole: text }
    case 'think':
      return { icon: 'thought', verb: running ? 'Thinking' : entry.took !== undefined && entry.took >= 1000 ? `Thought for ${took(entry.took)}` : 'Thought', whole: '' }
    default:
      return { icon: 'plug', verb: running ? 'Using' : 'Used', what: text, whole: text }
  }
}

/** A note between steps ("You allowed it."), in a row of its own. */
function NoteRow({ text }: { text: string }): ReactNode {
  return (
    <div className="step-row task-note" data-kind="note">
      <div className="row-line">
        <span className="row-icon" aria-hidden="true">
          <i className="row-dot" />
        </span>
        <span className="row-words">{text}</span>
      </div>
    </div>
  )
}

/** What a line of a diff is, by how it starts. */
const diffLine = (line: string): string =>
  line.startsWith('@@') ? 'd-at' : line.startsWith('+++') || line.startsWith('---') ? 'd-head' : line.startsWith('+') ? 'd-add' : line.startsWith('-') ? 'd-del' : line.startsWith('\\') ? 'd-note' : 'd-keep'

/** How a file changed: its lines, what was added green and what was taken out red, in a small box of its own, with Copy. */
function DiffBox({ taskKey, more, file }: { taskKey: string; more: string; file: string }): ReactNode {
  const { detail, loading } = useDetail(taskKey, more, '', true)
  return (
    <div className="step-box diff-box">
      <div className="box-head">
        <span className="box-file" title={file}>
          {file}
        </span>
      </div>
      <div className="box-out">
        {loading ? (
          <p className="hint">Reading how it changed…</p>
        ) : detail ? (
          <>
            <pre className="diff" tabIndex={0} aria-label={`How ${nameOf(file)} changed`}>
              {detail.text.split('\n').map((line, index) => (
                <span key={index} className={diffLine(line)}>
                  {line || ' '}
                </span>
              ))}
            </pre>
            {detail.cut && <p className="hint">Only the start of it is shown.</p>}
            <CopyButton text={detail.text} label="Copy how it changed" />
          </>
        ) : (
          <p className="hint">How it changed is not kept any more.</p>
        )}
      </div>
    </div>
  )
}

/** One file of a change, a row that opens to how it changed. A change that failed changed nothing, and opens to nothing. */
function FileRow({ entry, file, index, taskKey }: { entry: LogEntry; file: string; index: number; taskKey: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const failed = entry.status === 'failed'
  const opens = !!entry.more && !failed
  const line = (
    <>
      <span className="row-icon" aria-hidden="true">
        <Icon name={failed ? 'alert' : 'pencil'} size={13} />
      </span>
      <span className="row-words">
        <span className="row-verb">{failed ? 'Tried to change' : 'Changed'}</span>{' '}
        <span className="row-what">
          <FileName file={file} />
        </span>
      </span>
      {opens && (
        <span className="row-caret" aria-hidden="true">
          <Icon name="chevron" size={11} />
        </span>
      )}
      {failed && <span className="row-note">failed</span>}
    </>
  )
  return (
    <div className={`step-row task-file${open ? ' open' : ''}`} data-kind="files" data-status={failed ? 'failed' : undefined}>
      {opens ? (
        <button type="button" className="row-line" aria-expanded={open} title={file} onClick={() => setOpen((was) => !was)}>
          {line}
        </button>
      ) : (
        <div className="row-line" title={file}>
          {line}
        </div>
      )}
      {open && entry.more && <DiffBox taskKey={taskKey} more={`${entry.more}#${index}`} file={file} />}
    </div>
  )
}

/** The files one change touched, a row for each. */
function FileRows({ entry, taskKey }: { entry: LogEntry; taskKey: string }): ReactNode {
  const files = entry.paths ?? []
  if (!files.length) return <NoteRow text={entry.text} />
  return (
    <>
      {files.slice(0, FILES_SHOWN).map((file, index) => (
        <FileRow key={file} entry={entry} file={file} index={index} taskKey={taskKey} />
      ))}
      {files.length > FILES_SHOWN && <NoteRow text={`and ${files.length - FILES_SHOWN} more ${files.length - FILES_SHOWN === 1 ? 'file' : 'files'}`} />}
    </>
  )
}

/** A command opened: the whole of it, how it ended, and what it printed, with a way to copy that. */
function CommandBox({ entry, taskKey, running, stopped }: { entry: LogEntry; taskKey: string; running: boolean; stopped: boolean }): ReactNode {
  const { detail, loading } = useDetail(taskKey, entry.more, entry.status ?? '', true)
  // Code is shown as code; a command after a $.
  const code = entry.step === 'code'
  return (
    <div className="step-box">
      <div className={code ? 'box-head code' : 'box-head'}>
        {!code && (
          <span className="box-prompt" aria-hidden="true">
            $
          </span>
        )}
        <code className="box-command">{entry.text}</code>
        {entry.status === 'failed' && <span className="box-chip bad">failed</span>}
        {entry.status === 'declined' && <span className="box-chip">refused</span>}
        {running && <span className="box-chip live">running</span>}
        {stopped && <span className="box-chip">stopped</span>}
      </div>
      {entry.more && (
        <div className="box-out">
          {loading ? (
            <p className="hint">Reading what it printed…</p>
          ) : detail ? (
            <>
              {detail.cut && <p className="hint">Only the end of it is shown.</p>}
              <pre tabIndex={0}>{detail.text}</pre>
              <CopyButton text={detail.text} label="Copy what it printed" />
            </>
          ) : (
            <p className="hint">What it printed is not kept any more.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** A thought opened: its words, as the agent kept them. */
function ThoughtBox({ entry, taskKey }: { entry: LogEntry; taskKey: string }): ReactNode {
  const { detail, loading } = useDetail(taskKey, entry.more, '', true)
  return (
    <div className="thought-box" tabIndex={0}>
      {loading ? <p className="hint">Reading its thinking…</p> : detail ? <p className="thought-words">{detail.text}</p> : <p className="hint">Its thinking is not kept any more.</p>}
    </div>
  )
}

/**
 * One thing the agent did, in one line: its mark, what it did to what, and how long it took. Success has no mark of its own: a
 * step that runs turns and counts its time, and one that failed is red. A command opens to all of it and what it printed; a
 * thought whose words were kept opens to them.
 */
function StepRow({ entry, taskKey }: { entry: LogEntry; taskKey: string }): ReactNode {
  const mayRun = useContext(StepsRun)
  const running = entry.status === 'running' && mayRun
  // Its result never came, and nothing of the task runs any more: it was stopped under it.
  const stopped = entry.status === 'running' && !mayRun
  const look = lookOf(entry, running)
  const opens = entry.kind === 'command' || entry.step === 'code' || (entry.kind === 'step' && entry.step === 'think' && !!entry.more)
  const [open, setOpen] = useState(false)
  const ticking = running && realTime(entry.at)
  const now = useNow(ticking)
  // (A thought says how long it took in its words.)
  const time = ticking ? (now >= entry.at ? clock(now - entry.at) : undefined) : entry.took !== undefined && entry.step !== 'think' ? stepTime(entry.took) : undefined
  const line = (
    <>
      <span className="row-icon" aria-hidden="true">
        {running ? <i className="row-spin" /> : <Icon name={entry.status === 'failed' ? 'alert' : look.icon} size={13} />}
      </span>
      <span className="row-words">
        <span className="row-verb">{look.verb}</span>
        {look.what !== undefined && (
          <>
            {' '}
            <span className="row-what">{look.what}</span>
          </>
        )}
      </span>
      {opens && (
        <span className="row-caret" aria-hidden="true">
          <Icon name="chevron" size={11} />
        </span>
      )}
      {entry.status === 'declined' && <span className="row-note">refused</span>}
      {entry.status === 'failed' && <span className="row-note">failed</span>}
      {stopped && <span className="row-note quiet">stopped</span>}
      {/* A clock that runs is for the eye only: read out, it would speak every second. */}
      {time && (
        <span className="row-time" aria-hidden={ticking || undefined}>
          {time}
        </span>
      )}
    </>
  )
  const kind = entry.kind === 'step' ? entry.step : entry.kind
  return (
    <div className={`step-row${entry.kind === 'command' ? ' task-cmd' : ''}${open ? ' open' : ''}`} data-kind={kind} data-status={stopped ? 'stopped' : entry.status}>
      {opens ? (
        <button type="button" className="row-line" aria-expanded={open} title={look.whole || undefined} onClick={() => setOpen((was) => !was)}>
          {line}
        </button>
      ) : (
        <div className="row-line" title={look.whole || undefined}>
          {line}
        </div>
      )}
      {open && (entry.kind === 'command' || entry.step === 'code' ? <CommandBox entry={entry} taskKey={taskKey} running={running} stopped={stopped} /> : <ThoughtBox entry={entry} taskKey={taskKey} />)}
    </div>
  )
}

/** Any entry that is not something said, as its row (or rows). */
function Rows({ entry, taskKey }: { entry: LogEntry; taskKey: string }): ReactNode {
  if (entry.kind === 'files') return <FileRows entry={entry} taskKey={taskKey} />
  if (entry.kind === 'command' || entry.kind === 'step' || entry.kind === 'asked') return <StepRow entry={entry} taskKey={taskKey} />
  return <NoteRow text={entry.text} />
}

// ---- A stretch of work, as one quiet line ----

type ClauseKey = 'read' | 'search' | 'web' | 'change' | 'command' | 'helper' | 'tool' | 'thought'
// The order the things done are told in: how a turn of work goes, looking first, then doing.
const CLAUSE_ORDER: ClauseKey[] = ['read', 'search', 'web', 'change', 'command', 'helper', 'tool', 'thought']

/** What an entry counts as in a line of work; nothing for a note, a refused command, or the agent's checklist. */
function clauseOf(entry: LogEntry): ClauseKey | undefined {
  if (entry.kind === 'command') return entry.status === 'declined' ? undefined : 'command'
  if (entry.kind === 'files') return entry.status === 'failed' ? undefined : 'change'
  if (entry.kind !== 'step' || entry.step === 'plan') return undefined
  if (entry.step === 'think') return 'thought'
  if (entry.step === 'code') return 'command'
  return entry.step === 'read' || entry.step === 'search' || entry.step === 'web' || entry.step === 'helper' ? entry.step : 'tool'
}

/** Whether an entry is something the agent did or thought (a row), not something said or a checklist. */
const isDoing = (entry: LogEntry): boolean => !!clauseOf(entry) || (entry.kind === 'command' && entry.status === 'declined') || (entry.kind === 'files' && entry.status === 'failed')

interface Clause {
  text: string
  key?: ClauseKey
  bad?: boolean
}

// What a sentence in brief tells: the files changed and the commands run. What it read, looked up or thought is a detail, opened.
const BRIEF: ClauseKey[] = ['change', 'command']

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** What a stretch of work is at now: the step that runs, else the last one it did. */
const currentOf = (rows: readonly LogEntry[]): LogEntry | undefined => [...rows].reverse().find((entry) => entry.status === 'running' && isDoing(entry)) ?? [...rows].reverse().find(isDoing)

/**
 * What a stretch of work was, in one sentence: "Read 4 files, ran 5 commands, thought for 32s, 1 failed". While it is the work
 * going on, what it does now is in the present ("Read 4 files, running 2 commands").
 */
function sentenceOf(rows: readonly LogEntry[], live: boolean, brief = false): Clause[] {
  const by = new Map<ClauseKey, LogEntry[]>()
  for (const entry of rows) {
    const key = clauseOf(entry)
    if (key) by.set(key, [...(by.get(key) ?? []), entry])
  }
  const current = live ? currentOf(rows) : undefined
  const now = current ? clauseOf(current) : undefined
  const words = (key: ClauseKey, of: LogEntry[], present: boolean): string => {
    switch (key) {
      case 'read':
        return `${present ? 'reading' : 'read'} ${plural(new Set(of.flatMap((entry) => (entry.paths?.length ? entry.paths : [entry.text]))).size, 'file', 'files')}`
      case 'change':
        return `${present ? 'changing' : 'changed'} ${plural(new Set(of.flatMap((entry) => entry.paths ?? [])).size || of.length, 'file', 'files')}`
      case 'command':
        return present ? `running ${of.length === 1 ? 'a command' : `${of.length} commands`}` : `ran ${plural(of.length, 'command', 'commands')}`
      case 'search':
        return present ? 'searching' : `searched ${times(of.length)}`
      case 'web':
        return present ? 'looking on the web' : `looked on the web ${times(of.length)}`
      case 'helper':
        return present ? `asking ${of.length === 1 ? 'a helper' : `${of.length} helpers`}` : `asked ${plural(of.length, 'helper', 'helpers')}`
      case 'tool':
        return present ? `using ${of.length === 1 ? 'a tool' : `${of.length} tools`}` : `used ${plural(of.length, 'tool', 'tools')}`
      case 'thought': {
        if (present) return 'thinking'
        const ms = of.reduce((sum, entry) => sum + (entry.took ?? 0), 0)
        return ms >= 1000 ? `thought for ${took(ms)}` : `thought ${times(of.length)}`
      }
    }
  }
  let clauses: Clause[] = CLAUSE_ORDER.filter((key) => by.has(key)).map((key) => ({ key, text: words(key, by.get(key) ?? [], key === now) }))
  // In brief: what was changed and run, else the first two things it did.
  if (brief) clauses = clauses.some((clause) => clause.key && BRIEF.includes(clause.key)) ? clauses.filter((clause) => clause.key && BRIEF.includes(clause.key)) : clauses.slice(0, 2)
  const failed = rows.filter((entry) => entry.status === 'failed').length
  const refused = rows.filter((entry) => entry.kind === 'command' && entry.status === 'declined').length
  if (failed) clauses.push({ text: `${failed} failed`, bad: true })
  if (refused) clauses.push({ text: `${refused} refused`, bad: true })
  if (clauses.length) clauses[0] = { ...clauses[0], text: clauses[0].text.charAt(0).toUpperCase() + clauses[0].text.slice(1) }
  return clauses
}

/**
 * Work folded to one quiet line, the sentence of what it was. It opens and closes as the person chooses, and is closed until
 * they do. While it is the work going on, the line says what it does now and `ticker` (the newest row) shows under it, so that
 * the conversation does not grow with every step.
 */
function Fold({ clauses, label, live = false, ticker, fresh, children }: { clauses: Clause[]; label?: string; live?: boolean; ticker?: ReactNode; fresh?: boolean; children: ReactNode }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className={`task-steps${open ? ' open' : ''}${fresh ? ' fresh' : ''}`}>
      <button type="button" className="fold-line" aria-expanded={open} onClick={() => setOpen((was) => !was)}>
        <Icon name="chevron" size={12} />
        {label && <span className="fold-label">{label}</span>}
        {clauses.length > 0 && (
          <span className={live ? 'fold-words live' : 'fold-words'}>
            {clauses.map((clause, index) => (
              <span key={index}>
                {index ? ', ' : ''}
                <span className={clause.bad ? 'bad' : undefined}>{clause.text}</span>
              </span>
            ))}
          </span>
        )}
      </button>
      {!open && ticker}
      {open && <div className="fold-body">{children}</div>}
    </div>
  )
}

/** Something the agent said, as it wrote it. */
function Said({ entry, fresh }: { entry: LogEntry; fresh?: boolean }): ReactNode {
  return (
    <div className={fresh ? 'task-agent fresh' : 'task-agent'}>
      <Markdown text={entry.text} />
    </div>
  )
}

/** A turn's parts: each thing the agent said, and each stretch of what it did between. */
interface Part {
  key: string
  said?: LogEntry
  run?: LogEntry[]
}

function partsOf(entries: readonly LogEntry[]): Part[] {
  const parts: Part[] = []
  let run: LogEntry[] = []
  const flush = (): void => {
    if (!run.length) return
    parts.push({ key: `run-${run[0].id}`, run })
    run = []
  }
  for (const entry of entries) {
    if (entry.kind === 'agent') {
      flush()
      parts.push({ key: `said-${entry.id}`, said: entry })
    } else run.push(entry)
  }
  flush()
  return parts
}

/**
 * A stretch of what the agent did between its words. One thing is its row. More is one line that opens to all of them; while it
 * is what the agent does now, the line says so and the newest row ticks under it.
 */
function RunView({ run, taskKey, live, fresh, flat = false }: { run: LogEntry[]; taskKey: string; live: boolean; fresh?: boolean; flat?: boolean }): ReactNode {
  const single = run.length === 1 && !(run[0].kind === 'files' && (run[0].paths?.length ?? 0) > 1)
  const rows = (
    <div className={fresh ? 'rows fresh' : 'rows'}>
      {run.map((entry) => (
        <Rows key={entry.id} entry={entry} taskKey={taskKey} />
      ))}
    </div>
  )
  if (single || flat || !run.some(isDoing)) return rows
  // Under the line while it goes on: the step that runs, else the last one it did, in one row (of a change of several files,
  // the last of them).
  const current = live ? currentOf(run) : undefined
  const shown = current?.kind === 'files' && (current.paths?.length ?? 0) > 1 ? { ...current, paths: current.paths?.slice(-1) } : current
  return (
    <Fold
      clauses={sentenceOf(run, live)}
      live={live}
      fresh={fresh}
      ticker={
        shown ? (
          <div className="fold-ticker" key={shown.id}>
            <Rows entry={shown} taskKey={taskKey} />
          </div>
        ) : undefined
      }
    >
      {rows}
    </Fold>
  )
}

/** Parts as they are drawn: what the agent said in the open, each stretch of work as its line (or its rows, `flat`). */
function PartsView({ parts, taskKey, live, isNew, flat = false }: { parts: Part[]; taskKey: string; live: boolean; isNew: (id: number) => boolean; flat?: boolean }): ReactNode {
  return (
    <>
      {parts.map((part, index) =>
        part.said ? (
          <Said key={part.key} entry={part.said} fresh={isNew(part.said.id)} />
        ) : (
          <RunView key={part.key} run={part.run ?? []} taskKey={taskKey} live={live && index === parts.length - 1} fresh={isNew((part.run ?? [])[0]?.id ?? -1)} flat={flat} />
        )
      )}
    </>
  )
}

/** Under an answer: when it came, and a way to copy it as the agent wrote it (shown when the pointer is on its turn). */
function Meta({ at, text, fresh }: { at?: number; text: string; fresh?: boolean }): ReactNode {
  return (
    <div className={fresh ? 'said-meta fresh' : 'said-meta'}>
      {at !== undefined && <When at={at} />}
      <CopyButton text={text} label="Copy the answer" />
    </div>
  )
}

/** The pictures read so far, by task and key: a picture shown again is not asked for again. */
const picturesRead = new Map<string, Promise<string | null>>()
function pictureOf(taskKey: string, picture: string): Promise<string | null> {
  const at = `${taskKey}\n${picture}`
  let found = picturesRead.get(at)
  if (!found) {
    // One that could not be read is asked for again the next time it is shown (its conversation may be read again by then).
    const forget = (): null => {
      picturesRead.delete(at)
      return null
    }
    found = api.runnerPicture(taskKey, picture).then((src) => src ?? forget(), forget)
    picturesRead.set(at, found)
    while (picturesRead.size > 30) picturesRead.delete(picturesRead.keys().next().value as string)
  }
  return found
}

/**
 * A picture in what the person said: small in its card, in a place of its own size before it comes (nothing moves when it
 * does); pressed, it opens whole over the window. One no longer kept says so.
 */
function Picture({ taskKey, picture, index }: { taskKey: string; picture: string; index: number }): ReactNode {
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    let live = true
    void pictureOf(taskKey, picture).then((found) => {
      if (live) setSrc(found)
    })
    return () => {
      live = false
    }
  }, [taskKey, picture])
  const label = `Picture ${index + 1}`
  if (src === null) return <span className="you-picture gone">The picture is no longer kept</span>
  return (
    <>
      <button
        type="button"
        className="you-picture"
        aria-label={`${label}: open it`}
        title="Open the picture"
        disabled={!src}
        onClick={(event) => {
          // The keys come back here when it closes.
          event.currentTarget.focus()
          setOpen(true)
        }}
      >
        {src && <img src={src} alt="" />}
      </button>
      {open && src && <PictureOver src={src} label={label} onClose={() => setOpen(false)} />}
    </>
  )
}

/**
 * What the person said, as a card of its own at the head of its turn, set apart from what the agent says. The last one (`pinned`),
 * what the agent works on now, stays at the top of the conversation while its turn is in view, so that it is always there; the
 * ones before scroll away with their turns. A long one shows its first lines, fading out, and opens to all of it (and then it
 * scrolls away like the rest).
 */
function YouCard({ entry, at, fresh, pinned, taskKey }: { entry: LogEntry; at?: number; fresh?: boolean; pinned: boolean; taskKey: string }): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const [long, setLong] = useState(false)
  const [whole, setWhole] = useState(false)
  const pictures = entry.images ?? []
  const words = youWords(entry)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || whole) return
    const measure = (): void => {
      if (el.isConnected) setLong(el.scrollHeight > el.clientHeight + 2)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(measure)
    watch.observe(el)
    return () => watch.disconnect()
  }, [entry.text, whole])
  return (
    <div className={`you-row${pinned && !whole ? ' pinned' : ''}${fresh ? ' fresh' : ''}`}>
      <div className="you-head">
        <span className="you-label">You</span>
        {at !== undefined && <When at={at} />}
      </div>
      {(words || !pictures.length) && (
        <div ref={box} className={`task-you${long && !whole ? ' clamped' : ''}${whole ? ' whole' : ''}`}>
          {words}
        </div>
      )}
      {!!pictures.length && (
        <div className="you-pictures">
          {pictures.map((picture, index) => <Picture key={picture} taskKey={taskKey} picture={picture} index={index} />)}
        </div>
      )}
      {(long || whole) && (
        <button type="button" className="link you-more" aria-expanded={whole} onClick={() => setWhole((was) => !was)}>
          {whole ? 'Show less' : 'Show all'}
        </button>
      )}
      {pinned && !whole && <span className="you-fade" aria-hidden="true" />}
    </div>
  )
}

// How many of a turn's latest parts are in the open while it goes on. Measured on real conversations, a turn at work has 3 parts
// at the median and more than 40 one time in ten: the parts before the latest are behind one line.
const PARTS_SHOWN = 8

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

/** The turn a conversation is at, by what it starts with: to tell a new turn from the one that was there. */
export function lastTurnKey(entries: readonly LogEntry[]): number | undefined {
  const turns = turnsOf(entries)
  return turns[turns.length - 1]?.key
}

const isPlan = (entry: LogEntry): boolean => entry.kind === 'step' && entry.step === 'plan'

/** What the person said, as words: with its pictures shown, the words that stand in for them ("[Image #1]") are not said again. */
export function youWords(entry: LogEntry): string {
  return entry.images?.length ? entry.text.replace(/\[Image #\d+\]\s*/g, '').trim() : entry.text
}

/** What the person asked in one turn, for the rail beside the conversation: the turn's key, the words, and when they were said. */
export interface Prompt {
  key: number
  text: string
  at?: number
}

/** The questions of a conversation, turn by turn. A turn that starts with the agent, or with nothing said, has none. */
export function promptsOf(entries: readonly LogEntry[]): Prompt[] {
  const prompts: Prompt[] = []
  for (const turn of turnsOf(entries.filter((entry) => !isPlan(entry)))) {
    if (!turn.you) continue
    const text = youWords(turn.you).replace(/\s+/g, ' ').trim() || (turn.you.images?.length ? 'A picture' : '')
    if (text) prompts.push({ key: turn.key, text, ...(realTime(turn.you.at) ? { at: turn.you.at } : {}) })
  }
  return prompts
}

/**
 * A conversation as a chat: what the person said in a card of its own (the last one, what the agent works on, pinned at the top
 * while its turn is in view), what the agent
 * said as words under it, and what it did out of the way, to open when wanted (the Terminal view has all of it as it was). A turn that is over and was answered shows
 * one quiet line for all the work, "Worked for 4m 8s · Changed 4 files, ran 5 commands", which opens to what it did and what it
 * said along the way; then the answer, with when it came and Copy. The turn going on, and one that ended with no answer, show what
 * the agent says in the open and each stretch of work as its line; the stretch it is at says what it does now, and its step ticks
 * under it. Of a long turn only the latest parts are in the open. The agent's checklist is by the reply box (`PlanCard`).
 *
 * `settled` is the turn that was the last one when the task last stood still. A reply makes the task work at once, and the
 * agent's record has the reply a moment later: until then the turn that was over is drawn as over, so nothing unfolds and folds
 * again. `known` is the entries drawn before: one that is not among them comes in with a little motion, once. (Null at first:
 * what was there when the task opened does not move.)
 */
export function Thread({ entries, state, settled, taskKey, known = null, stepsRun = state === 'working' || state === 'waiting' }: { entries: LogEntry[]; state: TaskState; settled?: number; taskKey: string; known?: ReadonlySet<number> | null; stepsRun?: boolean }) {
  const now = Date.now()
  const turns = turnsOf(entries.filter((entry) => !isPlan(entry)))
  const isNew = (id: number): boolean => !!known && !known.has(id)
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
    // The work of a turn: all of it up to what the agent said after the last thing it did. (A note right after a step, "You
    // allowed it.", belongs to the step.)
    let lastDone = -1
    turn.rest.forEach((entry, at) => {
      if (isDoing(entry)) lastDone = at
    })
    let cut = lastDone < 0 ? 0 : turn.rest.length
    for (let at = lastDone + 1; lastDone >= 0 && at < turn.rest.length; at++) {
      if (turn.rest[at].kind === 'agent') {
        cut = at
        break
      }
    }
    const work = turn.rest.slice(0, cut)
    const after = turn.rest.slice(cut)
    const answer = after.filter((entry) => entry.kind === 'agent')
    const answered = !live && answer.length > 0
    // How long the turn took: from what was asked to the last thing in it, by the times its agent kept.
    const ended = [...turn.rest].reverse().find((entry) => realTime(entry.at))?.at
    const time = asked !== undefined && ended !== undefined && ended - asked >= 1000 ? took(ended - asked) : undefined
    const inside: ReactNode[] = []
    if (answered && work.length) {
      // A turn that only thought shows its thought ("Thought for 8s"). Any other is one line, "Worked for 4m 8s", with what it
      // changed and ran; opened, one stretch of work shows its steps at once, several show each as its own line.
      if (work.every((entry) => entry.kind === 'step' && entry.step === 'think')) inside.push(<RunView key={`work-${work[0].id}`} run={work} taskKey={taskKey} live={false} fresh={isNew(work[0].id)} />)
      else {
        const workParts = partsOf(work)
        inside.push(
          <Fold key={`work-${work[0].id}`} label={time ? `Worked for ${time}` : undefined} clauses={sentenceOf(work, false, true)} fresh={isNew(work[0].id)}>
            <PartsView parts={workParts} taskKey={taskKey} live={false} isNew={() => false} flat={workParts.filter((part) => part.run).length <= 1} />
          </Fold>
        )
      }
      inside.push(<PartsView key="after" parts={partsOf(after)} taskKey={taskKey} live={false} isNew={isNew} />)
    } else {
      const parts = partsOf(turn.rest)
      const early = parts.slice(0, Math.max(0, parts.length - PARTS_SHOWN))
      if (early.length) {
        inside.push(
          <Fold key={`early-${turn.key}`} label="Earlier in this turn" clauses={sentenceOf(early.flatMap((part) => part.run ?? []), false)}>
            <PartsView parts={early} taskKey={taskKey} live={false} isNew={() => false} />
          </Fold>
        )
      }
      inside.push(<PartsView key="parts" parts={parts.slice(early.length)} taskKey={taskKey} live={live && state === 'working'} isNew={isNew} />)
    }
    if (answered) {
      const end = answer[answer.length - 1]
      inside.push(<Meta key={`meta-${end.id}`} at={realTime(end.at) ? end.at : undefined} text={answer.map((entry) => entry.text).join('\n\n')} fresh={isNew(end.id)} />)
    }
    blocks.push(
      <div key={turn.key} className="turn" data-turn={turn.key}>
        {turn.you && <YouCard entry={turn.you} at={asked} fresh={isNew(turn.you.id)} pinned={last} taskKey={taskKey} />}
        {inside}
      </div>
    )
  })
  return <StepsRun.Provider value={stepsRun}>{blocks}</StepsRun.Provider>
}

// ---- Beside the thread ----

/** The checklist of the turn at hand: the last one the agent kept in its last turn, if it kept one. */
export function currentPlan(entries: readonly LogEntry[]): PlanItem[] | undefined {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at]
    if (entry.kind === 'you') return undefined
    if (isPlan(entry) && entry.plan?.length) return entry.plan
  }
  return undefined
}

/**
 * The agent's own checklist for the turn at hand, by the reply box: each thing on it, done, being done or still to do. Open while
 * something is left to do, folded to its count once all of it is done; a press opens or folds it.
 */
export function PlanCard({ plan }: { plan: PlanItem[] }): ReactNode {
  const done = plan.filter((item) => item.state === 'done').length
  const [open, setOpen] = useState<boolean | undefined>(undefined)
  const shown = open ?? done < plan.length
  return (
    <section className="task-plan" aria-label="Its checklist">
      <button type="button" className="plan-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <Icon name="chevron" size={12} />
        <span className="plan-title">Checklist</span>
        <span className="plan-count">
          {done} of {plan.length} done
        </span>
      </button>
      {shown && (
        <ul className="plan-items">
          {plan.map((item, index) => (
            <li key={index} data-state={item.state}>
              <span className="plan-mark" aria-hidden="true">
                {item.state === 'done' ? <Icon name="check" size={11} /> : item.state === 'doing' ? <i className="row-spin" /> : <i className="plan-todo" />}
              </span>
              <span className="plan-text">{item.text}</span>
              <span className="sr-only">{item.state === 'done' ? ', done' : item.state === 'doing' ? ', being done' : ', to do'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
