import { randomUUID } from 'node:crypto'
import type { DictationInsertion, DictationReceipt, DictationState, DictationTarget } from '@shared/dictation'
import { abortable, type DictationEngine } from './dictation-speech'

interface DictationOptions {
  target: { capture(): Promise<DictationTarget>; insert(token: string, text: string): Promise<DictationInsertion> }
  speech(): DictationEngine
  changed(state: DictationState): void
  inCall(): boolean
  microphone?(): string
  now?: () => number
  completed?(receipt: DictationReceipt, speech: DictationEngine): void
}
interface Job {
  id: string; target: DictationTarget; controller: AbortController; queue: Promise<void>; parts: string[]
  targetReady: Promise<void>; targetResolved?: boolean; targetRevision?: number
  samples: number; pending: number; failed?: string; start?: number; end?: number; finalizing?: boolean
  cleanup?: AbortController; original?: boolean
  speech: DictationEngine
}

/** Dictation is independent of agents and calls. A cancelled job can never deliver into a later target. */
export class Dictation {
  private current: DictationState = { phase: 'idle' }
  private job?: Job
  private timer?: NodeJS.Timeout
  private captureDeadline?: NodeJS.Timeout
  private intervals: { start: number; end?: number }[] = []
  private now: () => number
  constructor(private options: DictationOptions) { this.now = options.now ?? Date.now }
  status(): DictationState { return { ...this.current } }
  private set(patch: Partial<DictationState>): void { this.current = { ...this.current, ...patch }; this.options.changed(this.status()) }
  get active(): boolean { return ['starting', 'recording', 'finishing', 'polishing', 'inserting'].includes(this.current.phase) }
  async toggle(): Promise<void> {
    if (this.current.phase === 'recording') { this.stop(); return }
    // Repeated shortcuts while opening or processing must not discard the user's words.
    if (this.active) return
    await this.start()
  }
  async start(hold = false): Promise<void> {
    if (this.active) return
    const id = randomUUID(), start = this.now()
    this.job?.controller.abort(); this.job?.speech.dispose?.()
    this.job = undefined
    let speech: DictationEngine
    try { speech = this.options.speech() }
    catch (error) { this.set({ phase: 'error', id, text: undefined, message: (error as Error).message, preparing: false }); return }
    const job: Job = this.job = { id, speech, target: { label: 'Your text box' }, controller: new AbortController(), queue: Promise.resolve(), targetReady: Promise.resolve(), parts: [], samples: 0, pending: 0, start }
    this.intervals.push({ start }); this.intervals = this.intervals.slice(-32)
    // Capture immediately. Setup runs in parallel; the bounded audio queue preserves early words.
    // Install the readiness barrier before notifying the renderer so even an immediate chunk waits for it.
    job.targetReady = this.captureTarget(job)
    // A slow desktop app must not hold up speech recognition and fill its audio queue.
    const setupSignal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(15_000)])
    job.queue = abortable(Promise.resolve().then(() => { setupSignal.throwIfAborted(); return job.speech.ready(job.controller.signal) }), setupSignal).then(() => {
      if (this.job === job && !job.controller.signal.aborted) this.set({ preparing: false })
    }).catch(error => {
      if (this.job === job && !job.controller.signal.aborted) this.failed(id, error?.name === 'TimeoutError' ? 'Speech setup took too long. Check your connection or subscription in Settings.' : (error as Error).message)
    })
    this.set({ phase: 'recording', id, hold, streaming: !!speech.streaming, text: undefined, outcome: undefined, message: undefined, destination: undefined, preparing: true, microphoneId: this.options.microphone?.() || '', startedAt: start, inCall: this.options.inCall() })
    this.timer = setTimeout(() => this.stop(), 120_000)
    this.timer.unref?.()
    await Promise.all([job.queue, job.targetReady])
  }
  private captureTarget(job: Job): Promise<void> {
    const revision = job.targetRevision = (job.targetRevision ?? 0) + 1
    job.targetResolved = false
    return abortable(Promise.resolve().then(() => { job.controller.signal.throwIfAborted(); return this.options.target.capture() }), job.controller.signal)
      .catch(() => ({ label: 'Your text box', reason: 'Automatic insertion is unavailable. Your text will be ready to copy.' }))
      .then(target => {
        if (this.job !== job || job.controller.signal.aborted || job.targetRevision !== revision) return
        job.target = target; job.targetResolved = true
        this.set({ destination: target.label, ...(this.current.phase === 'recording' ? { message: target.reason } : {}) })
      })
  }
  private endInterval(): void { const interval = this.intervals.at(-1); if (interval && interval.end === undefined) interval.end = this.now() }
  /** Keep private dictation out of meeting prompts, including a late final segment containing that interval. */
  overlaps(start: number, end: number): boolean { return this.intervals.some(interval => start <= (interval.end ?? this.now()) && end >= interval.start) }
  stop(): void {
    if (this.current.phase !== 'recording') return
    if (this.current.hold && this.job) this.job.targetReady = this.captureTarget(this.job)
    clearTimeout(this.timer)
    this.endInterval()
    this.set({ phase: 'finishing', message: 'Transcribing…' })
    // The capture page flushes its last chunk before acknowledging stop.
    this.captureDeadline = setTimeout(() => this.failed(this.job?.id ?? '', 'The microphone did not finish. Try dictation again.'), 8000)
    this.captureDeadline.unref?.()
  }
  push(id: string, pcm: Float32Array): void {
    const job = this.job
    if (!job || id !== job.id || !['recording', 'finishing'].includes(this.current.phase) || job.finalizing) return
    if (!(pcm instanceof Float32Array) || pcm.length > 30 * 16000 || !pcm.length || !pcm.every(Number.isFinite)) return
    if (job.samples + pcm.length > 125 * 16000 || job.pending >= (job.speech.streaming ? 150 : 8)) { this.failed(id, 'Dictation could not keep up. Try a shorter phrase.'); return }
    job.samples += pcm.length; job.pending++
    const input = pcm.slice()
    job.queue = job.queue.then(async () => {
      if (job.controller.signal.aborted) return
      if (job.speech.streaming) { job.speech.push!(input); return }
      const result = await job.speech.transcribe(input, job.controller.signal)
      if (!job.controller.signal.aborted && this.job === job && result.trim()) job.parts.push(result.trim())
    }).catch(error => {
      if (this.job === job && !job.controller.signal.aborted) { job.failed = (error as Error).message; this.failed(id, job.failed) }
    }).finally(() => { job.pending-- })
  }
  async finish(id: string): Promise<void> {
    const job = this.job
    if (!job || job.id !== id || job.finalizing || this.current.phase !== 'finishing') return
    job.finalizing = true; clearTimeout(this.captureDeadline)
    await job.queue
    if (this.job !== job || job.controller.signal.aborted || job.failed) return
    if (job.speech.streaming) {
      try { const text = await job.speech.finish!(job.controller.signal); if (text.trim()) job.parts.push(text.trim()) }
      catch (error) { this.failed(id, (error as Error).message); return }
    }
    if (this.job !== job || job.controller.signal.aborted) return
    const raw = job.parts.join(' ').trim()
    if (!raw) {
      job.speech.dispose?.()
      this.set({ phase: 'ready', message: 'No speech heard. Try again.', text: undefined })
      // An empty attempt is a brief dictation status, not a persistent call warning.
      this.timer = setTimeout(() => { if (this.job === job && this.current.phase === 'ready' && !this.current.text) this.dispose() }, 2500)
      this.timer.unref?.()
      return
    }
    this.set({ ...(job.speech.polishes !== false ? { phase: 'polishing' as const } : {}), text: raw, lastText: raw, message: job.speech.polishes !== false ? 'Cleaning up your text…' : 'Preparing text…' })
    let text = raw, polishFailed = false
    job.cleanup = new AbortController()
    const cleanupSignal = AbortSignal.any([job.controller.signal, job.cleanup.signal])
    try { const cleaned = await abortable(job.speech.polish(raw, cleanupSignal), cleanupSignal); text = cleaned.trim() ? cleaned : raw } catch { polishFailed = !job.original; text = job.speech.format?.(raw) ?? raw }
    if (this.job !== job || job.controller.signal.aborted) return
    // Cleanup and destination capture overlap; a slow text field must not delay the model.
    if (!job.targetResolved) this.set({ message: 'Finding your text box…' })
    await job.targetReady
    if (this.job !== job || job.controller.signal.aborted) return
    job.speech.dispose?.()
    this.set({ text, lastText: text })
    if (!job.target.token) { this.set({ phase: 'ready', message: job.target.reason || 'Text is ready. Copy it into your text box.' }); this.receipt(job, raw, text, 'ready'); return }
    this.set({ phase: 'inserting', message: 'Entering text…' })
    // Once insertion begins it is a single commit, never retried by a late callback or another shortcut.
    try {
      const result = await this.options.target.insert(job.target.token, text)
      if (this.job !== job) return
      this.set({ phase: result.inserted ? 'done' : 'ready', outcome: result.inserted ? 'inserted' : undefined, message: result.inserted ? result.message || (polishFailed || job.original ? 'Original words entered' : 'Text entered') : result.message || 'Text ready. The destination changed; copy it where you need it.' })
      this.receipt(job, raw, text, result.inserted ? 'inserted' : 'ready')
    } catch { if (this.job === job) { this.set({ phase: 'ready', message: 'Could not confirm insertion. Check your text box before copying.' }); this.receipt(job, raw, text, 'ready') } }
  }
  private receipt(job: Job, originalText: string, text: string, outcome: DictationReceipt['outcome']): void {
    // History is outside the insertion path; saving can never delay delivery or retry insertion.
    try { this.options.completed?.({ id: job.id, revision: randomUUID(), startedAt: job.start!, finishedAt: this.now(), originalText, text, destination: job.target.label, outcome }, job.speech) }
    catch (error) { console.warn('[dictation history]', (error as Error).message) }
  }
  useOriginal(id: string): void {
    const job = this.job
    if (this.current.phase !== 'polishing' || job?.id !== id || !job.cleanup) return
    job.original = true; job.cleanup.abort(new Error('Use the original words.'))
  }
  copied(id: string | undefined, text: string): void {
    if (this.current.id === id && this.current.text === text && ['ready', 'error'].includes(this.current.phase)) {
      this.set({ phase: 'done', outcome: 'copied', message: 'Copied to clipboard' })
    }
  }
  copyFailed(id: string | undefined, text: string): void {
    if (!this.active && this.current.id === id && this.current.lastText === text) {
      this.set({ phase: 'ready', text, message: 'Could not copy. Your text is still here; try again.' })
    }
  }
  failed(id: string, message: string): void {
    if (!this.job || this.job.id !== id || !['recording', 'finishing'].includes(this.current.phase)) return
    const text = this.job.parts.join(' ').trim()
    this.job.controller.abort(); this.job.speech.dispose?.(); clearTimeout(this.timer); clearTimeout(this.captureDeadline); this.endInterval()
    this.set({ phase: 'error', message, preparing: false, ...(text ? { text, lastText: text } : {}) })
  }
  cancel(): void {
    if (this.current.phase === 'inserting') return
    this.dispose()
  }
  /** App shutdown also abandons an in-flight insertion result; it must not recreate the bar. */
  dispose(): void {
    this.job?.controller.abort(); this.job?.speech.dispose?.(); this.job = undefined
    clearTimeout(this.timer); clearTimeout(this.captureDeadline); this.endInterval()
    this.set({ phase: 'idle', id: undefined, text: undefined, message: undefined, startedAt: undefined, preparing: false, outcome: undefined })
  }
}
