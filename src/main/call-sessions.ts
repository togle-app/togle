import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CallSession, CallSessionInfo, CallSessionSummary, CallView, PastCall, SessionSuggestion } from '@shared/types'
import { emptyLessons, lessonCount, lessonItems } from '@shared/learning'
import { speakerLabel } from '@shared/meeting'
import { speechTurns } from '@shared/speakers'
import { resolveCallTitle } from '@shared/call-title'
import type { CallState } from './call-file'
import { readSecret, readSecretJson, writeSecret, writeSecretJson } from './storage'

const INDEX = 'call-history/index.bin'
// The active call and a few inspected calls. Old archives must not accumulate in memory.
const CACHE_RECORDS = 4
const CACHE_BYTES = 16 * 1024 * 1024
const safeId = (id: string): boolean => typeof id === 'string' && /^[\w-]{1,100}$/.test(id) && id !== 'index'
const fileFor = (id: string): string => {
  if (!safeId(id)) throw new Error('No such call.')
  return `call-history/${id}.bin`
}

export function sessionSummary(session: CallSession): CallSessionSummary {
  const { transcript, suggestions, notes: _notes, personalNotes: _personal, callAnswers: _answers, learning, ...info } = session
  return { ...info, summary: info.summary.slice(0, 2000), lines: transcript.length, replies: suggestions.length, learningState: learning.state, pendingLessons: lessonCount(learning.pending), learned: learning.changes.length }
}

export function legacySession(call: PastCall, agentName: string): CallSession {
  return {
    version: 1, id: `legacy-${call.id}`, agentId: call.agentId, agentName, startedAt: call.at, endedAt: call.endedAt, status: 'ended', updatedAt: call.endedAt,
    title: call.title || call.brief || call.with.join(', ') || 'Untitled call', titleSource: call.title ? 'generated' : undefined, frameSession: call.callId || '', brief: call.brief, group: false,
    transcript: [], suggestions: call.asked.map((answer, index) => ({ id: `legacy-${index}`, kind: 'suggest', question: answer.question, text: answer.answer, at: call.at })),
    summary: call.summary, notes: '', callAnswers: [], learning: { state: 'not-reviewed', pending: emptyLessons(), changes: [] }, legacy: { agentId: call.agentId, id: call.id }
  }
}

/** Durable call records, independent of whether the learning model produced a summary. All writes serialize. */
export class CallSessions extends EventEmitter {
  private index = new Map<string, CallSessionSummary>()
  private loaded?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private deleted = new Set<string>()
  private cache = new Map<string, string>()
  private cacheBytes = 0

  private forgetCached(id: string): void {
    const previous = this.cache.get(id)
    if (previous !== undefined) this.cacheBytes -= previous.length * 2
    this.cache.delete(id)
  }

  private remember(id: string, json: string): void {
    this.forgetCached(id)
    const bytes = json.length * 2
    if (bytes > CACHE_BYTES) return
    this.cache.set(id, json)
    this.cacheBytes += bytes
    while (this.cache.size > CACHE_RECORDS || this.cacheBytes > CACHE_BYTES) this.forgetCached(this.cache.keys().next().value!)
  }

  private load(): Promise<void> {
    return this.loaded ??= (async () => {
      let reconciled = false
      const index = await readSecret<CallSessionSummary[]>(INDEX)
      if (Array.isArray(index)) {
        for (const entry of index) if (entry && safeId(entry.id) && typeof entry.title === 'string') this.index.set(entry.id, entry)
      }
      // Also recover a record whose write succeeded immediately before an interrupted index write.
      const files = await fs.readdir(path.join(app.getPath('userData'), 'call-history')).catch(() => null)
      if (files) {
        const present = new Set(files.filter(file => file.endsWith('.bin')).map(file => file.slice(0, -4)))
        for (const id of this.index.keys()) if (!present.has(id)) { this.index.delete(id); reconciled = true }
      }
      for (const file of files ?? []) {
        const id = file.replace(/\.bin$/, '')
        const previous = this.index.get(id)
        const migrateTitle = !!previous && !previous.customTitle && !previous.titleSource
        if (!file.endsWith('.bin') || !safeId(id) || (previous && !migrateTitle && previous.learningState !== 'reviewing' && previous.minutes?.state !== 'generating')) continue
        const record = await this.read(id)
        if (!record) continue
        reconciled = true
        if (record.learning.state === 'reviewing') {
          record.learning = { ...record.learning, state: 'error', error: 'The review was interrupted. Try reviewing this call again.' }
          await writeSecret(fileFor(id), record)
          this.forgetCached(id)
        }
        if (record.minutes?.state === 'generating') {
          record.minutes = { ...record.minutes, state: 'error', error: 'Notes generation was interrupted. Generate notes again to retry.' }
          await writeSecret(fileFor(id), record)
          this.forgetCached(id)
        }
        if (migrateTitle) { await writeSecret(fileFor(id), record); this.forgetCached(id) }
        this.index.set(id, sessionSummary(record))
      }
      if (reconciled) await writeSecret(INDEX, [...this.index.values()])
    })()
  }

