/** Read-only reports inside the encrypted channel between paired devices. */
export type PhoneQuery = { kind: 'session'; task: string; view?: 'chat' } | { kind: 'usage' }

export type PhoneActivity = {
  kind: 'you' | 'agent' | 'work'
  text: string
  id?: number
  at?: number
  replyTo?: string
  delivery?: 'sent' | 'delivered'
}

export type PhoneUsage = {
  readings: string[]
  limits: { label: string; usedPercent: number; resetsAt?: number }[]
}

export type PhoneDelivery = 'sent' | 'queued'

export type PhoneQueue = {
  revision: string
  messages: string[]
  canSend: boolean
  note?: string
}

export type PhoneSessionReport = {
  kind: 'session'
  task: string
  model?: string
  activity: PhoneActivity[]
  usage: PhoneUsage
  queue?: PhoneQueue
}

export type PhoneUsageReport = {
  kind: 'usage'
  agents: { runner: string; name: string; usage: PhoneUsage }[]
}

export type PhoneReport = PhoneSessionReport | PhoneUsageReport

export function isPhoneQuery(value: unknown): value is PhoneQuery {
  if (!value || typeof value !== 'object') return false
  const query = value as Record<string, unknown>
  return query.kind === 'usage' || (query.kind === 'session' && typeof query.task === 'string' &&
    query.task.length > 0 && query.task.length <= 200 && (query.view === undefined || query.view === 'chat'))
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const words = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max

const timestamp = (value: unknown): value is number =>
  typeof value === 'number' && value > 0 && value < 8.64e15

/** A reply can open only the conversation the controller asked for. */
export function isSessionReport(value: unknown, task: string): value is PhoneSessionReport {
  if (!record(value) || value.kind !== 'session' || value.task !== task || value.queue !== undefined || !record(value.usage)) return false
  const { readings, limits } = value.usage
  return (value.model === undefined || words(value.model, 140)) &&
    Array.isArray(readings) && readings.length <= 24 && readings.every(line => words(line, 180)) &&
    Array.isArray(limits) && limits.length <= 12 && limits.every(limit =>
      record(limit) && words(limit.label, 80) && typeof limit.usedPercent === 'number' &&
      Number.isFinite(limit.usedPercent) && limit.usedPercent >= 0 &&
      (limit.resetsAt === undefined || timestamp(limit.resetsAt))) &&
    Array.isArray(value.activity) && value.activity.length <= 24 && value.activity.every(entry =>
      record(entry) && (entry.kind === 'you' || entry.kind === 'agent' || entry.kind === 'work') &&
      words(entry.text, 6_000) && (entry.id === undefined || Number.isSafeInteger(entry.id)) &&
      (entry.at === undefined || timestamp(entry.at)) &&
      (entry.replyTo === undefined || (entry.kind === 'you' && words(entry.replyTo, 200))) &&
      (entry.delivery === undefined || (entry.kind === 'you' && (entry.delivery === 'sent' || entry.delivery === 'delivered'))))
}
