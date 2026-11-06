import type { SegmentKind, Speaker } from '@shared/types'
import type { Copilot } from './copilot'
import type { HeardTiming } from './perf'
import type { LocalParakeet, ParakeetResult } from './stt/parakeet'
import type { SpeechApi } from './stt/speech-api'
import { SAMPLE_RATE, type LocalWhisper } from './stt/whisper'

// Below this mean token confidence Parakeet was guessing (very poor pronunciation, noise): Whisper, with its
// stronger language model and the agent's vocabulary, takes that utterance. On accented and poorly
// pronounced English this beat either recognizer alone.
const LOW_CONFIDENCE = 0.8
const SHORT_SOUND_S = 1.5
// Parakeet also knows other European languages: in English, accented letters mean it switched language.
const NOT_ENGLISH = /[^\x00-\x7f‘’“”–—…]/

// Below this (see signalToNoise) Parakeet starts dropping words while still sounding sure of itself, and Whisper
// with the agent's words holds up better: in npm run speech, with chatter 5 dB below the caller, 8.5% of the
// words wrong against 15.5%, and at 10 dB 2.0% against 4.5%, for about 100 ms more per utterance. Live captions
// stay with Parakeet.
const NOISY_DB = 25

/**
 * How far the speech stands out from the noise under it, in dB: the loud moments of the clip (words)
 * against its quietest ones (the gaps between them, where only the noise is left).
 */
export function signalToNoise(pcm: Float32Array): number {
  const frame = 512
  const levels: number[] = []
  for (let i = 0; i + frame <= pcm.length; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += pcm[j] * pcm[j]
    levels.push(Math.sqrt(sum / frame))
  }
  if (levels.length < 10) return Infinity
  levels.sort((a, b) => a - b)
  const noise = levels[Math.floor(levels.length * 0.1)]
  const speech = levels[Math.floor(levels.length * 0.9)]
  return noise > 0 ? 20 * Math.log10(speech / noise) : Infinity
}

export interface Ears {
  /** Exact, agent-scoped user spelling corrections, independent of the speech provider. */
  normalize?: (text: string) => string
  /** Null while it isn't installed or running; Whisper then hears everything. */
  parakeet: () => Pick<LocalParakeet, 'available' | 'transcribe'> | null
  whisper: Pick<LocalWhisper, 'transcribe'>
  /**
   * The API picked to hear a side (OpenAI's, or another server's), once it has what it needs: it writes that side's
   * transcript in place of this PC's models. Live captions and answers started at a pause stay on this PC, where
   * they're quick and cost nothing.
   */
  api?: (speaker: Speaker) => Pick<SpeechApi, 'id' | 'transcribe'> | null
  /** The call's language setting. */
  language: () => string
  /** Words the active agent expects, which help Whisper. */
  vocabulary: () => Promise<string>
  copilot: Pick<Copilot, 'anticipate' | 'dropAnticipated' | 'talkedOn' | 'add'>
  /** A live caption for an utterance still in progress; empty text clears it. */
  caption: (caption: { segmentId: string; speaker: Speaker; text: string; at: number }) => void
  /** Development logging; none in a packaged app. */
  log?: (line: string) => void
  /** Each finished utterance: who transcribed it, whether the line was noisy, and how long it took. */
  heard?: (timing: HeardTiming) => void
}

export type SegmentHandler = (speaker: Speaker, pcm: Float32Array, startedAt: number, segmentId: string, kind: SegmentKind) => Promise<void>
export type Hearing = SegmentHandler & { reset(): void; pause(speaker: Speaker, paused: boolean): void }

/** What was heard in a clip, by which recognizer, and whether the line was noisy. */
interface Heard {
  text: string
  by: HeardTiming['by']
  noisy: boolean
}

/**
 * Turns the audio the window cuts out of the call into live captions, transcript lines, and answers
 * started at a pause.
 */
