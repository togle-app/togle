import { utilityProcess, type UtilityProcess } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { SttStatus } from '@shared/types'
import { libraryEnv, type LocalSpeech } from './install'
import { encodeWav } from './wav'

export const SAMPLE_RATE = 16000

// Whisper invents these on silence or noise; drop them when the clip is short.
const HALLUCINATIONS = new Set([
  'thank you.',
  'thank you',
  'thank you very much.',
  'thanks for watching!',
  'thanks for watching.',
  'thank you for watching.',
  'thank you for watching!',
  'please subscribe.',
  'you',
  'bye.',
  'bye!',
  'okay.',
  'hvala.',
  'hvala na gledanju.',
  'subtitles by the amara.org community'
])

// A segment Whisper itself thinks is probably not speech, and isn't confident about: the rule OpenAI's
// own transcribe() uses to skip silence.
const NO_SPEECH_PROB = 0.6
const LOW_LOGPROB = -1.0
// A request that takes longer than this has hung (normal: well under a second on GPU).
const REQUEST_TIMEOUT_MS = 30_000
// Automatic restarts after crashes; more than this many in the window means something is really wrong.
const MAX_RESTARTS = 4
const RESTART_WINDOW_MS = 5 * 60_000

/**
 * What's left of a transcript once what a recognizer writes for no speech is gone: nothing but punctuation, a sound in
 * brackets ("[Music]"), or a line Whisper invents on silence or noise in a short clip. Empty when nothing was said.
 * Whisper's own, and the speech APIs' (many of them run Whisper too).
 */
export function cleanTranscript(text: string, seconds: number, language: string, dictation = false): string {
  // Language hints must never delete real words when a speaker switches languages.
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean || /^[\s.,!?…-]*$/.test(clean) || /^[[(].*[\])]$/.test(clean)) return ''
  return !dictation && seconds < 3 && HALLUCINATIONS.has(clean.toLowerCase()) ? '' : clean
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

export interface TranscribeOptions {
  dictation?: boolean
  language: string
  /** Names and jargon to spell right; Whisper's initial prompt. */
  prompt?: string
  /** A live preview of an utterance still in progress; dropped when outdated. */
  partial?: boolean
  /** Which audio stream the clip belongs to (a speaker), for dropping outdated previews. */
  stream: string
}

export interface Transcript {
  text: string
  /** The language it was transcribed as (a name like "croatian", or the code from settings). */
  language?: string
}

interface Job {
  pcm: Float32Array
  opts: TranscribeOptions
  resolve: (result: Transcript) => void
  reject: (err: unknown) => void
  retried?: boolean
}

/**
 * The samples as whisper-server reads them from the WAV file it's sent (16-bit, then divided by 32768), so the library
 * hears exactly what the server hears: on a noisy line a difference that small changes the way through the search
 * ("Zap" for "SAP").
 */
function asReadFromWav(pcm: Float32Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    out[i] = Math.round(s < 0 ? s * 0x8000 : s * 0x7fff) / 32768
  }
  return out
}

interface VerboseResult {
  text?: string
  detected_language?: string
  detected_language_probability?: number
  segments?: { text: string; no_speech_prob?: number; avg_logprob?: number }[]
}

/** A clip the library's worker is hearing (macOS), and when to give up on it. */
interface Asked {
  resolve: (result: VerboseResult) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Runs Whisper on this PC: whisper.cpp's HTTP server as a sidecar process where its release has one (Windows, Linux),
 * or, on macOS, whose framework has no server, its library in a utility process of its own. Either way a crash in
 * native code can't take Togle down, and it's started again.
 */
export class LocalWhisper extends EventEmitter {
  private proc: ChildProcess | null = null
  private worker: UtilityProcess | null = null
  private asked: Asked | null = null
  private port = 0
  private current: SttStatus = { state: 'missing' }
  private pending: Job[] = []
  private running = false
  private log: string[] = []
  private stopping = false
  private restarts: number[] = []

  constructor(
    /** What to run, as installed (or set up for development); null while there's nothing to run. */
    private speech: () => LocalSpeech | null
  ) {
    super()
  }

  status(): SttStatus {
    return this.current
  }

  private set(status: SttStatus): void {
    this.current = status
    this.emit('status', status)
  }

