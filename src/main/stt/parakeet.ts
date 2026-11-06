import { utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { libraryEnv, type LocalSpeech } from './install'

export const PARAKEET_MODEL = 'ggml-parakeet-tdt-0.6b-v3-q8_0.bin'
const REQUEST_TIMEOUT_MS = 20_000
// Restarts after a crash or a hang: more than this many within the window is a crash loop, and Whisper takes
// over. Counted over a window, so the odd hang in a long session doesn't use them up.
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 5 * 60_000

export interface ParakeetResult {
  text: string
  /** Mean token probability, 0-1: low when it was unsure what it heard. */
  confidence: number
}

interface Job {
  pcm: Float32Array
  partial: boolean
  stream: string
  resolve: (result: ParakeetResult | null) => void
  reject: (err: Error) => void
}

/**
 * NVIDIA's Parakeet TDT, the main speech recognizer: on conversational English with accents (Indian,
 * Eastern European, Spanish, Nigerian…) it missed far less of what was said than Whisper turbo, in about
 * 40 ms per utterance on a GPU, and it doesn't invent text on silence. It runs whisper.cpp's Parakeet library
 * (parakeet.dll, libparakeet.so, or on macOS the framework that has Whisper's functions too) in its own utility
 * process, so a crash in native code can't take Togle down; without the model, or after repeated crashes, Whisper
 * does all the work.
 */
export class LocalParakeet {
  private child: UtilityProcess | null = null
  private ready = false
  private restarts: number[] = []
  private restartTimer: NodeJS.Timeout | undefined
  private stopping = false
  private queue: Job[] = []
  private running: { job: Job; timer: NodeJS.Timeout } | null = null

  constructor(
    private speech: Pick<LocalSpeech, 'binDir' | 'library' | 'ggml' | 'gpu' | 'parakeetModel'>,
    /** Called when it becomes available or stops. */
    private onChange: () => void = () => {}
  ) {}

  get available(): boolean {
    return this.ready
  }

  start(): void {
    if (this.child) return
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    const { binDir, library, ggml, gpu, parakeetModel: model } = this.speech
    if (!model || !existsSync(model) || !existsSync(library)) return
    this.stopping = false
    const child = utilityProcess.fork(path.join(__dirname, 'parakeet-worker.js'), [library, ggml ?? '', model, gpu ? '1' : '0'], {
      cwd: binDir,
      env: libraryEnv(binDir),
      serviceName: 'Togle Parakeet',
      stdio: 'ignore'
    })
    this.child = child
    child.on('message', (msg: { type: string; text?: string; confidence?: number; error?: string; message?: string }) => {
      if (this.child !== child) return
      if (msg.type === 'ready') {
        this.ready = true
        console.info('[stt] Parakeet ready')
        this.onChange()
        this.pump()
      } else if (msg.type === 'failed') {
        console.warn('[stt] Parakeet could not start:', msg.message)
      } else if (msg.type === 'result' && this.running) {
        const { job, timer } = this.running
        clearTimeout(timer)
        this.running = null
        if (msg.error) job.reject(new Error(msg.error))
        else job.resolve({ text: (msg.text ?? '').replace(/\s+/g, ' ').trim(), confidence: msg.confidence ?? 0 })
        this.pump()
      }
    })
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = null
      this.ready = false
      this.onChange()
      this.rejectPending()
      if (this.stopping) return
      const now = Date.now()
      this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
      if (this.restarts.length >= MAX_RESTARTS) {
        console.warn(`[stt] Parakeet exited (code ${code}) too often; Whisper takes over`)
        return
      }
      this.restarts.push(now)
      console.warn(`[stt] Parakeet exited (code ${code}); restarting`)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined
        if (!this.stopping) this.start()
      }, 2000 * this.restarts.length)
    })
  }

  stop(): void {
    this.stopping = true
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.ready = false
    const child = this.child
    this.child = null
    this.rejectPending()
    child?.kill()
    this.onChange()
  }

  /** Release every clip for Whisper to hear instead, without waiting for a native worker to exit. */
  private rejectPending(): void {
    if (this.running) {
      clearTimeout(this.running.timer)
      this.running.job.reject(new Error('Parakeet stopped'))
      this.running = null
    }
    for (const job of this.queue.splice(0)) job.reject(new Error('Parakeet stopped'))
  }

  /**
   * Transcribes a clip. One runs at a time: finished utterances go first, and a live preview is dropped
   * (resolved with null) when a newer one of the same stream, or its final, arrives.
   */
  transcribe(pcm: Float32Array, { partial, stream }: { partial: boolean; stream: string }): Promise<ParakeetResult | null> {
    if (!this.ready) return Promise.reject(new Error('Parakeet is not running'))
    return new Promise((resolve, reject) => {
      this.queue = this.queue.filter((job) => {
        const stale = job.partial && job.stream === stream
        if (stale) job.resolve(null)
        return !stale
      })
      this.queue.push({ pcm, partial, stream, resolve, reject })
      this.pump()
    })
  }

  private pump(): void {
    const child = this.child
    if (this.running || !child || !this.ready || !this.queue.length) return
    const finalIndex = this.queue.findIndex((job) => !job.partial)
    const [job] = this.queue.splice(finalIndex >= 0 ? finalIndex : 0, 1)
    // A hung native call can't be interrupted: start over (the exit handler fails this job).
    const timer = setTimeout(() => child.kill(), REQUEST_TIMEOUT_MS)
    this.running = { job, timer }
    child.postMessage({ id: 0, pcm: job.pcm })
  }
}
