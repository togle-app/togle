import { noiseVerdict, type NoiseReport } from '@shared/microphone'

/**
 * What the microphone picks up when nobody speaks: measured during calls (and by the microphone check in Settings) so
 * Togle can show the user, with Togle Microphone as the way to remove it. It takes the 16 kHz frames of the pcm-tap
 * worklet from a microphone stream without noise suppression or automatic gain, so the background is measured as the
 * microphone hears it. Only levels are kept, and a few seconds of background audio in memory to play back to the user;
 * nothing is saved or sent.
 */

const RATE = 16_000
const FRAME_MS = (512 / RATE) * 1000
/** A muted microphone sends digital silence: not measured. */
const MUTED_DB = -90
/** A voice is at least this far above the steady background. */
const SPEECH_ABOVE_DB = 12
const SPEECH_FRAMES = 3
/** This long below the voice threshold ends a phrase. */
const END_FRAMES = 10
/** Louder moments shorter than this are noises (typing, a click, a knock), not words. */
const MIN_SPEECH_MS = 400
/** Sound that doesn't dip for this long isn't speech. */
const NO_DIP_MS = 8_000
const BURST_ABOVE_DB = 15
const BURST_MIN_DB = -55
/** Background at least this loud is heard in a call, whatever the voice. */
const LOUD_DB = -45
/** Without a measured voice, background from this level counts as noise. */
const NOISY_DB = -50
/** Background closer than this to the user's voice is heard over it. */
const BELOW_VOICE_DB = 25
const QUIET_ROOM_DB = -60
/** Where the background is assumed to start. */
const START_FLOOR_DB = -45
/** Speech needed to trust the voice level. */
const MIN_SPEECH_MEASURED_MS = 2_000
const SAMPLE_FRAMES = Math.round(4_000 / FRAME_MS)
const MIN_DB = -100
const BINS = 101

type Kind = 'quiet' | 'speech' | 'skip'
interface Held { db: number; pcm: Float32Array; remote: boolean }

function histogramAt(histogram: Uint32Array, total: number, share: number): number | undefined {
  if (!total) return
  let seen = 0
  const target = share * total
  for (let i = 0; i < histogram.length; i++) {
    seen += histogram[i]
    if (seen >= target) return MIN_DB + i
  }
  return MIN_DB + histogram.length - 1
}

const decibels = (frame: Float32Array): number => {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return 10 * Math.log10(sum / Math.max(1, frame.length) + 1e-20)
}

/** Background this loud is noise someone in the call can hear. */
export function noisyThreshold(speechDb?: number): number {
  return speechDb === undefined ? NOISY_DB : Math.min(LOUD_DB, Math.max(QUIET_ROOM_DB, speechDb - BELOW_VOICE_DB))
}

export class NoiseCheck {
  private floor?: number
  private segment: Held[] = []
  private loudFrames = 0
  private quietRun = 0
  private peakDb = -Infinity
  private speaking = false
  /** Levels of the voice frames since the sound last dipped. */
  private run: number[] = []
  private analyzed = 0
  private speech = new Uint32Array(BINS)
  private speechFrames = 0
  private quiet = new Uint32Array(BINS)
  private quietFrames = 0
  private bursts = 0
  /** The last few seconds of what was measured, and the loudest stretch with nobody speaking. */
  private recent: { pcm: Float32Array; kind: Kind; power: number }[] = []
  private recentQuiet = 0
  private recentPower = 0
  private best?: { power: number; frames: Float32Array[] }
  private sinceBest = 0

  /** `remote`: whether the other side is speaking now (their voice from the speakers isn't the user's background). */
  constructor(private remote: () => boolean = () => false) {}

  push(frame: Float32Array): void {
    const db = decibels(frame)
    if (db < MUTED_DB) { this.flushSegment(); this.speaking = false; this.quietRun = 0; this.run = []; this.remember(frame, 'skip', db); return }
    this.analyzed++
    const held: Held = { db, pcm: frame, remote: this.remote() }
    // A call can start mid-sentence: the background starts no higher than a fairly noisy room, and drops from there.
    const floor = this.floor ??= Math.min(db, START_FLOOR_DB)
    const loud = db >= floor + SPEECH_ABOVE_DB
    if (this.speaking) {
      this.quietRun = loud ? 0 : this.quietRun + 1
      this.classify(held, loud ? 'speech' : 'skip')
      if (loud && !held.remote) this.run.push(db)
      else if (!loud) this.run = []
      if (this.quietRun >= END_FRAMES) { this.speaking = false; this.quietRun = 0; this.run = [] }
      else if (this.run.length * FRAME_MS >= NO_DIP_MS) this.steadySound()
      return
    }
    if (!this.segment.length) {
      if (!loud) {
        // The steady background: follows drops quickly and rises slowly, so a voice doesn't become the floor.
        this.floor = floor + (db - floor) * (db < floor ? 0.1 : 0.003)
        this.classify(held, 'quiet')
        return
      }
      this.peakDb = db
      this.loudFrames = 0
      this.quietRun = 0
    }
    this.segment.push(held)
    this.peakDb = Math.max(this.peakDb, db)
    if (loud) { this.loudFrames++; this.quietRun = 0 } else this.quietRun++
    if (this.loudFrames >= SPEECH_FRAMES && this.segment.length * FRAME_MS >= MIN_SPEECH_MS) {
      // Long enough to be words.
      this.run = []
      for (const item of this.segment) {
        const voice = item.db >= floor + SPEECH_ABOVE_DB
        this.classify(item, voice ? 'speech' : 'skip')
        if (voice && !item.remote) this.run.push(item.db)
        else if (!voice) this.run = []
      }
      this.segment = []
      this.speaking = true
      this.quietRun = 0
    } else if (this.quietRun >= END_FRAMES) this.flushSegment()
  }

