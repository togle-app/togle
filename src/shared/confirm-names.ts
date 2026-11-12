import { introducedName, speakerLabel } from './meeting'
import type { TranscriptEntry } from './types'

/**
 * The voices of a call that are worth asking about after it ends, each with a guess at who it is and why. The sound
 * kept for this is deleted when the person has answered, or by `until`.
 */
export interface CallConfirm {
  /** When the sound kept for this is gone at the latest (epoch ms). */
  until: number
  /** The voices to ask about, in the order they first spoke. */
  voices: ConfirmVoice[]
  /** When the person answered the last one: nothing is asked and no sound is kept after. */
  closed?: number
}

export interface ConfirmVoice {
  /** The voice's id in the call's transcript. */
  id: string
  /** Who it may be, and what says so. Absent: nothing does. */
  guess?: string
  reason?: string
  /** One thing it said. */
  said?: string
  /** The name of the short clip kept to play it (until `until`). Absent: none is kept. */
  clip?: string
  /** How long it spoke in the call, in seconds. */
  seconds: number
  /** The person's answer: the name they gave. Absent: not answered yet. */
  answered?: string
}

/** A voice needs at least this much speech to be worth a question. */
const MIN_SECONDS = 2
/** A name said just before a voice first speaks, or just after it, is about it if it is this close. */
const NEAR_MS = 10_000
/** Voices to ask about in one call: more than that is a room, not a meeting. */
const MAX_VOICES = 8
const NAME = String.raw`(\p{Lu}[\p{L}'’-]{1,30})`
// A name called out ("Marta, can you…", "Marta?"), put to someone ("What do you think, Marta?"), or thanked ("Thanks, Marta").
const CALLED = new RegExp(String.raw`^(?:(?:okay|ok|so|well|and|hey|hi|right|great|thanks|thank you)[,.!\s]+)?${NAME}[,?!]`, 'u')
const PUT_TO = new RegExp(String.raw`,\s*${NAME}\s*[?.!]*$`, 'u')
const THANKED = new RegExp(String.raw`\bthank(?:s| you)[,]?\s+${NAME}\b`, 'iu')
const HANDED = new RegExp(String.raw`\b(?:over to|hear from|ask)\s+${NAME}\b`, 'u')

const fold = (word: string): string => word.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase()

/** The first names a line puts to someone by name, in the order they come. Only first names from `known` count. */
export function addressedNames(text: string, known: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const pattern of [CALLED, PUT_TO, THANKED, HANDED]) {
      const name = pattern.exec(sentence.trim())?.[1]
      if (name && known.has(fold(name)) && !found.includes(name)) found.push(name)
    }
  }
  return found
}

/** Who a line is by, for a reason given: a guessed name without its question mark. */
const who = (line: TranscriptEntry): string => line.speaker === 'me' ? 'You' : speakerLabel(line).replace(/[?]$/, '')

const clip = (text: string, length: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? flat.slice(0, length - 1).trimEnd() + '…' : flat
}

/**
 * The voices to ask about after a call. Names the person gave are done and not asked again. A voice already named by
 * an introduction or a remembered voice is asked to confirm it; one with no name is guessed from what the others said
 * to it by name just before or after it first spoke, when that is a first name nobody else in the call has.
 * `clips` says which voices a short clip is kept of (by voice id, the clip's name) and `said` which of its lines to show.
 */
export function confirmVoices(transcript: TranscriptEntry[], known: ReadonlySet<string>, clips: ReadonlyMap<string, { name: string; at: number; end: number }> = new Map()): ConfirmVoice[] {
  const lines = transcript.filter(line => line.text.trim())
  const order: string[] = []
  for (const line of lines) if (line.speaker === 'them' && line.voiceId && !order.includes(line.voiceId)) order.push(line.voiceId)
  const taken = new Set(lines.filter(line => line.voiceName).map(line => fold(line.voiceName!)))
  const voices: ConfirmVoice[] = []
  for (const id of order) {
    const own = lines.filter(line => line.voiceId === id)
    if (own.some(line => line.voiceNamedBy === 'user')) continue
    const seconds = Math.round(own.reduce((sum, line) => sum + Math.max(0, line.end - line.at), 0) / 1000)
    if (seconds < MIN_SECONDS) continue
    const named = own.find(line => line.voiceName)
    let guess: string | undefined, reason: string | undefined
    if (named?.voiceName) {
      guess = named.voiceName
      if (named.voiceNamedBy === 'remembered') reason = 'Recognized from a previous call.'
      else {
        const introduction = own.find(line => introducedName(line.text)?.toLocaleLowerCase() === named.voiceName!.toLocaleLowerCase())
        reason = introduction ? `Introduced themselves: “${clip(introduction.text, 70)}”` : 'Named earlier in the call.'
      }
    } else {
      const first = lines.indexOf(own[0])
      const before = lines[first - 1]
      const candidates: { name: string; reason: string }[] = []
      if (before && before.voiceId !== id && own[0].at - before.end <= NEAR_MS) {
        for (const name of addressedNames(before.text, known)) candidates.push({ name, reason: `${who(before)} said “${name}” just before.` })
      }
      for (const line of own.slice(0, 3)) {
        const after = lines[lines.indexOf(line) + 1]
        if (after && after.voiceId !== id && after.at - line.end <= NEAR_MS) {
          for (const name of addressedNames(after.text, known)) candidates.push({ name, reason: `${who(after)} said “${name}” just after.` })
        }
      }
      const pick = candidates.find(candidate => !taken.has(fold(candidate.name)))
      if (pick) { guess = pick.name; reason = pick.reason; taken.add(fold(pick.name)) }
    }
    const kept = clips.get(id)
    const said = kept ? own.reduce((best, line) => Math.abs(line.at - kept.at) < Math.abs(best.at - kept.at) ? line : best, own[0]) : own.reduce((best, line) => line.text.length > best.text.length ? line : best, own[0])
    voices.push({ id, guess, reason, said: clip(said.text, 140), clip: kept?.name, seconds })
  }
  return voices.slice(0, MAX_VOICES)
}

/**
 * What is still to ask once the call's voices changed: one merged into another is no longer a voice of its own, and
 * when no voice is left to answer, it is closed (and its sound is no longer needed).
 */
export function pruneConfirm(confirm: CallConfirm, transcript: TranscriptEntry[], now: number): CallConfirm {
  const present = new Set(transcript.map(line => line.voiceId))
  const voices = confirm.voices.filter(voice => present.has(voice.id))
  return { ...confirm, voices, closed: confirm.closed ?? (voices.every(voice => voice.answered !== undefined) ? now : undefined) }
}

/** How many voices the person still has to answer, while the sound is kept. */
export function namesToConfirm(confirm: CallConfirm | undefined, now: number): number {
  if (!confirm || confirm.closed || confirm.until <= now) return 0
  return confirm.voices.filter(voice => voice.answered === undefined).length
}
