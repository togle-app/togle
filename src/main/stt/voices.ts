import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { download, speechHome } from './install'
import { VoiceClusters } from './voice-clusters'
import type { RememberedVoice, RememberVoiceResult } from '@shared/voices'
import type { VoiceMemory } from './voice-memory'

export const VOICE_MODEL = {
  url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  bytes: 28281164,
  sha256: 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2'
}
export const VOICE_SEGMENTATION_MODEL = {
  url: 'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/9403a69/model.onnx',
  bytes: 5992913,
  sha256: '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079'
}

export interface VoiceStatus { state: 'off' | 'loading' | 'ready' | 'error'; error?: string; memoryError?: string }
interface MemoryOptions {
  memory: VoiceMemory
  enabled: () => boolean
  remembered: (voiceId: string, person: RememberedVoice) => void
  revoked?: (segment: string) => void
}
interface VoiceFeatures { embedding?: Float32Array; seconds?: number; evidence?: number; clean?: boolean }
export interface DiarizedTurn { id: string; from: number; to: number }

/** Audio stays transient. Only explicitly confirmed profiles can enter encrypted voice memory. */
export class VoiceTracker {
  private child?: UtilityProcess
  private scope?: AbortController
  private ready = false
  private running?: { id: string; at: number; end: number; preview: boolean; request: number }
  private queue: { id: string; pcm: Float32Array; at: number; end: number; preview: boolean }[] = []
  private request = 0
  private previewed = new Set<string>()
  private previewLengths = new Map<string, number>()
  private finalized = new Set<string>()
  private drained?: () => void
  private finishing?: Promise<void>
  private timer?: NodeJS.Timeout
  private current: VoiceStatus = { state: 'off' }
  private clusters = new VoiceClusters()
  private namespace = randomUUID()
  private aliases = new Map<string, string>()
  private pendingNames = new Map<string, { name: string; identity?: string }>()
  private bindings = new Map<string, { person: RememberedVoice; confirmed: boolean }>()
  private remembering = new Map<string, Promise<RememberVoiceResult>>()
  private memoryError?: string
  private splits = new Map<string, { resolve: (turns: DiarizedTurn[]) => void; timer: NodeJS.Timeout }>()
  constructor(private result: (segment: string, voice: string, person?: RememberedVoice) => void, private changed: (status: VoiceStatus) => void, private memory?: MemoryOptions) {}
  status(): VoiceStatus { return this.current }
  get pending(): boolean { return this.remembering.size > 0 || !!this.memory?.memory.pending }
  private set(status: VoiceStatus): void { this.current = { ...status, memoryError: this.memoryError }; this.changed(this.current) }

