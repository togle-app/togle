import type { McpServerStatus, PreToolUseHookInput, Query } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeConnectionSelection } from '@shared/types'

export const connectionLabel = (name: string): string => name.replace(/^claude\.ai\s+/, '')
export const connectionToolName = (server: string, tool: string): string => `mcp__${server.replace(/[^a-zA-Z0-9_-]/g, '_')}__${tool}`
export const isClaudeConnection = (server: McpServerStatus): boolean => server.source === 'claudeai' && server.config?.type === 'claudeai-proxy'
export const readTools = (server: McpServerStatus): string[] => server.status === 'connected' && isClaudeConnection(server)
  ? (server.tools ?? []).filter(tool => tool.annotations?.readOnly === true && tool.annotations.destructive !== true).map(tool => connectionToolName(server.name, tool.name))
  : []

/** No wildcard server grants, credentials, or account changes through imported agent data. */
export function connectionSelection(value: unknown): ClaudeConnectionSelection | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { account, servers } = value as Partial<ClaudeConnectionSelection>
  if (typeof account !== 'string' || !account.trim() || account.length > 254 || !Array.isArray(servers)) return undefined
  const names = [...new Set(servers.filter((name): name is string => typeof name === 'string' && /^claude\.ai [^\r\n*?]{1,180}$/.test(name)))].slice(0, 30)
  return names.length ? { account: account.trim().toLowerCase(), servers: names } : undefined
}

/** The actual server's provenance matters: a local server can impersonate a cloud connector's name. */
export function mayReadConnection(event: PreToolUseHookInput, servers: McpServerStatus[]): boolean {
  return event.mcp_server?.source === 'claudeai' && servers.some(server =>
    server.name === event.mcp_server?.name && readTools(server).includes(event.tool_name))
}

/** MCP discovery is asynchronous. Hold the first prompt until selected apps finish connecting. */
export async function waitForConnections(query: Query, signal: AbortSignal, selected?: string[]): Promise<McpServerStatus[]> {
  const until = Date.now() + 8_000
  while (true) {
    signal.throwIfAborted()
    const all = await query.mcpServerStatus()
    const servers = all.filter(server => isClaudeConnection(server) && (!selected || selected.includes(server.name)))
    const ready = selected ? selected.every(name => servers.some(server => server.name === name && server.status !== 'pending'))
      : servers.length > 0 && servers.every(server => server.status !== 'pending')
    if (ready || Date.now() >= until) return servers
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 200)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
