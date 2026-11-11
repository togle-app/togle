// What the window can ask of the agents' tasks: each a message from the window to the hub, and one back when
// something changed (the window then asks again for what it shows).
import type { RunnerKind } from '@shared/runner'
import { ClaudeBackend } from './claude'
import { CodexBackend } from './codex'
import { HermesBackend } from './hermes'
import { RunnerHub, type RecordStore, type TitleStore } from './hub'
import type { Backend } from './types'

export interface RunnerDeps {
  /** `ipcMain.handle`, without the event the window's message came with. */
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
  send(channel: string, payload: unknown): void
  titles: TitleStore
  /** Which tasks Togle started, for the agents that cannot list their own. */
  records?: RecordStore
  /** Asks the person for a folder; null when they close the dialog. */
  pickFolder(): Promise<string | null>
  /** Togle's version, told to the agents that ask who is talking. */
  version: string
  /** The agents to work with: Codex, Claude Code and Hermes when left out. */
  backends?: Backend[]
}

const RUNNERS: readonly RunnerKind[] = ['codex', 'claude', 'hermes']

function word(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${what} is missing.`)
  return value
}

export function registerRunners(deps: RunnerDeps): RunnerHub {
  const hub = new RunnerHub({
    backends: deps.backends ?? [new CodexBackend({ version: deps.version }), new ClaudeBackend(), new HermesBackend({ version: deps.version })],
    changed: () => deps.send('runners:changed', null),
    titles: deps.titles,
    records: deps.records
  })
  const { handle } = deps
  handle('runners:status', () => hub.status())
  handle('runners:list', () => hub.list())
  handle('runners:detail', (key) => hub.detail(word(key, 'The task')))
  handle('runners:start', (request) => {
    const given = (request ?? {}) as Record<string, unknown>
    const runner = given.runner as RunnerKind
    if (!RUNNERS.includes(runner)) throw new Error('Pick an agent.')
    return hub.start({ runner, folder: word(given.folder, 'The folder'), prompt: word(given.prompt, 'The task'), title: typeof given.title === 'string' ? given.title : undefined })
  })
  handle('runners:open', (key) => hub.open(word(key, 'The task')))
  handle('runners:take-over', (key) => hub.takeOver(word(key, 'The task')))
  handle('runners:send', (key, text) => hub.send(word(key, 'The task'), typeof text === 'string' ? text : ''))
  handle('runners:answer', (key, requestId, decision) => hub.answer(word(key, 'The task'), word(requestId, 'The request'), decision as 'allow-once' | 'refuse'))
  handle('runners:reply', (key, requestId, text) => hub.reply(word(key, 'The task'), word(requestId, 'The request'), typeof text === 'string' ? text : ''))
  handle('runners:stop', (key) => hub.stop(word(key, 'The task')))
  handle('runners:end-commands', (key) => hub.endCommands(word(key, 'The task')))
  handle('runners:close', (key) => hub.close(word(key, 'The task')))
  handle('runners:pick-folder', () => deps.pickFolder())
  return hub
}
