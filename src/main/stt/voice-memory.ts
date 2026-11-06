import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { RememberedVoice } from '@shared/voices'
import { readSecret, writeSecret } from '../storage'
import { voiceSimilarity } from './voice-clusters'

const FILE = 'voices/people.bin'
const MAX_PEOPLE = 100
interface SavedVoice extends RememberedVoice { model: string; samples: number[][] }
const publicVoice = ({ id, name, createdAt, updatedAt }: SavedVoice): RememberedVoice => ({ id, name, createdAt, updatedAt })
const valid = (sample: unknown): sample is number[] => Array.isArray(sample) && sample.length >= 16 && sample.length <= 2048 && sample.every(value => typeof value === 'number' && Number.isFinite(value)) && voiceSimilarity(sample, sample) > .99
const cleanName = (name: string): string => name.replace(/[\r\n\[\]<>]/g, '').trim().slice(0, 60)

/** Keep original anchors and distinct confirmed variations, never a continually drifting average. */
function samplesOf(vectors: (Float32Array | number[])[]): number[][] {
  const samples: number[][] = []
  for (const vector of vectors) {
    const sample = Array.from(vector)
    if (!valid(sample) || samples[0] && samples[0].length !== sample.length) continue
    const magnitude = Math.sqrt(sample.reduce((sum, value) => sum + value * value, 0))
    const unit = sample.map(value => Number((value / magnitude).toFixed(7)))
    if (!samples.some(known => voiceSimilarity(known, unit) > .995)) samples.push(unit)
  }
  const selected = samples.splice(0, 2)
  while (samples.length && selected.length < 8) {
    let best = 0, distance = Infinity
    for (let n = 0; n < samples.length; n++) {
      const nearest = Math.max(...selected.map(anchor => voiceSimilarity(anchor, samples[n])))
      if (nearest < distance) { distance = nearest; best = n }
    }
    selected.push(samples.splice(best, 1)[0])
  }
  return selected
}

/** Device-local, OS-encrypted memory of explicitly confirmed people. No recordings. */
export class VoiceMemory {
  private people: SavedVoice[] = []
  private loaded?: Promise<void>
  private writes: Promise<unknown> = Promise.resolve()
  private writing = 0
  get pending(): boolean { return this.writing > 0 }
  constructor(readonly model: string, private changed: () => void = () => {}) {}

  load(): Promise<void> {
    return this.loaded ??= (async () => {
      const exists = await fs.stat(path.join(app.getPath('userData'), FILE)).then(info => {
        if (info.size > 16 * 1024 * 1024) throw new Error('Saved voice profiles are too large to read.')
        return true
      }, error => { if (error.code === 'ENOENT') return false; throw error })
      if (!exists) return
      const saved = await readSecret<{ version: number; people: SavedVoice[] }>(FILE)
      if (!saved || saved.version !== 1 || !Array.isArray(saved.people) || saved.people.length > MAX_PEOPLE) throw new Error('Saved voice profiles could not be opened. They have not been replaced.')
      if (saved.people.some(person => !person || typeof person.id !== 'string' || typeof person.name !== 'string' || typeof person.model !== 'string' || !Number.isFinite(person.createdAt) || !Number.isFinite(person.updatedAt) || !Array.isArray(person.samples) || !person.samples.length || person.samples.length > 8 || !person.samples.every(sample => valid(sample) && sample.length === person.samples[0].length))) throw new Error('A saved voice profile is invalid. It has not been replaced.')
      this.people = saved.people
    })()
  }

  async list(): Promise<RememberedVoice[]> { await this.load(); await this.writes; return this.people.map(publicVoice).sort((a, b) => a.name.localeCompare(b.name)) }
  get(id: string): RememberedVoice | undefined { const person = this.people.find(person => person.id === id); return person && publicVoice(person) }
  get size(): number { return this.people.filter(person => person.model === this.model).length }
  samples(id: string): Float32Array[] { const person = this.people.find(person => person.id === id && person.model === this.model); return person?.samples.map(sample => new Float32Array(sample)) ?? [] }

