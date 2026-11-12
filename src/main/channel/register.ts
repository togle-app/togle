// What Togle answers on its local channel, the start of it, and what the window can ask about connecting Claude Code.
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ClaudeHookStatus, RunnerKind, TaskBoxOpen } from '@shared/runner'
import type { RunnerHub } from '../runners/hub'
import { permissionFrom } from './claude-permission'
import { MIN_CLAUDE_VERSION, versionAtLeast, type ClaudeSettings } from './claude-settings'
import { channelAddress, loadSecret } from './paths'
import { ChannelServer } from './server'

/** How a hook of Claude Code is answered: what the person decided, or that nothing was decided. */
export interface PermissionAnswer {
  decision: 'allow' | 'deny' | 'none'
  message?: string
}

/** A question from a Claude Code hook, held until it is answered in Togle or is gone. */
export async function answerPermission(hub: Pick<RunnerHub, 'askOutside'>, body: string, call: { signal: AbortSignal }): Promise<PermissionAnswer> {
  let sent: unknown
  try {
    sent = JSON.parse(body)
  } catch {
    throw new Error('That is not a permission request.')
  }
  const asked = permissionFrom((sent as { payload?: unknown } | null)?.payload)
  const outcome = await hub.askOutside({ runner: 'claude', asked }, call.signal)
  if (outcome === 'allow-once') return { decision: 'allow' }
  if (outcome === 'refuse') return { decision: 'deny', message: 'The person refused it in Togle.' }
  return { decision: 'none' }
}

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
  hub: Pick<RunnerHub, 'askOutside' | 'start' | 'list' | 'status'>
  /** Opens the task box with what it is given. */
  openBox: (opening: TaskBoxOpen) => void
}

/** Opens the channel. It throws when it cannot (another Togle is listening, or the secret cannot be kept). */
export async function startChannel(deps: ChannelDeps): Promise<ChannelServer> {
  const server = new ChannelServer({
    secret: await loadSecret(deps.dataFolder),
    address: channelAddress(deps.dataFolder),
    handlers: {
      'claude-permission': (body, call) => answerPermission(deps.hub, body, call),
      run: (body) => startTask(deps.hub, body),
      box: (body) => openBox(deps.hub, body, deps.openBox),
      tasks: () => listTasks(deps.hub)
    }
  })
  await server.listen()
  return server
}

export interface ConnectionDeps {
  /** `ipcMain.handle`, without the event the window's message came with. */
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
  settings: Pick<ClaudeSettings, 'status' | 'connect' | 'disconnect' | 'file'>
  /** Claude Code as this computer has it: its version, or null when it is not installed. */
  claude(): Promise<{ installed: boolean; version?: string }>
}

/** What the window can ask about Claude Code in a terminal asking Togle. */
export function registerConnection(deps: ConnectionDeps): void {
  const status = async (): Promise<ClaudeHookStatus> => {
    const [claude, connection] = await Promise.all([deps.claude(), deps.settings.status()])
    return {
      claude: claude.installed,
      ...(claude.version ? { version: claude.version } : {}),
      supported: versionAtLeast(claude.version),
      minimum: MIN_CLAUDE_VERSION,
      installed: connection.installed,
      current: connection.current,
      file: connection.file,
      ...(connection.problem ? { problem: connection.problem } : {})
    }
  }
  deps.handle('claude-hook:status', status)
  deps.handle('claude-hook:connect', async () => {
    const before = await status()
    if (!before.claude) throw new Error('Claude Code is not installed on this computer.')
    if (!before.supported) throw new Error(`This Claude Code (${before.version ?? 'unknown version'}) is older than ${MIN_CLAUDE_VERSION}. Update it, and Togle can connect.`)
    await deps.settings.connect()
    return status()
  })
  deps.handle('claude-hook:disconnect', async () => {
    await deps.settings.disconnect()
    return status()
  })
}
