// What Codex keeps of a thread's conversation, for the Web view: its turns as `thread/turns/list` tells them, made into the same
// entries the window shows for any task. The newest turns come with every step (commands, files changed); older ones with only
// what was asked and the answer, which is all the server gives of them in one cheap call.
import type { LogEntry } from '@shared/runner'
import { list, rec, text } from './jsonrpc'
import { unwrapShell } from './process-tree'

type Json = Record<string, unknown>

const WORDS_MOST = 20_000
const COMMAND_MOST = 2_000

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

/** The entries of turns, given oldest first: what was asked, what Codex answered, the commands it ran and the files it changed. */
export function codexEntries(turns: unknown[]): LogEntry[] {
  const entries: LogEntry[] = []
  for (const turn of turns.map(rec)) {
    const turnAt = typeof turn.startedAt === 'number' ? turn.startedAt * 1000 : 0
    list(turn.items).map(rec).forEach((item, index) => {
      const id = stable(text(item.id) || `${text(turn.id)}:${index}`)
      const at = typeof item.startedAtMs === 'number' ? item.startedAtMs : turnAt
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
          entries.push({ id, at, kind: 'command', text: command, status: status === 'inProgress' ? 'running' : status === 'declined' ? 'declined' : status === 'failed' ? 'failed' : 'finished' })
          break
        }
        case 'fileChange': {
          const paths = list(item.changes).map((change) => text(rec(change).path)).filter(Boolean)
          if (paths.length && text(item.status) === 'completed') entries.push({ id, at, kind: 'files', text: `Changed ${paths.length} file${paths.length === 1 ? '' : 's'}: ${paths.join(', ').slice(0, 160)}`, paths: paths.slice(0, 200) })
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
