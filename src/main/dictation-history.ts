import { createHash, randomUUID } from 'node:crypto'
import type { DictationHistory, DictationReceipt } from '@shared/dictation'
import { readSecret, writeSecret } from './storage'

const KEEP_MS = 7 * 24 * 60 * 60 * 1000
const LIMIT = 50
interface Saved extends DictationHistory { generation: string }
export interface DictationHistoryTicket { accountId: string; generation: string }

/** Opt-in text history. Serialized gates make clear/off win over an in-flight recording. */
export class DictationHistoryStore {
  private writes = new Map<string, Promise<unknown>>()
  private cache = new Map<string, Saved>()
  private expiry = new Map<string, NodeJS.Timeout>()
  constructor(private changed: (accountId: string) => void = () => {}, private now = Date.now) {}
  private file(accountId: string): string {
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw new Error('Choose a subscription account.')
    return `dictation-history/${createHash('sha256').update(accountId).digest('hex')}.bin`
  }
  private queue<T>(accountId: string, work: (value: Saved) => Promise<T>): Promise<T> {
    const file = this.file(accountId)
    const task = (this.writes.get(accountId) ?? Promise.resolve()).then(async () => {
      let saved = this.cache.get(accountId)
      if (!saved) {
        const read = await readSecret<Saved>(file)
        saved = read && typeof read.enabled === 'boolean' && typeof read.generation === 'string' && Array.isArray(read.entries)
          ? read : { enabled: false, generation: randomUUID(), entries: [] }
        saved.entries = saved.entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.text === 'string' && typeof entry.originalText === 'string' && typeof entry.revision === 'string' && Number.isFinite(entry.finishedAt))
        this.cache.set(accountId, saved)
        this.scheduleExpiry(accountId, saved)
      }
      const entries = saved.entries.filter(entry => entry.finishedAt > this.now() - KEEP_MS).sort((a, b) => b.finishedAt - a.finishedAt).slice(0, LIMIT)
      if (entries.length !== saved.entries.length) { saved = { ...saved, entries }; await this.write(accountId, saved) }
      return work(saved)
    })
    this.writes.set(accountId, task.catch(() => undefined))
    return task
  }
  private async write(accountId: string, value: Saved): Promise<void> {
    await writeSecret(this.file(accountId), value)
    this.cache.set(accountId, value); this.changed(accountId)
    this.scheduleExpiry(accountId, value)
  }
  private scheduleExpiry(accountId: string, value: Saved): void {
    clearTimeout(this.expiry.get(accountId)); this.expiry.delete(accountId)
    if (!value.entries.length) return
    const expires = Math.min(...value.entries.map(entry => entry.finishedAt)) + KEEP_MS
    const timer = setTimeout(() => { this.expiry.delete(accountId); void this.get(accountId).catch(error => console.warn('[dictation history] expiry:', (error as Error).message)) }, Math.max(10, expires - this.now() + 1))
    timer.unref(); this.expiry.set(accountId, timer)
  }
  get(accountId: string): Promise<DictationHistory> { return this.queue(accountId, async saved => structuredClone({ enabled: saved.enabled, entries: saved.entries })) }
  configure(accountId: string, enabled: boolean): Promise<DictationHistory> {
    if (typeof enabled !== 'boolean') return Promise.reject(new Error('Choose whether to keep recent text.'))
    return this.queue(accountId, async saved => {
      const next = { ...saved, enabled, generation: randomUUID() }
      await this.write(accountId, next)
      return structuredClone({ enabled, entries: next.entries })
    })
  }
  begin(accountId: string): Promise<DictationHistoryTicket | undefined> {
    return this.queue(accountId, async saved => saved.enabled ? { accountId, generation: saved.generation } : undefined)
  }
  record(ticket: DictationHistoryTicket | undefined, receipt: DictationReceipt): Promise<void> {
    if (!ticket) return Promise.resolve()
    const snapshot = structuredClone(receipt)
    return this.queue(ticket.accountId, async saved => {
      if (!saved.enabled || saved.generation !== ticket.generation || saved.entries.some(entry => entry.id === snapshot.id)) return
      if (!snapshot.text.trim() || snapshot.text.length > 16000 || snapshot.originalText.length > 16000 || !Number.isFinite(snapshot.finishedAt) || snapshot.finishedAt <= this.now() - KEEP_MS) return
      await this.write(ticket.accountId, { ...saved, entries: [snapshot, ...saved.entries].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, LIMIT) })
    })
  }
  correct(accountId: string, id: string, revision: string, text: string): Promise<DictationReceipt> {
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) return Promise.reject(new Error('Enter text of up to 16,000 characters.'))
    return this.queue(accountId, async saved => {
      const entry = saved.entries.find(entry => entry.id === id)
      if (!entry) throw new Error('This dictation is no longer in recent history.')
      if (entry.revision !== revision) throw new Error('This dictation changed. Reopen it before editing.')
      const updated = { ...entry, text, corrected: true, revision: randomUUID() }
      await this.write(accountId, { ...saved, entries: saved.entries.map(value => value.id === id ? updated : value) })
      return structuredClone(updated)
    })
  }
  remove(accountId: string, id?: string): Promise<DictationHistory> {
    return this.queue(accountId, async saved => {
      const next = { ...saved, generation: randomUUID(), entries: id === undefined ? [] : saved.entries.filter(entry => entry.id !== id) }
      await this.write(accountId, next)
      return structuredClone({ enabled: next.enabled, entries: next.entries })
    })
  }
  async flush(): Promise<void> {
    for (;;) {
      const pending = [...this.writes.values()]
      await Promise.all(pending)
      if ([...this.writes.values()].every(task => pending.includes(task))) return
    }
  }
}
