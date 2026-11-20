import { randomUUID } from 'node:crypto'
import type { DictationInsertion, DictationReceipt, DictationState, DictationTarget } from '@shared/dictation'
import { abortable, asHeardBecause, type DictationEngine } from './dictation-speech'

interface DictationOptions {
  target: {
    capture(): Promise<DictationTarget>
    insert(token: string, text: string): Promise<DictationInsertion>
    /** F8 Show: the picture goes into the same box first (in a terminal, its path is typed). */
    insertPicture?(token: string, file: string): Promise<DictationInsertion>
  }
  speech(): DictationEngine
  changed(state: DictationState): void
  inCall(): boolean
  microphone?(): string
  now?: () => number
  completed?(receipt: DictationReceipt, speech: DictationEngine): void
  /** Puts words on the clipboard, for a box Togle cannot type into. */
  copy?(text: string): void | Promise<void>
  copyPicture?(file: string, words: string, terminal?: boolean): Promise<void>
}
interface Job {
  id: string; target: DictationTarget; controller: AbortController; queue: Promise<void>; parts: string[]
  targetReady: Promise<void>; targetResolved?: boolean; targetRevision?: number
  samples: number; pending: number; failed?: string; start?: number; end?: number; finalizing?: boolean
  cleanup?: AbortController; original?: boolean
  speech: DictationEngine
  /** F8 Show: the picture saved for this dictation, which lands with its words. */
  picture?: string
  show?: { target: Promise<DictationTarget>; picture: Promise<string | null> }
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
  async start(hold = false, show?: Job['show']): Promise<void> {
    if (this.active) return
    const id = randomUUID(), start = this.now()
    this.job?.controller.abort(); this.job?.speech.dispose?.()
    this.job = undefined
    let speech: DictationEngine
    try { speech = this.options.speech() }
    catch (error) {
      const message = (error as Error).message
      this.set({ phase: 'error', id, show: !!show, picture: undefined, text: undefined, outcome: undefined, message, preparing: false })
      if (show) void this.recoverPicture(id, show, message)
      return
    }
    const job: Job = this.job = { id, speech, show, target: { label: 'Your text box' }, controller: new AbortController(), queue: Promise.resolve(), targetReady: Promise.resolve(), parts: [], samples: 0, pending: 0, start }
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
    this.set({ phase: 'recording', id, hold, show: !!show, picture: undefined, streaming: !!speech.streaming, text: undefined, outcome: undefined, message: undefined, destination: undefined, preparing: true, microphoneId: this.options.microphone?.() || '', startedAt: start, inCall: this.options.inCall() })
    if (!show) {
      this.timer = setTimeout(() => this.stop(), 120_000)
      this.timer.unref?.()
    }
    await Promise.all([job.queue, job.targetReady])
  }
  private captureTarget(job: Job): Promise<void> {
    const revision = job.targetRevision = (job.targetRevision ?? 0) + 1
    job.targetResolved = false
    return abortable(job.show?.target ?? Promise.resolve().then(() => { job.controller.signal.throwIfAborted(); return this.options.target.capture() }), job.controller.signal)
      .catch(() => ({ label: 'Your text box', reason: 'Automatic insertion is unavailable. Your text will be ready to copy.' }))
      .then(target => {
        if (this.job !== job || job.controller.signal.aborted || job.targetRevision !== revision) return
        job.target = target; job.targetResolved = true
        this.set({ destination: target.label, ...(this.current.phase === 'recording' ? { message: target.reason } : {}) })
      })
  }
  /** A hold that let go at once, where a key's state may not be readable: dictation stays on until the next press. */
  keepOn(id: string): void {
    if (this.current.phase === 'recording' && this.current.id === id && this.current.hold) this.set({ hold: false })
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
    if ((!job.show && job.samples + pcm.length > 125 * 16000) || job.pending >= (job.speech.streaming ? 150 : 8)) { this.failed(id, 'Dictation could not keep up. Try a shorter phrase.'); return }
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
    if (job.show) {
      const file = await job.show.picture
      if (this.job !== job || job.controller.signal.aborted) return
      if (!file) { this.cancel(); return }
      job.picture = file
    }
    const raw = job.parts.join(' ').trim()
    // A picture with nothing said still lands.
    if (!raw && job.picture) {
      job.speech.dispose?.()
      await job.targetReady
      if (this.job === job && !job.controller.signal.aborted) await this.deliverShow(id, job.target, job.picture, '')
      return
    }
    if (!raw) {
      job.speech.dispose?.()
      this.set({ phase: 'ready', message: 'No speech heard. Try again.', text: undefined })
      // An empty attempt is a brief dictation status, not a persistent call warning.
      this.timer = setTimeout(() => { if (this.job === job && this.current.phase === 'ready' && !this.current.text) this.dispose() }, 2500)
      this.timer.unref?.()
      return
    }
    this.set({ ...(job.speech.polishes !== false ? { phase: 'polishing' as const } : {}), text: raw, lastText: raw, message: job.speech.polishes !== false ? 'Cleaning up your text…' : 'Preparing text…' })
    // With no internet, or a plan at its limit, the words go in as heard and the bar says why.
    let text = raw, asHeard: string | undefined
    job.cleanup = new AbortController()
    const cleanupSignal = AbortSignal.any([job.controller.signal, job.cleanup.signal])
    try { const cleaned = await abortable(job.speech.polish(raw, cleanupSignal), cleanupSignal); text = cleaned.trim() ? cleaned : raw } catch (error) { if (!job.original) asHeard = asHeardBecause(error); text = job.speech.format?.(raw) ?? raw }
    if (this.job !== job || job.controller.signal.aborted) return
    // Cleanup and destination capture overlap; a slow text field must not delay the model.
    if (!job.targetResolved) this.set({ message: 'Finding your text box…' })
    await job.targetReady
    if (this.job !== job || job.controller.signal.aborted) return
    job.speech.dispose?.()
    this.set({ text, lastText: text })
    if (job.picture) {
      const inserted = await this.deliverShow(id, job.target, job.picture, text, job.speech.asHeard || asHeard)
      if (this.job === job) this.receipt(job, raw, text, inserted ? 'inserted' : 'ready')
      return
    }
    let insertionProblem: string | undefined
    if (job.target.token) {
      this.set({ phase: 'inserting', message: 'Entering text…' })
      let result: DictationInsertion
      try { result = await this.options.target.insert(job.target.token, text) }
      catch { result = { inserted: false, message: 'Could not confirm insertion. Check your text box before pasting.' } }
      if (this.job !== job) return
      if (result.inserted) {
        this.set({ phase: 'done', outcome: 'inserted', message: result.message || job.speech.asHeard || asHeard || (job.original ? 'Original words entered' : 'Text entered') })
        this.receipt(job, raw, text, 'inserted')
        return
      }
      insertionProblem = result.message || 'The original text field is unavailable.'
    }
    // An unavailable destination gets one clipboard copy. Terminal pastes must stay on one line.
    if (this.options.copy) {
      const words = job.target.terminal ? text.replace(/\s*[\r\n]+\s*/g, ' ').replace(/\t/g, ' ').trim() : text
      const why = job.target.copyReason ?? "that window runs as administrator, so Togle can't type there."
      try {
        await this.options.copy(words)
        if (this.job !== job) return
        const paste = `Press ${process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'} to paste.`
        const message = job.target.copy ? `Copied: ${why} ${paste}` : insertionProblem ? 'Check the original field before pasting. ' + paste : paste
        this.set({ phase: job.target.copy ? 'done' : 'ready', outcome: 'copied', text: words, lastText: words, message })
      } catch {
        if (this.job !== job) return
        this.set({ phase: 'ready', text: words, lastText: words, message: !job.target.copy || job.target.copyReason
          ? "The clipboard didn't take the words. Copy them from here."
          : "That window runs as administrator, so Togle can't type there, and the clipboard didn't take the words. Copy them from here." })
      }
      this.receipt(job, raw, words, 'ready')
      return
    }
    this.set({ phase: 'ready', message: insertionProblem || job.target.reason || 'Text is ready. Copy it into your text box.' })
    this.receipt(job, raw, text, 'ready')
  }
  /** Settle one F8 capture once. An unavailable field leaves the complete result on the clipboard and in the bar. */
  private async deliverShow(id: string, target: DictationTarget, file: string, words: string, enteredMessage?: string, speechError?: string): Promise<boolean> {
    if (this.current.id !== id) return false
    this.set({ phase: 'inserting', message: target.token ? 'Inserting screenshot…' : 'Copying screenshot…' })
    let pictureEntered = false
    if (target.token && this.options.target.insertPicture && !(speechError && words)) {
      try {
        pictureEntered = (await this.options.target.insertPicture(target.token, file)).inserted
        if (this.current.id !== id) return false
        if (pictureEntered && (!words || (await this.options.target.insert(target.token, words)).inserted)) {
          if (this.current.id !== id) return false
          this.set({ phase: 'done', outcome: 'inserted', message: [enteredMessage || (words ? 'Screenshot and text entered' : 'Picture entered'), speechError].filter(Boolean).join('. ') })
          return true
        }
      } catch { /* The saved capture is still available when the destination disappears. */ }
    }
    if (this.current.id !== id) return false
    let copied = false
    try {
      if (this.options.copyPicture) { await this.options.copyPicture(file, words, target.terminal); copied = true }
    } catch { /* The bar keeps the same file and words for a retry. */ }
    if (this.current.id !== id) return false
    const paste = process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
    const instruction = copied ? `Press ${paste} to paste.` : 'The clipboard is unavailable. Use Copy to try again.'
    this.set({ phase: 'ready', picture: file, text: words || undefined, ...(words ? { lastText: words } : {}),
      outcome: copied ? 'copied' : undefined, message: [pictureEntered ? 'The screenshot was already sent to the original field.' : '', speechError, instruction].filter(Boolean).join(' ') })
    return false
  }
  /** A manual copy dismisses this result only once the clipboard accepts both parts. */
  async copyHeldPicture(): Promise<void> {
    const { id, picture, text } = this.current
    if (this.current.phase !== 'ready' || !picture || !this.options.copyPicture) throw new Error('There is no screenshot ready to copy.')
    this.set({ phase: 'inserting', message: 'Copying screenshot…' })
    try { await this.options.copyPicture(picture, text || '', this.job?.target.terminal) }
    catch (error) {
      if (this.current.id === id && this.current.picture === picture) this.set({ phase: 'ready', outcome: undefined, message: 'The clipboard is unavailable. Use Copy to try again.' })
      throw error
    }
    if (this.current.id === id && this.current.picture === picture) this.set({ phase: 'done', picture: undefined, outcome: 'copied', message: 'Copied to clipboard.' })
  }
  /** If speech fails, the second Show press can still deliver the finished screenshot and keep any partial words. */
  private async recoverPicture(id: string, show: NonNullable<Job['show']>, message: string): Promise<void> {
    const [file, target] = await Promise.all([show.picture, show.target])
    if (!file || this.current.id !== id || this.current.phase !== 'error') return
    await this.deliverShow(id, target, file, this.current.text || '', undefined, message)
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
      this.set({ phase: 'done', outcome: 'copied', message: `Copied. Press ${process.platform === 'darwin' ? '⌘V' : 'Ctrl+V'} to paste.` })
    }
  }
  pasted(id: string): void {
    if (this.current.id === id && this.current.outcome === 'copied' && ['ready', 'done'].includes(this.current.phase)) this.dispose()
  }
  copyFailed(id: string | undefined, text: string): void {
    if (!this.active && this.current.id === id && this.current.lastText === text) {
      this.set({ phase: 'ready', outcome: undefined, text, message: 'Could not copy. Your text is still here; try again.' })
    }
  }
  failed(id: string, message: string): void {
    const job = this.job
    if (!job || job.id !== id || !['recording', 'finishing'].includes(this.current.phase)) return
    const text = job.parts.join(' ').trim()
    job.controller.abort(); job.speech.dispose?.(); clearTimeout(this.timer); clearTimeout(this.captureDeadline); this.endInterval()
    this.set({ phase: 'error', message, preparing: false, ...(text ? { text, lastText: text } : {}) })
    if (job.show) void this.recoverPicture(id, job.show, message)
  }
  cancel(): void {
    if (this.current.phase === 'inserting') return
    this.dispose()
  }
  /** App shutdown also abandons an in-flight insertion result; it must not recreate the bar. */
  dispose(): void {
    this.job?.controller.abort(); this.job?.speech.dispose?.(); this.job = undefined
    clearTimeout(this.timer); clearTimeout(this.captureDeadline); this.endInterval()
    this.set({ phase: 'idle', id: undefined, show: false, picture: undefined, text: undefined, message: undefined, startedAt: undefined, preparing: false, outcome: undefined })
  }
}
