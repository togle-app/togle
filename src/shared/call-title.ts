import type { CallSession } from './types'

const GENERIC = /^(?:untitled call|call|meeting|meeting notes|notes|summary|key points|decisions|action items|open questions|none|null|n\/a)$/iu
const GREETING = /^(?:(?:hi|hey|hello)(?: there| guys| team| everyone| everybody| all)?|all? ?right|okay|ok|good (?:morning|afternoon|evening)|thanks|thank you|can you hear me|yes|yeah|no)[\s,.!?…]*$/iu

/** A generated name is a short label, not a greeting, section heading or paragraph. */
export function cleanCallTitle(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\r\n\x00-\x1f]/u.test(value)) return
  const title = value.trim().replace(/^#+\s+/, '').replace(/^["“]|["”]$/gu, '').replace(/\s+/g, ' ').trim()
  if (title.length < 2 || title.length > 140 || GENERIC.test(title) || GREETING.test(title)) return
  return title
}

export function titleFromNotes(notes: string): string | undefined {
  return cleanCallTitle(/^#\s+([^\r\n]+)$/mu.exec((notes || '').trim())?.[1])
}

export function titleFromReview(review: string): string | undefined {
  return cleanCallTitle(/^\s*(?:[-*•]|\d+[.)])?\s*TITLE:\s*([^\r\n]+)$/miu.exec(review.replace(/\*\*/g, ''))?.[1])
}

type Titled = Pick<CallSession, 'title' | 'customTitle' | 'titleSource' | 'meeting' | 'brief' | 'summary' | 'transcript'>
export function resolveCallTitle(record: Titled): Pick<CallSession, 'title' | 'titleSource'> {
  if (record.customTitle) return { title: record.title, titleSource: record.titleSource }
  const meeting = typeof record.meeting?.title === 'string' ? record.meeting.title.replace(/[\r\n]/g, ' ').trim().slice(0, 140) : ''
  if (meeting) return { title: meeting, titleSource: 'calendar' }
  const brief = cleanCallTitle((record.brief || '').split('\n')[0])
  if (brief) return { title: brief, titleSource: 'brief' }
  // Older releases copied the first remote utterance. Recognize it in any language.
  const firstWords = record.transcript.find(line => line.speaker === 'them')?.text.trim().slice(0, 140)
  const oldName = (record.titleSource === 'legacy' || !record.titleSource && record.title !== firstWords) && cleanCallTitle(record.title)
  if (oldName) return { title: oldName, titleSource: 'legacy' }
  const generated = record.titleSource === 'generated' && cleanCallTitle(record.title) || titleFromNotes(record.summary)
  if (generated) return { title: generated, titleSource: 'generated' }
  return { title: 'Untitled call', titleSource: 'fallback' }
}

export function withGeneratedTitle<T extends Titled>(record: T, title?: string): T {
  if (!title || record.customTitle || ['calendar', 'brief', 'legacy'].includes(resolveCallTitle(record).titleSource || '')) return record
  const valid = cleanCallTitle(title)
  return valid ? { ...record, title: valid, titleSource: 'generated' } : record
}
