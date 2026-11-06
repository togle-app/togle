import type { SegmentKind, Speaker } from '@shared/types'
import { NoiseCheck } from './noise-check'
// A plain static file (src/renderer/public), not a bundled module: the dev server's transform step
// stalled on it, and an AudioWorklet needs nothing but the file itself. Resolved when audio starts, so the
// Segmenter can also be loaded outside a page (the tests).
const tapUrl = (): string => new URL('pcm-tap.js', document.baseURI).href

const SAMPLE_RATE = 16000
const FRAME = 512
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000
const START_FRAMES = 3 // ~100 ms of sound before we call it speech
const PREROLL_FRAMES = 10 // keep ~320 ms before the trigger so first syllables survive
const END_SILENCE_MS = 600
const MIN_SEGMENT_MS = 600
// A breath between sentences, well before END_SILENCE_MS: what they said may already be a whole question, so
// it's transcribed now and an answer can start while the end-of-speech wait runs (Copilot.anticipate).
const PAUSE_FRAMES = 8 // ~256 ms
// Long monologues: past the soft limit a shorter pause ends the utterance; at the hard limit it's cut at
// the quietest moment of the last stretch, never mid-word. Whisper reads up to 30 s at once.
const SOFT_MAX_MS = 15_000
const SOFT_END_SILENCE_MS = 250
const HARD_MAX_MS = 28_000
const CUT_SEARCH_FRAMES = 47 // ~1.5 s
// A sound that never pauses for this long (a fan, music) isn't speech: the noise floor catches up with it.
const NO_DIP_MS = 8_000
// Live captions: the first comes this soon after someone starts talking, then the utterance so far is
// re-transcribed this often while they keep going.
const FIRST_PARTIAL_MS = 700
const PARTIAL_EVERY_MS = 1000

/** A finished utterance, a live preview of one still in progress, or the utterance so far at a pause. */
export type SegmentHandler = (speaker: Speaker, pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind) => void

function joinFrames(frames: Float32Array[]): Float32Array {
  const pcm = new Float32Array(frames.length * FRAME)
  frames.forEach((f, i) => pcm.set(f, i * FRAME))
  return pcm
}

/** Energy-based voice activity detection that cuts a continuous stream into utterances. */
export class Segmenter {
  level = 0
  private noise = 0.004
  private speaking = false
  private loud = 0
  private quiet = 0
  private frames: Float32Array[] = []
  /** Level of each frame in `frames`, for finding a quiet place to cut. */
  private levels: number[] = []
  private preroll: Float32Array[] = []
  private startedAt = 0
  private segmentId = ''
  private lastPartial = 0
  /** Frames since the level last dipped below the threshold during speech. */
  private sinceDip = 0
  /** A pause was reported, and they haven't spoken since. */
  private paused = false

  constructor(
    private onSegment: (pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind) => void,
    private livePreview: boolean,
    private minSegmentMs = MIN_SEGMENT_MS
  ) {}

  /** Someone is speaking on this source now. */
  get active(): boolean {
    return this.speaking
  }

  push(frame: Float32Array): void {
    let sum = 0
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
    const rms = Math.sqrt(sum / frame.length)
    this.level = rms
    const threshold = Math.max(this.noise * 3, 0.006)

    if (!this.speaking) {
      // Track the noise floor while nobody talks: follow drops quickly, rises slowly.
      this.noise = rms < this.noise ? this.noise * 0.9 + rms * 0.1 : this.noise * 0.998 + rms * 0.002
      this.preroll.push(frame)
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift()
      this.loud = rms > threshold ? this.loud + 1 : 0
      if (this.loud >= START_FRAMES) this.begin(this.preroll, Date.now() - this.preroll.length * FRAME_MS)
      return
    }

    this.frames.push(frame)
    this.levels.push(rms)
    this.quiet = rms > threshold * 0.7 ? 0 : this.quiet + 1
    this.sinceDip = rms > threshold ? this.sinceDip + 1 : 0
    // Speech always has gaps; a level that never dips is a fan or music that started: adopt it as the floor.
    if (this.sinceDip * FRAME_MS >= NO_DIP_MS) {
      this.noise = Math.min(...this.levels.slice(-this.sinceDip)) / 2
      this.sinceDip = 0
    }
    const length = this.frames.length * FRAME_MS
    const endSilence = length >= SOFT_MAX_MS ? SOFT_END_SILENCE_MS : END_SILENCE_MS
    if (this.quiet * FRAME_MS >= endSilence) {
      this.flush()
      return
    }
    if (length >= HARD_MAX_MS) {
      this.cutAtQuietest()
      return
    }
    if (!this.livePreview) return
    if (this.quiet === PAUSE_FRAMES && length >= MIN_SEGMENT_MS) {
      this.paused = true
      this.onSegment(joinFrames(this.frames), this.startedAt, this.segmentId, 'pause')
    } else if (this.quiet === 0 && (this.paused || Date.now() - this.lastPartial >= PARTIAL_EVERY_MS)) {
      // Talking again after a pause: a caption right away tells main that an answer started there was early.
      this.paused = false
      this.lastPartial = Date.now()
      this.onSegment(joinFrames(this.frames), this.startedAt, this.segmentId, 'partial')
    }
  }

