// What Claude Code tells a PermissionRequest hook when it is about to ask the person about a tool, as Togle shows it, and
// what the hook answers with. Pure text in and out: the hook program loads it, so it must stay light.

/** A request Claude Code is about to ask about, as Togle holds it. */
export interface AskedPermission {
  sessionId: string
  /** The folder the session works in. */
  folder: string
  tool: string
  kind: 'command' | 'edit'
  /** What a command is, or for a tool that is not a shell, the tool and what it was given. */
  command?: string
  raw?: string
  files?: string[]
  /** Why, in the agent's words, when it gave a reason. */
  reason?: string
  /** The session's transcript, which grows once the question has been answered wherever it was answered. */
  transcript?: string
}

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELLS = new Set(['Bash', 'PowerShell', 'Shell'])
/** No more than this of any one text is kept: a request is shown in part anyway. */
const KEPT = 20_000

/** Text with no control characters but line breaks and tabs, and no more than `longest` of it. */
function text(value: unknown, longest = KEPT): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, longest) : ''
}

const record = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** Reads what Claude Code sent a PermissionRequest hook. It throws for what is not one. */
export function permissionFrom(payload: unknown): AskedPermission {
  const given = record(payload)
  const sessionId = text(given.session_id, 200)
  const tool = text(given.tool_name, 200)
  if (!sessionId || !/^[\w.:-]+$/.test(sessionId) || !tool) throw new Error('That is not a permission request.')
  const input = record(given.tool_input)
  const common = { sessionId, tool, folder: text(given.cwd, 1000), ...(text(given.transcript_path, 1000) ? { transcript: text(given.transcript_path, 1000) } : {}) }
  const reason = text(input.description, 500)
  if (EDITS.has(tool)) {
    const file = text(input.file_path, 1000) || text(input.notebook_path, 1000)
    return { ...common, kind: 'edit', files: file ? [file] : [] }
  }
  if (SHELLS.has(tool) && typeof input.command === 'string') {
    const command = text(input.command)
    return { ...common, kind: 'command', command, raw: command, ...(reason ? { reason } : {}) }
  }
  // Any other tool: the person reads its name and what it was given, as it would be written.
  let what = ''
  try {
    what = JSON.stringify(input) ?? ''
  } catch {
    what = ''
  }
  const raw = text(`${tool} ${what}`)
  return { ...common, kind: 'command', command: raw, raw, reason: reason || `The ${tool} tool` }
}

/** What the hook prints so that Claude Code takes the answer. Nothing printed leaves the question to the person. */
export function hookOutput(answer: { decision?: unknown; message?: unknown }): string | null {
  if (answer.decision === 'allow') return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  if (answer.decision === 'deny') {
    const message = typeof answer.message === 'string' && answer.message ? answer.message.slice(0, 500) : 'The person refused it in Togle.'
    return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message, interrupt: false } } })
  }
  return null
}
