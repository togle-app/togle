import fs from 'node:fs/promises'
import { limitName } from '@shared/plan'
import type { AgentMoney, CostScope, RunnerUsage, UsageWindow } from '@shared/runner-usage'
import { list, rec } from './jsonrpc'
import { keepJson } from './keep'

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
const currencyCode = (v: unknown): v is string => typeof v === 'string' && /^[A-Z]{3}$/.test(v)

function windowOf(label: string, percent: unknown, reset: unknown): UsageWindow[] {
  if (!label || !finite(percent) || percent > 100) return []
  const numeric = typeof reset === 'string' && /^\d+(?:\.\d+)?$/.test(reset) ? Number(reset) : reset
  const at = finite(numeric) ? (numeric < 1e11 ? numeric * 1000 : numeric) : typeof reset === 'string' ? Date.parse(reset) : NaN
  return [{ label, usedPercent: percent, ...(at > 0 && at < 8.64e15 ? { resetsAt: at } : {}) }]
}

export function codexPlan(reply: unknown): UsageWindow[] {
  const body = rec(reply)
  const limits = rec(rec(body.rateLimitsByLimitId).codex ?? body.rateLimits)
  return [limits.primary, limits.secondary].map(rec).flatMap(w => finite(w.windowDurationMins) && w.windowDurationMins > 0 && w.windowDurationMins !== 300
    ? windowOf(limitName(w.windowDurationMins), w.usedPercent, w.resetsAt) : [])
}

export function claudePlan(reply: unknown): UsageWindow[] {
  const week = rec(rec(rec(reply).rate_limits).seven_day)
  return windowOf('weekly', week.utilization, week.resets_at)
}

export function hermesPlan(reply: unknown): UsageWindow[] {
  return list(rec(reply).windows).map(rec).flatMap(w => {
    const name = typeof w.label === 'string' ? w.label.trim().slice(0, 64) : ''
    if (/^(?:(?:5|five)[ _-]?(?:h|hours?)|300[ -]?minutes?|(?:current )?session)$/i.test(name)) return []
    const label = /^(?:(?:current )?week(?:ly)?|7[ -]?days?)$/i.test(name) ? 'weekly' : name
    return windowOf(label, w.used_percent, w.resets_at)
  })
}

/** Hermes reports costs and canonical token counters for the session itself. */
export function hermesSessionUsage(value: unknown, id: string): RunnerUsage {
  const row = rec(value)
  if (row.id !== id) return { kind: 'unavailable', reason: 'unsupported' }
  if (row.cost_status !== 'included') {
    const actual = row.actual_cost_usd
    const estimated = row.estimated_cost_usd
    if (finite(actual) || (row.cost_status === 'estimated' && finite(estimated))) {
      return { kind: 'cost', scope: 'session', amounts: [{ amount: finite(actual) ? actual : Number(estimated), currency: 'USD' }], estimated: !finite(actual) }
    }
  }
  const fields = [row.input_tokens, row.output_tokens, row.cache_read_tokens, row.cache_write_tokens]
  if (fields.some(finite)) return { kind: 'tokens', period: 'session', total: fields.reduce<number>((sum, n) => sum + (finite(n) ? n : 0), 0) }
  return { kind: 'unavailable', reason: 'unsupported' }
}

/** Only the agent's own Insights report supplies an aggregate. Subscription sessions have no API charge. */
export function hermesHistoryUsage(report: string): RunnerUsage {
  const value = /^\s*Estimated:\s*~?\$([\d,.]+)\s*$/im.exec(report)
  const amount = value ? Number(value[1].replaceAll(',', '')) : NaN
  const tokens = /^\s*Total tokens:\s*([\d,]+)\s*$/im.exec(report)
  const partial = /^\s*Unknown:\s*[1-9]/im.test(report)
  if (tokens && /^\s*Included:\s*[1-9]/im.test(report)) return { kind: 'tokens', period: 'all',
    total: Number(tokens[1].replaceAll(',', '')), ...(finite(amount) && amount > 0 ? { apiEstimate: { amount, currency: 'USD' }, partial } : {}) }
  if (finite(amount) && (amount > 0 || !tokens)) return { kind: 'cost', scope: 'hermes-history', estimated: true,
    amounts: [{ amount, currency: 'USD' }], partial }
  if (tokens) return { kind: 'tokens', period: 'all', total: Number(tokens[1].replaceAll(',', '')) }
  return { kind: 'unavailable', reason: 'unsupported' }
}

export interface ReportedCost extends AgentMoney { estimated?: boolean; partial?: boolean }

export function codexThreadTokens(reply: unknown, id: string): RunnerUsage {
  const row = rec(rec(reply).threadUsage)
  const groups = list(row.groups).map(group => rec(group).totalTokens)
  if (row.threadId === id && groups.length && groups.every(finite)) {
    return { kind: 'tokens', period: 'session', total: groups.reduce((sum, n) => sum + n, 0) }
  }
  return { kind: 'unavailable', reason: 'unsupported' }
}

export function codexThreadCost(reply: unknown, id: string): ReportedCost | undefined {
  const usage = rec(rec(reply).threadUsage)
  if (usage.threadId !== id) return
  if (finite(usage.nativeUsageUsdMicros)) return { currency: 'USD', amount: usage.nativeUsageUsdMicros / 1e6 }
  if (finite(usage.estimatedUsageUsdMicros)) return { currency: 'USD', amount: usage.estimatedUsageUsdMicros / 1e6, estimated: true }
}