  private begin(frames: Float32Array[], startedAt: number, levels: number[] = []): void {
    this.speaking = true
    this.frames = frames
    this.levels = levels.length ? levels : frames.map(() => 0)
    this.preroll = []
    this.quiet = 0
    this.sinceDip = 0
    this.paused = false
    this.startedAt = startedAt
    this.segmentId = crypto.randomUUID()
    this.lastPartial = Date.now() - (PARTIAL_EVERY_MS - FIRST_PARTIAL_MS)
  }

  /** Someone has talked for the longest Whisper reads at once: end at the quietest recent moment, continue after it. */
  private cutAtQuietest(): void {
    const from = Math.max(1, this.levels.length - CUT_SEARCH_FRAMES)
    let cut = from
    for (let i = from; i < this.levels.length; i++) if (this.levels[i] < this.levels[cut]) cut = i
    const rest = this.frames.slice(cut)
    const restLevels = this.levels.slice(cut)
    this.onSegment(joinFrames(this.frames.slice(0, cut)), this.startedAt, this.segmentId, 'final')
    this.begin(rest, this.startedAt + cut * FRAME_MS, restLevels)
  }

  flush(): void {
    if (!this.speaking) return
    this.speaking = false
    this.loud = 0
    // Drop most of the trailing silence, keep ~200 ms of tail.
    const keep = this.frames.length - Math.max(0, this.quiet - 6)
    const frames = this.frames.slice(0, keep)
    this.frames = []
    this.levels = []
    // Too short to be speech: still report it (empty) so a live caption for it disappears.
    if (frames.length * FRAME_MS < this.minSegmentMs) {
      if (this.livePreview) this.onSegment(new Float32Array(0), this.startedAt, this.segmentId, 'final')
      return
    }
    this.onSegment(joinFrames(frames), this.startedAt, this.segmentId, 'final')
  }
}

interface Source {
  speaker: Speaker
  segmenter: Segmenter
  stop(): void
}

const WORKLET_TIMEOUT_MS = 8000

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One audio engine for both sources, with the PCM tap loaded once. A stalled load must not leave
 * "Starting…" up forever: time out, retry once under a fresh URL (Chromium queues repeat requests for
 * the same URL behind a stuck one), then fail with a clear message.
 */
async function openEngine(): Promise<AudioContext> {
  // Native device rate on purpose; the tap converts to 16 kHz (see public/pcm-tap.js).
  const ctx = new AudioContext()
  try {
    try {
      await withTimeout(ctx.audioWorklet.addModule(tapUrl()), WORKLET_TIMEOUT_MS, 'Loading the audio processor')
    } catch {
      const url = tapUrl()
      const fresh = `${url}${url.includes('?') ? '&' : '?'}retry=${Date.now()}`
      await withTimeout(ctx.audioWorklet.addModule(fresh), WORKLET_TIMEOUT_MS, 'Loading the audio processor')
    }
    await withTimeout(ctx.resume(), WORKLET_TIMEOUT_MS, 'Starting audio')
    return ctx
  } catch (err) {
    void ctx.close()
    throw err
  }
}