  private async read(id: string): Promise<CallSession | null> {
    const json = this.cache.get(id) ?? await readSecretJson(fileFor(id))
    if (json === null) return null
    let record: CallSession
    try { record = JSON.parse(json) as CallSession } catch { return null }
    if (!record || record.version !== 1 || record.id !== id || !Array.isArray(record.transcript) || !Array.isArray(record.suggestions) || !record.learning?.pending) return null
    if (typeof record.title !== 'string' || typeof record.agentId !== 'string' || !Number.isFinite(record.startedAt) || !Array.isArray(record.learning.changes)) return null
    if (!['facts', 'answers', 'skills', 'updates', 'forget'].every(key => Array.isArray(record.learning.pending[key as keyof typeof record.learning.pending]))) return null
    if (!record.transcript.every(line => line && typeof line.text === 'string' && (line.speaker === 'me' || line.speaker === 'them') && Number.isFinite(line.at))) return null
    if (!record.suggestions.every(card => card && typeof card.text === 'string' && typeof card.id === 'string')) return null
    const resolved = resolveCallTitle(record)
    const titleChanged = resolved.title !== record.title || resolved.titleSource !== record.titleSource
    Object.assign(record, resolved)
    this.remember(id, titleChanged ? JSON.stringify(record) : json)
    return record
  }

