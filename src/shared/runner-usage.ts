/** A provider's shared allowance, reported independently from measured session usage. */
export interface UsageWindow {
  label: string
  usedPercent: number
  resetsAt?: number
  provider?: string
}

export function resetCountdown(at: number, now = Date.now()): string {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return 'reset due'
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  if (days) return 'resets in ' + days + 'd ' + hours % 24 + 'h'
  if (hours) return 'resets in ' + hours + 'h ' + minutes % 60 + 'm'
  return 'resets in ' + minutes + 'm'
}

export interface AgentMoney {
  currency: string
  amount: number
}

export type CostScope = 'api-tasks' | 'agent-sessions' | 'hermes-history' | 'session'
export interface CostReading {
  kind: 'cost'
  amounts: AgentMoney[]
  scope: CostScope
  estimated?: boolean
  partial?: boolean
}
export interface ProviderUsage {
  provider: string
  billing: 'subscription' | 'api' | 'unknown'
  tokens: number
  cost?: AgentMoney
  estimated?: boolean
}
export type RunnerUsage =
  | { kind: 'providers'; period: 'session' | 'all'; sources: ProviderUsage[] }
  | { kind: 'tokens'; period: '7d' | 'session'; total: number; trackedApi?: CostReading }
  | { kind: 'tokens'; period: 'all'; total: number; apiEstimate?: AgentMoney; partial?: boolean }
  | CostReading
  | { kind: 'unavailable'; reason: 'signed-out' | 'unsupported' | 'temporary' }

/** Keep small amounts visible even when rounding to cents would display zero. */
export function formatAgentMoney({ currency, amount }: AgentMoney): string {
  const format = (value: number, digits: number): string => new Intl.NumberFormat(undefined, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: digits
  }).format(value)
  if (amount > 0 && amount < 0.0001) return `<${format(0.0001, 4)}`
  return format(amount, amount > 0 && amount < 0.01 ? 4 : 2)
}
