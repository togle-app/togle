import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { ProviderUsage, RunnerUsage } from '@shared/runner-usage'

const counters = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'actual_cost_usd', 'estimated_cost_usd'] as const
type Counter = typeof counters[number]
type Meter = { session: string; billing_provider: string | null; model: string | null; cost_status: string | null; billing_mode: string | null } & Record<Counter, number | null>
const columns = 'billing_provider, model, cost_status, billing_mode, ' + counters.join(', ')

export function hermesProviderName(provider: string): string {
  const names: Record<string, string> = { 'openai-codex': 'ChatGPT', 'openai-api': 'OpenAI', anthropic: 'Anthropic', 'xai-oauth': 'xAI', kimi: 'Kimi', moonshot: 'Moonshot', 'kimi-coding': 'Kimi Coding', 'kimi-coding-cn': 'Kimi Coding CN', openrouter: 'OpenRouter' }
  return Object.hasOwn(names, provider) ? names[provider] : provider || 'Unattributed'
}

export function hermesUsageFile(env: NodeJS.ProcessEnv, customCommand: boolean): string | undefined {
  if (customCommand && !env.HERMES_HOME) return
  const root = env.HERMES_HOME || (process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes' + (env.HERMES_DATA_DIR_SUFFIX || ''))
    : path.join(env.HOME || os.homedir(), '.hermes' + (env.HERMES_DATA_DIR_SUFFIX || '')))
  if (!env.HERMES_HOME) {
    try {
      const profile = readFileSync(path.join(root, 'active_profile'), 'utf8').trim()
      if (profile !== 'default' && /^[\w-]+$/.test(profile)) return path.join(root, 'profiles', profile, 'state.db')
    } catch { /* The default profile has no marker. */ }
  }
  return path.join(root, 'state.db')
}

export async function hermesUsageDb<T>(file: string | undefined, read: (db: DatabaseSync) => T): Promise<T | undefined> {
  if (!file) return
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try { db.exec('BEGIN'); return read(db) } finally { db.close() }
  } catch { return undefined } // Older installations can still report usage through the CLI.
}

export function hermesMeterProviders(db: DatabaseSync): string[] {
  const supported = ['openai-codex', 'anthropic']
  const from = (table: string) => db.prepare(`SELECT DISTINCT billing_provider FROM ${table} WHERE billing_provider IN (?, ?)`).all(...supported).map(r => String(r.billing_provider))
  const providers = from('sessions')
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_model_usage'").get()) providers.push(...from('session_model_usage'))
  return [...new Set(providers)]
}

/** Hermes records a row per billing route, including model switches within a single session. Legacy sessions have only a total. */
export function hermesMeters(db: DatabaseSync, id?: string): RunnerUsage | undefined {
  const select = (table: string, key: string): Meter[] => db.prepare(`SELECT ${key} AS session, ${columns} FROM ${table}${id === undefined ? '' : ' WHERE ' + key + ' = ?'}`).all(...(id === undefined ? [] : [id])) as unknown as Meter[]
  const sessions = select('sessions', 'id')
  if (!sessions.length) return
  const routes = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'session_model_usage'").get() ? select('session_model_usage', 'session_id') : []
  const totals = new Map<string, Record<Counter, number>>()
  const sources = new Map<string, ProviderUsage>()
  const add = (row: Meter): void => {
    const tokens = (row.input_tokens ?? 0) + (row.output_tokens ?? 0) + (row.cache_read_tokens ?? 0) + (row.cache_write_tokens ?? 0)
    const included = row.billing_provider === 'openai-codex' || row.cost_status === 'included' || row.billing_mode === 'subscription_included'
    // In the route table Hermes uses zero as the default for an unreported actual charge.
    const actual = (row.actual_cost_usd ?? 0) > 0 || row.cost_status === 'actual' ? row.actual_cost_usd : null
    const priced = !included && (actual != null || row.cost_status === 'estimated' || row.cost_status === 'official')
    const cost = priced ? actual ?? row.estimated_cost_usd : null
    if (!tokens && !cost && !row.cost_status) return
    const provider = hermesProviderName(row.billing_provider || row.model || '')
    const api = priced || ['api', 'api_key', 'official_models_api', 'official_docs_snapshot'].includes(row.billing_mode ?? '')
    const billing = included ? 'subscription' : api ? 'api' : 'unknown'
    const key = JSON.stringify([provider, billing])
    const source: ProviderUsage = sources.get(key) ?? { provider, billing, tokens: 0 }
    source.tokens += tokens
    if (cost != null) {
      source.cost = { currency: 'USD', amount: (source.cost?.amount ?? 0) + cost }
      if (actual == null) source.estimated = true
    }
    sources.set(key, source)
  }
  for (const row of routes) {
    add(row)
    const sum = totals.get(row.session) ?? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, actual_cost_usd: 0, estimated_cost_usd: 0 }
    for (const key of counters) sum[key] += row[key] ?? 0
    totals.set(row.session, sum)
  }
  for (const session of sessions) {
    const sum = totals.get(session.session)
    if (!sum) { add(session); continue }
    // Partial migrations can leave usage only in the session total. Count the excess once.
    const residual = { ...session }
    for (const key of counters) residual[key] = Math.max(0, (session[key] ?? 0) - sum[key])
    if (counters.some(key => (residual[key] ?? 0) > 0.000000001)) add(residual)
  }
  if (!sources.size) return
  return { kind: 'providers', period: id === undefined ? 'all' : 'session', sources: [...sources.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.billing.localeCompare(b.billing)) }
}
