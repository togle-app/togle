// What Hermes kept of a session's conversation, for the Chat view: its `hermes sessions export - --session-id <id>` (one JSON
// object, with the session's messages) made into the same entries the window shows for any task. The export holds every row,
// including ones that were compacted away or are Hermes's own notes to itself: only the live conversation is drawn.
import type { LogEntry, PlanItem } from '@shared/runner'
import { list, rec, text } from './jsonrpc'

const WORDS_MOST = 20_000
const COMMAND_MOST = 2_000
const NAME_MOST = 300
// The most of what one command printed, or of one thought, kept to be opened (its end), and the most kept of a whole session:
// past that, the oldest steps are not opened any more.
const DETAIL_MOST = 400_000
const DETAILS_MOST = 6 * 1048576
// The most files one run of reads names.
const READS_MOST = 60
// Hermes's tools by name: those that run a command (or code, which is told as a command), those that change a file, and the
// ones told as a step of their own kind. Any other tool is told by its name.
const RUNS = new Set(['terminal', 'shell', 'bash', 'execute_command', 'run_command'])
const CODE = new Set(['execute_code'])
const EDITS = new Set(['write_file', 'patch', 'edit_file', 'file_edit', 'apply_patch', 'str_replace', 'create_file'])
const READS = new Set(['read_file'])
const SEARCHES = new Set(['search_files', 'session_search'])
const WEB = new Set(['web_search', 'web_extract'])
const PLANS = new Set(['todo_list'])
// Rows Hermes keeps for itself, not for the person to read.
const NOT_SHOWN = new Set(['hidden', 'internal_notification', 'model_switch', 'process_complete'])

/** The words of a message: its text, or the text parts of a list of parts. */
function wordsOf(content: unknown): string {
  if (typeof content === 'string') return content
  return list(content).map(rec).filter((part) => part.type === 'text').map((part) => text(part.text)).join('\n')
}

/** What a tool call was given or what a tool answered, when it is a JSON object. */
function objectOf(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return rec(value)
  try {
    return rec(JSON.parse(value))
  } catch {
    return {}
  }
}

/** A row's tool calls: a list, or the same written as text. */
function callsOf(value: unknown): unknown[] {
  if (typeof value !== 'string') return list(value)
  try {
    return list(JSON.parse(value))
  } catch {
    return []
  }
}

/** Hermes's checklist as a list of things, each done, being done or still to do. What was called off is left out. */
function planOf(todos: unknown): PlanItem[] {
  return list(todos)
    .map(rec)
    .filter((item) => text(item.content).trim() && text(item.status) !== 'cancelled')
    .map((item): PlanItem => ({ text: text(item.content).trim().slice(0, NAME_MOST), state: text(item.status) === 'completed' ? 'done' : text(item.status) === 'in_progress' ? 'doing' : 'todo' }))
}

const planWords = (plan: PlanItem[]): string => `${plan.filter((item) => item.state === 'done').length} of ${plan.length} done`

/** A tool that waits for its row: its entry, and when it was called. */
interface Waiting {
  entry: LogEntry
  at: number
  tool: string
}

/**
 * The conversation in an export: what was asked, what Hermes said, the commands it ran with how each ended and how long it took,
 * the files it changed, and what else it did (files read, searches, the web, its checklist, its thinking, its other tools by
 * name). `details`, when given, is filled with what a step holds to be opened (what a command printed, the words of a thought),
 * by the key the step carries in `more`.
 */
