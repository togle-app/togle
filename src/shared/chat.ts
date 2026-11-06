import type { CallChatContext, CallSession, Lessons, TrainTurn } from './types'
import { lessonCount } from './learning'

/** A call that taught the agent about my work: offered to keep as a document, being written, kept (then undone). */
export interface LessonOffer {
  id: string
  title: string
  state: 'offer' | 'writing' | 'kept' | 'removed'
  docId?: string
  name?: string
  error?: string
}

/**
 * The call review, as the agent tells it in its conversation: what it learned on its own (in its history, to undo), the
 * facts memory had no room for, and what it held back to ask about: a change to what it knows, an amount or a deal
 * heard on the call.
 */
export type Review = {
  sessionId?: string
  reviewId?: string
  /** A summary of the call was kept, for the next call with the same people. */
  remembered?: boolean
  lesson?: LessonOffer
} & (
  | { state: 'loading' }
  // `asking`: it asks before keeping anything (Setup: Ask me first), so all it found is held.
  // `decided`: Keep or Don't keep was picked for what it held: those replies go.
  | { state: 'learned'; changes: string[]; left: string[]; held?: Lessons; asking?: boolean; error?: string; decided?: boolean }
  | { state: 'error'; message: string }
)

/** Preserve an unchanged review's identity so an archive refresh doesn't resave the agent's whole conversation. */
export function reviewAfterCall(review: Review, record: CallSession | null): Review {
  if (review.state !== 'learned' || !review.sessionId || (record && record.id !== review.sessionId)) return review
  if (record && record.learning.reviewId === review.reviewId) return review
  if (!record && review.decided && !review.held && !review.reviewId) return review
  const held = record?.learning.pending
  const pending = held && lessonCount(held) > 0
  return { ...review, reviewId: record?.learning.reviewId, held: pending ? held : undefined, decided: !pending, changes: record?.learning.changes.map(change => change.id) ?? review.changes }
}

/** What a call review said, for the Train model: so "yes, keep those" or "it's 39, not 53" says what about. */
export function reviewText(review: Review): string {
  if (review.state === 'loading') return 'I was looking back at the call.'
  if (review.state === 'error') return `I couldn't look back at the call: ${review.message}`
  const lines = ['I looked back at the call.']
  if (review.changes.length) lines.push("I kept on my own what's listed as changes below.")
  const held = review.held
  if (held) {
    lines.push(
      review.asking
        ? 'I asked them which of these to keep (I keep nothing from a call before they say). Keep only what they confirm, as they say it:'
        : "I held these back for their yes, since each changes what I know or says an amount or a deal heard on the call (maybe misheard, or meant for that customer only). Keep only what they confirm, as they say it:",
      ...held.facts.map((f) => `- Fact: ${f}`),
      ...held.answers.map((a) => `- Answer to "${a.question}": ${a.answer}`),
      ...held.updates.map((u) => `- Change the fact "${u.from}" to "${u.to}"`),
      ...held.forget.map((f) => `- Forget the fact: ${f}`),
      ...held.skills.map((s) => `- Skill "${s.name}"${s.when ? ` (when ${s.when})` : ''}:\n${s.how}`)
    )
  }
  if (review.left.length) lines.push(`Memory was full, so these facts weren't kept: ${review.left.join(' · ')}`)
  if (review.lesson?.state === 'offer') lines.push(`The call taught me about their work ("${review.lesson.title}"): I offered to keep notes of it as a document (keep_call_notes).`)
  if (review.lesson?.state === 'kept') lines.push(`I kept notes of the call as the document "${review.lesson.name}".`)
  if (review.remembered) lines.push('I kept a summary of the call, for the next call with the same people.')
  return lines.join('\n')
}

/**
 * An agent's conversation as Togle keeps it on this PC, encrypted: its entries, and the suggestions of the calls in it
 * by their ids. The window's to read and write; the main process keeps it as it is given.
 */
export interface SavedConversation {
  entries: unknown[]
  cards: Record<string, unknown>
}