  async start(): Promise<void> {
    if (this.scope) return
    const scope = this.scope = new AbortController()
    this.set({ state: 'loading' })
    try {
      if (this.memory?.enabled()) {
        try { await this.memory.memory.load(); this.memoryError = undefined }
        catch (error) { this.memoryError = (error as Error).message }
      }
      const file = path.join(speechHome(), 'voices', 'campplus-zh-en.onnx')
      const segmentation = path.join(speechHome(), 'voices', 'segmentation-3.onnx')
      const models: [typeof VOICE_MODEL, string][] = [[VOICE_MODEL, file], [VOICE_SEGMENTATION_MODEL, segmentation]]
      await Promise.all(models.map(async ([model, target]) => {
        if (!existsSync(target)) await download(model, target, scope.signal, () => {})
      }))
      if (scope.signal.aborted) return
      const child = this.child = utilityProcess.fork(path.join(__dirname, 'voice-worker.js'), [file, segmentation], { serviceName: 'Togle speaker labels', stdio: 'ignore' })
      this.timer = setTimeout(() => this.fail('Speaker model took too long to start.'), 30_000)
      child.on('message', (message: VoiceFeatures & { type: string; id: string; request?: number; error?: string; turns?: (VoiceFeatures & { from: number; to: number })[] }) => {
        if (this.child !== child) return
        if (message.type === 'ready') { clearTimeout(this.timer); this.ready = true; this.set({ state: 'ready' }); this.pump() }
        if (message.type === 'failed') this.fail(message.error ?? 'Speaker recognition could not start.')
        if (message.type === 'result') {
          const job = this.running
          if (!job || message.id !== job.id || message.request !== undefined && message.request !== job.request) return
          clearTimeout(this.timer); this.running = undefined
          const evidence = this.memory?.enabled() && !this.memoryError && message.embedding ? this.memory.memory.recognize(message.embedding, message.seconds ?? 0, message.clean !== false) : undefined
          const known = evidence?.person
          if (job.preview) {
            if (!this.finalized.has(job.id)) {
              const match = message.clean === false ? undefined : this.clusters.preview(message.embedding, known ? { id: known.id, samples: this.memory!.memory.samples(known.id) } : undefined, evidence?.ranked)
              if (match !== undefined) {
                const voice = this.canonical(`${this.namespace}:${match}`)
                if (known && !this.bindings.has(voice) && !this.pendingNames.has(voice)) this.bindings.set(voice, { person: known, confirmed: false })
                this.result(job.id, voice, this.memory?.enabled() ? this.bindings.get(voice)?.person : undefined)
                this.previewed.add(job.id)
              } else if (this.previewed.delete(job.id)) this.memory?.revoked?.(job.id)
            }
            this.pump(); return
          }
          const turns = message.turns
          const size = Math.round((job.end - job.at) * 16)
          const valid = turns && turns.length > 1 && turns.length <= 32 && turns[0].from === 0 && turns.at(-1)!.to === size && turns.every((turn, index) => Number.isInteger(turn.from) && Number.isInteger(turn.to) && turn.to > turn.from && turn.to <= size && (!index || turn.from === turns[index - 1].to))
          if (valid) {
            if (this.previewed.delete(job.id)) this.memory?.revoked?.(job.id)
            const slices = turns.map((turn, index) => ({ id: `${job.id}:turn:${index}`, from: turn.from, to: turn.to }))
            turns.forEach((turn, index) => this.observe({ id: slices[index].id, at: job.at + turn.from / 16, end: job.at + turn.to / 16 }, turn))
            this.resolveSplit(job.id, slices)
          } else {
            this.observe(job, message)
            this.resolveSplit(job.id, [])
          }
          this.pump()
        }
      })
      child.on('exit', () => { if (this.child === child) this.fail('Speaker recognition stopped. Transcription continues.') })
    } catch (error) { if (!scope.signal.aborted) this.fail((error as Error).message) }
  }

  private observe(job: { id: string; at: number; end: number }, message: VoiceFeatures): void {
    const evidence = this.memory?.enabled() && !this.memoryError && message.embedding ? this.memory.memory.recognize(message.embedding, message.seconds ?? 0, message.clean !== false) : undefined
    const assignments = this.clusters.observe({ ...job, ...message, seconds: message.seconds ?? 0, identity: evidence?.person?.id, identities: evidence?.ranked })
    if (this.previewed.delete(job.id) && !assignments.some(assignment => assignment.id === job.id)) this.memory?.revoked?.(job.id)
    for (const assignment of assignments) {
      const voice = this.canonical(`${this.namespace}:${assignment.voice}`), profile = this.clusters.profile(assignment.voice)
      if (this.memory?.enabled() && !this.bindings.has(voice) && profile && !this.pendingNames.has(voice)) {
        const person = profile.identity ? this.memory.memory.get(profile.identity) : profile.count >= 2 && profile.seconds >= 6 ? this.memory.memory.match(profile.samples) : undefined
        if (person) { this.bindings.set(voice, { person, confirmed: false }); this.clusters.remember(assignment.voice, person.id) }
      }
      this.result(assignment.id, voice, this.memory?.enabled() ? this.bindings.get(voice)?.person : undefined)
      if (this.pendingNames.has(voice)) void this.saveName(voice).catch(error => { this.memoryError = error.message; this.set(this.current) })
    }
  }
  private resolveSplit(id: string, turns: DiarizedTurn[]): void {
    const waiting = this.splits.get(id)
    if (waiting) { clearTimeout(waiting.timer); this.splits.delete(id); waiting.resolve(turns) }
  }
  /** Reuse the embedding worker’s diarization once; never hold transcription for a model download or stalled CPU. */
  split(id: string, pcm: Float32Array, at: number): Promise<DiarizedTurn[]> {
    if (!this.ready || !this.scope || this.finishing || this.finalized.has(id) || pcm.length < .7 * 16000 || pcm.length > 30 * 16000) { this.hear(id, pcm, at); return Promise.resolve([]) }
    return new Promise(resolve => {
      const timer = setTimeout(() => this.resolveSplit(id, []), 1800)
      timer.unref?.()
      this.splits.set(id, { resolve, timer })
      this.hear(id, pcm, at)
    })
  }