export function hermesEntries(session: unknown, details?: Map<string, string>): LogEntry[] {
  const rows = list(rec(session).messages)
    .map(rec)
    .filter((row) => row.active !== 0 && row.active !== false && !row._compressed_summary && !NOT_SHOWN.has(text(row.display_kind)))
    // In the order Hermes wrote them: a row's time can be before the row that came first.
    .sort((a, b) => (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0))
  const entries: LogEntry[] = []
  const waiting = new Map<string, Waiting>()
  const last = (): LogEntry | undefined => entries[entries.length - 1]
  const keep = (key: string, words: string): string | undefined => {
    if (!details || !key || !words.trim()) return undefined
    details.set(key, words.slice(-DETAIL_MOST))
    return key
  }
  rows.forEach((row, position) => {
    const id = (typeof row.id === 'number' ? row.id : position + 1) * 100
    const at = typeof row.timestamp === 'number' ? Math.round(row.timestamp * 1000) : 0
    const role = text(row.role)
    if (role === 'user') {
      const words = wordsOf(row.content).trim()
      // What Hermes adds to a turn of its own is marked "[System:": not the person's words.
      if (words && !words.startsWith('[System:')) entries.push({ id, at, kind: 'you', text: words.slice(0, WORDS_MOST) })
    } else if (role === 'assistant') {
      // Its thinking comes before what it then says or does. Hermes keeps the words, and no time for them.
      const more = keep(`think:${id}`, text(row.reasoning))
      if (more) entries.push({ id: id + 98, at, kind: 'step', step: 'think', text: '', more })
      const words = wordsOf(row.content).trim()
      if (words) entries.push({ id, at, kind: 'agent', text: words.slice(0, WORDS_MOST) })
      callsOf(row.tool_calls).map(rec).slice(0, 90).forEach((call, index) => {
        const tool = rec(call.function)
        const name = text(tool.name)
        const given = objectOf(tool.arguments)
        const own = id + 1 + index
        const wait = (entry: LogEntry): void => {
          entries.push(entry)
          if (text(call.id)) waiting.set(text(call.id), { entry, at, tool: name })
        }
        if (RUNS.has(name) && text(given.command)) wait({ id: own, at, kind: 'command', text: text(given.command).slice(0, COMMAND_MOST), status: 'running' })
        else if (CODE.has(name) && text(given.code).trim()) wait({ id: own, at, kind: 'command', text: text(given.code).trim().slice(0, COMMAND_MOST), status: 'running' })
        else if (EDITS.has(name)) {
          const file = text(given.path) || text(given.file_path) || text(given.filename)
          if (file) entries.push({ id: own, at, kind: 'files', text: `Changed 1 file: ${file}`, paths: [file] })
        } else if (READS.has(name)) {
          // Several reads one after another are one step that names them all.
          const file = text(given.path)
          const before = last()
          if (!file) return
          if (before?.kind === 'step' && before.step === 'read' && before.paths && before.paths.length < READS_MOST) {
            if (!before.paths.includes(file)) before.paths.push(file)
          } else entries.push({ id: own, at, kind: 'step', step: 'read', text: file.slice(0, NAME_MOST), paths: [file] })
        } else if (SEARCHES.has(name)) {
          const what = text(given.pattern) || text(given.query)
          if (what) wait({ id: own, at, kind: 'step', step: 'search', text: what.slice(0, NAME_MOST) })
        } else if (WEB.has(name)) {
          const what = text(given.query) || text(list(given.urls)[0])
          if (what) wait({ id: own, at, kind: 'step', step: 'web', text: what.slice(0, NAME_MOST) })
        } else if (PLANS.has(name)) {
          // The list as it was given; its row then says how it stands in all.
          const plan = planOf(given.todos)
          const before = last()
          const entry: LogEntry = before?.kind === 'step' && before.step === 'plan' ? before : { id: own, at, kind: 'step', step: 'plan', text: '' }
          if (plan.length) {
            entry.plan = plan
            entry.text = planWords(plan)
          }
          if (entry !== before) entries.push(entry)
          if (text(call.id)) waiting.set(text(call.id), { entry, at, tool: name })
        } else if (name) wait({ id: own, at, kind: 'step', step: 'tool', text: name.slice(0, NAME_MOST) })
      })
    } else if (role === 'tool') {
      const held = waiting.get(text(row.tool_call_id))
      if (!held) return
      waiting.delete(text(row.tool_call_id))
      const { entry } = held
      const said = wordsOf(row.content)
      const result = objectOf(said)
      const failed = (typeof result.exit_code === 'number' && result.exit_code !== 0) || !!result.error
      // How long it took: what the tool says itself, else from the call to its row, when their times are in order.
      const told = typeof result.duration_seconds === 'number' && result.duration_seconds >= 0 ? result.duration_seconds * 1000 : held.at > 0 && at >= held.at ? at - held.at : undefined
      if (told !== undefined) entry.took = Math.round(told)
      if (entry.kind === 'command') {
        entry.status = failed ? 'failed' : 'finished'
        // What it printed: the tool's own account of it, or the row as it is when it is not such an account.
        const more = keep(text(row.tool_call_id), typeof result.output === 'string' ? [result.output, typeof result.error === 'string' ? result.error : ''].filter((part) => part.trim()).join('\n') : said)
        if (more) entry.more = more
      } else if (entry.step === 'plan') {
        const plan = planOf(result.todos)
        if (plan.length) {
          entry.plan = plan
          entry.text = planWords(plan)
        }
        delete entry.took
      } else if (failed) entry.status = 'failed'
    }
  })
  // A checklist that never said what is on it is not a step.
  const told = entries.filter((entry) => !(entry.kind === 'step' && entry.step === 'plan' && !entry.plan?.length))
  // Of a long session only the newest of what can be opened is kept.
  if (details) {
    let held = 0
    for (let at = told.length - 1; at >= 0; at--) {
      const entry = told[at]
      if (!entry.more) continue
      held += details.get(entry.more)?.length ?? 0
      if (held > DETAILS_MOST) {
        details.delete(entry.more)
        delete entry.more
      }
    }
  }
  return told
}
