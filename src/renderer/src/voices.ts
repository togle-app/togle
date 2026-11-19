import type { CSSProperties } from 'react'
import type { TranscriptEntry } from '@shared/types'

/** A voice's color in a call's words: yours is Togle's, each other voice one of a few, the same voice always the same one. */
const VOICE_COLORS = ['#e5b865', '#55d3b6', '#ff9fb2', '#9ad46a', '#f0a36b', '#7fc4ff', '#c49bff']

export function colorOf(line: Pick<TranscriptEntry, 'speaker' | 'voiceId'>): CSSProperties {
  let color = 'var(--togle)'
  if (line.speaker !== 'me') {
    let hash = 0
    for (const letter of line.voiceId ?? 'call') hash = (hash * 31 + letter.charCodeAt(0)) >>> 0
    color = VOICE_COLORS[hash % VOICE_COLORS.length]
  }
  return { '--avatar': color } as CSSProperties
}

/** The first letter of who said it, on the voice's color: a guess's question mark is not part of it. */
export const initialOf = (label: string): string => Array.from(label.replace(/[?\s]+$/, ''))[0]?.toUpperCase() ?? '?'
