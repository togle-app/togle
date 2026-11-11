// What Togle answers on its local channel, the start of it, and what the window can ask about connecting Claude Code.
import type { ClaudeHookStatus } from '@shared/runner'
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

export interface ChannelDeps {
  /** Togle's data folder: the secret is kept in it, and the channel's name comes from it. */
  dataFolder: string
  hub: Pick<RunnerHub, 'askOutside'>
}

/** Opens the channel. It throws when it cannot (another Togle is listening, or the secret cannot be kept). */
export async function startChannel(deps: ChannelDeps): Promise<ChannelServer> {
  const server = new ChannelServer({
    secret: await loadSecret(deps.dataFolder),
    address: channelAddress(deps.dataFolder),
    handlers: { 'claude-permission': (body, call) => answerPermission(deps.hub, body, call) }
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
