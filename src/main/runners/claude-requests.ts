// What Claude Code asks, as Togle shows it, and what Togle answers it with. A task (claude-job.ts) hears each request
// through the hook (claude-hooks.ts).
import type { AgentQuestion, PendingRequest } from '@shared/runner'
import type { HookVerdict } from './claude-hooks'
import { list, rec, text } from './jsonrpc'
import type { Answer } from './task-base'

export const oneLine = (value: string, longest = 90): string => value.replace(/\s+/g, ' ').trim().slice(0, longest)

/** The two answers a plan has as buttons. Words of the person's own go back to Claude Code as what to change. */
export const PLAN_APPROVE = 'Approve the plan'
export const PLAN_REVISE = 'Keep planning'

// What a tool is, for the person reading a request.
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const summary = (tool: string, input: Record<string, unknown>): string => {
  if (typeof input.command === 'string') return input.command
  if (typeof input.url === 'string') return `${tool} ${input.url}`
  if (typeof input.pattern === 'string') return `${tool} ${input.pattern}`
  return oneLine(`${tool} ${JSON.stringify(input)}`, 200)
}

/** Where Claude Code saves a rule, as the words on the button say it. */
const REACH: Record<string, (folder: string) => string> = {
  session: () => 'for the rest of this task',
  localSettings: (folder) => 'in ' + folder,
  projectSettings: (folder) => 'in ' + folder,
  userSettings: () => 'everywhere'
}

/**
 * The rule "always" would keep, when Claude Code suggested one: an allow rule for this tool only, saved where Claude
 * Code says (this task, this project, or everywhere). Anything else it may suggest (a change of permission mode, more
 * folders) is never offered here.
 */
function alwaysRule(tool: string, command: string, folder: string, event: Record<string, unknown>): { rule: Record<string, unknown>; words: string } | undefined {
  for (const suggestion of list(event.permission_suggestions).map(rec)) {
    const rules = list(suggestion.rules).map(rec)
    const reach = REACH[text(suggestion.destination)]
    if (text(suggestion.type) !== 'addRules' || text(suggestion.behavior) !== 'allow' || !reach || !rules.length || !rules.every((rule) => text(rule.toolName) === tool && text(rule.ruleContent))) continue
    const what = rules.length === 1 && text(rules[0].ruleContent) === command ? 'this command' : rules.map((rule) => text(rule.ruleContent)).join(', ')
    const name = folder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder
    return { rule: suggestion, words: 'Always allow ' + what + ' ' + reach(name) }
  }
  return undefined
}

/**
 * A permission request Claude Code posted, as the person is asked it, with the one rule "always" would keep when Claude
 * Code offered one. `fallbackFolder` is the task's folder, for a request that does not say where it is.
 */
export function requestOf(id: string, event: Record<string, unknown>, fallbackFolder: string): { request: PendingRequest; rule?: Record<string, unknown> } {
  const tool = text(event.tool_name)
  const input = rec(event.tool_input)
  const offersAlways = list(event.permission_suggestions).length > 0
  const folder = text(event.cwd) || fallbackFolder
  // A plan to approve (plan mode): shown whole, as a question with two answers and a place for words of the person's own.
  if (tool === 'ExitPlanMode') {
    const plan = text(input.plan).trim()
    return { request: { id, kind: 'question', questions: [{ id: '0', text: plan || 'Claude Code has a plan for you to approve.', options: [PLAN_APPROVE, PLAN_REVISE], free: true, secret: false }], offersAlways: false } }
  }
  if (tool === 'AskUserQuestion') {
    const questions: AgentQuestion[] = list(input.questions).map(rec).map((q, at) => ({
      id: String(at),
      text: text(q.question) || text(q.header),
      options: list(q.options).map((option) => text(rec(option).label)).filter(Boolean),
      free: true,
      secret: false
    }))
    return { request: { id, kind: 'question', questions, offersAlways: false } }
  }
  if (EDITS.has(tool)) {
    const file = text(input.file_path) || text(input.notebook_path)
    return { request: { id, kind: 'edit', folder, files: file ? [file] : [], offersAlways } }
  }
  const command = summary(tool, input)
  const always = alwaysRule(tool, command, folder, event)
  return { request: { id, kind: 'command', command, raw: command, folder, offersAlways, ...(always ? { always: always.words } : {}) }, ...(always ? { rule: always.rule } : {}) }
}

/**
 * What Togle answers Claude Code with, for what the person answered. `refused` is the command that was refused, so the
 * task can tell that what follows is a refusal and not a failure.
 */
export function verdictOf(answer: Answer, request: PendingRequest, rule: Record<string, unknown> | undefined, input: Record<string, unknown>, tool = ''): { verdict: HookVerdict; refused?: string } {
  // A plan: approved, or sent back for Claude Code to change, with what the person said. Claude Code takes a plan as approved
  // only when the answer gives its input back (checked with 2.1.323): a plain "allow" leaves its own question open on the
  // screen. It then goes on in the mode that asks before each edit, as "Yes, manually approve edits" does there.
  if (tool === 'ExitPlanMode' && answer.kind === 'text') {
    if (answer.text === PLAN_APPROVE) return { verdict: { behavior: 'allow', updatedInput: input } }
    return { verdict: { behavior: 'deny', message: answer.text === PLAN_REVISE ? 'The person wants the plan changed: ask what to change, then plan again.' : `The person asked for changes to the plan: ${answer.text}` } }
  }
  if (answer.kind === 'text' && request.kind === 'question') {
    // Every question of the tool gets the words: one at a time is what a person usually asks.
    return { verdict: { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries((request.questions ?? []).map((q) => [q.text, answer.text])) } } }
  }
  // Always: Claude Code saves the very rule it suggested, where it said it would, and asks no more for what it matches.
  if (answer.kind === 'decision' && answer.decision === 'allow-always' && rule) return { verdict: { behavior: 'allow', updatedPermissions: [rule] } }
  if (answer.kind === 'decision' && answer.decision !== 'refuse') return { verdict: { behavior: 'allow' } }
  if (answer.kind === 'cancelled') return { verdict: { behavior: 'deny', message: 'The task was stopped.' } }
  return { verdict: { behavior: 'deny', message: 'The person refused this in Togle.' }, ...(request.command ? { refused: request.command } : {}) }
}