/** Loads the audio processor once at launch, so pressing Start doesn't wait on the first load. */
export async function warmUpAudio(): Promise<void> {
  const ctx = await openEngine()
  await ctx.close()
}

function openSource(ctx: AudioContext, speaker: Speaker, stream: MediaStream, onSegment: SegmentHandler): Source {
  const input = ctx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' })
  // The graph must reach the destination to be pulled; a zero gain keeps it silent.
  const mute = ctx.createGain()
  mute.gain.value = 0
  input.connect(tap).connect(mute).connect(ctx.destination)

  // Live captions for the other side only: their questions are what Togle answers, and it halves the GPU work.
  const segmenter = new Segmenter(
    (pcm, startedAt, segmentId, kind) => onSegment(speaker, pcm, startedAt, segmentId, kind),
    speaker === 'them'
  )
  tap.port.onmessage = (e: MessageEvent<Float32Array>) => segmenter.push(e.data)
  return {
    speaker,
    segmenter,
    stop() {
      segmenter.flush()
      tap.port.onmessage = null
      input.disconnect()
      tap.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((t) => t.stop())
    }
  }
}

interface NoiseTap { stop(): void }

/**
 * The microphone as it is, to measure its background: without noise suppression or automatic gain. Echo cancellation
 * stays on, so the other side heard from the speakers isn't measured as the user's background.
 */
export async function openRawMic(): Promise<MediaStream> {
  const base = { noiseSuppression: false, autoGainControl: false, channelCount: 1 }
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: 'all' as unknown as boolean } })
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: true } })
  }
}

/** Feeds a stream's 16 kHz frames to a noise check, through the same PCM tap as the call. */
export function openNoiseTap(ctx: AudioContext, stream: MediaStream, check: { push(frame: Float32Array): void }, paused: () => boolean = () => false): NoiseTap {
  const input = ctx.createMediaStreamSource(stream)
  const tap = new AudioWorkletNode(ctx, 'pcm-tap', { channelCount: 1, channelCountMode: 'explicit' })
  const mute = ctx.createGain()
  mute.gain.value = 0
  input.connect(tap).connect(mute).connect(ctx.destination)
  tap.port.onmessage = (e: MessageEvent<unknown>) => { if (e.data instanceof Float32Array && !paused()) check.push(e.data) }
  return {
    stop() {
      tap.port.onmessage = null
      input.disconnect()
      tap.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((t) => t.stop())
    }
  }
}

const QUIET_CHECK_MS = 4_500
const SPEAK_CHECK_MS = 5_500
/** The first moments after the microphone opens (a click, the gain settling) aren't the room. */
const CHECK_SETTLE_MS = 500

/**
 * The microphone check in Settings: a few seconds of quiet, then a sentence, measured like a call (noise-check.ts).
 * Returns the measurement and the quiet seconds, to play back; nothing is kept after that.
 */
export async function checkMicrophone(onPhase: (phase: 'quiet' | 'speak') => void, signal: AbortSignal): Promise<ReturnType<NoiseCheck['report']> & { quietSample?: Float32Array }> {
  const ctx = await openEngine()
  let tap: NoiseTap | undefined
  try {
    const stream = await openRawMic()
    if (signal.aborted) { stream.getTracks().forEach((t) => t.stop()); throw new Error('Cancelled') }
    const check = new NoiseCheck()
    const quiet: Float32Array[] = []
    let phase: 'settle' | 'quiet' | 'speak' = 'settle'
    tap = openNoiseTap(ctx, stream, { push(frame) {
      if (phase === 'settle') return
      check.push(frame)
      if (phase === 'quiet') quiet.push(frame)
    } })
    const wait = (ms: number): Promise<void> => new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Cancelled')) }, { once: true })
    })
    onPhase('quiet')
    await wait(CHECK_SETTLE_MS)
    phase = 'quiet'
    await wait(QUIET_CHECK_MS - CHECK_SETTLE_MS)
    phase = 'speak'
    onPhase('speak')
    await wait(SPEAK_CHECK_MS)
    const report = check.report(true)
    const quietSample = new Float32Array(quiet.reduce((n, f) => n + f.length, 0))
    let at = 0
    for (const frame of quiet) { quietSample.set(frame, at); at += frame.length }
    return { ...report, sample: undefined, quietSample: quietSample.length ? quietSample : undefined }
  } finally {
    tap?.stop()
    void ctx.close()
  }
}

