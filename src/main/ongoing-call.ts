import { randomUUID } from 'node:crypto'
import { introducedName } from '@shared/meeting'
import { mergeSpeakers } from '@shared/speakers'
import { speechLesson } from '@shared/speech-words'
import type { Speaker, TranscriptEntry } from '@shared/types'
import type { RememberedVoice } from '@shared/voices'
import type { CallState } from './call-file'
import { getSettings } from './settings'

// The most moments one call can have marked.
const MAX_MARKS = 200
// The PC's clock set back more than this during a call is the clock, not a line transcribed late (see callTime).
const CLOCK_JUMP_MS = 60_000
const CLOCK_JUMP_GAP_MS = 5_000
// Without headphones the mic also hears the other side. Such a "me" line repeats their words at the same
// moment: most of its words appear in a line of theirs that covers most of its time.
const ECHO_SLACK_MS = 800
const ECHO_OVERLAP = 0.5
const ECHO_WORDS = 0.6
// Lines of mine compared with theirs for an echo: the last few are enough, as both arrive within seconds.
const ECHO_LOOKBACK = 20

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/** Whether a line of mine is the mic picking up a line of theirs from the speakers. */
export function isEcho(mine: TranscriptEntry, theirs: TranscriptEntry): boolean {
  const overlap = Math.min(mine.end, theirs.end + ECHO_SLACK_MS) - Math.max(mine.at, theirs.at - ECHO_SLACK_MS)
  if (overlap < (mine.end - mine.at) * ECHO_OVERLAP) return false
  const pool = new Map<string, number>()
  for (const w of words(theirs.text)) pool.set(w, (pool.get(w) ?? 0) + 1)
  const own = words(mine.text)
  let shared = 0
  for (const w of own) {
    const left = pool.get(w) ?? 0
    if (left > 0) {
      shared++
      pool.set(w, left - 1)
    }
  }
  return own.length > 0 && shared / own.length >= ECHO_WORDS
}

type VoiceName = { name: string; by: 'suggested' | 'user' | 'remembered'; identity?: string }

/**
 * The call being written down: what was said and by whom (the voices, named as people say who they are, as the person
 * names them, or as remembered), the moments marked, and whether the person told the others. Its words reach the AI
 * only once the call is over, for its notes (meeting-notes.ts).
 */
export class OngoingCall {
  private transcript: TranscriptEntry[] = []
  private listening = false
  /** When the call was last cleared: what was said before it, transcribed only now, was the call before. */
  private clearedAt = 0
  /** How far the PC's clock was set back during this call (see callTime). */
  private clockShift = 0
  /** When the person said they had told the others that the call is being written down (0: not yet). */
  private toldOthersAt = 0
  /** The moments the person marked, on the call's clock. */
  private marks: number[] = []
  /** Voices heard before their line came in (by the line's segment), names given to voices, and voices merged. */
  private voiceSegments = new Map<string, string>()
  private voiceNames = new Map<string, VoiceName>()
  private voiceAliases = new Map<string, string>()
  /** Told whenever the call changes, to save it (call-file.ts). */
  onChange?: () => void

  constructor(
    private send: (channel: string, payload: unknown) => void,
    /** The person's own name, as their AI account has it: their voice's name until they give another. */
    private ownName: () => string | undefined = () => undefined,
    /** A spelling the person said aloud ("Togle, T-O-G-L-E"): kept for speech recognition. */
    private learnWords?: (word: { heardAs: string; word: string }) => Promise<void>
  ) {}

  get isListening(): boolean {
    return this.listening
  }

  /** What to save of the call to pick it up again (call-file.ts). */
  callState(): CallState {
    return { transcript: this.transcript, toldOthers: this.toldOthersAt, marks: this.marks }
  }

  /** Picks up a call saved when Togle last closed. */
  restore(state: CallState): void {
    this.transcript = Array.isArray(state.transcript) ? state.transcript : []
    this.voiceNames.clear(); this.voiceSegments.clear(); this.voiceAliases.clear()
    for (const line of this.transcript) if (line.voiceId && line.voiceName) this.voiceNames.set(line.voiceId, { name: line.voiceName, by: line.voiceNamedBy ?? 'suggested', identity: line.voiceIdentityId })
    this.toldOthersAt = Number.isFinite(state.toldOthers) ? state.toldOthers! : 0
    this.marks = Array.isArray(state.marks) ? state.marks.filter(Number.isFinite).slice(0, MAX_MARKS) : []
  }

  /** The call so far, for a window that opens on it. */
  current(): { transcript: TranscriptEntry[]; toldOthers: number; marks: number[] } {
    return { transcript: this.transcript, toldOthers: this.toldOthersAt, marks: this.marks }
  }

  /** Whether there is a call to attach a mark or a note about the others to: one running, or one with words in it. */
  private inCall(): boolean {
    return this.listening || this.transcript.length > 0
  }