export function reportedCost(value: unknown): ReportedCost | undefined {
  const row = rec(value)
  if (currencyCode(row.currency) && finite(row.amount)) return { currency: row.currency, amount: row.amount,
    ...(row.estimated === true ? { estimated: true } : {}), ...(row.partial === true ? { partial: true } : {}) }
}

interface SessionReading { cost?: ReportedCost; updatedAt?: number; closed?: boolean }

/** Each session contributes its latest cumulative amount once, including after a replay or app restart. */
export class SessionCosts {
  private readonly sessions = new Map<string, SessionReading>()
  private readonly fetching = new Map<string, Promise<ReportedCost | undefined>>()
  private readonly loaded: Promise<void>

  constructor(private readonly file?: string) {
    this.loaded = file ? this.load(file).catch(() => undefined) : Promise.resolve()
  }

  private async load(file: string): Promise<void> {
    for (const item of list(JSON.parse(await fs.readFile(file, 'utf8')))) {
      const row = rec(item)
      if (typeof row.id !== 'string' || !row.id) continue
      this.sessions.set(row.id, { cost: reportedCost(row.cost), updatedAt: finite(row.updatedAt) ? row.updatedAt : undefined, closed: row.closed === true })
    }
  }

  private save(): Promise<void> {
    return this.file ? keepJson(this.file, Array.from(this.sessions, ([id, entry]) => ({ id, ...entry }))) : Promise.resolve()
  }

  async track(id: string): Promise<void> {
    await this.loaded
    if (!id || this.sessions.has(id)) return
    this.sessions.set(id, {})
    await this.save()
  }

  async has(id?: string): Promise<boolean> {
    await this.loaded
    return id === undefined ? this.sessions.size > 0 : this.sessions.has(id)
  }

  async record(id: string, cost: ReportedCost, replay = false): Promise<void> {
    await this.loaded
    const previous = this.sessions.get(id)?.cost
    if (replay && previous && (previous.currency !== cost.currency || previous.amount >= cost.amount)) return
    if (previous?.currency === cost.currency && previous.amount === cost.amount && !!previous.estimated === !!cost.estimated && !!previous.partial === !!cost.partial) return
    this.sessions.set(id, { cost })
    await this.save()
  }

  /** A later subscription may use the same task. Keep its last API reading. */
  async closeTracked(): Promise<void> {
    await this.loaded
    let changed = false
    for (const session of this.sessions.values()) if (!session.closed) { session.closed = true; changed = true }
    if (changed) await this.save()
  }

  async refresh(tasks: { id: string; updatedAt: number; state: string }[], read: (id: string) => Promise<ReportedCost | undefined>, only?: string): Promise<void> {
    await this.loaded
    const listed = new Map(tasks.map(task => [task.id, task]))
    const changed = []
    for (const [id, entry] of this.sessions) {
      if (entry.closed || (only !== undefined && id !== only)) continue
      // Older tasks can fall off an agent's recent list before their final cost is read.
      const task = listed.get(id) ?? { id, updatedAt: 0, state: 'idle' }
      if (!entry.cost || entry.updatedAt !== task.updatedAt || task.state === 'working') changed.push(task)
    }
    let dirty = false
    for (let start = 0; start < changed.length; start += 4) {
      await Promise.all(changed.slice(start, start + 4).map(async task => {
        let pending = this.fetching.get(task.id)
        if (!pending) {
          pending = read(task.id).catch(() => undefined).finally(() => this.fetching.delete(task.id))
          this.fetching.set(task.id, pending)
        }
        const cost = await pending
        const entry = this.sessions.get(task.id)
        if (!entry || entry.closed) return
        if (!cost) {
          if (entry.cost && !entry.cost.partial) { entry.cost.partial = true; dirty = true }
          return
        }
        if (JSON.stringify(entry.cost) !== JSON.stringify(cost) || entry.updatedAt !== task.updatedAt) dirty = true
        entry.cost = cost
        entry.updatedAt = task.updatedAt
      }))
    }
    if (dirty) await this.save()
  }

  async total(scope: CostScope, id?: string): Promise<Extract<RunnerUsage, { kind: 'cost' }>> {
    await this.loaded
    const amounts = new Map<string, number>()
    let estimated = false
    let partial = false
    const entries = id === undefined ? this.sessions.values() : [this.sessions.get(id) ?? {}]
    for (const { cost } of entries) {
      if (!cost) { partial = true; continue }
      amounts.set(cost.currency, (amounts.get(cost.currency) ?? 0) + cost.amount)
      estimated ||= !!cost.estimated
      partial ||= !!cost.partial
    }
    return { kind: 'cost', scope: id === undefined ? scope : 'session', amounts: Array.from(amounts, ([currency, amount]) => ({ currency, amount })), estimated, partial }
  }

  /** A switch back to a subscription can add tokens while the recorded API charges still belong to the task. */
  async withTrackedApi(usage: RunnerUsage, id?: string): Promise<RunnerUsage> {
    if (!await this.has(id)) return usage
    const trackedApi = await this.total('api-tasks', id)
    if (!trackedApi.amounts.length) return usage
    return usage.kind === 'tokens' && usage.period !== 'all' ? { ...usage, trackedApi } : trackedApi
  }
}
