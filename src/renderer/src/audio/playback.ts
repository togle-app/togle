import { NOISE_SAMPLE_RATE } from './noise-check'

let playing: { ctx: AudioContext; source: AudioBufferSourceNode; done: () => void } | undefined

/** Your voice at this level is what a call app aims for; the background is played as far below it as it was. */
const VOICE_TARGET_DB = -20
const MAX_GAIN_DB = 20

/**
 * Plays back a few seconds the microphone picked up while nobody spoke. Raised by as much as a call app would raise
 * the voice (up to 20 dB), so it sounds the way it does to the others, and never more. Returns a function that stops it.
 */
export function playNoiseSample(sample: Float32Array, speechDb: number | undefined, onEnd: () => void): () => void {
  stopNoiseSample()
  const ctx = new AudioContext()
  const buffer = ctx.createBuffer(1, sample.length, NOISE_SAMPLE_RATE)
  buffer.copyToChannel(new Float32Array(sample), 0)
  const source = ctx.createBufferSource()
  source.buffer = buffer
  const gain = ctx.createGain()
  const raise = speechDb === undefined ? 0 : Math.max(0, Math.min(MAX_GAIN_DB, VOICE_TARGET_DB - speechDb))
  gain.gain.value = 10 ** (raise / 20)
  source.connect(gain).connect(ctx.destination)
  const current = { ctx, source, done: onEnd }
  source.onended = () => { if (playing === current) stopNoiseSample() }
  playing = current
  source.start()
  return stopNoiseSample
}

export function stopNoiseSample(): void {
  const current = playing
  if (!current) return
  playing = undefined
  try { current.source.stop() } catch { /* already ended */ }
  void current.ctx.close()
  current.done()
}