export function hearing(ears: Ears): Hearing {
  /**
   * Text for a clip: a finished utterance from the API picked for its side, when there is one; otherwise Parakeet first,
   * Whisper when Parakeet is unsure, missing, the call isn't in English, or (except for live captions) the line is
   * noisy. Null means a newer live caption replaced this one.
   */
  async function recognize(speaker: Speaker, pcm: Float32Array, partial: boolean): Promise<Heard | null> {
    const language = ears.language()
    const noisy = !partial && signalToNoise(pcm) < NOISY_DB
    const api = partial ? null : ears.api?.(speaker)
    if (api) {
      try {
        return { text: await api.transcribe(pcm, { language, vocabulary: await ears.vocabulary() }), by: api.id, noisy }
      } catch (err) {
        // This PC hears it instead, so the line isn't lost; the window says why.
        console.warn(`[stt] ${api.id}:`, (err as Error).message)
      }
    }
    const byWhisper = async (): Promise<Heard> => ({
      text: (await ears.whisper.transcribe(pcm, { language, prompt: await ears.vocabulary(), partial, stream: speaker })).text,
      by: 'whisper',
      noisy
    })
    const parakeet = ears.parakeet()
    if (!parakeet?.available || language !== 'en' || noisy) return byWhisper()
    let heard: ParakeetResult | null
    try {
      heard = await parakeet.transcribe(pcm, { partial, stream: speaker })
    } catch (err) {
      console.warn('[stt] Parakeet:', (err as Error).message)
      return byWhisper()
    }
    if (!heard) return null
    const byParakeet: Heard = { text: heard.text, by: 'parakeet', noisy }
    if (partial || (heard.text && heard.confidence >= LOW_CONFIDENCE && !NOT_ENGLISH.test(heard.text))) return byParakeet
    // Parakeet hearing nothing in a short sound means there was no speech; Whisper would only guess.
    if (!heard.text && pcm.length < SHORT_SOUND_S * SAMPLE_RATE) return byParakeet
    const second = await byWhisper().catch((err: Error) => {
      console.warn('[stt] Whisper:', err.message)
      return null
    })
    ears.log?.(`[stt] unclear (${heard.confidence.toFixed(2)}): "${heard.text}" -> Whisper: "${second?.text ?? ''}"`)
    return second?.text ? second : byParakeet
  }

  /**
   * What they said up to a pause, when Parakeet is sure of it (tens of milliseconds on a GPU). Otherwise
   * nothing: the final transcript, a moment later, settles it the usual way.
   */
  async function heardAtPause(speaker: Speaker, pcm: Float32Array): Promise<string | null> {
    const parakeet = ears.parakeet()
    if (!parakeet?.available || ears.language() !== 'en') return null
    // On a noisy line, what Whisper hears the way it will hear the final transcript, so the two agree.
    if (signalToNoise(pcm) < NOISY_DB) {
      const heard = await ears.whisper
        .transcribe(pcm, { language: 'en', prompt: await ears.vocabulary(), partial: false, stream: speaker })
        .catch(() => null)
      return heard?.text.trim() || null
    }
    const heard = await parakeet.transcribe(pcm, { partial: true, stream: speaker }).catch(() => null)
    return heard?.text && heard.confidence >= LOW_CONFIDENCE && !NOT_ENGLISH.test(heard.text) ? heard.text : null
  }

  // The newest piece of audio of each utterance still in progress: a pause transcribed after they went on
  // talking mustn't start an answer.
  const latestPiece = new Map<string, number>()
  const captions = new Map<string, { speaker: Speaker; at: number }>()
  // Requests may finish in another order. Keep them parallel, but deliver each side's finished lines in order so
  // a later question cannot be answered twice while the earlier one is still missing. Captions stay immediate.
  const finalized: Record<Speaker, Promise<void>> = { me: Promise.resolve(), them: Promise.resolve() }
  let pieces = 0
  let generation = 0
  const paused = { me: false, them: false }
  const sides = { me: 0, them: 0 }
  const { copilot } = ears
  const handler: SegmentHandler = async (speaker, pcm, startedAt, segmentId, kind) => {
    if (paused[speaker]) return
    const call = generation
    const side = sides[speaker]
    const current = (): boolean => call === generation && side === sides[speaker] && !paused[speaker]
    const partial = kind !== 'final'
    const piece = ++pieces
    if (partial) { latestPiece.set(segmentId, piece); captions.set(segmentId, { speaker, at: startedAt }) }
    else latestPiece.delete(segmentId)
    const clearCaption = (): void => { captions.delete(segmentId); ears.caption({ segmentId, speaker, text: '', at: startedAt }) }
    // An empty final means the sound was too short to be speech: just drop its live caption.
    if (!pcm.length) {
      copilot.dropAnticipated(segmentId)
      return clearCaption()
    }
    if (!partial) ears.log?.(`[audio] ${speaker} utterance, ${(pcm.length / SAMPLE_RATE).toFixed(1)}s`)
    const before = finalized[speaker]
    let finishFinal: (() => void) | undefined
    if (!partial) finalized[speaker] = new Promise<void>((resolve) => { finishFinal = resolve })
    try {
      if (kind === 'pause') {
        const raw = await heardAtPause(speaker, pcm)
        const text = raw && (ears.normalize?.(raw) ?? raw)
        if (!current() || !text || latestPiece.get(segmentId) !== piece) return
        ears.caption({ segmentId, speaker, text, at: startedAt })
        // The answer needs any earlier finished utterance, even if this pause was heard locally first. If its final
        // or another piece arrived while waiting, that settles it instead.
        await before
        if (!current() || latestPiece.get(segmentId) !== piece) return
        copilot.anticipate(text, startedAt, segmentId, startedAt + (pcm.length / SAMPLE_RATE) * 1000)
        return
      }
      const started = Date.now()
      const heard = await recognize(speaker, pcm, partial)
      if (!current()) return
      if (!partial) {
        if (heard) ears.heard?.({ at: new Date(started).toISOString(), by: heard.by, noisy: heard.noisy, seconds: pcm.length / SAMPLE_RATE, ms: Date.now() - started })
        await before
      }
      if (!current() || heard === null) return
      const text = ears.normalize?.(heard.text) ?? heard.text
      if (partial) {
        if (latestPiece.get(segmentId) !== piece) return
        if (text) ears.caption({ segmentId, speaker, text, at: startedAt })
        // Talking again after a pause: an answer started there was early, unless it's still the same words (a click
        // or a breath after the question, which would only ask the same again).
        copilot.talkedOn(segmentId, text)
        return
      }
      if (!text) {
        copilot.dropAnticipated(segmentId)
        return clearCaption()
      }
      ears.log?.(`[transcript] ${speaker}: ${text}`)
      copilot.add(speaker, text, startedAt, startedAt + (pcm.length / SAMPLE_RATE) * 1000, segmentId)
      captions.delete(segmentId)
    } catch (err) {
      if (partial || !current()) return
      await before
      if (!current()) return
      copilot.dropAnticipated(segmentId)
      clearCaption()
      console.error('[stt]', (err as Error).message)
    } finally {
      finishFinal?.()
    }
  }
  return Object.assign(handler, {
    pause(speaker: Speaker, value: boolean): void {
      if (paused[speaker] === value) return
      paused[speaker] = value; sides[speaker]++
      finalized[speaker] = Promise.resolve()
      if (value) for (const [segmentId, caption] of captions) if (caption.speaker === speaker) {
        ears.caption({ segmentId, ...caption, text: '' }); captions.delete(segmentId); latestPiece.delete(segmentId)
      }
      if (speaker === 'them') copilot.dropAnticipated()
    },
    reset(): void {
      generation++
      paused.me = paused.them = false
      latestPiece.clear()
      captions.clear()
      // New calls never wait for an old provider request that may be hung or still streaming.
      finalized.me = Promise.resolve()
      finalized.them = Promise.resolve()
    }
  })
}