  hear(id: string, pcm: Float32Array, at: number, preview = false): void {
    if (!this.scope || this.finishing || !Number.isFinite(at)) return
    if (pcm.length < 0.7 * 16000 || pcm.length > 30 * 16000) {
      if (!preview && this.previewed.delete(id)) this.memory?.revoked?.(id)
      return
    }
    if (this.finalized.has(id)) return
    if (preview) {
      const previous = this.previewLengths.get(id)
      if ((!this.clusters.size && !(this.memory?.enabled() && this.memory.memory.size)) || pcm.length < 1.5 * 16000 || previous !== undefined && pcm.length - previous < .9 * 16000) return
      this.previewLengths.set(id, pcm.length)
      if (this.previewLengths.size > 32) this.previewLengths.delete(this.previewLengths.keys().next().value!)
    } else {
      this.finalized.add(id); if (this.finalized.size > 512) this.finalized.delete(this.finalized.values().next().value!)
      this.previewLengths.delete(id)
    }
    const samples = pcm
    let energy = 0
    for (const sample of samples) energy += sample * sample
    // Match the normalizer's floor: quiet but recoverable speech must reach gain normalization.
    if (energy / samples.length < .00015 ** 2) { if (!preview && this.previewed.delete(id)) this.memory?.revoked?.(id); return }
    this.queue = this.queue.filter(job => job.id !== id)
    // Keeping only a few short clips prevents a slow CPU from accumulating meeting audio.
    if (this.queue.length >= 4) {
      const pendingPreview = this.queue.findIndex(job => job.preview)
      if (pendingPreview >= 0) this.queue.splice(pendingPreview, 1)
      else if (preview) return
      else { const dropped = this.queue.shift()!; this.resolveSplit(dropped.id, []); if (this.previewed.delete(dropped.id)) this.memory?.revoked?.(dropped.id) }
    }
    const job = { id, pcm: new Float32Array(samples), at, end: at + pcm.length / 16, preview }
    if (preview) this.queue.push(job)
    else { const firstPreview = this.queue.findIndex(job => job.preview); this.queue.splice(firstPreview < 0 ? this.queue.length : firstPreview, 0, job) }
    this.pump()
  }
  private pump(): void {
    if (this.running) return
    if (!this.queue.length) { this.drained?.(); return }
    if (!this.ready || !this.child) return
    const job = this.queue.shift()!
    this.running = { id: job.id, at: job.at, end: job.end, preview: job.preview, request: ++this.request }
    this.timer = setTimeout(() => this.fail('Speaker recognition timed out. Transcription continues.'), 10_000)
    this.child.postMessage({ ...job, request: this.running.request })
  }
  private fail(error: string): void { this.stop(); this.set({ state: 'error', error }) }
  private canonical(id: string): string { for (let n = 0; n < this.aliases.size && this.aliases.has(id); n++) id = this.aliases.get(id)!; return id }
  private profile(id: string): ReturnType<VoiceClusters['profile']> { return id.startsWith(this.namespace + ':') ? this.clusters.profile(Number(id.split(':').at(-1))) : undefined }

  async remember(id: string, name: string, identity?: string): Promise<RememberVoiceResult> {
    if (!this.memory?.enabled()) return { state: 'off' }
    id = this.canonical(id)
    if (!this.profile(id)) return { state: 'unavailable' }
    await this.memory.memory.load()
    if (identity && !this.memory.memory.get(identity)) throw new Error('This remembered person was removed. Choose them again.')
    const binding = this.bindings.get(id)
    // Correcting an automatic match must not rename the other person's saved identity.
    identity ??= binding && (binding.confirmed || binding.person.name === name.trim()) ? binding.person.id : undefined
    this.pendingNames.set(id, { name, identity })
    try { return await this.saveName(id) }
    catch (error) { this.memoryError = (error as Error).message; this.set(this.current); throw error }
  }

