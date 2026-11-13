// What Togle answers on its local channel (the `togle` command), and the start of it.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { RunnerKind, TaskBoxOpen } from '@shared/runner'
import type { RunnerHub } from '../runners/hub'
import { channelAddress, loadSecret } from './paths'
import { ChannelServer } from './server'

const RUNNERS = ['claude', 'codex', 'hermes']

/** A task asked for by the `togle` command: started in the folder it names, asking before every command. */
export async function startTask(hub: Pick<RunnerHub, 'start'> & Partial<Pick<RunnerHub, 'has'>>, body: string): Promise<{ key: string; title: string; runner: string; folder: string }> {
  let given: Record<string, unknown>
  try {
    given = (JSON.parse(body) ?? {}) as Record<string, unknown>
  } catch {
    throw new Error('That is not a task.')
  }
  const { runner, folder, prompt, title } = given
  // Claude Code, Codex, Hermes, or an agent added in Settings (its id starts with acp-).
  if (typeof runner !== 'string' || !(hub.has ? hub.has(runner) : RUNNERS.includes(runner))) throw new Error('Pick an agent: claude, codex, hermes, or one added in Settings.')
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Name the folder in full.')
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Say what the task is.')
  if (prompt.length > 20_000) throw new Error('That task is too long. Put it in a file and say where it is.')
  const view = await hub.start({ runner: runner as RunnerKind, folder, prompt, ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 120) } : {}) })
  return { key: view.key, title: view.title, runner: view.runner, folder: view.folder }
}

/**
 * `togle run claude` with no task: the task box opens with that agent and folder picked, for the person to type or say
 * the task. Both are checked here, so the terminal says what is wrong instead of the box picking something else.
 */
export async function openBox(hub: Pick<RunnerHub, 'status'>, body: string, open: (opening: TaskBoxOpen) => void): Promise<{ runner: string; name: string; folder: string }> {
  let given: Record<string, unknown>
  try {
    given = (JSON.parse(body) ?? {}) as Record<string, unknown>
  } catch {
    throw new Error('That is not a task.')
  }
  const { runner, folder } = given
  const agent = typeof runner === 'string' ? (await hub.status()).find((status) => status.runner === runner) : undefined
  if (!agent) throw new Error('Pick an agent: claude, codex, hermes, or one added in Settings.')
  if (!agent.installed) throw new Error(`${agent.name} is not installed on this computer.`)
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Name the folder in full.')
  if (!(await fs.stat(folder).catch(() => null))?.isDirectory()) throw new Error('That folder is not there.')
  open({ runner: agent.runner, folder })
  return { runner: agent.runner, name: agent.name, folder }
}

/** The tasks Togle can see, waiting ones first, for the `togle` command to list. */
export async function listTasks(hub: Pick<RunnerHub, 'list'>): Promise<{ key: string; title: string; runner: string; folder: string; state: string; line: string }[]> {
  return (await hub.list()).slice(0, 60).map((task) => ({ key: task.key, title: task.title, runner: task.runner, folder: task.folder, state: task.state, line: task.line }))
}

export interface ChannelDeps {
  /** Togle's data folder: the secret is kept in it, and the channel's name comes from it. */
  dataFolder: string
  hub: Pick<RunnerHub, 'start' | 'list' | 'status'>
  /** Opens the task box with what it is given. */
  openBox: (opening: TaskBoxOpen) => void
}

/** Opens the channel. It throws when it cannot (another Togle is listening, or the secret cannot be kept). */
export async function startChannel(deps: ChannelDeps): Promise<ChannelServer> {
  const server = new ChannelServer({
    secret: await loadSecret(deps.dataFolder),
    address: channelAddress(deps.dataFolder),
    handlers: {
      run: (body) => startTask(deps.hub, body),
      box: (body) => openBox(deps.hub, body, deps.openBox),
      tasks: () => listTasks(deps.hub)
    }
  })
  await server.listen()
  return server
}
