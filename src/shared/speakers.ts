import type { TranscriptEntry } from './types'

/** Display turns only: retain the original chunks and their exact times for call context. */
export function sameSpeechTurn(a: TranscriptEntry, b: TranscriptEntry): boolean {
  return a.speaker === b.speaker && (a.speaker === 'me' || !!a.voiceId && a.voiceId === b.voiceId)
    && b.at >= a.at && b.at >= a.end - 320 && b.at - a.end <= 2000
}

export function speechTurns(lines: TranscriptEntry[]): TranscriptEntry[] {
  const turns: TranscriptEntry[] = []
  for (const line of lines) {
    const last = turns.at(-1)
    if (last && sameSpeechTurn(last, line)) {
      last.text += ' ' + line.text
      last.end = Math.max(last.end, line.end)
    } else turns.push({ ...line })
  }
  return turns
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
