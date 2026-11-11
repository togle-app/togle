import type { Frame, TranscriptEntry } from './types'

export type TimelineItem = { at: number; line: TranscriptEntry } | { at: number; frame: Frame }

const ordered = (items: { at: number }[]): boolean => items.every((item, i) => i === 0 || items[i - 1].at <= item.at)

/**
 * The call's lines and pictures in time order (a line before a picture of the same moment). Both come in that order:
 * merged, they're in order in one pass, rather than sorted again with every line of an hour-long call. Out of order
 * (a line that ended late), they're sorted.
 */
export function inTimeOrder(transcript: TranscriptEntry[], frames: Frame[]): TimelineItem[] {
  if (!ordered(transcript) || !ordered(frames)) {
    return [...transcript.map(line => ({ at: line.at, line })), ...frames.map(frame => ({ at: frame.at, frame }))].sort((a, b) => a.at - b.at)
  }
  const out: TimelineItem[] = []
  let i = 0, j = 0
  while (i < transcript.length || j < frames.length) {
    if (j >= frames.length || (i < transcript.length && transcript[i].at <= frames[j].at)) { out.push({ at: transcript[i].at, line: transcript[i] }); i++ }
    else { out.push({ at: frames[j].at, frame: frames[j] }); j++ }
  }
  return out
}
