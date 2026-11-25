// What the window can ask of the agents' tasks: each a message from the window to the hub, and one back when
// something changed (the window then asks again for what it shows).
import path from 'node:path'
import { addedAgentProblem, agentIdOf, KNOWN_AGENTS, runsInTerminal, type AddedAgent, type RunnerKind, type RunnerStatus, type StartRequest, type TaskView } from '@shared/runner'
import type { TodoRef } from '@shared/todo'
import { AcpBackend, commandIsAcp, commandWords, whereIs } from './acp'
import { agentCatalog, fetchRegistry, rememberedWhere } from './agent-catalog'
import { ClaudeBackend } from './claude'
import { CodexBackend } from './codex'
import { HermesBackend } from './hermes'
import { RunnerHub, type FreshStore, type RecordStore, type TitleStore } from './hub'
import { NO_GROUPS, type GroupChange, type TaskGroups } from '@shared/task-groups'
import { widenSearchPath } from './search-path'
import type { SortTask } from './subjects'
import { TerminalBackend, type TerminalChunk } from './terminal'
import type { Backend } from './types'

/**
 * An agent the person added: started by their command, its program found the way a terminal would find it. One that runs
 * in a terminal of Togle's own tells what it prints through `told`.
 */
export function addedBackend(agent: AddedAgent, version: string, told?: (chunk: TerminalChunk) => void, keepIn?: string): Backend {
  if (runsInTerminal(agent.id)) return new TerminalBackend({ runner: agent.id, name: agent.name, command: agent.command }, told)
  return new AcpBackend({
    runner: agent.id,
    name: agent.name,
    costFile: keepIn ? path.join(keepIn, `agent-usage-${encodeURIComponent(agent.id)}.json`) : undefined,
    version,
    command: async () => {
      const [program, ...args] = commandWords(agent.command)
      const found = program ? await whereIs(program) : null
      return found ? [found, ...args] : null
    }
  })
}