  private queue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => { await this.load(); return work() })
    this.writes = result.catch(() => undefined)
    return result
  }

  private async write(record: CallSession): Promise<CallSession> {
    record = { ...record, ...resolveCallTitle(record) }
    const json = JSON.stringify(record)
    this.forgetCached(record.id)
    await writeSecretJson(fileFor(record.id), json)
    this.index.set(record.id, sessionSummary(record))
    await writeSecret(INDEX, [...this.index.values()])
    this.remember(record.id, json)
    this.emit('changed', record.id)
    // A fresh value for the caller, while the cached JSON stays private. Parsing is cheaper than cloning a long call.
    return JSON.parse(json) as CallSession
  }

  async list(): Promise<CallSessionSummary[]> {
    await this.writes
    await this.load()
    return structuredClone([...this.index.values()].sort((a, b) => b.startedAt - a.startedAt))
  }

  async get(id: string): Promise<CallSession | null> {
    fileFor(id)
    // Serial reads share the cache and cannot replace a newer write with an older in-flight disk read.
    return this.queue(async () => this.deleted.has(id) ? null : this.read(id))
  }

  /** A capture update may not overwrite a title, summary, or learning result saved meanwhile. */
  capture(info: CallSessionInfo, frameSession: string, state: CallState, view?: CallView): Promise<CallSession | null> {
    const owner = { ...info }
    fileFor(owner.id)
    // Snapshot only what history stores. Screen frames and nested live card state can be large and aren't archived.
    const transcript = state.transcript.slice(-20_000).map(line => ({ ...line }))
    const callAnswers = state.callAnswers.map(answer => ({ ...answer }))
    const brief = state.brief ?? ''
    const group = !!state.group
    const notes = state.notes
    const incoming: SessionSuggestion[] = (view?.cards ?? []).flatMap((value) => {
      const card = value as Record<string, unknown> | null
      if (!card || typeof card.id !== 'string' || !['suggest', 'ask', 'summary'].includes(String(card.kind))) return []
      const text = typeof card.text === 'string' ? card.text.slice(0, 100_000) : ''
      const deep = card.deep as { text?: unknown } | undefined
      if (!text && typeof deep?.text !== 'string') return []
      return [{ id: card.id, kind: card.kind as SessionSuggestion['kind'], question: typeof card.question === 'string' ? card.question.slice(0, 5000) : '', text, deep: typeof deep?.text === 'string' ? deep.text.slice(0, 100_000) : undefined, at: typeof card.at === 'number' ? card.at : owner.startedAt }]
    }).slice(0, 200)
    return this.queue(async () => {
      if (this.deleted.has(owner.id)) return null
      const previous = await this.read(owner.id)
      if (previous && previous.agentId !== owner.agentId) throw new Error('A saved call cannot change its owning agent.')
      if (previous?.accountId && owner.accountId && previous.accountId !== owner.accountId) throw new Error('A saved call cannot change its subscription account.')
      // The live window keeps a small recent list. History retains replies that have scrolled out of it.
      const byId = new Map((previous?.suggestions ?? []).map(card => [card.id, card]))
      for (const card of incoming) byId.set(card.id, card)
      const suggestions = [...byId.values()].sort((a, b) => a.at - b.at).slice(-2000)
      return this.write({
        version: 1, ...owner, updatedAt: Date.now(), frameSession,
        accountId: previous?.accountId ?? owner.accountId,
        meeting: previous?.meeting ?? owner.meeting,
        title: previous?.title || 'Untitled call', titleSource: previous?.titleSource, titleKey: previous?.titleKey, titleRetryAt: previous?.titleRetryAt,
        customTitle: previous?.customTitle, brief, group,
        transcript, suggestions, notes, callAnswers,
        personalNotes: previous?.personalNotes, minutes: previous?.minutes,
        summary: previous?.summary || incoming.find(card => card.kind === 'summary')?.text || '',
        learning: previous?.learning ?? { state: 'not-reviewed', pending: emptyLessons(), changes: [] }
      })
    })
  }

  put(record: CallSession): Promise<CallSession> {
    const snapshot = structuredClone(record)
    fileFor(record.id)
    return this.queue(async () => {
      if (this.deleted.has(snapshot.id)) throw new Error('This call was deleted.')
      const previous = await this.read(snapshot.id)
      if (previous && previous.agentId !== snapshot.agentId) throw new Error('A saved call cannot change its owning agent.')
      if (previous?.accountId && snapshot.accountId && previous.accountId !== snapshot.accountId) throw new Error('A saved call cannot change its subscription account.')
      return this.write({ ...snapshot, accountId: previous?.accountId ?? snapshot.accountId })
    })
  }

  update(id: string, change: (record: CallSession) => CallSession): Promise<CallSession> {
    fileFor(id)
    return this.queue(async () => {
      const record = this.deleted.has(id) ? null : await this.read(id)
      if (!record) throw new Error('This call is no longer available.')
      return this.write({ ...change(record), id: record.id, agentId: record.agentId, accountId: record.accountId, updatedAt: Date.now() })
    })
  }

  rename(id: string, title: string): Promise<CallSession> {
    if (typeof title !== 'string' || !title.trim() || title.trim().length > 140) throw new Error('Use a call title between 1 and 140 characters.')
    return this.update(id, record => ({ ...record, title: title.trim(), customTitle: true }))
  }

  remove(id: string): Promise<void> {
    fileFor(id)
    this.deleted.add(id)
    this.forgetCached(id)
    return this.queue(async () => {
      this.forgetCached(id)
      await writeSecret(fileFor(id), null)
      this.index.delete(id)
      await writeSecret(INDEX, [...this.index.values()])
      this.emit('changed', id)
    })
  }
}

export function exportCall(session: CallSession): string {
  return [
    `# ${session.title}`, `Agent: ${session.agentName}`, `Started: ${new Date(session.startedAt).toISOString()}`,
    session.brief && `## Call context\n\n${session.brief}`, session.personalNotes && `## My notes\n\n${session.personalNotes}`, session.summary && `## Summary\n\n${session.summary}`,
    `## Transcript\n\n${session.transcript.length ? speechTurns(session.transcript).map(line => `${speakerLabel(line)}: ${line.text}`).join('\n\n') : 'No transcript was saved.'}`,
    `## Suggestions\n\n${session.suggestions.map(card => `### ${card.question || card.kind}\n\n${card.text}${card.deep ? `\n\n${card.deep}` : ''}`).join('\n\n')}`,
    session.learning.changes.length ? `## Learning changes recorded for this call\n\n${session.learning.changes.map(change => `- ${change.text}`).join('\n')}` : '',
    lessonCount(session.learning.pending) ? `## Pending lessons (not approved)\n\n${lessonItems(session.learning.pending).map(item => `- ${item.label}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n') + '\n'
}
