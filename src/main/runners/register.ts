// What the window can ask of the agents' tasks: each a message from the window to the hub, and one back when
// something changed (the window then asks again for what it shows).
import { addedAgentProblem, agentIdOf, KNOWN_AGENTS, type AddedAgent, type RunnerKind, type StartRequest, type TaskView } from '@shared/runner'
import type { TodoRef } from '@shared/todo'
import { AcpBackend, commandWords, whereIs } from './acp'
import { ClaudeBackend } from './claude'
import { CodexBackend } from './codex'
import { HermesBackend } from './hermes'
import { RunnerHub, type RecordStore, type TitleStore } from './hub'
import { widenSearchPath } from './search-path'
import type { Backend } from './types'

/** An agent the person added: started by their command, its program found the way a terminal would find it. */
export function addedBackend(agent: AddedAgent, version: string): AcpBackend {
  return new AcpBackend({
    runner: agent.id,
    name: agent.name,
    version,
    command: async () => {
      const [program, ...args] = commandWords(agent.command)
      const found = program ? await whereIs(program) : null
      return found ? [found, ...args] : null
    }
  })
}

export interface RunnerDeps {
  /** `ipcMain.handle`, without the event the window's message came with. */
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
  send(channel: string, payload: unknown): void
  titles: TitleStore
  /** Which tasks Togle started, for the agents that cannot list their own. */
  records?: RecordStore
  /** Something in the tasks changed, told to the main process as it is told to the window. */
  changed?: () => void
  /** Asks the person for a folder; null when they close the dialog. */
  pickFolder(): Promise<string | null>
  /** Togle's version, told to the agents that ask who is talking. */
  version: string
  /** The agents to work with: Codex, Claude Code and Hermes when left out. */
  backends?: Backend[]
  /** The agents the person added (any that speaks ACP), and keeping a changed list. */
  added?(): AddedAgent[]
  saveAdded?(agents: AddedAgent[]): Promise<void>
  /** A task was started, from the window, the task box or the togle command (see HubOptions.started). */
  started?(task: TaskView, request: StartRequest): void
}

/** The to-do item a task is for, as the window names it: its line and its words. */
function todoOf(value: unknown): TodoRef | undefined {
  if (value === undefined || value === null) return undefined
  const given = value as Record<string, unknown>
  if (typeof given.line !== 'number' || !Number.isInteger(given.line) || given.line < 0 || typeof given.text !== 'string') throw new Error('Pick an item.')
  return { line: given.line, text: given.text }
}

function word(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${what} is missing.`)
  return value
}

export function registerRunners(deps: RunnerDeps): RunnerHub {
  const hub = new RunnerHub({
    backends: [
      ...(deps.backends ?? [new CodexBackend({ version: deps.version }), new ClaudeBackend(), new HermesBackend({ version: deps.version })]),
      ...(deps.added?.() ?? []).map((agent) => addedBackend(agent, deps.version))
    ],
    changed: () => {
      deps.send('runners:changed', null)
      deps.changed?.()
    },
    titles: deps.titles,
    records: deps.records,
    started: deps.started,
    // The agents on this computer, looked for as the person's terminal would; stand-ins are not looked for.
    ...(deps.backends ? {} : { widenPath: widenSearchPath })
  })
  const { handle } = deps
  handle('runners:status', () => hub.status())
  handle('runners:list', () => hub.list())
  handle('runners:detail', (key) => hub.detail(word(key, 'The task')))
  handle('runners:changes', (key) => hub.changes(word(key, 'The task')))
  handle('runners:start', (request) => {
    const given = (request ?? {}) as Record<string, unknown>
    const runner = given.runner as RunnerKind
    if (typeof runner !== 'string' || !hub.has(runner)) throw new Error('Pick an agent.')
    const todo = todoOf(given.todo)
    return hub.start({ runner, folder: word(given.folder, 'The folder'), prompt: word(given.prompt, 'The task'), title: typeof given.title === 'string' ? given.title : undefined, ...(todo ? { todo } : {}) })
  })
  handle('runners:open', (key) => hub.open(word(key, 'The task')))
  handle('runners:take-over', (key) => hub.takeOver(word(key, 'The task')))
  handle('runners:send', (key, text) => hub.send(word(key, 'The task'), typeof text === 'string' ? text : ''))
  handle('runners:answer', (key, requestId, decision) => hub.answer(word(key, 'The task'), word(requestId, 'The request'), decision as 'allow-once' | 'allow-always' | 'refuse'))
  handle('runners:reply', (key, requestId, text) => hub.reply(word(key, 'The task'), word(requestId, 'The request'), typeof text === 'string' ? text : ''))
  handle('runners:stop', (key) => hub.stop(word(key, 'The task')))
  handle('runners:end-commands', (key) => hub.endCommands(word(key, 'The task')))
  handle('runners:close', (key) => hub.close(word(key, 'The task')))
  handle('runners:pick-folder', () => deps.pickFolder())
  // Settings → Agents → Add an agent: any agent that speaks ACP, by its name and the command that starts it.
  handle('runners:add-agent', async (name, command) => {
    const problem = addedAgentProblem(name, command)
    if (problem) throw new Error(problem)
    const given = (name as string).trim()
    if (Object.values(KNOWN_AGENTS).some((known) => known.toLowerCase() === given.toLowerCase())) throw new Error(`Togle finds ${given} by itself.`)
    const added = deps.added?.() ?? []
    const base = agentIdOf(given)
    let id = base
    for (let n = 2; hub.has(id) || added.some((agent) => agent.id === id); n++) id = `${base}-${n}`
    const agent: AddedAgent = { id, name: given, command: (command as string).trim() }
    await deps.saveAdded?.([...added, agent])
    hub.addBackend(addedBackend(agent, deps.version))
    return hub.status()
  })
  handle('runners:remove-agent', async (id) => {
    const added = deps.added?.() ?? []
    if (!added.some((agent) => agent.id === id)) throw new Error('Only an agent you added can be removed.')
    await deps.saveAdded?.(added.filter((agent) => agent.id !== id))
    await hub.removeBackend(id as string)
    return hub.status()
  })
  return hub
}
