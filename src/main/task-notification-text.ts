import { stripVTControlCharacters } from 'node:util'
import type { Tokens } from 'marked'
import { richDocument, richPreview } from '@shared/rich-text'
import type { LogEntry, TaskNotice } from '@shared/runner'
import { withoutSecrets } from './runners/claude-sessions'

const sentences = new Intl.Segmenter(undefined, { granularity: 'sentence' })
const filler = /^(?:done|finished|completed|all done|ran it|here you go|here(?:’s|'s| is) (?:the |my )?(?:summary|result|update)|summary|results?|changes)[.!:\s]*$/i
const needsAttention = /^(?:(?:but|however)[, ]+)?(?:(?:I|we) (?:still )?(?:could(?:n['’]t| not)|can(?:['’]t|not)|(?:was|were) unable to)|blocked (?:on|by)|permission denied|action required|please (?:approve|confirm|choose|sign in))\b/i
const BODY_LENGTH = 180

function clean(text: string): string {
  return withoutSecrets(stripVTControlCharacters(text.slice(0, 8192)))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
}

function fit(text: string, size: number): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  if (chars.length <= size) return chars.join('')
  const start = chars.slice(0, size - 1).join('')
  const gap = start.lastIndexOf(' ')
  return (gap > start.length * 0.7 ? start.slice(0, gap) : start).trimEnd() + '…'
}

/** Read the agent's own result. A reported blocker belongs in the first visible line of a collapsed banner. */
export function resultExcerpt(raw: string): string {
  const document = richDocument(clean(raw))
  const prose: string[] = []
  let heading = ''
  for (const block of document.blocks) {
    if (prose.length >= 8) break
    if (block.type === 'heading' && !heading) heading = richPreview(block.raw)
    if (block.type === 'paragraph') prose.push(richPreview(block.raw))
    if (block.type === 'list') prose.push(...(block as Tokens.List).items.slice(0, 8 - prose.length).map(item => richPreview(item.text)))
  }
  const lines = prose.flatMap(paragraph => Array.from(sentences.segment(paragraph), part => part.segment.trim()))
    .filter(line => line && !filler.test(line))
  const lead = lines.find(line => needsAttention.test(line)) ?? lines[0]
  if (lead) {
    const next = lines.find(line => line !== lead)
    return fit(next ? lead + ' ' + next : lead, BODY_LENGTH)
  }
  const table = document.blocks.find(block => block.type === 'table') as Tokens.Table | undefined
  const row = table?.rows[0]?.map(cell => richPreview(cell.text)).filter(Boolean)
  if (row?.length) return fit(row.join(' · '), BODY_LENGTH)
  if (heading && !filler.test(heading)) return fit(heading, BODY_LENGTH)
  return document.blocks.some(block => block.type === 'code') ? 'The reply includes a code block.' : ''
}

const privateRequest: Record<TaskNotice['detailKind'], string> = {
  command: 'A command needs approval.', files: 'A file change needs approval.',
  question: 'A question needs an answer.', words: 'Open the task to continue.'
}

const basename = (value: string): string => value.trim().split(/[\\/]/).filter(Boolean).pop() ?? ''

/** Show a recognizable command without exposing shell arguments, environment assignments or script bodies. */
function commandName(command: string): string {
  const match = /^(?:"([^"]+)"|'([^']+)'|([^\s"'|;&]+))(?:\s+([\w:-]+))?(?:\s+([\w:-]+))?/.exec(command.trim())
  if (!match) return ''
  const tool = basename(match[1] ?? match[2] ?? match[3]).replace(/\.(?:exe|cmd|bat)$/i, '')
  if (!/^[\w.+-]+$/.test(tool)) return ''
  const subcommand = match[4]
  if (!subcommand || subcommand.startsWith('-') || !/^(?:git|npm|pnpm|yarn|cargo|dotnet|go|gh|docker)$/i.test(tool)) return tool
  return [tool, subcommand, subcommand === 'run' ? match[5] : ''].filter(Boolean).join(' ')
}