  private saveName(id: string): Promise<RememberVoiceResult> {
    const running = this.remembering.get(id)
    if (running) return running.then(() => this.pendingNames.has(id) ? this.saveName(id) : { state: 'remembered', person: this.bindings.get(id)?.person })
    const pending = this.pendingNames.get(id), profile = this.profile(id), memory = this.memory
    if (!memory?.enabled() || !pending) return Promise.resolve({ state: 'off' })
    if (!profile || profile.count < 2 || profile.seconds < 6) return Promise.resolve({ state: 'learning' })
    const namespace = this.namespace
    const task = memory.memory.remember(pending.name, profile.samples, pending.identity).then(person => {
      if (this.namespace === namespace && this.pendingNames.get(id) === pending && memory.enabled()) {
        this.pendingNames.delete(id); this.bindings.set(id, { person, confirmed: true })
        this.clusters.remember(Number(id.split(':').at(-1)), person.id)
        memory.remembered(id, person)
      } else if (this.namespace === namespace && !pending.identity && this.pendingNames.get(id) && !this.pendingNames.get(id)!.identity) {
        // A second explicit name correction while the first save is in flight updates that same person.
        this.pendingNames.get(id)!.identity = person.id
      }
      this.memoryError = undefined
      return { state: 'remembered' as const, person }
    }).finally(() => { if (this.remembering.get(id) === task) this.remembering.delete(id) })
    this.remembering.set(id, task)
    return task
  }

  async merge(from: string, into: string, name?: string): Promise<void> {
    const source = this.canonical(from), target = this.canonical(into)
    if (source === target) return
    const fromPerson = this.bindings.get(source), intoPerson = this.bindings.get(target)
    this.aliases.set(source, target)
    if (source.startsWith(this.namespace + ':') && target.startsWith(this.namespace + ':')) this.clusters.merge(Number(source.split(':').at(-1)), Number(target.split(':').at(-1)))
    const pending = this.pendingNames.get(source)
    if (pending && !this.pendingNames.has(target)) this.pendingNames.set(target, { ...pending, name: name ?? pending.name })
    this.pendingNames.delete(source); this.bindings.delete(source)
    if (this.memory?.enabled()) {
      if (fromPerson && intoPerson && fromPerson.person.id !== intoPerson.person.id) {
        const person = await this.memory.memory.merge(fromPerson.person.id, intoPerson.person.id)
        this.bindings.set(target, { person, confirmed: true }); this.memory.remembered(target, person)
      } else if (fromPerson && !intoPerson) this.bindings.set(target, fromPerson)
      const binding = this.bindings.get(target)
      if (binding) await this.remember(target, name ?? binding.person.name, binding.person.id)
      else if (this.pendingNames.has(target)) await this.saveName(target)
    }
  }
  forget(identity: string): void {
    for (const [voice, binding] of this.bindings) if (binding.person.id === identity) { this.bindings.delete(voice); this.pendingNames.delete(voice) }
    for (const [voice, pending] of this.pendingNames) if (pending.identity === identity) this.pendingNames.delete(voice)
  }
  async memoryChanged(): Promise<void> {
    if (!this.memory?.enabled()) { this.pendingNames.clear(); this.bindings.clear(); return }
    try { await this.memory.memory.load(); this.memoryError = undefined }
    catch (error) { this.memoryError = (error as Error).message }
    this.set(this.current)
  }
  async flush(): Promise<void> {
    while (this.remembering.size) await Promise.allSettled([...this.remembering.values()])
    await this.memory?.memory.flush()
  }
  /** Finish captured final turns at call end; never keep taking audio or wait on a slow download. */
  finish(): Promise<void> {
    if (this.finishing) return this.finishing
    this.queue = this.queue.filter(job => !job.preview)
    if (!this.ready || !this.running && !this.queue.length) { this.stop(); return Promise.resolve() }
    const scope = this.scope
    const task = new Promise<void>(resolve => {
      const timer = setTimeout(() => done(), 1500)
      const done = (): void => {
        clearTimeout(timer); this.drained = undefined
        if (this.scope === scope) this.stop()
        resolve()
      }
      this.drained = done
      this.pump()
    })
    this.finishing = task
    void task.then(() => { if (this.finishing === task) this.finishing = undefined })
    return task
  }
  reset(): void { this.stop(); this.clusters = new VoiceClusters(); this.aliases.clear(); this.bindings.clear(); this.pendingNames.clear(); this.finalized.clear(); this.namespace = randomUUID() }
  stop(): void {
    for (const id of this.splits.keys()) this.resolveSplit(id, [])
    const drained = this.drained; this.drained = undefined
    this.finishing = undefined
    this.scope?.abort(); this.scope = undefined
    const child = this.child; this.child = undefined; child?.kill()
    clearTimeout(this.timer); this.queue = []; this.ready = false; this.running = undefined; this.clusters.breakTurn()
    for (const id of this.previewed) this.memory?.revoked?.(id)
    this.previewed.clear(); this.previewLengths.clear()
    this.set({ state: 'off' })
    drained?.()
  }
}