/** Dev only (test runs, TOGLE_SILENT_AUDIO): a silent stream instead of the mic or the PC's sound, so nothing real is heard. */
function silence(ctx: AudioContext): MediaStream {
  const out = ctx.createMediaStreamDestination()
  const source = ctx.createConstantSource()
  source.offset.value = 0
  source.connect(out)
  source.start()
  return out.stream
}

async function openMic(ctx: AudioContext): Promise<MediaStream> {
  if (window.togleDev?.silentAudio) return silence(ctx)
  const base = { noiseSuppression: true, autoGainControl: true, channelCount: 1 }
  try {
    // "all" asks Chromium to cancel everything the PC plays (the other side of the call), not just this page.
    return await navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: 'all' as unknown as boolean } })
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: { ...base, echoCancellation: true } })
  }
}

/**
 * What the PC plays on Linux, where Chromium has no loopback capture: the sound server's monitor of the speakers
 * (PulseAudio's, or PipeWire's through it), which Chromium lists as an input. The default speakers' own, when it can
 * tell which that is.
 */
async function openMonitor(): Promise<MediaStream> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const monitors = devices.filter((d) => d.kind === 'audioinput' && /^Monitor of /i.test(d.label))
  if (!monitors.length) throw new Error("no monitor of the speakers to listen to: Togle needs PulseAudio or PipeWire's pulse server")
  const speakers = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')
  const named = speakers && devices.find((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.groupId === speakers.groupId)
  const monitor = monitors.find((m) => named && m.label === `Monitor of ${named.label}`) ?? monitors[0]
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: monitor.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
  })
}

async function openLoopback(ctx: AudioContext): Promise<MediaStream> {
  if (window.togleDev?.silentAudio) return silence(ctx)
  if (/Linux/.test(navigator.userAgent)) return openMonitor()
  const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
  display.getVideoTracks().forEach((t) => t.stop())
  const audio = display.getAudioTracks()
  if (!audio.length) throw new Error('no loopback audio track')
  return new MediaStream(audio)
}

const SOURCE_NAME: Record<Speaker, string> = { me: 'Microphone', them: 'System audio' }

function captureProblem(error: unknown, speaker: Speaker): string {
  const { name, message } = error as Error
  if (window.togle?.platform !== 'darwin') return message
  if (name === 'NotAllowedError' || name === 'SecurityError' || (speaker === 'them' && message === 'no loopback audio track')) {
    const permission = speaker === 'me' ? 'Microphone' : 'Screen & System Audio Recording'
    return `Check Togle's access in System Settings → Privacy & Security → ${permission}, then quit and reopen Togle.`
  }
  return message
}

export interface AudioInput {
  state: 'off' | 'connecting' | 'ready' | 'unavailable' | 'paused'
  detail?: string
}
export type CaptureInputs = Record<Speaker, AudioInput>
const offInputs = (): CaptureInputs => ({ me: { state: 'off' }, them: { state: 'off' } })

/** The physical devices Windows uses by default right now, to notice when the user switches (e.g. plugs in headphones). */
async function defaultDevices(): Promise<Record<Speaker, string>> {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const group = (kind: MediaDeviceKind): string => devices.find((d) => d.kind === kind && d.deviceId === 'default')?.groupId ?? ''
  return { me: group('audioinput'), them: group('audiooutput') }
}

/**
 * Mic = "me", system loopback = "them". Either may fail; we keep whatever works. A source whose device goes
 * away (unplugged, or the default device switched) is opened again, so dictation doesn't silently stop.
 */