  /** A clear acoustic match is required. Similar names and meeting attendees are never evidence. */
  match(samples: Float32Array[], singleObservation = false): RememberedVoice | undefined {
    const ranked = this.rank(samples), best = ranked[0]
    return best && best.score >= (singleObservation ? .74 : .68) && best.score - (ranked[1]?.score ?? -1) >= (singleObservation ? .14 : .12) ? this.get(best.identity) : undefined
  }

  /** Keep the other remembered voices in contention, even before they have spoken in this call. */
  rank(samples: Float32Array[]): { identity: string; score: number }[] {
    if (!samples.length) return []
    const ranked = this.people.filter(person => person.model === this.model && person.samples[0].length === samples[0].length).map(person => {
      const scores = samples.map(sample => Math.max(...person.samples.map(anchor => voiceSimilarity(sample, anchor)))).sort((a, b) => b - a)
      // More than one agreeing observation when available; a single outlier cannot win.
      const score = scores.length > 1 ? (scores[0] + scores[1]) / 2 : scores[0]
      return { identity: person.id, score }
    }).sort((a, b) => b.score - a.score)
    return ranked
  }

  recognize(embedding: Float32Array, seconds: number, clean = true): { person?: RememberedVoice; ranked: { identity: string; score: number }[] } {
    const ranked = this.rank([embedding]), best = ranked[0], short = seconds < 1.5, sustained = clean && seconds >= 3
    // A one-word reply needs stronger separation than several seconds of verified single-speaker speech.
    const certain = seconds >= .7 && best && best.score >= (short ? .84 : sustained ? .70 : .74) && best.score - (ranked[1]?.score ?? -1) >= (short ? .18 : sustained ? .12 : .14)
    return { ranked, person: certain ? this.get(best.identity) : undefined }
  }

  private change<T>(update: (people: SavedVoice[]) => { people: SavedVoice[]; result: T }): Promise<T> {
    this.writing++
    const next = this.writes.catch(() => {}).then(async () => {
      await this.load()
      const change = update(this.people)
      await writeSecret(FILE, { version: 1, people: change.people })
      this.people = change.people; this.changed()
      return change.result
    })
    const done = next.finally(() => { this.writing-- })
    this.writes = done.then(() => undefined, () => undefined)
    return done
  }

  /** Only call after a user confirms a name/identity; recognition alone never trains saved profiles. */
  remember(name: string, vectors: Float32Array[], id?: string): Promise<RememberedVoice> {
    const value = cleanName(name), samples = samplesOf(vectors)
    if (!value || !samples.length) return Promise.reject(new Error('A name and clean voice samples are required.'))
    return this.change(people => {
      const existing = id ? people.find(person => person.id === id) : undefined
      if (id && !existing) throw new Error('This remembered person was removed. Choose them again.')
      if (!existing && people.length >= MAX_PEOPLE) throw new Error('Voice memory is full. Forget someone in Settings before adding a new person.')
      const now = Date.now()
      const person: SavedVoice = { id: existing?.id ?? randomUUID(), name: value, model: this.model, samples: samplesOf([...(existing?.model === this.model ? existing.samples : []), ...samples]), createdAt: existing?.createdAt ?? now, updatedAt: now }
      return { people: [...people.filter(item => item.id !== person.id), person], result: publicVoice(person) }
    })
  }

  forget(id: string): Promise<void> { return this.change(people => ({ people: people.filter(person => person.id !== id), result: undefined })) }
  merge(from: string, into: string): Promise<RememberedVoice> {
    return this.change(people => {
      const source = people.find(person => person.id === from), target = people.find(person => person.id === into)
      if (!source || !target || source === target) throw new Error('Choose two different remembered people.')
      const person = { ...target, updatedAt: Date.now(), samples: samplesOf([...target.samples, ...(source.model === target.model ? source.samples : [])]) }
      return { people: [...people.filter(item => item !== source && item !== target), person], result: publicVoice(person) }
    })
  }
  flush(): Promise<unknown> { return this.writes }
}
