// What Codex keeps of a thread's conversation, for the Web view: its turns as `thread/turns/list` tells them, made into the same
// entries the window shows for any task. The newest turns come with every step (commands with what they printed and how long they
// took, files changed, its thinking, its searches of the web, the tools of its connectors); older ones with only what was asked and
// the answer, which is all the server gives of them in one cheap call.
import type { LogEntry } from '@shared/runner'
import { list, rec, text } from './jsonrpc'
import { unwrapShell } from './process-tree'

type Json = Record<string, unknown>

const WORDS_MOST = 20_000
const COMMAND_MOST = 2_000
const NAME_MOST = 300
// The most of what a command printed, or of a thought, kept to be opened: its end.
const DETAIL_MOST = 400_000
// The most files one run of looks names, and how long a thought with no words kept has to be to be told, in milliseconds.
const READS_MOST = 60
const THOUGHT_LEAST = 1_000

/** A number for an item that is the same each time it is read: the window keeps its place by it. */
function stable(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** The words of a message the person sent: its text, and a mark for each picture. */
function theirWords(item: Json): string {
  const parts: string[] = []
  for (const block of list(item.content).map(rec)) {
    if (block.type === 'text') parts.push(text(block.text))
    else if (block.type === 'localImage' || block.type === 'image') parts.push('[picture]')
  }
  return parts.join('\n').trim()
}

/** The words of a thought: its summary and its text, each a list of words or of parts that hold words. */
function thoughtWords(item: Json): string {
  const words = (part: unknown): string => (typeof part === 'string' ? part : text(rec(part).text))
  return [...list(item.summary), ...list(item.content)].map(words).filter((part) => part.trim()).join('\n\n').trim()
}

/** How long an item took: what it says itself, else from its start to its end, when both are told and in order. */
function tookOf(item: Json): number | undefined {
  if (typeof item.durationMs === 'number' && item.durationMs >= 0) return Math.round(item.durationMs)
  const from = item.startedAtMs
  const to = item.completedAtMs
  return typeof from === 'number' && typeof to === 'number' && to >= from ? Math.round(to - from) : undefined
}

/**
 * The entries of turns, given oldest first: what was asked, what Codex answered, the commands it ran, the files it changed, and
 * what else it did. `details`, when given, is filled with what a step holds to be opened (what a command printed, the words of a
 * thought), by the key the step carries in `more`: the item's own id.
 */
export function codexEntries(turns: unknown[], details?: Map<string, string>): LogEntry[] {
  const entries: LogEntry[] = []
  const last = (): LogEntry | undefined => entries[entries.length - 1]
  const keep = (key: string, words: string): string | undefined => {
    if (!details || !key || !words.trim()) return undefined
    details.set(key, words.slice(-DETAIL_MOST))
    return key
  }
  for (const turn of turns.map(rec)) {
    const turnAt = typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : 0
    list(turn.items).map(rec).forEach((item, index) => {
      const key = text(item.id)
      const id = stable(key || `${text(turn.id)}:${index}`)
      const at = typeof item.startedAtMs === 'number' ? item.startedAtMs : turnAt
      const took = tookOf(item)
      const timed = took !== undefined ? { took } : {}
      switch (text(item.type)) {
        case 'userMessage': {
          const words = theirWords(item)
          if (words) entries.push({ id, at, kind: 'you', text: words.slice(0, WORDS_MOST) })
          break
        }
        case 'agentMessage': {
          const words = text(item.text).trim()
          if (words) entries.push({ id, at, kind: 'agent', text: words.slice(0, WORDS_MOST) })
          break
        }
        case 'commandExecution': {
          const command = unwrapShell(text(item.command)).slice(0, COMMAND_MOST)
          if (!command) break
          const status = text(item.status)
          const more = keep(key, text(item.aggregatedOutput))
          entries.push({ id, at, kind: 'command', text: command, status: status === 'inProgress' ? 'running' : status === 'declined' ? 'declined' : status === 'failed' ? 'failed' : 'finished', ...timed, ...(more ? { more } : {}) })
          break
        }
        case 'fileChange': {
          const paths = list(item.changes).map((change) => text(rec(change).path)).filter(Boolean)
          if (paths.length && text(item.status) === 'completed') entries.push({ id, at, kind: 'files', text: `Changed ${paths.length} file${paths.length === 1 ? '' : 's'}: ${paths.join(', ').slice(0, 160)}`, paths: paths.slice(0, 200) })
          break
        }
        case 'reasoning': {
          // Thoughts one after another are one step, with their times added up. A short one with no words kept is not told.
          const words = thoughtWords(item)
          const before = last()
          if (before?.kind === 'step' && before.step === 'think' && !(words && before.more)) {
            if (took) before.took = (before.took ?? 0) + took
            const more = keep(key, words)
            if (more) before.more = more
            break
          }
          if (!words && (took ?? 0) < THOUGHT_LEAST) break
          const more = keep(key, words)
          entries.push({ id, at, kind: 'step', step: 'think', text: '', ...(took ? { took } : {}), ...(more ? { more } : {}) })
          break
        }
        case 'webSearch': {
          const action = rec(item.action)
          const what = text(item.query).trim() || text(action.url).trim() || text(action.query).trim()
          if (what) entries.push({ id, at, kind: 'step', step: 'web', text: what.slice(0, NAME_MOST), ...timed })
          break
        }
        case 'mcpToolCall': {
          const name = [text(item.server), text(item.tool)].filter(Boolean).join(': ')
          if (!name) break
          const status = text(item.status)
          entries.push({ id, at, kind: 'step', step: 'tool', text: name.slice(0, NAME_MOST), ...(status === 'inProgress' ? { status: 'running' as const } : status === 'failed' || item.error ? { status: 'failed' as const } : {}), ...timed })
          break
        }
        case 'imageView': {
          // A picture it looked at: a file read. Several looks one after another are one step that names them all.
          const file = text(item.path)
          if (!file) break
          const before = last()
          if (before?.kind === 'step' && before.step === 'read' && before.paths && before.paths.length < READS_MOST) {
            if (!before.paths.includes(file)) before.paths.push(file)
          } else entries.push({ id, at, kind: 'step', step: 'read', text: file.slice(0, NAME_MOST), paths: [file] })
          break
        }
        default:
      }
    })
  }
  return entries
}

/** The turns of an answer to `thread/turns/list`, newest first as the server gives them, and where the older ones go on. */
export function turnsOf(answer: unknown): { turns: unknown[]; next: string | null } {
  const found = rec(answer)
  return { turns: list(found.data), next: text(found.nextCursor) || null }
}