export class CallCapture {
  private paused = new Set<Speaker>()
  private sources: Source[] = []
  private ctx: AudioContext | null = null
  private onSegment: SegmentHandler | null = null
  private devices: Record<Speaker, string> = { me: '', them: '' }
  private generation = 0
  private revisions: Record<Speaker, number> = { me: 0, them: 0 }
  private reopening = new Map<Speaker, { generation: number; revision: number }>()
  private inputs = offInputs()
  private watchDevices = (): void => void this.devicesChanged()
  /** What the microphone picks up when nobody speaks, measured during the call when asked to (see noise-check.ts). */
  private measureNoise = false
  private noiseCheck?: NoiseCheck
  private noiseTap?: NoiseTap
  private noiseResult?: ReturnType<NoiseCheck['report']>
  /** Told when a source drops out for good. */
  onNotice: (message: string) => void = () => {}
  /** Changes only when a device connects or disconnects; level updates stay outside React. */
  onState: (inputs: CaptureInputs) => void = () => {}

  get state(): CaptureInputs {
    return this.inputs
  }

  private input(speaker: Speaker, state: AudioInput['state'], detail?: string): void {
    this.inputs = { ...this.inputs, [speaker]: { state, detail } }
    this.onState(this.inputs)
  }

  /** Current input level per captured source; a missing key means that source isn't captured. */
  get levels(): Partial<Record<Speaker, number>> {
    const levels: Partial<Record<Speaker, number>> = {}
    for (const s of this.sources) levels[s.speaker] = s.segmenter.level
    return levels
  }

  async start(onSegment: SegmentHandler, paused: Speaker[] = [], options: { measureNoise?: boolean } = {}): Promise<string[]> {
    if (this.ctx) throw new Error('Audio capture is already running')
    this.paused = new Set(paused)
    this.measureNoise = !!options.measureNoise
    this.noiseResult = undefined
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation
    this.onSegment = onSegment
    this.input('me', 'connecting')
    this.input('them', 'connecting')
    try {
      const ctx = await openEngine()
      if (!current()) {
        void ctx.close()
        throw new Error('Audio start cancelled')
      }
      this.ctx = ctx
      const warnings: string[] = []
      for (const speaker of ['me', 'them'] as const) {
        if (this.paused.has(speaker)) { this.input(speaker, 'paused'); continue }
        try {
          const stream = await (speaker === 'me' ? openMic(ctx) : openLoopback(ctx))
          if (!current()) {
            stream.getTracks().forEach((t) => t.stop())
            throw new Error('Audio start cancelled')
          }
          if (this.paused.has(speaker)) { stream.getTracks().forEach(t => t.stop()); this.input(speaker, 'paused'); continue }
          this.attach(speaker, stream)
        } catch (err) {
          if (!current()) throw err
          const detail = captureProblem(err, speaker)
          this.input(speaker, 'unavailable', detail)
          warnings.push(`${SOURCE_NAME[speaker]} unavailable: ${detail}`)
        }
      }
      if (!this.sources.length && this.paused.size < 2) throw new Error(warnings.join(' '))
      const devices = await defaultDevices()
      if (!current()) throw new Error('Audio start cancelled')
      this.devices = devices
      navigator.mediaDevices.addEventListener('devicechange', this.watchDevices)
      if (this.measureNoise) void this.openNoise()
      return warnings
    } catch (err) {
      if (current()) this.stop()
      throw err
    }
  }