  /**
   * The person told the others on the call that it is being written down (or took that back): the call's notes
   * record it, and the reminder to do so goes. Said once, the first time stays.
   */
  setToldOthers(told: boolean): void {
    if (told && !this.inCall()) return
    const at = told ? this.toldOthersAt || this.now() : 0
    if (at === this.toldOthersAt) return
    this.toldOthersAt = at
    this.onChange?.()
    this.send('call:flags', { toldOthers: this.toldOthersAt, marks: this.marks })
  }

  /** The person marked this moment: the notes list marked moments first. Returns every mark of the call. */
  mark(): number[] {
    if (!this.inCall() || this.marks.length >= MAX_MARKS) return this.marks
    this.marks = [...this.marks, this.now()]
    this.onChange?.()
    this.send('call:flags', { toldOthers: this.toldOthersAt, marks: this.marks })
    return this.marks
  }

  setListening(listening: boolean): void {
    this.listening = listening
  }

  /** A new call: nothing of the one before stays. */
  clear(): void {
    this.clearedAt = Date.now()
    // The next call starts on the clock as it is.
    this.clockShift = 0
    this.transcript = []
    this.voiceNames.clear(); this.voiceSegments.clear(); this.voiceAliases.clear()
    this.toldOthersAt = 0
    this.marks = []
  }

  /** Now, on the call's timeline (the clock as it was, when it was set back during the call). */
  private now(): number {
    return Date.now() + this.clockShift
  }

  /**
   * A moment as the call's timeline has it. The window stamps what's heard by the PC's clock; set back mid-call (a
   * time sync after sleep, by hand), what comes next would land an hour into the past (or before New call, where it's
   * dropped). Past a minute back, that's the clock: what comes after it goes on after what came before. A clip
   * transcribed late is a few seconds back, and stays where it was said.
   */
  private callTime(at: number): number {
    const before = Math.max(this.clearedAt, this.transcript.at(-1)?.end ?? 0)
    // Set a few seconds after it, so a clip transcribed late still lands after what came before.
    if (before && at + this.clockShift < before - CLOCK_JUMP_MS) this.clockShift = before + CLOCK_JUMP_GAP_MS - at
    return at + this.clockShift
  }

  private canonicalVoice(id: string): string {
    for (let n = 0; n < this.voiceAliases.size && this.voiceAliases.has(id); n++) id = this.voiceAliases.get(id)!
    return id
  }

  /** Who a live caption's voice is, as far as it is known yet. */
  speakerForSegment(segment: string): Pick<TranscriptEntry, 'voiceId' | 'voiceName' | 'voiceNamedBy'> {
    const voiceId = this.voiceSegments.get(segment), person = voiceId && this.voiceNames.get(voiceId)
    return { voiceId, voiceName: person ? person.name : undefined, voiceNamedBy: person ? person.by : undefined }
  }

  /** A line heard again by another recognizer: whose voice it was is told again too. */
  forgetVoiceSegment(segment: string): void {
    this.voiceSegments.delete(segment)
    const entry = this.transcript.find(line => line.segmentId === segment && line.speaker === 'them')
    if (entry) {
      entry.voiceId = undefined; entry.voiceName = undefined; entry.voiceNamedBy = undefined; entry.voiceIdentityId = undefined
      this.send('transcript:updated', [entry]); this.onChange?.()
    }
  }

  /** Which voice said a line (by its segment), and who that is when the voice is remembered. */
  identifyVoice(segmentId: string, voiceId: string, person?: RememberedVoice): void {
    voiceId = this.canonicalVoice(voiceId)
    if (person) {
      const known = this.voiceNames.get(voiceId)
      if (!known || known.by !== 'user') this.voiceNames.set(voiceId, { name: person.name, by: 'remembered', identity: person.id })
      else if (known.name === person.name) this.voiceNames.set(voiceId, { ...known, identity: person.id })
    }
    const entry = this.transcript.find(line => line.segmentId === segmentId && line.speaker === 'them')
    if (entry) {
      if (entry.voiceId !== voiceId) { delete entry.voiceName; delete entry.voiceNamedBy; delete entry.voiceIdentityId }
      entry.voiceId = voiceId
      this.nameVoice(entry)
      this.send('transcript:updated', this.transcript.filter(line => line.voiceId === voiceId))
      this.onChange?.()
    } else {
      this.voiceSegments.set(segmentId, voiceId)
      if (this.voiceSegments.size > 100) this.voiceSegments.delete(this.voiceSegments.keys().next().value!)
    }
  }

  renameVoice(id: string, name: string): void {
    id = this.canonicalVoice(id)
    const value = name.replace(/[\r\n\[\]<>]/g, '').trim().slice(0, 60)
    if (!value || !this.transcript.some(line => line.voiceId === id)) throw new Error('Choose a speaker from this call and enter a name.')
    this.voiceNames.set(id, { name: value, by: 'user' })
    for (const line of this.transcript) if (line.voiceId === id) this.nameVoice(line)
    this.send('transcript:updated', this.transcript.filter(line => line.voiceId === id))
    this.onChange?.()
  }