export interface RunnerDeps {
  /** Enable Codex's input tool for threads in the private phone smoke test. */
  pilotInputTool?: boolean
  /** `ipcMain.handle`, without the event the window's message came with. */
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
  send(channel: string, payload: unknown): void
  titles: TitleStore
  /** Which tasks Togle started, for the agents that cannot list their own. */
  records?: RecordStore
  /** Which tasks finished since the person last looked at them. */
  fresh?: FreshStore
  /** The person's own arrangement of the list: groups they made, names they gave, tasks they moved. */
  groups?: { get(): TaskGroups; change(change: GroupChange): TaskGroups }
  /** Togle's sorting by subject (subjects.ts). A task the person moved is theirs: it is not sorted. */
  subjects?: { of(key: string, place: string): string | undefined; notice(tasks: SortTask[]): void }
  /** Something in the tasks changed, told to the main process as it is told to the window. */
  changed?: () => void
  /** Asks the person for a folder; null when they close the dialog. */
  pickFolder(): Promise<string | null>
  /** Togle's version, told to the agents that ask who is talking. */
  version: string
  /** The agents to work with: Codex, Claude Code and Hermes when left out. */
  backends?: Backend[]
  /** A folder of Togle's own where what Claude Code's tasks need to go on without Togle is kept: see ClaudeOptions.keep. */
  keep?: string
  /** A folder of Togle's own where Codex and Hermes keep what their tasks need between runs (a folder of each one's name in it). */
  keepIn?: string
  /** The agents the person added (any that speaks ACP), and keeping a changed list. */
  added?(): AddedAgent[]
  saveAdded?(agents: AddedAgent[]): Promise<void>
  /**
   * What Add another agent reads: the ACP registry (from the network when left out, with a copy kept in `registryFile` so that the list
   * does not wait for the network each time Togle starts) and where a program is on this computer.
   */
  catalog?: { registry?(): Promise<unknown>; registryFile?: string; whereIs?(program: string): Promise<string | null> }
  /** The agents Togle finds by itself that the person took off its lists, and keeping a changed list. */
  hidden?(): string[]
  saveHidden?(ids: string[]): Promise<void>
  /** A task was started, from the window, the task box or the togle command (see HubOptions.started). */
  started?(task: TaskView, request: StartRequest): void
  linkGivenTodo?(item: TodoRef, key: string): Promise<unknown>
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
  // What a terminal of Togle's own prints goes to the window as it comes.
  const told = (chunk: TerminalChunk): void => deps.send('runners:terminal-data', chunk)
  // The agents Togle finds by itself, one by its id: what is started again when one is added back.
  const known = (runner: string): Backend | undefined =>
    runner === 'codex'
      ? new CodexBackend({ version: deps.version, told, pilotInputTool: deps.pilotInputTool, ...(deps.keepIn ? { keep: path.join(deps.keepIn, 'codex') } : {}) })
      : runner === 'claude'
        ? new ClaudeBackend({ told, ...(deps.keep ? { keep: deps.keep } : {}) })
        : runner === 'hermes'
          ? new HermesBackend({ told, ...(deps.keepIn ? { keep: path.join(deps.keepIn, 'hermes') } : {}) })
          : undefined
  const hidden = (): string[] => deps.hidden?.() ?? []
  const hub = new RunnerHub({
    limitsChanged: (runner, windows) => deps.send('runners:limits-changed', { runner, windows }),
    backends: [
      // The ones the person took off Togle's lists are not started.
      ...(deps.backends ?? Object.keys(KNOWN_AGENTS).filter((runner) => !hidden().includes(runner)).map((runner) => known(runner) as Backend)),
      ...(deps.added?.() ?? []).map((agent) => addedBackend(agent, deps.version, told, deps.keepIn))
    ],
    changed: () => {
      deps.send('runners:changed', null)
      deps.changed?.()
    },
    titles: deps.titles,
    records: deps.records,
    fresh: deps.fresh,
    ...(deps.subjects
      ? {
          subjects: {
            of: (key: string, place: string) => deps.subjects?.of(key, place),
            notice: (tasks: SortTask[]) => {
              const placed = deps.groups?.get().placed ?? {}
              deps.subjects?.notice(tasks.filter((task) => !(task.key in placed)))
            }
          }
        }
      : {}),
    started: deps.started,
    // The agents on this computer, looked for as the person's terminal would; stand-ins are not looked for.
    ...(deps.backends ? {} : { widenPath: widenSearchPath })
  })
  // Tasks that went on while Togle was closed are Togle's own again, with what they ask.
  void hub.restore()
  const { handle } = deps
  // What Togle works with, and the agents it finds that were taken off its lists, so that Settings can add them back.
  const statusOf = async (): Promise<RunnerStatus[]> => {
    const added = deps.added?.() ?? []
    // An added agent says its command, so that its Edit form can show it.
    const listed = (await hub.status()).map((status) => {
      const own = status.added ? added.find((agent) => agent.id === status.runner) : undefined
      return own ? { ...status, command: own.command } : status
    })
    // The added ones keep the order they were added in, whatever order their programs were started in (an edit starts its again,
    // after the others): they take the places they had, in the order of the saved list.
    const places = listed.flatMap((status, at) => (status.added ? [at] : []))
    const inOrder = listed.filter((status) => status.added).sort((a, b) => added.findIndex((agent) => agent.id === a.runner) - added.findIndex((agent) => agent.id === b.runner))
    places.forEach((at, n) => { listed[at] = inOrder[n] })
    return [
      ...listed,
      ...hidden().filter((runner) => runner in KNOWN_AGENTS && !hub.has(runner)).map((runner): RunnerStatus => ({ runner, name: KNOWN_AGENTS[runner], installed: false, removed: true }))
    ]
  }
  handle('runners:status', () => statusOf())
  handle('runners:limits', runner => hub.limits(word(runner, 'The agent')))
  handle('runners:usage', (runner, sessionId) => {
    if (sessionId !== undefined && (typeof sessionId !== 'string' || !sessionId.length || sessionId.length > 512)) throw new Error('Invalid session ID.')
    return hub.usage(word(runner, 'The agent'), sessionId)
  })
  handle('runners:list', () => hub.list())
  handle('runners:detail', (key) => hub.detail(word(key, 'The task')))
  handle('runners:history', (key, all) => hub.history(word(key, 'The task'), all === true))
  handle('runners:step', (key, more) => hub.step(word(key, 'The task'), word(more, 'The step').slice(0, 300)))
  handle('runners:groups', () => deps.groups?.get() ?? NO_GROUPS)
  handle('runners:groups-change', (change) => (deps.groups ? deps.groups.change(change as GroupChange) : NO_GROUPS))
  handle('runners:start', (request) => {
    const given = (request ?? {}) as Record<string, unknown>
    const runner = given.runner as RunnerKind
    if (typeof runner !== 'string' || !hub.has(runner)) throw new Error('Pick an agent.')
    const todo = todoOf(given.todo)
    return hub.start({ runner, folder: word(given.folder, 'The folder'), prompt: word(given.prompt, 'The task'), title: typeof given.title === 'string' ? given.title : undefined, ...(todo ? { todo } : {}), ...(given.asks === true ? { asks: true } : {}) })
  })
  handle('runners:open', (key) => hub.open(word(key, 'The task')))
  handle('runners:give', async (key, text, item): Promise<{ todoProblem?: string }> => {
    const task = word(key, 'The task')
    const prompt = word(text, 'The message')
    const todo = todoOf(item)
    await hub.giveToTask(task, prompt)
    if (todo && deps.linkGivenTodo) {
      try { await deps.linkGivenTodo(todo, task) }
      catch (error) { return { todoProblem: (error as Error).message } }
    }
    return {}
  })
  handle('runners:take-over', (key) => hub.takeOver(word(key, 'The task')))
  // What the person sends from Chat: words an agent cannot take while it works wait, and go in when its turn ends.
  handle('runners:send', (key, text) => hub.sendOrHold(word(key, 'The task'), typeof text === 'string' ? text : ''))
  // An interrupt: what the agent does is stopped and these words go in as soon as it has stopped (what was queued waits for the end of that turn).
  handle('runners:interrupt', (key, text) => hub.interrupt(word(key, 'The task'), typeof text === 'string' ? text : ''))
  // The model and the effort a task's agent works with now, for its status line.
  handle('runners:model', (key) => hub.model(word(key, 'The task')))
  // What waits in the agent's own queue, given back to change: the words, in the order they were queued.
  handle('runners:take-back', (key) => hub.takeBack(word(key, 'The task')))
  handle('runners:held', (key, action, index) => hub.held(word(key, 'The task'), action === 'send' ? 'send' : action === 'interrupt' ? 'interrupt' : 'drop', typeof index === 'number' && Number.isInteger(index) && index >= 0 ? index : undefined))
  handle('runners:picture', async (key, picture) => {
    const found = await hub.picture(word(key, 'The task'), word(picture, 'The picture').slice(0, 200))
    return found ? `data:${found.type};base64,${found.data}` : null
  })
  handle('runners:answer', (key, requestId, decision) => hub.answer(word(key, 'The task'), word(requestId, 'The request'), decision as 'allow-once' | 'allow-always' | 'refuse'))
  handle('runners:reply', (key, requestId, text) => hub.reply(word(key, 'The task'), word(requestId, 'The request'), typeof text === 'string' ? text : ''))
  handle('runners:hand-back', (key) => hub.handBack(word(key, 'The task')))
  handle('runners:offers', (key) => hub.offers(word(key, 'The task')))
  handle('runners:stop', (key) => hub.stop(word(key, 'The task')))
  handle('runners:end-commands', (key) => hub.endCommands(word(key, 'The task')))
  handle('runners:close', (key) => hub.close(word(key, 'The task')))
  handle('runners:pick-folder', () => deps.pickFolder())
  // A task in a terminal of Togle's own: what it printed, the keys the person types, its size, and its words typed in.
  handle('runners:terminal-read', (key) => hub.terminalRead(word(key, 'The task')))
  handle('runners:terminal-write', (key, data) => {
    if (typeof data !== 'string' || data.length > 65_536) throw new Error('That is not what a terminal is sent.')
    hub.terminalWrite(word(key, 'The task'), data)
  })
  handle('runners:terminal-resize', (key, cols, rows) => {
    const size = (value: unknown): number => (typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 1000 ? value : NaN)
    if (Number.isNaN(size(cols)) || Number.isNaN(size(rows))) throw new Error('That is not a size.')
    hub.terminalResize(word(key, 'The task'), size(cols), size(rows))
  })
  handle('runners:terminal-words', (key) => hub.typeWords(word(key, 'The task')))
  // Settings → Agents → Add an agent, by its name and the command that starts it. A command for ACP is talked to directly;
  // any other runs in a terminal of Togle's own (commandIsAcp says which).
  handle('runners:add-agent', async (name, command) => {
    const problem = addedAgentProblem(name, command)
    if (problem) throw new Error(problem)
    const given = (name as string).trim()
    if (Object.values(KNOWN_AGENTS).some((known) => known.toLowerCase() === given.toLowerCase())) throw new Error(`Togle finds ${given} by itself.`)
    const added = deps.added?.() ?? []
    const base = agentIdOf(given, !commandIsAcp((command as string).trim()))
    let id = base
    for (let n = 2; hub.has(id) || added.some((agent) => agent.id === id); n++) id = `${base}-${n}`
    const agent: AddedAgent = { id, name: given, command: (command as string).trim() }
    await deps.saveAdded?.([...added, agent])
    hub.addBackend(addedBackend(agent, deps.version, told, deps.keepIn))
    return statusOf()
  })
  // An agent that refused a task until the person signs in (Cline, for one): the ways it offered, and Sign in, which the agent does
  // itself in its own page and answers when the person is done there.
  handle('runners:sign-in-choices', (runner) => (typeof runner === 'string' ? hub.signInChoices(runner) : []))
  handle('runners:sign-in', async (runner, method) => {
    if (typeof runner !== 'string' || !hub.has(runner)) throw new Error('Pick an agent.')
    if (typeof method !== 'string' || !method) throw new Error('Pick a way to sign in.')
    await hub.signIn(runner, method)
  })
  // Settings → Agents → Add another agent: the agents on this computer and the ones of the ACP registry, with their commands.
  // Where a program is, remembered for a minute: the list is opened again and again, and each lookup starts a program.
  const lookup = rememberedWhere(deps.catalog?.whereIs ?? whereIs, 60_000)
  handle('runners:agent-catalog', () => agentCatalog({ added: deps.added?.() ?? [], fetchRegistry: deps.catalog?.registry ?? (() => fetchRegistry(deps.catalog?.registryFile)), whereIs: lookup }))
  // Edit, on an agent the person added: its command and nothing else. It keeps its name and its id, so how it runs stays what it
  // was: a command that would run it the other way (as a conversation, or in a terminal) is refused, and the agent is added again.
  // Its tasks that run stop with its program, and stay in the list as stopped, as when it is removed.
  handle('runners:edit-agent', async (id, command) => {
    const added = deps.added?.() ?? []
    const agent = typeof id === 'string' ? added.find((one) => one.id === id) : undefined
    if (!agent) throw new Error('That agent is not on Togle’s lists.')
    const problem = addedAgentProblem(agent.name, command)
    if (problem) throw new Error(problem)
    const line = (command as string).trim()
    if (commandIsAcp(line) === runsInTerminal(agent.id)) {
      throw new Error(commandIsAcp(line) ? `With that command ${agent.name} would be a conversation, not a terminal. Remove it and add it again with that command.` : `With that command ${agent.name} would run in a terminal, not as a conversation. Remove it and add it again with that command.`)
    }
    const edited: AddedAgent = { ...agent, command: line }
    await deps.saveAdded?.(added.map((one) => (one.id === agent.id ? edited : one)))
    await hub.removeBackend(agent.id)
    hub.addBackend(addedBackend(edited, deps.version, told, deps.keepIn))
    return statusOf()
  })
  // Remove: an agent the person added is forgotten. One Togle finds by itself is taken off its lists: it stays installed, its
  // tasks go on in it, and Settings can add it back.
  handle('runners:remove-agent', async (id) => {
    const added = deps.added?.() ?? []
    if (typeof id === 'string' && id in KNOWN_AGENTS) {
      if (!hub.has(id)) throw new Error(`${KNOWN_AGENTS[id]} is not on Togle’s lists.`)
      await deps.saveHidden?.([...hidden().filter((one) => one !== id), id])
      await hub.removeBackend(id)
      return statusOf()
    }
    if (!added.some((agent) => agent.id === id)) throw new Error('That agent is not on Togle’s lists.')
    await deps.saveAdded?.(added.filter((agent) => agent.id !== id))
    await hub.removeBackend(id as string)
    return statusOf()
  })
  handle('runners:restore-agent', async (id) => {
    if (typeof id !== 'string' || !(id in KNOWN_AGENTS)) throw new Error('Togle finds only Claude Code, Codex and Hermes by itself.')
    if (hub.has(id)) return statusOf()
    const backend = deps.backends ? deps.backends.find((one) => one.runner === id) : known(id)
    if (!backend) throw new Error(`${KNOWN_AGENTS[id]} is not set up in this version of Togle.`)
    await deps.saveHidden?.(hidden().filter((one) => one !== id))
    // Its tasks that went on while it was off the lists are Togle's own again.
    hub.addBackend(backend, true)
    return statusOf()
  })
  return hub
}