  private attach(speaker: Speaker, stream: MediaStream): void {
    try {
      const source = openSource(this.ctx!, speaker, stream, (...args) => { if (!this.paused.has(speaker)) this.onSegment?.(...args) })
      this.sources.push(source)
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        if (this.sources.includes(source)) void this.reopen(speaker)
      }, { once: true })
      this.input(speaker, 'ready')
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop())
      throw err
    }
  }

  /** The default mic or speakers changed: follow them. */
  private async devicesChanged(): Promise<void> {
    const generation = this.generation
    const now = await defaultDevices()
    if (!this.ctx || generation !== this.generation) return
    for (const speaker of ['me', 'them'] as const) {
      if (now[speaker] && now[speaker] !== this.devices[speaker]) void this.reopen(speaker)
    }
    this.devices = now
  }

  /** Retry the missing side without ending the call or interrupting a working device. */
  async retryMissing(): Promise<void> {
    await Promise.all((['me', 'them'] as const).filter((speaker) => this.inputs[speaker].state === 'unavailable').map((speaker) => this.reopen(speaker)))
  }

  private async reopen(speaker: Speaker): Promise<void> {
    const ctx = this.ctx
    const generation = this.generation
    const revision = this.revisions[speaker], opening = this.reopening.get(speaker)
    if (!ctx || this.paused.has(speaker) || opening?.generation === generation && opening.revision === revision) return
    const request = { generation, revision }
    const current = (): boolean => this.ctx === ctx && generation === this.generation && revision === this.revisions[speaker] && !this.paused.has(speaker)
    this.reopening.set(speaker, request)
    const old = this.sources.find((s) => s.speaker === speaker)
    this.sources = this.sources.filter((s) => s !== old)
    this.input(speaker, 'connecting')
    old?.stop()
    let detail = 'The device is no longer available.'
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt))
        if (!current()) return
        try {
          const stream = await (speaker === 'me' ? openMic(ctx) : openLoopback(ctx))
          if (!current()) {
            stream.getTracks().forEach((t) => t.stop())
            return
          }
          this.attach(speaker, stream)
          console.info(`[capture] ${SOURCE_NAME[speaker]} reopened`)
          // The measurement follows the microphone the call now uses.
          if (speaker === 'me' && this.measureNoise) void this.openNoise()
          return
        } catch (err) {
          detail = captureProblem(err, speaker)
          // The new device may not be ready yet; try again shortly.
        }
      }
      if (!current()) return
      this.input(speaker, 'unavailable', detail)
      this.onNotice(`${SOURCE_NAME[speaker]} stopped and could not be reopened. Reconnect audio to try again.`)
    } finally {
      if (this.reopening.get(speaker) === request) this.reopening.delete(speaker)
    }
  }

  async setPaused(speaker: Speaker, paused: boolean): Promise<void> {
    if (!this.ctx) return
    if (this.paused.has(speaker) === paused) return
    this.revisions[speaker]++
    if (paused) {
      this.paused.add(speaker)
      const source = this.sources.find(item => item.speaker === speaker)
      this.sources = this.sources.filter(item => item !== source)
      source?.stop()
      this.input(speaker, 'paused')
    } else {
      this.paused.delete(speaker)
      await this.reopen(speaker)
    }
  }

  /** Opens (or opens again) the unprocessed microphone the noise check measures. Without it the call goes on unmeasured. */
  private async openNoise(): Promise<void> {
    const ctx = this.ctx, generation = this.generation
    if (!ctx || window.togleDev?.silentAudio) return
    this.noiseTap?.stop()
    this.noiseTap = undefined
    try {
      const stream = await openRawMic()
      if (this.ctx !== ctx || generation !== this.generation) { stream.getTracks().forEach((t) => t.stop()); return }
      // Opened again meanwhile (the device changed twice): the newer stream replaces this one's predecessor.
      ;(this.noiseTap as NoiseTap | undefined)?.stop()
      this.noiseCheck ??= new NoiseCheck(() => this.sources.some((s) => s.speaker === 'them' && s.segmenter.active))
      this.noiseTap = openNoiseTap(ctx, stream, this.noiseCheck, () => this.paused.has('me'))
    } catch (err) {
      console.warn('[capture] the microphone noise check could not start:', (err as Error).message)
    }
  }

  /** The call's noise measurement, once it has stopped (and only once). */
  takeNoiseReport(): ReturnType<NoiseCheck['report']> | undefined {
    const result = this.noiseResult
    this.noiseResult = undefined
    return result
  }

  stop(): void {
    this.generation++
    navigator.mediaDevices.removeEventListener('devicechange', this.watchDevices)
    this.noiseTap?.stop()
    this.noiseTap = undefined
    // Test runs hear silence: their fixture can stand in for what a noisy microphone measures.
    this.noiseResult = this.noiseCheck?.report() ?? (this.measureNoise ? window.togleDev?.noiseReport?.() : undefined)
    this.noiseCheck = undefined
    const ctx = this.ctx
    this.ctx = null
    this.sources.forEach((s) => s.stop())
    this.sources = []
    this.onSegment = null
    this.paused.clear()
    this.inputs = offInputs()
    this.onState(this.inputs)
    void ctx?.close()
  }
}
