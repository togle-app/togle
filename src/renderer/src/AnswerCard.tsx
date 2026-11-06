import { memo, useEffect, useState } from 'react'
import type { AssistEvent, AssistKind, InstantFact, Source, AssistanceContext } from '@shared/types'
import { sourceLabel } from '@shared/agent-learning'
import { ErrorText } from './ErrorText'
import { useHotkey } from './hotkeys'
import { InlineMarkdown, Markdown } from './Markdown'
import { richPreview } from '@shared/rich-text'

type PartStatus = 'streaming' | 'done' | 'error'

/** The deep answer to a hard question: the stronger model, streaming in below the quick answer. */
export interface DeepAnswer {
  text: string
  status: PartStatus
  /** When it started thinking. */
  at: number
  activity?: string
  error?: string
  /** Stopped for a newer question's deep answer, before it was through: the card says so, and can finish it. */
  cut?: boolean
}

export interface AnswerItem {
  id: string
  kind: AssistKind
  title: string
  question: string
  agentId: string
  /** The main answer: words to say now (or the summary, or the answer to my question). */
  text: string
  status: PartStatus
  /** What the agent is doing right now, e.g. "Looking up: scale plan price". */
  activity?: string
  sources: Source[]
  context?: AssistanceContext
  error?: string
  withScreen: boolean
  at: number
  /** An approved answer whose question matches, shown before the model replies. */
  match?: { question: string; answer: string }
  /** Lines of the agent's documents that answer the question, also shown before the model replies. */
  facts?: InstantFact[]
  deep?: DeepAnswer
  /** Picked up with the call when Togle started again: shown as it was, nothing more to ask of it. */
  restored?: boolean
}

export const isStreaming = (item: AnswerItem): boolean => item.status === 'streaming' || item.deep?.status === 'streaming'

/**
 * Stopped before it said anything: a newer suggestion took its place (or it was stopped). An empty reply that wasn't
 * stopped ends in an error instead, so this is never an answer that looks given.
 */
export const saidNothing = (item: AnswerItem): boolean =>
  item.status === 'done' && !item.text && !item.error && !item.deep && !item.match && !item.facts?.length

/** Where the lines shown at once are from: what I told the agent, its documents, or both. */
const factsHead = (facts: InstantFact[]): string =>
  facts.every((f) => f.mine) ? 'From what you told me' : facts.some((f) => f.mine) ? 'From what you told me and your documents' : 'From your documents'

/**
 * The call's cards as the window saved them, after it loaded again (Reload after an error): what's still being
 * answered goes on streaming, what ended meanwhile ended.
 */
export function reloadedCards(cards: unknown[], answering: string[]): AnswerItem[] {
  const open = new Set(answering)
  const ended = (id: string, part: 'main' | 'deep', status: PartStatus): PartStatus => (status === 'streaming' && !open.has(`${id}:${part}`) ? 'done' : status)
  return (cards as AnswerItem[]).map((a) => ({
    ...a,
    status: ended(a.id, 'main', a.status),
    deep: a.deep && { ...a.deep, status: ended(a.id, 'deep', a.deep.status) }
  }))
}

/** Cards saved with a call, as they come back after Togle closed: what was still streaming stopped there. */
export function restoredCards(cards: unknown[]): AnswerItem[] {
  const ended = (status: PartStatus): PartStatus => (status === 'streaming' ? 'done' : status)
  return (cards as AnswerItem[]).map((a) => ({
    ...a,
    restored: true,
    status: ended(a.status),
    activity: undefined,
    deep: a.deep && { ...a.deep, status: ended(a.deep.status), activity: undefined }
  }))
}