  async start(): Promise<void> {
    this.stopping = false
    const local = this.speech()
    const model = local?.whisperModel
    if (!local || !model) {
      this.set({
        state: 'missing',
        detail: "Speech recognition isn't on this PC yet: install it in Settings, or pick OpenAI or a speech server there."
      })
      return
    }
    const exe = local.server
    if (!existsSync(model) || !existsSync(exe ?? local.library)) {
      this.set({ state: 'missing', detail: 'Some of speech recognition is missing from this PC: install it again in Settings.' })
      return
    }

    this.set({ state: 'starting', detail: `Loading ${path.basename(model)}${local.gpu ? ' on GPU' : ''}…` })
    const threads = Math.max(2, Math.min(8, os.availableParallelism() - 2))
    if (!exe) return this.startLibrary(local, model, threads)
    this.port = await freePort()
    const proc = spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(this.port), '-t', String(threads)], {
      cwd: path.dirname(exe),
      env: libraryEnv(path.dirname(exe)),
      windowsHide: true
    })
    this.proc = proc
    const capture = (chunk: Buffer): void => {
      this.log.push(...chunk.toString().split(/\r?\n/).filter(Boolean))
      this.log = this.log.slice(-30)
    }
    proc.stdout?.on('data', capture)
    proc.stderr?.on('data', capture)
    proc.on('exit', (code) => {
      if (this.proc !== proc) return
      this.proc = null
      if (this.stopping) return
      const tail = this.log.filter((l) => /error|fail|cuda/i.test(l)).slice(-3).join(' | ')
      this.restart(`Whisper server exited (code ${code}). ${tail}`.trim())
    })

    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && this.proc === proc) {
      try {
        const res = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(5000) })
        if (res.ok) {
          this.set({ state: 'ready', detail: `${path.basename(model)}${local.gpu ? ' · GPU' : ' · CPU'}` })
          void this.pump()
          return
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    if (this.proc === proc) this.restart('Whisper server did not start within 2 minutes.')
  }

  /** On macOS: whisper.cpp's library, in a utility process that hears one clip at a time. */
  private startLibrary(local: LocalSpeech, model: string, threads: number): void {
    const worker = utilityProcess.fork(
      path.join(__dirname, 'whisper-worker.js'),
      [local.library, local.ggml ?? '', model, local.gpu ? '1' : '0', String(threads)],
      { cwd: local.binDir, env: libraryEnv(local.binDir), serviceName: 'Togle Whisper', stdio: 'ignore' }
    )
    this.worker = worker
    worker.on('message', (msg: { type: string; segments?: VerboseResult['segments']; error?: string; message?: string }) => {
      if (msg.type === 'ready') {
        this.set({ state: 'ready', detail: `${path.basename(model)}${local.gpu ? ' · GPU' : ' · CPU'}` })
        void this.pump()
      } else if (msg.type === 'failed') {
        this.log = [...this.log, msg.message ?? ''].slice(-30)
      } else if (msg.type === 'result' && this.asked) {
        const { resolve, reject, timer } = this.asked
        this.asked = null
        clearTimeout(timer)
        if (msg.error) reject(new Error(msg.error))
        else resolve({ segments: msg.segments })
      }
    })
    worker.on('exit', (code) => {
      if (this.worker !== worker) return
      this.worker = null
      if (this.stopping) return
      this.restart(`Whisper exited (code ${code}). ${this.log.at(-1) ?? ''}`.trim())
    })
  }

  /** Starts it again after a crash or a hang, unless it keeps failing. */
  private restart(reason: string): void {
    console.warn(`[stt] ${reason}`)
    this.halt(new Error(reason))
    const now = Date.now()
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS)
    if (this.restarts.length >= MAX_RESTARTS) {
      this.set({ state: 'error', detail: `${reason} It keeps failing, so transcription is off. Restart Togle to try again.` })
      for (const job of this.pending.splice(0)) job.reject(new Error(reason))
      return
    }
    this.restarts.push(now)
    this.set({ state: 'starting', detail: 'Restarting local Whisper…' })
    setTimeout(() => void this.start(), 1000 * this.restarts.length)
  }

  /** Stops what runs; the clip the library was hearing fails (and is tried again once it's back). */
  private halt(err: Error): void {
    const proc = this.proc
    this.proc = null
    proc?.kill()
    const worker = this.worker
    this.worker = null
    worker?.kill()
    const asked = this.asked
    this.asked = null
    if (asked) {
      clearTimeout(asked.timer)
      asked.reject(err)
    }
  }

  stop(): void {
    this.stopping = true
    this.halt(new Error('Whisper stopped'))
  }

  /**
   * Transcribes audio. Whisper hears one clip at a time, so jobs queue here: finished utterances go first, and a
   * live preview ("partial") of a stream is dropped when a newer one, or the final, arrives.
   */
  transcribe(pcm: Float32Array, opts: TranscribeOptions): Promise<Transcript> {
    return new Promise((resolve, reject) => {
      // While it (re)starts, clips wait for it; when it's missing or gave up, there's nothing to wait for.
      if (this.current.state === 'missing' || this.current.state === 'error') {
        reject(new Error(this.current.detail ?? 'Whisper is not available'))
        return
      }
      // Anything still waiting for the same stream is out of date now.
      this.pending = this.pending.filter((job) => {
        const stale = job.opts.partial && job.opts.stream === opts.stream
        if (stale) job.resolve({ text: '' })
        return !stale
      })
      this.pending.push({ pcm, opts, resolve, reject })
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.running || !this.pending.length || this.current.state !== 'ready') return
    const finalIndex = this.pending.findIndex((job) => !job.opts.partial)
    const [job] = this.pending.splice(finalIndex >= 0 ? finalIndex : 0, 1)
    this.running = true
    try {
      job.resolve(await this.run(job.pcm, job.opts))
    } catch (err) {
      // A finished utterance lost to a crash or hang gets one more try once Whisper is back.
      if (!job.opts.partial && !job.retried && this.status().state !== 'error') {
        job.retried = true
        this.pending.unshift(job)
      } else job.reject(err)
    } finally {
      this.running = false
      void this.pump()
    }
  }

  private async run(pcm: Float32Array, opts: TranscribeOptions): Promise<Transcript> {
    if (this.current.state !== 'ready') throw new Error(this.current.detail ?? 'Whisper is not ready')
    const seconds = pcm.length / SAMPLE_RATE
    const language = opts.language || 'en'
    const result = this.worker ? await this.askLibrary(this.worker, pcm, opts, language) : await this.askServer(pcm, opts, language)
    // Segments are joined as they are: one can end mid-word ("lumin" + "ous").
    const kept = (result.segments ?? [{ text: result.text ?? '' }]).filter(
      (s) => !((s.no_speech_prob ?? 0) > NO_SPEECH_PROB && (s.avg_logprob ?? 0) < LOW_LOGPROB)
    )
    const text = cleanTranscript(kept.map((s) => s.text).join(''), seconds, language, opts.dictation)
    return text ? { text, language } : { text: '' }
  }

  private async askServer(pcm: Float32Array, opts: TranscribeOptions, language: string): Promise<VerboseResult> {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(encodeWav(pcm, SAMPLE_RATE))], { type: 'audio/wav' }), 'clip.wav')
    form.append('response_format', 'verbose_json')
    form.append('temperature', '0.0')
    form.append('language', language)
    // Beam search reads poorly pronounced speech better (24% vs 25% word errors measured) for ~20 ms more;
    // live previews keep the faster greedy search.
    if (!opts.partial) form.append('beam_size', '5')
    // Spelling hints for names and jargon ("Debezyum" → "Debezium").
    if (opts.prompt) form.append('prompt', opts.prompt)
    let res: Response
    try {
      res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') this.restart('Whisper stopped responding.')
      throw err
    }
    if (!res.ok) throw new Error(`Whisper failed (${res.status}): ${await res.text()}`)
    return (await res.json()) as VerboseResult
  }

  /** The library hears a clip as the server would: the same search, temperature and hints (whisper-worker.ts). */
  private askLibrary(worker: UtilityProcess, pcm: Float32Array, opts: TranscribeOptions, language: string): Promise<VerboseResult> {
    return new Promise((resolve, reject) => {
      // A hung native call can't be interrupted: start over, which fails this clip.
      const timer = setTimeout(() => this.restart('Whisper stopped responding.'), REQUEST_TIMEOUT_MS)
      this.asked = { resolve, reject, timer }
      worker.postMessage({ pcm: asReadFromWav(pcm), language, prompt: opts.prompt ?? '', beam: !opts.partial })
    })
  }
}
