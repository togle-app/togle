import type { TranscriptEntry } from './types'
import { markedLineIds } from './meeting'

/** Display turns only: retain the original chunks and their exact times for call context. */
export function sameSpeechTurn(a: TranscriptEntry, b: TranscriptEntry): boolean {
  return a.speaker === b.speaker && (a.speaker === 'me' || !!a.voiceId && a.voiceId === b.voiceId)
    && b.at >= a.at && b.at >= a.end - 320 && b.at - a.end <= 2000
}

/** The turns, each with the ids of the lines it holds (a turn keeps the id of its first line). */
function groupedTurns(lines: TranscriptEntry[]): Array<{ turn: TranscriptEntry; ids: string[] }> {
  const groups: Array<{ turn: TranscriptEntry; ids: string[] }> = []
  for (const line of lines) {
    const last = groups.at(-1)
    if (last && sameSpeechTurn(last.turn, line)) {
      last.turn.text += ' ' + line.text
      last.turn.end = Math.max(last.turn.end, line.end)
      last.ids.push(line.id)
    } else groups.push({ turn: { ...line }, ids: [line.id] })
  }
  return groups
}

export function speechTurns(lines: TranscriptEntry[]): TranscriptEntry[] {
  return groupedTurns(lines).map(group => group.turn)
}

/** The ids of the turns that hold a line the person marked. A turn has its first line's id, so a mark on a later line of it is found through the lines' own ids. */
export function markedTurnIds(record: { transcript: TranscriptEntry[]; marks?: number[] }): Set<string> {
  const marked = markedLineIds(record)
  const turns = new Set<string>()
  if (!marked.size) return turns
  for (const group of groupedTurns(record.transcript)) if (group.ids.some(id => marked.has(id))) turns.add(group.turn.id)
  return turns
}

/** A line said again by the same voice within this long goes on from the last one: it has no avatar, name and time of its own. */
export const CONTINUES_WITHIN_MS = 30_000
/** ...until the stretch is this long, when the next line has them again, so a long speech still shows where it is. */
export const STRETCH_MS = 60_000

type Said = Pick<TranscriptEntry, 'speaker' | 'voiceId' | 'at'> & { end?: number }
const voiceOf = (line: Said): string => (line.speaker === 'me' ? 'me' : line.voiceId ?? 'call')

/** For each line, whether it goes on from the line before it. */
export function continuations(lines: Said[]): boolean[] {
  let from = 0
  return lines.map((line, index) => {
    const before = lines[index - 1]
    const goesOn = !!before && voiceOf(before) === voiceOf(line) && line.at - (before.end ?? before.at) <= CONTINUES_WITHIN_MS && line.at - from < STRETCH_MS
    if (!goesOn) from = line.at
    return goesOn
  })
}

/** Explicit correction only; never infer that two people are the same from their names. */
export function mergeSpeakers(lines: TranscriptEntry[], from: string, into: string): TranscriptEntry[] {
  const source = lines.filter(line => line.voiceId === from && line.speaker === 'them')
  const target = lines.filter(line => line.voiceId === into && line.speaker === 'them')
  if (typeof from !== 'string' || typeof into !== 'string' || from === into || from === 'me' || into === 'me' || !source.length || !target.length) throw new Error('Choose two different speakers from this call.')
  const named = [...target, ...source]
  const name = named.find(line => line.voiceName && line.voiceNamedBy === 'user') ?? named.find(line => line.voiceName)
  return lines.map(line => line.speaker === 'them' && (line.voiceId === from || line.voiceId === into)
    ? { ...line, voiceId: into, voiceName: name?.voiceName, voiceNamedBy: name?.voiceNamedBy, voiceIdentityId: name?.voiceIdentityId }
    : line)
}
