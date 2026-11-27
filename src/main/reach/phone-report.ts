import path from 'node:path'
import { createHash } from 'node:crypto'
import { modelLine } from '@shared/model-words'
import type { PhoneActivity, PhoneQuery, PhoneQueue, PhoneReport, PhoneUsage } from '@shared/phone-report'
import { stepsLine, type LogEntry, type ModelInfo, type TaskDetail, type TaskHistory, type TaskView } from '@shared/runner'
import { formatAgentMoney, type CostReading, type RunnerUsage, type UsageWindow } from '@shared/runner-usage'
import { hideSecrets } from './share'

export interface PhoneReportSources {
  detail(key: string): Promise<TaskDetail>
  history(key: string): Promise<TaskHistory | null>
  model(key: string): Promise<ModelInfo | null>
  usage(runner: string, sessionId?: string): Promise<RunnerUsage>
  limits(runner: string): UsageWindow[]
  queue?(key: string): PhoneQueue | undefined
}

/** A queue action from the phone applies only to the list it actually saw. */
export function queueRevision(messages: string[]): string {
  return createHash('sha256').update(JSON.stringify(messages)).digest('base64url')
}

const tokens = new Intl.NumberFormat()
const text = (value: string, max: number) => hideSecrets(value.trim()).slice(0, max)

function cost(reading: CostReading) {
  if (!reading.amounts.length) return ''
  const label = reading.scope === 'agent-sessions' ? 'reported cost' : 'API cost'
  return (reading.estimated ? '≈ ' : '') + reading.amounts.map(formatAgentMoney).join(' + ') +
    ' ' + label + (reading.partial ? ' · partial' : '')
}

function readings(value: RunnerUsage): string[] {
  if (value.kind === 'providers') {
    return value.sources.slice(0, 20).map(source => {
      const provider = source.provider + (source.billing === 'subscription' ? ' subscription' : source.billing === 'api' ? ' API' : '')
      const amount = source.cost
        ? (source.estimated ? '≈ ' : '') + formatAgentMoney(source.cost)
        : tokens.format(source.tokens) + ' tokens'
      return provider + ' · ' + amount
    })
  }
  if (value.kind === 'tokens') {
    const scope = value.period === '7d' ? 'Last 7 days' : value.period === 'all' ? 'All time' : ''
    const total = [tokens.format(value.total) + ' tokens', scope].filter(Boolean).join(' · ')
    if (value.period === 'all' && value.apiEstimate) {
      return [total, '≈ ' + formatAgentMoney(value.apiEstimate) + (value.partial ? ' partial API estimate' : ' estimated API cost')]
    }
    return value.period !== 'all' && value.trackedApi ? [total, cost(value.trackedApi)] : [total]
  }
  return value.kind === 'cost' ? [cost(value)] : []
}

async function usage(source: PhoneReportSources, runner: string, accountUsage: boolean, sessionId?: string): Promise<PhoneUsage> {
  const value = await source.usage(runner, sessionId).catch((): RunnerUsage => ({ kind: 'unavailable', reason: 'temporary' }))
  const scoped = value.kind === 'cost' ? value.scope === 'session'
    : (value.kind === 'tokens' || value.kind === 'providers') && value.period === 'session'
  if (!accountUsage && (!sessionId || !scoped)) return { readings: [], limits: [] }
  const visible = !accountUsage && value.kind === 'tokens' && value.period === 'session' && value.trackedApi?.scope !== 'session'
    ? { ...value, trackedApi: undefined } : value
  const limits = (accountUsage ? source.limits(runner) : [])
    .filter(window => Number.isFinite(window.usedPercent) && window.usedPercent >= 0)
    .slice(0, 12)
    .map(window => ({
      label: text([window.provider, window.label].filter(Boolean).join(' '), 80) || 'Account limit',
      usedPercent: window.usedPercent,
      ...(typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0 ? { resetsAt: window.resetsAt } : {}),
    }))
  return { readings: readings(visible).map(line => text(line, 180)).filter(Boolean), limits }
}

