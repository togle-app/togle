import type { ScreenReference, TranscriptEntry } from './types'

export const SCREEN_SAMPLE_MS = 500
export const SCREEN_HISTORY_MS = 120_000

// Capture references, not conferencing logistics such as "can you see/hear me?" or "I'll share in a moment".
const SCREEN_REFERENCE = /\b(?:as you can see(?:\b.{0,80})?(?:screen|slide|chart|diagram|code|here)|(?:look|looking) at (?:my |the |this |your )?(?:screen|slide|chart|diagram|code)|(?:on|in) (?:my|your|the|this|our) (?:shared )?screen|(?:watch|see) (?:what happens|how (?:this|it) (?:changes|works)|(?:me |what I )(?:click|type|drag))|this (?:chart|diagram|slide|graph) (?:shows|illustrates)|kao što (?:možete (?:vidjeti|da vidite)|vidite)|na (?:(?:mom|mojem|vašem) )?ekranu)\b/iu

export function screenReference(entry: TranscriptEntry): ScreenReference | undefined {
  return SCREEN_REFERENCE.test(entry.text) ? { id: entry.id, speaker: entry.speaker, text: entry.text.slice(0, 800), from: entry.at, to: Math.max(entry.at, entry.end) } : undefined
}

/** Freeze speech time before retrieval and model latency. Later transcript arrivals cannot move this anchor. */
export function screenQuestionTime(entries: TranscriptEntry[], requestedAt: number, question = ''): { from: number; to: number; references: ScreenReference[]; speech: ScreenReference[] } {
  const references: ScreenReference[] = []
  const speech: ScreenReference[] = []
  let turn: TranscriptEntry | undefined
  let questionTurn: TranscriptEntry | undefined
  const normalize = (text: string): string => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const normalized = ` ${normalize(question)} `
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.at > requestedAt) continue
    turn ??= entry
    if (speech.length < 8) speech.unshift({ id: entry.id, speaker: entry.speaker, text: entry.text.slice(0, 300), from: entry.at, to: Math.min(Math.max(entry.at, entry.end), requestedAt) })
    if (!questionTurn && question && entry.end >= requestedAt - SCREEN_HISTORY_MS) {
      const said = normalize(entry.text)
      if (said.length >= 8 && (normalized.includes(` ${said} `) || (normalized.trim().length >= 8 && ` ${said} `.includes(normalized)))) questionTurn = entry
    }
    const reference = screenReference(entry)
    // Old references still need exact timestamps so an expired recording is reported as missing, never as now.
    if (reference && references.length < 6) references.unshift({ ...reference, to: Math.min(reference.to, requestedAt) })
    if (references.length === 6 && speech.length === 8) break
  }
  const latest = references.at(-1)
  const reference = latest && latest.to >= requestedAt - SCREEN_HISTORY_MS ? latest : undefined
  const from = questionTurn?.at ?? reference?.from ?? turn?.at ?? requestedAt
  return { from, to: Math.max(from, Math.min(questionTurn?.end ?? reference?.to ?? turn?.end ?? requestedAt, requestedAt)), references, speech }
}

/** Human-readable timestamps retain milliseconds; no inference-completion time is substituted. */
export function screenClock(at: number): string {
  const date = new Date(at)
  if (!Number.isFinite(date.getTime())) return 'Invalid time'
  return `${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

export function screenRange(from: number, to: number): string {
  return from === to ? screenClock(from) : `${screenClock(from)}–${screenClock(to)}`
}