/** Folds one streamed event into the list of answers (newest first). */
export function applyAnswerEvent(items: AnswerItem[], event: AssistEvent, max = 30): AnswerItem[] {
  if (event.type === 'start') {
    const { type: _type, ...start } = event
    return [{ ...start, text: '', status: 'streaming' as const, sources: [] }, ...items].slice(0, max)
  }
  return items.map((a) => {
    if (a.id !== event.id) return a
    // Events for a deep answer that was dropped (or replaced) have nowhere to go.
    const deep = (patch: (d: DeepAnswer) => Partial<DeepAnswer>): AnswerItem => (a.deep ? { ...a, deep: { ...a.deep, ...patch(a.deep) } } : a)
    switch (event.type) {
      case 'match':
        return { ...a, match: { question: event.question, answer: event.answer } }
      case 'facts':
        return { ...a, facts: event.facts }
      case 'delta':
        return event.part === 'deep'
          ? deep((d) => ({ text: d.text + event.text, activity: undefined }))
          : { ...a, text: a.text + event.text, activity: undefined }
      case 'status':
        return event.part === 'deep' ? deep(() => ({ activity: event.text })) : { ...a, activity: event.text }
      case 'sources':
        return { ...a, sources: event.sources }
      case 'context':
        return { ...a, context: event.context }
      case 'deep':
        return { ...a, deep: event.state === 'start' ? { text: '', status: 'streaming', at: event.at } : undefined }
      case 'error':
        return event.part === 'deep'
          ? deep(() => ({ status: 'error', error: event.message, activity: undefined }))
          : { ...a, status: 'error', error: event.message, activity: undefined }
      case 'done':
        return event.part === 'deep' ? deep(() => ({ status: 'done', activity: undefined, cut: event.cut })) : { ...a, status: 'done', activity: undefined }
    }
  })
}

const KIND_LABEL: Record<AssistKind, string> = { suggest: 'Say this', ask: 'Answer', summary: 'Summary' }

// Remember explicit choices across agent navigation; default folding still follows the newest answer.
const FOLDS_KEY = 'togle.answer-folds.v1'
function folds(): [string, boolean][] {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(FOLDS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'boolean').slice(-120) : []
  } catch { return [] }
}

/** The same question, whatever its letters' case and punctuation. */
const sameQuestion = (a: string, b: string): boolean => {
  const words = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  return words(a) === words(b)
}

/** An answer as one line of plain text: without its Markdown, its lines run together. */
const plain = richPreview

/** Sources the answer actually cites, by document. */
function citedDocs(text: string, sources: Source[]): string[] {
  const cited = new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).map(Number)))
  return [...new Set(sources.filter((s) => cited.has(s.n)).map((s) => s.doc))]
}

// How long Copy says "Copied".
const COPIED_MS = 1500

const withoutCitations = (text: string): string => text.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, '').trim()

/** The part to say, without the supporting facts and citation markers: what an approved answer should hold. */
export function sayPart(text: string): string {
  return withoutCitations(text.split(/\n\s*\**Facts:?\**\s*\n/i)[0])
}

/** What a card says to say, as its Copy copies it: the part to say, or the approved answer when that's all it shows. */
export const toSay = (item: AnswerItem): string => (item.text.trim() ? sayPart(item.text) : (item.match?.answer ?? ''))

/** Seconds since a moment, ticking. */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <>{Math.max(0, Math.round((now - since) / 1000))}s</>
}

interface Props {
  item: AnswerItem
  older?: boolean
  /** Shows what they said that it answers (not where the question is shown above it already). */
  asked?: boolean
  /** Asks the stronger model to think the question through (again, harder, if it already did). */
  onDeeper?: (item: AnswerItem) => void
  /** Asks a card that failed again. */
  onAgain?: (item: AnswerItem) => void
  /** Stops this card's answers. */
  onStop?: (item: AnswerItem) => void
}