/** Keep recent messages and work summaries together without forwarding commands or file contents. */
function activity(log: LogEntry[], chat: boolean): PhoneActivity[] {
  const result: PhoneActivity[] = []
  const max = chat ? 6_000 : 800
  const add = (kind: PhoneActivity['kind'], raw: string, from: LogEntry) => {
    const words = hideSecrets(raw.trim())
    if (!words) return
    const message = words.length > max ? words.slice(0, max - 1) + '…' : words
    result.push({ kind, text: message,
      ...(chat && Number.isSafeInteger(from.id) ? { id: from.id } : {}),
      ...(chat && from.at > 0 && from.at < 8.64e15 ? { at: from.at } : {}),
      ...(chat && kind === 'you' ? {
        delivery: from.delivery ?? 'delivered',
        ...(from.replyTo ? { replyTo: from.replyTo } : {})
      } : {})
    })
  }
  let work: LogEntry[] = []
  const finishWork = () => {
    const summary = stepsLine(work)
    if (summary) add('work', summary, work[0])
    work = []
  }
  for (const entry of log) {
    if (entry.kind === 'you' || entry.kind === 'agent') {
      finishWork()
      add(entry.kind, entry.text, entry)
    } else work.push(entry)
  }
  finishWork()
  const shown: PhoneActivity[] = []
  let bytes = 0
  for (const entry of result.slice(-24).reverse()) {
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1
    // Allow room for usage and the relay's encrypted envelope and encoding.
    if (bytes > 115 * 1024) break
    shown.push(entry)
  }
  return shown.reverse()
}

export async function phoneReport(source: PhoneReportSources, tasks: TaskView[], query: PhoneQuery, includeQueue = false, accountUsage = false): Promise<PhoneReport | undefined> {
  if (query.kind === 'usage') {
    if (!accountUsage) return { kind: 'usage', agents: [] }
    const active = new Map(tasks.map(task => [task.runner, task.agent || task.runner]))
    const agents = await Promise.all([...active.entries()].slice(0, 20).map(async ([runner, name]) => ({
      runner: text(runner, 80),
      name: text(name, 80),
      usage: await usage(source, runner, true),
    })))
    const shown: typeof agents = []
    let bytes = 0
    for (const agent of agents) {
      if (!agent.runner || !agent.name) continue
      bytes += Buffer.byteLength(JSON.stringify(agent)) + 1
      if (bytes > 160 * 1024) break
      shown.push(agent)
    }
    return { kind: 'usage', agents: shown }
  }
  const task = tasks.find(item => item.key === query.task)
  if (!task) return
  const detail = await source.detail(task.key)
  if (!detail.task.mine || detail.task.key !== task.key || path.resolve(detail.task.folder) !== path.resolve(task.folder)) return
  // Hermes keeps its replies in its session history. Togle's live log can contain just the messages it sent.
  const history = task.runner === 'hermes' || !detail.log.length ? await source.history(task.key).catch(() => null) : null
  const log = history?.entries.length ? history.entries : detail.log
  const [measured, model] = await Promise.all([
    usage(source, task.runner, accountUsage, detail.task.sessionId ?? detail.task.id),
    source.model(task.key).catch(() => null),
  ])
  const name = text(modelLine(model), 140)
  const queue = includeQueue && query.view === 'chat' ? source.queue?.(task.key) : undefined
  return { kind: 'session', task: task.key, activity: activity(log, query.view === 'chat'), usage: measured, ...(name ? { model: name } : {}),
    ...(queue ? { queue: { revision: queue.revision, canSend: queue.canSend,
      messages: queue.messages.slice(0, 20).map(message => {
        const words = hideSecrets(message.trim())
        return words.length > 320 ? words.slice(0, 319) + '…' : words
      }),
      ...(queue.note ? { note: text(queue.note, 220) } : {}) } } : {}) }
}
