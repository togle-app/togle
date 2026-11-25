// What a computer tells the person's other devices about its tasks: the least they need. A task's title, agent, folder
// name, state and one line, and each request with the command whole (the command is always sent whole: it is what runs).
// Text that looks like a key or a password is hidden in the rest. Long output and the conversation stay on the computer.
import path from 'node:path'
import type { PendingRequest, TaskView } from '@shared/runner'
import type { RemoteTask } from '@shared/reach'

const HIDDEN = '••••'

// Shapes of secrets: keys with a known prefix, tokens in the open, private key blocks, and values after words like
// password, secret, token or key.
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(sk|pk|rk)[-_](live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abprs]|hf|npm|pypi|sk_live|rk_live|AIza)[-_A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(pass(word)?|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret)(\s*[:=]\s*|\s+)("[^"\s]{4,}"|'[^'\s]{4,}'|[^\s"',;]{4,})/gi,
  /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/g
]

/** The text with whatever looks like a key or a password hidden. */
export function hideSecrets(text: string): string {
  let shown = text
  for (const pattern of SECRETS) {
    shown = shown.replace(pattern, (match, ...groups: unknown[]) => {
      // For "password: value" keep the word and hide the value; for a URL with a password, keep the scheme and the user.
      if (/^(pass|passwd|pwd|secret|token|api|access|private|client)/i.test(match)) {
        const word = String(groups[0] ?? '')
        const between = match.slice(word.length).match(/^(\s*[:=]\s*|\s+)/)?.[0] ?? ' '
        return `${match.slice(0, word.length)}${between}${HIDDEN}`
      }
      if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(match)) return match.replace(/:[^:@/]+@$/, `:${HIDDEN}@`)
      return HIDDEN
    })
  }
  return shown
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** Only offer choices whose complete labels and question can be displayed as issued. */
export function phoneChoices(request: PendingRequest): string[] | undefined {
  if (!request.codexInputId || request.kind !== 'question' || request.questions?.length !== 1) return
  const [question] = request.questions
  if (question.secret || !question.id || !question.text.trim() || question.text.length > 1000 || hideSecrets(question.text) !== question.text) return
  const options = question.options
  if (!options.length || options.length > 10 || options.some(label => !label.trim() || label.length > 200 || hideSecrets(label) !== label)) return
  return options
}

/** A task as another device sees it. */
export function shareTask(task: TaskView, forPilotPhone = false): RemoteTask {
  const canReply = forPilotPhone && task.runner === 'codex' && task.mine && (!task.terminal || task.screen)
  return {
    key: task.key,
    title: clip(hideSecrets(task.title || 'A task'), 160),
    agent: task.agent ?? task.runner,
    folder: path.basename(task.folder.replace(/[\\/]+$/, '')) || task.folder,
    state: task.state,
    line: clip(hideSecrets(task.line), 240),
    pending: task.pending.map((request) => {
      const choices = canReply ? phoneChoices(request) : undefined
      return {
        id: choices ? request.codexInputId! : request.id,
        kind: request.kind,
        ...(request.command !== undefined ? { command: request.command } : {}),
        ...(request.files?.length ? { files: request.files.slice(0, 20).map((file) => path.basename(file)) } : {}),
        ...(request.questions?.length ? { question: clip(hideSecrets(request.questions.map((question) => question.text).join('\n')), 1000) } : {}),
        ...(choices ? { choices } : {}),
        ...(request.danger ? { danger: request.danger } : {})
      }
    }),
    mine: task.mine,
    // A task in the background (Claude Code) is refused and stopped from here like any other, whether its screen is open on
    // that computer or not: the mark is for a terminal Togle only watches.
    ...(task.terminal && !task.screen ? { terminal: true } : {}),
    commandsRunning: task.commandsRunning,
    updatedAt: task.updatedAt
  }
}

/** The tasks a device shares: those of the last week, newest first, at most 40. */
export function shareTasks(tasks: TaskView[], now = Date.now(), forPilotPhone = false): RemoteTask[] {
  return tasks
    .filter((task) => task.state === 'waiting' || task.state === 'working' || now - task.updatedAt < 7 * 86_400_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 40)
    .map(task => shareTask(task, forPilotPhone))
}
