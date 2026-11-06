import type { Tool } from './types'

// A lookup (knowledge search, reading code) that takes longer than this is given up on.
const TOOL_TIMEOUT_MS = 20_000

/** What a tool the model called gave back: its result, or why there is none (`failed`). */
export interface ToolResult {
  text: string
  failed?: boolean
}

/**
 * Runs a tool the model called, by its name. What it returns, its error, an unknown name or a lookup that took too
 * long all come back as text for the model.
 */
export async function runTool(tools: Tool[], name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name)
  if (!tool) return { text: `Unknown tool ${name}`, failed: true }
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => resolve({ text: 'Error: the lookup took too long.', failed: true }), tool.timeoutMs ?? TOOL_TIMEOUT_MS)
  })
  const run = tool.run(args).then(
    (text): ToolResult => ({ text }),
    (err: Error): ToolResult => ({ text: `Error: ${err.message}`, failed: true })
  )
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer))
}
