// What Hermes kept of a session's conversation, for the Web view: its `hermes sessions export - --session-id <id>` (one JSON
// object, with the session's messages) made into the same entries the window shows for any task. The export holds every row,
// including ones that were compacted away or are Hermes's own notes to itself: only the live conversation is drawn.
import type { LogEntry } from '@shared/runner'
import { list, rec, text } from './jsonrpc'

const WORDS_MOST = 20_000
const COMMAND_MOST = 2_000
// Hermes's tools that run a command, and those that change a file, by name.
const RUNS = new Set(['terminal', 'shell', 'bash', 'execute_command', 'run_command'])
const EDITS = new Set(['write_file', 'patch', 'edit_file', 'file_edit', 'apply_patch', 'str_replace', 'create_file'])
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

/** The conversation in an export: what was asked, what Hermes said, the commands it ran with how each ended, the files it changed. */
export function hermesEntries(session: unknown): LogEntry[] {
  const rows = list(rec(session).messages)
    .map(rec)
    .filter((row) => row.active !== 0 && row.active !== false && !row._compressed_summary && !NOT_SHOWN.has(text(row.display_kind)))
    // In the order Hermes wrote them: a row's time can be before the row that came first.
    .sort((a, b) => (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : 0))
  const entries: LogEntry[] = []
  const waiting = new Map<string, LogEntry>()
  rows.forEach((row, position) => {
    const id = (typeof row.id === 'number' ? row.id : position + 1) * 100
    const at = typeof row.timestamp === 'number' ? Math.round(row.timestamp * 1000) : 0
    const role = text(row.role)
    if (role === 'user') {
      const words = wordsOf(row.content).trim()
      // What Hermes adds to a turn of its own is marked "[System:": not the person's words.
      if (words && !words.startsWith('[System:')) entries.push({ id, at, kind: 'you', text: words.slice(0, WORDS_MOST) })
    } else if (role === 'assistant') {
      const words = wordsOf(row.content).trim()
      if (words) entries.push({ id, at, kind: 'agent', text: words.slice(0, WORDS_MOST) })
      list(row.tool_calls).map(rec).forEach((call, index) => {
        const tool = rec(call.function)
        const name = text(tool.name)
        const given = objectOf(tool.arguments)
        if (RUNS.has(name) && text(given.command)) {
          const entry: LogEntry = { id: id + 1 + index, at, kind: 'command', text: text(given.command).slice(0, COMMAND_MOST), status: 'running' }
          entries.push(entry)
          if (text(call.id)) waiting.set(text(call.id), entry)
        } else if (EDITS.has(name)) {
          const file = text(given.path) || text(given.file_path) || text(given.filename)
          if (file) entries.push({ id: id + 1 + index, at, kind: 'files', text: `Changed 1 file: ${file}`, paths: [file] })
        }
      })
    } else if (role === 'tool') {
      const entry = waiting.get(text(row.tool_call_id))
      if (!entry) return
      waiting.delete(text(row.tool_call_id))
      const result = objectOf(wordsOf(row.content))
      entry.status = (typeof result.exit_code === 'number' && result.exit_code !== 0) || !!result.error ? 'failed' : 'finished'
    }
  })
  return entries
}
