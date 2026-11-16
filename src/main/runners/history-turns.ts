// The part of an agent's conversation the Web view shows: its last turns, or all of them up to a limit. A turn starts with what the
// person asked. Used for the agents whose conversation is read in full (Claude Code's file, Hermes's export).
import type { LogEntry, TaskHistory } from '@shared/runner'

// The newest turns shown at first, and the most that "show earlier" brings.
const TURNS_SHOWN = 12
const TURNS_ALL = 400

/**
 * The last turns of a conversation (all of them, up to a limit, with `all`). `cut` says that what came before `entries` was left
 * out already, so that there is more than these even when all of them are shown. A command with no result, when something was asked
 * after it, was cut short (its session ended under it): it is not shown as running.
 */
export function lastTurns(entries: readonly LogEntry[], all: boolean, cut = false): TaskHistory {
  const turns = all ? TURNS_ALL : TURNS_SHOWN
  let start = 0
  for (let seen = 0, at = entries.length - 1; at >= 0; at--) {
    if (entries[at].kind === 'you' && ++seen === turns) {
      start = at
      break
    }
  }
  const shown = entries.slice(start)
  const lastAsked = shown.map((entry) => entry.kind).lastIndexOf('you')
  return {
    entries: shown.map((entry, index) => (entry.kind === 'command' && entry.status === 'running' && index < lastAsked ? { ...entry, status: 'failed' as const } : { ...entry })),
    more: start > 0 || cut
  }
}