/** Use observed work when the agent sent a bare acknowledgement or no written answer. */
export function actionResult(turn: readonly LogEntry[]): string {
  const paths = [...new Set(turn.filter(entry => entry.kind === 'files').flatMap(entry => entry.paths ?? []))]
  const files = paths.slice(0, 2).map(file => basename(clean(file))).filter(Boolean)
  const changed = files.length ? 'Changed ' + files.join(', ') + (paths.length > 2 ? ` and ${paths.length - 2} more` : '') + '.' : ''
  const command = turn.findLast(entry => entry.kind === 'command' && entry.status === 'failed') ?? turn.findLast(entry => entry.kind === 'command')
  const name = command && commandName(clean(command.text))
  const byStatus = { failed: `${name} failed.`, declined: `${name} was declined.`, running: `${name} is still running.`, stopped: `${name} stopped.`, finished: `Ran ${name}.` }
  const ran = name && command ? byStatus[command.status ?? 'finished'] : ''
  return fit((command?.status === 'failed' ? [ran, changed] : [changed, ran]).filter(Boolean).join(' '), BODY_LENGTH)
}

function requestText(item: TaskNotice): string {
  if (item.detailKind === 'question') return fit(richPreview(clean(item.detail)), BODY_LENGTH) || privateRequest.question
  if (item.detailKind === 'files') {
    const files = item.detail.split('\n').map(file => basename(clean(file))).filter(Boolean)
    return files.length ? fit('Review changes to ' + files.join(', '), BODY_LENGTH) : privateRequest.files
  }
  if (item.detailKind === 'command') {
    const command = commandName(clean(item.detail))
    const why = item.danger || item.reason
    return fit([command ? 'Approve running ' + command + '?' : privateRequest.command, why && clean(why)].filter(Boolean).join(' '), BODY_LENGTH)
  }
  return fit(clean(item.detail), BODY_LENGTH) || privateRequest.words
}

function identity(item: TaskNotice, status = ''): string {
  const agent = fit(clean(item.agent), 24)
  const task = fit(clean(item.title), 56)
  return [(agent || 'Agent') + status, task && task !== agent ? task : ''].filter(Boolean).join(' · ')
}

function resultText(item: TaskNotice, previews: boolean): string {
  const counts = item.activity?.replace(/^\d+ steps?: /, '')
  const activity = counts ? counts[0].toUpperCase() + counts.slice(1) : ''
  if (previews && item.result) {
    const result = fit(clean(item.result), BODY_LENGTH)
    return activity && /^\d+ steps:/.test(item.activity ?? '') && result.length + activity.length + 1 <= BODY_LENGTH ? result + '\n' + activity : result
  }
  if (item.kind === 'failed') return item.says === 'is signed out' ? 'Sign in to the agent to continue.' : 'Open the task to review the error.'
  return activity || (previews ? 'The turn ended without a result summary.' : 'Open the task to read the result.')
}

/** The short lines Windows shows even when notification actions are collapsed. */
export function taskNotificationText(items: readonly TaskNotice[], previews: boolean): { title: string; body: string } {
  const first = items[0]
  if (items.length === 1) {
    if (first.kind === 'waiting') return {
      title: previews ? identity(first, ' needs input') : 'An agent needs your input',
      body: previews ? requestText(first) : privateRequest[first.detailKind]
    }
    return {
      title: previews ? identity(first, first.kind === 'failed' ? ' stopped' : '') : first.kind === 'failed' ? 'An agent task stopped with an error' : 'An agent task finished',
      body: resultText(first, previews)
    }
  }
  const failed = items.filter(item => item.kind === 'failed')
  const title = failed.length ? `${items.length} task results · ${failed.length} failed` : `${items.length} tasks finished`
  const visible = [...failed, ...items.filter(item => item.kind !== 'failed')].slice(0, 2)
  const body = visible.map(item => previews ? fit(identity(item) + ' — ' + resultText(item, true), 110) : resultText(item, false))
  if (items.length > visible.length) body.push(`+${items.length - visible.length} more`)
  return { title, body: [...new Set(body)].join('\n') }
}