// Memoized: while one card streams, the others don't re-render (or re-parse their Markdown).
export const AnswerCard = memo(function AnswerCard({ item, older, asked = true, onDeeper, onAgain, onStop }: Props) {
  // The part just copied: its Copy says so for a moment.
  const [copied, setCopied] = useState<'main' | 'deep' | null>(null)
  const deeperKeys = useHotkey('deeper')
  // An older card of the call is a line, until it's opened.
  const [choice, setChoice] = useState<boolean | undefined>(() => folds().find(([id]) => id === item.id)?.[1])
  const opened = choice ?? (!older || isStreaming(item))
  const setOpened = (value: boolean): void => {
    setChoice(value)
    try { sessionStorage.setItem(FOLDS_KEY, JSON.stringify([...folds().filter(([id]) => id !== item.id), [item.id, value]].slice(-120))) } catch { /* Storage is optional. */ }
  }
  const { deep } = item
  // A refused clipboard (the window not focused) just does nothing.
  const copy = (part: 'main' | 'deep', text: string): void =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(part)
      setTimeout(() => setCopied((now) => (now === part ? null : now)), COPIED_MS)
    }, () => undefined)
  const docs = citedDocs(`${item.text}\n${deep?.text ?? ''}`, item.sources)
  const failed = item.status === 'error' && !item.text
  const canDeepen = !!onDeeper && !item.restored && item.kind !== 'summary' && !failed && item.status !== 'streaming' && deep?.status !== 'streaming'

  // An older card of the call, as one line: what it was asked, faint, then what it said (or that it couldn't answer); a
  // click shows all of it. One still at work, or that said nothing, stays as it is.
  if (!opened) {
    // Not where the question is shown above it already (asked again, beside the review).
    const head = !asked ? '' : item.kind === 'suggest' ? item.question.trim() : item.kind === 'ask' ? item.title : KIND_LABEL.summary
    return (
      <article className={`assist ${item.kind} ${item.status} older line`}>
        <button type="button" className="line-open" aria-label="Expand suggestion" aria-expanded={false} title="Expand suggestion" onClick={() => setOpened(true)}>
          {head && <span className="line-asked">{head} · </span>}
          {failed ? `Couldn't answer: ${item.error ?? ''}` : plain(toSay(item)) || item.activity || 'Thinking…'}
          {isStreaming(item) && <span className="thinking"> · Updating</span>}
        </button>
      </article>
    )
  }

  const stoppable = !!onStop && isStreaming(item)
  const notes = (item.match || !!item.facts?.length) && <>
    {item.match && <div className="match">
      <p className="match-head">{sameQuestion(item.match.question, item.question) ? 'Your answer' : `Your answer to “${item.match.question}”`}</p>
      <Markdown text={item.match.answer} />
    </div>}
    {!!item.facts?.length && <div className="facts">
      <p className="facts-head">{factsHead(item.facts)}</p>
      {item.facts.map(fact => <p key={fact.text}><InlineMarkdown text={fact.text} /> <span className="facts-doc">{fact.doc}</span></p>)}
    </div>}
  </>
  const answered = !!item.text.trim() && item.status === 'done'
  return (
    <article className={`assist ${item.kind} ${item.status} ${older ? 'older' : ''}`}>
      {/* A suggestion is what it is: the others say theirs. */}
      {(
        <header>
          <button type="button" className="link fold-answer" aria-label="Collapse suggestion" aria-expanded={true} onClick={() => setOpened(false)}>Collapse</button>
          {item.kind === 'summary' && <span className={`kind ${item.kind}`}>{KIND_LABEL[item.kind]}</span>}
          {item.kind === 'ask' && <span className="title">{item.title}</span>}
          {item.withScreen && <span className="tag">screen</span>}
          {stoppable && (
            <button className="link stop" title="Stop this answer" onClick={() => onStop!(item)}>
              Stop
            </button>
          )}
        </header>
      )}
      {/* What they said that it answers: with questions coming fast, or looking back, which answer is for what. */}
      {asked && item.kind === 'suggest' && item.question.trim() && (
        <p className="asked" title={item.question.trim()}>
          “{item.question.trim()}”
        </p>
      )}
      {!answered && notes}
      {item.text ? (
        <Markdown text={item.text} sources={item.sources} streaming={item.status === 'streaming'} />
      ) : (
        item.status === 'streaming' && <p className="thinking">{item.activity ?? 'Thinking…'}</p>
      )}
      {item.text && item.activity && <p className="thinking">{item.activity}</p>}
      {item.error && <ErrorText text={item.error} />}
      {answered && notes && <details className="answer-evidence"><summary>Reference notes</summary>{notes}</details>}
      {/* With a deeper answer under it, the quick one's Copy is right under the quick one: the one at the bottom is the
          deeper answer's. */}
      {deep && !!toSay(item) && (
        <div className="card-actions">
          <button className="link" onClick={() => copy('main', toSay(item))}>
            {copied === 'main' ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}

      {deep && (
        <section className={`deep ${deep.status}`}>
          <div className="deep-head">
            <span>Deeper answer</span>
            {deep.status === 'streaming' && !deep.text && (
              <span className="thinking">
                {deep.activity ?? 'Thinking it through…'} <Elapsed since={deep.at} />
              </span>
            )}
          </div>
          {deep.text && <Markdown text={deep.text} sources={item.sources} streaming={deep.status === 'streaming'} />}
          {deep.text && deep.activity && <p className="thinking">{deep.activity}</p>}
          {deep.cut ? (
            <p className="hint">
              Stopped when they asked something new.{' '}
              {canDeepen && (
                <button className="link" onClick={() => onDeeper!(item)}>
                  Finish it
                </button>
              )}
            </p>
          ) : (
            deep.status === 'done' && !deep.text && <p className="hint">Stopped.</p>
          )}
          {deep.error && <ErrorText text={deep.error} />}
        </section>
      )}
      {docs.length > 0 && <p className="sources">From: {docs.join(' · ')}</p>}
      {item.context && <details className="answer-evidence context-trace">
        <summary>Context for this answer</summary>
        <p className="hint">Material supplied to the model. Inclusion alone does not show which items it relied on.</p>
        {!!item.context.skills.length && <><h4>Assistance skills</h4><ul>{item.context.skills.map(skill => <li key={skill.id}>{skill.name} · version {skill.revision}</li>)}</ul></>}
        {!!item.context.references.length && <><h4>Reference knowledge</h4><ul>{item.context.references.map(reference => <li key={reference.id}>{reference.name}</li>)}</ul></>}
        <details><summary>Remembered context ({item.context.facts.length})</summary>{item.context.facts.map(fact => <p key={fact.text}><InlineMarkdown text={fact.text} /><small className="hint"> · {sourceLabel(fact.source)}</small></p>)}</details>
      </details>}
      {/* What else it offers, under what it says: thinking it through (or asking again, when it failed), and copying. */}
      {((canDeepen && !deep?.cut) || (failed && !!onAgain) || (deep ? !!deep.text && deep.status !== 'streaming' : !!toSay(item))) && (
        <div className="card-actions">
          {failed && onAgain && (
            <button className="link" onClick={() => onAgain(item)}>
              Try again
            </button>
          )}
          {canDeepen && !deep?.cut && (
            <button className="link" title={deeperKeys || undefined} onClick={() => onDeeper!(item)}>
              {deep?.text ? 'Think harder' : 'Think deeper'}
            </button>
          )}
          {deep
            ? !!deep.text &&
              deep.status !== 'streaming' && (
                <button className="link" onClick={() => copy('deep', withoutCitations(deep.text))}>
                  {copied === 'deep' ? 'Copied' : 'Copy'}
                </button>
              )
            : !!toSay(item) && (
                <button className="link" onClick={() => copy('main', toSay(item))}>
                  {copied === 'main' ? 'Copied' : 'Copy'}
                </button>
              )}
        </div>
      )}
    </article>
  )
})