  /**
   * Seconds of sound that never dips aren't a voice (speech always pauses): a fan or an engine started. It's background
   * from now on, and so is what was taken for speech since it started.
   */
  private steadySound(): void {
    for (const db of this.run) {
      const bin = Math.max(0, Math.min(BINS - 1, Math.round(db - MIN_DB)))
      if (this.speech[bin]) { this.speech[bin]--; this.speechFrames-- }
      this.quiet[bin]++; this.quietFrames++
    }
    this.floor = Math.min(...this.run) - 3
    this.run = []
    this.speaking = false
    this.quietRun = 0
  }

  /** A short loud moment that ended: background with a noise in it, not words. */
  private flushSegment(): void {
    if (!this.segment.length) return
    const floor = this.floor ?? this.peakDb
    if (this.peakDb >= BURST_MIN_DB && this.peakDb >= floor + BURST_ABOVE_DB && !this.segment.some(item => item.remote)) this.bursts++
    for (const item of this.segment) this.classify(item, 'quiet')
    this.segment = []
  }

  private classify(item: Held, kind: Kind): void {
    // While the other side speaks, the microphone may hear them from the speakers: neither the user nor background.
    const counted: Kind = item.remote ? 'skip' : kind
    const bin = Math.max(0, Math.min(BINS - 1, Math.round(item.db - MIN_DB)))
    if (counted === 'speech') { this.speech[bin]++; this.speechFrames++ }
    if (counted === 'quiet') { this.quiet[bin]++; this.quietFrames++ }
    this.remember(item.pcm, counted, item.db)
  }

  private remember(pcm: Float32Array, kind: Kind, db: number): void {
    const power = 10 ** (db / 10)
    this.recent.push({ pcm, kind, power })
    if (kind === 'quiet') { this.recentQuiet++; this.recentPower += power }
    if (this.recent.length > SAMPLE_FRAMES) {
      const old = this.recent.shift()!
      if (old.kind === 'quiet') { this.recentQuiet--; this.recentPower -= old.power }
    }
    this.sinceBest++
    if (this.recentQuiet !== SAMPLE_FRAMES || this.sinceBest < 16) return
    const mean = this.recentPower / SAMPLE_FRAMES
    if (10 * Math.log10(mean + 1e-20) < noisyThreshold(this.voiceDb()) || (this.best && mean <= this.best.power)) return
    this.best = { power: mean, frames: this.recent.map(item => item.pcm) }
    this.sinceBest = 0
  }

  private voiceDb(): number | undefined {
    return this.speechFrames * FRAME_MS >= MIN_SPEECH_MEASURED_MS ? histogramAt(this.speech, this.speechFrames, 0.5) : undefined
  }

  /** What was measured so far. `check`: the short microphone check in Settings, which judges on less. */
  report(check = false): NoiseReport & { sample?: Float32Array } {
    this.flushSegment()
    const speechDb = this.voiceDb()
    const floorDb = histogramAt(this.quiet, this.quietFrames, 0.2)
    const threshold = noisyThreshold(speechDb)
    let noisy = 0
    for (let i = 0; i < BINS; i++) if (MIN_DB + i >= threshold) noisy += this.quiet[i]
    const measured = {
      analyzedMs: Math.round(this.analyzed * FRAME_MS),
      speechMs: Math.round(this.speechFrames * FRAME_MS),
      quietMs: Math.round(this.quietFrames * FRAME_MS),
      noisyMs: Math.round(noisy * FRAME_MS),
      bursts: this.bursts,
      floorDb,
      peakDb: histogramAt(this.quiet, this.quietFrames, 0.95),
      speechDb,
      snrDb: speechDb !== undefined && floorDb !== undefined ? speechDb - floorDb : undefined
    }
    const verdict = noiseVerdict(measured, check)
    const sample = this.best && (verdict === 'noisy' || verdict === 'some') ? joinFrames(this.best.frames) : undefined
    return { ...measured, verdict, sample }
  }
}

function joinFrames(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of frames) { out.set(f, at); at += f.length }
  return out
}

export const NOISE_SAMPLE_RATE = RATE