/** A message of an agent's conversation, as far as its Train model reads it. */
export type ChatTurnSource = { role: 'user'; text: string; call?: CallChatContext } | { role: 'agent'; text: string; changes: string[] }

/** What was said with an agent in its conversation, as its calls read it; a call in it is only a mark of when it was. */
export type TalkTurn = { role: 'user' | 'agent'; text: string; at: number; changes?: string[] } | { role: 'call'; at: number; endedAt?: number }

// What calls read of an agent's conversation: its latest entries; a message up to this long (a pasted log or a whole
// chat goes by its start: what's in it went into Knowledge, if anywhere), and a reply's first few changes.
const TALK_ENTRIES = 200
const TALK_TEXT_CHARS = { user: 1_500, agent: 800 }
const TALK_CHANGES = 6

const cutTo = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)} [… ${text.length - max} more characters]`)

/**
 * What was said with the agent lately, from its conversation's entries as the window keeps them: my messages, its
 * replies with what they changed, and when calls were. What was said on a call stays out (other people's words are
 * kept only as a summary of the call, if at all), and so does what a review said (what it kept is in the training).
 */
export function talkOf(entries: unknown[]): TalkTurn[] {
  const turns: TalkTurn[] = []
  // Each call's turn, by the call's id: stopped, written to (that's the way to write to the agent during a call), and
  // started again a moment later, it's the same call going on, and what was written then was written during it.
  const calls = new Map<string, Extract<TalkTurn, { role: 'call' }>>()
  for (const value of entries.slice(-TALK_ENTRIES)) {
    const e = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    if (e.role === 'call' && typeof e.startedAt === 'number') {
      const endedAt = typeof e.endedAt === 'number' ? e.endedAt : undefined
      const last = turns.at(-1)
      const same = e.resumed === true ? ((typeof e.call === 'string' ? calls.get(e.call) : undefined) ?? (last?.role === 'call' ? last : undefined)) : undefined
      if (same) same.endedAt = endedAt
      else {
        const turn: Extract<TalkTurn, { role: 'call' }> = { role: 'call', at: e.startedAt, ...(endedAt ? { endedAt } : {}) }
        turns.push(turn)
        if (typeof e.call === 'string') calls.set(e.call, turn)
      }
    } else if ((e.role === 'user' || e.role === 'agent') && typeof e.text === 'string' && typeof e.at === 'number') {
      const changes = e.role === 'agent' && Array.isArray(e.changes) ? e.changes.filter((c): c is string => typeof c === 'string').slice(0, TALK_CHANGES) : []
      const text = cutTo(e.text.trim(), TALK_TEXT_CHARS[e.role])
      if (text || changes.length) turns.push({ role: e.role, text, at: e.at, ...(changes.length ? { changes } : {}) })
    }
  }
  return turns
}

/**
 * The conversation so far, for the model: what earlier replies changed goes back with them, so it knows what it
 * already did. One turn each way at a time: what the agent said in a row (a call, then its review) is one turn.
 */
export function trainHistory(messages: ChatTurnSource[]): TrainTurn[] {
  const turns: TrainTurn[] = []
  const add = (role: TrainTurn['role'], text: string): void => {
    if (!text) return
    const last = turns.at(-1)
    if (last?.role === role) last.text += `\n\n${text}`
    else turns.push({ role, text })
  }
  for (const m of messages) {
    if (m.role === 'user') add('user', m.call ? `[Saved call reference: ${JSON.stringify(m.call)}]\n${m.text}` : m.text)
    else add('assistant', [m.text, ...m.changes.map((c) => `(${c})`)].filter(Boolean).join('\n'))
  }
  return turns
}

/** A question I had it try, as the model reads it: asked as on a call, then what it would say there (`answer`). */
export const triedTurns = (question: string, answer: string): ChatTurnSource[] => [
  { role: 'user', text: `[Try: how would you answer this, asked on a call? "${question}"]` },
  { role: 'agent', text: `[On a call I'd suggest:] ${answer}`, changes: [] }
]