  /** Not them: a guessed or recognized name is taken off the voice's lines. A name the person gave stays. */
  dropVoiceName(id: string): void {
    id = this.canonicalVoice(id)
    if (this.voiceNames.get(id)?.by === 'user') return
    this.voiceNames.delete(id)
    const changed = this.transcript.filter(line => line.voiceId === id && line.voiceNamedBy !== 'user')
    for (const line of changed) { line.voiceName = undefined; line.voiceNamedBy = undefined; line.voiceIdentityId = undefined }
    if (changed.length) { this.send('transcript:updated', changed); this.onChange?.() }
  }

  /** The person had a voice they named remembered: its lines carry who that is. */
  rememberVoice(id: string, person: RememberedVoice): void {
    id = this.canonicalVoice(id)
    const known = this.voiceNames.get(id)
    if (!known || known.name !== person.name) return
    this.voiceNames.set(id, { ...known, identity: person.id })
    for (const line of this.transcript) if (line.voiceId === id) this.nameVoice(line)
    this.send('transcript:updated', this.transcript.filter(line => line.voiceId === id))
    this.onChange?.()
  }

  /** Two voices are one person: the lines of `from` become `into`'s, now and for the rest of the call. */
  mergeVoices(from: string, into: string): string | undefined {
    from = this.canonicalVoice(from); into = this.canonicalVoice(into)
    this.transcript = mergeSpeakers(this.transcript, from, into)
    this.voiceAliases.set(from, into)
    this.voiceNames.delete(from)
    const name = this.transcript.find(line => line.voiceId === into && line.voiceName)
    if (name?.voiceName) this.voiceNames.set(into, { name: name.voiceName, by: name.voiceNamedBy ?? 'suggested', identity: name.voiceIdentityId })
    for (const [segment, voice] of this.voiceSegments) this.voiceSegments.set(segment, this.canonicalVoice(voice))
    this.send('transcript:updated', this.transcript.filter(line => line.voiceId === into))
    this.onChange?.()
    return name?.voiceName
  }

  private nameVoice(entry: TranscriptEntry): void {
    if (!entry.voiceId) return
    const known = this.voiceNames.get(entry.voiceId)
    const candidate = known?.name ?? introducedName(entry.text) ?? (entry.speaker === 'me' ? getSettings().assist.names?.split(',')[0].trim() || this.ownName() : undefined)
    if (!candidate) return
    const by = known?.by ?? 'suggested'
    this.voiceNames.set(entry.voiceId, { name: candidate, by, identity: known?.identity })
    for (const line of this.transcript) if (line.voiceId === entry.voiceId) { line.voiceName = candidate; line.voiceNamedBy = by; line.voiceIdentityId = known?.identity }
    entry.voiceName = candidate; entry.voiceNamedBy = by; entry.voiceIdentityId = known?.identity
  }

  /** A line said, as speech recognition heard it: into the transcript in spoken order, unless it is an echo. */
  add(speaker: Speaker, text: string, at: number, end = at, segmentId?: string): void {
    const shift = this.callTime(at) - at
    at += shift
    end += shift
    if (at < this.clearedAt) return
    const entry: TranscriptEntry = { id: randomUUID(), speaker, text, at, end, segmentId }
    entry.voiceId = speaker === 'me' ? 'me' : segmentId ? this.voiceSegments.get(segmentId) : undefined
    if (segmentId) this.voiceSegments.delete(segmentId)
    // The mic hearing the other side from the speakers: drop it, whichever of the two lines came first.
    const recent = this.transcript.slice(-ECHO_LOOKBACK)
    if (speaker === 'me' && recent.some((e) => e.speaker === 'them' && isEcho(entry, e))) return
    if (speaker === 'them') {
      const echoes = new Set(recent.filter((e) => e.speaker === 'me' && isEcho(e, entry)))
      if (echoes.size) {
        this.transcript = this.transcript.filter((e) => !echoes.has(e))
        this.send('transcript:remove', [...echoes].map((e) => e.id))
      }
    }
    // Clips are transcribed in arrival order; keep the transcript in spoken order.
    let i = this.transcript.length
    while (i > 0 && this.transcript[i - 1].at > at) i--
    this.transcript.splice(i, 0, entry)
    this.nameVoice(entry)
    if (entry.voiceName) this.send('transcript:updated', this.transcript.filter(line => line.voiceId === entry.voiceId))
    this.send('transcript', entry)
    this.onChange?.()
    if (speaker === 'me') {
      const wording = speechLesson(text)
      if (wording) void this.learnWords?.(wording).catch(error => console.warn('[call wording]', (error as Error).message))
    }
  }
}
