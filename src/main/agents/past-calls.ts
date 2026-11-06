import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Agent, PastCall, PastCallDraft } from '@shared/types'
import { FIRST_NAMES } from '../names'
import { readSecret, writeSecret } from '../storage'
import { SearchIndex } from './knowledge'

// The calls kept per agent, newest first: a year of a couple of calls a day.
const KEPT = 500
// What one answer gets of earlier calls with the same people, at most.
const RECALLED = 2
const RECALL_CHARS = 1_800
// What a search of earlier calls (a tool) gives back.
const FOUND = 3

// Words written with a capital that name no one in particular: what kind of call it is, greetings, days and months,
// and the words many company names share ("Health", "Logistics"). Lowercase, without accents.
const NOT_NAMES = new Set(
  (
    'call calls meeting discovery demo intro introduction kickoff kick-off follow follow-up followup renewal review sync ' +
    'catch-up check-in checkin onboarding support sales pitch interview weekly monthly quarterly annual first second third ' +
    'final quick new next last brief agenda notes update planning workshop training session hi hello hey thanks thank yes ' +
    'okay great perfect sure sorry please monday tuesday wednesday thursday friday saturday sunday january february march ' +
    'april may june july august september october november december inc ltd llc gmbh corp corporation company group ' +
    'holdings health healthcare logistics solutions systems technologies technology tech software services service global ' +
    'international partners capital labs digital media energy bank financial consulting university school hospital clinic ' +
    'foundation agency studio enterprise enterprises cloud data team the and our their your enterprise starter growth ' +
    'pro plus premium basic standard togle'
  ).split(' ')
)

const fold = (word: string): string =>
  word
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')

/**
 * The names a text mentions: words written with a capital, not all in capitals (SSO, CFO) and not a sentence's first
 * word (anyone can start one with "Great"), except in a brief, which often starts with the company ("Acme renewal").
 */
export function namesIn(text: string, brief = false): Set<string> {
  const names = new Set<string>()
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []
    words.forEach((word, i) => {
      if ((i === 0 && !brief) || word.length < 3 || !/^\p{Lu}/u.test(word) || word === word.toUpperCase()) return
      const name = fold(word.replace(/['’]s$/, ''))
      if (name.length >= 3 && !NOT_NAMES.has(name)) names.add(name)
    })
  }
  return names
}

/** The names in an agent's own setup and documents: the user's company and product, which come up in every call. */
export function ownNames(agent: Pick<Agent, 'name' | 'description' | 'instructions' | 'aboutMe' | 'vocabulary' | 'knowledge'>): Set<string> {
  return new Set([
    ...namesIn([agent.name, agent.description, ...agent.vocabulary.split(','), ...agent.knowledge.map((d) => d.name)].join('\n'), true),
    ...namesIn(`${agent.instructions}\n${agent.aboutMe}`)
  ])
}

const wordsOf = (text: string, capitalOnly = false): string[] =>
  (text.match(capitalOnly ? /\p{Lu}[\p{L}\p{N}'’-]*/gu : /\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).map((w) => fold(w.replace(/['’]s$/, '')))

/**
 * What finds a call again by one of the people it was with (as the review named them): a person by first and last
 * name together ("Dana Smith", never "Dana" alone), a company by its own words ("Acme", not "Logistics"), or by all of
 * them when it has none ("Global Health"). Nothing for a name that's too common to tell anyone apart.
 */
export function whoTokens(entry: string): string[] {
  const words = wordsOf(entry).filter((w) => w.length >= 2)
  if (words.length >= 2 && FIRST_NAMES.has(words[0])) return words
  const own = words.filter((w) => w.length >= 3 && !NOT_NAMES.has(w) && !FIRST_NAMES.has(w))
  return own.length ? own : words.length >= 2 ? words : []
}

const day = (ms: number): string => {
  const date = new Date(ms)
  const thisYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(thisYear ? {} : { year: 'numeric' }) })
}

/** Earlier calls as a prompt reads them: when, what for, what happened, and what was asked. */
export function pastCallsText(calls: PastCall[], maxChars = RECALL_CHARS): string {
  let text = ''
  for (const c of calls) {
    const title = c.brief || (c.with?.length ? `with ${c.with.join(', ')}` : '')
    const lines = [`- ${day(c.at)}${title ? ` (${title})` : ''}: ${c.summary}`]
    if (c.about.length) lines.push(`  About them: ${c.about.join('; ')}`)
    if (c.asked.length) lines.push(`  They asked: ${c.asked.map((a) => `"${a.question}" (I said: ${a.answer})`).join('; ')}`)
    const block = lines.join('\n')
    if (text && text.length + block.length + 1 > maxChars) break
    text += (text ? '\n' : '') + block
  }
  return text.slice(0, maxChars)
}

/**
 * The calls an agent has had, as summaries (Hermes Agent keeps its past sessions to search): kept encrypted on this
 * PC, one file per agent, and recalled on a later call with the same people. Emits "changed" (agent id, calls).
 */
export class PastCalls extends EventEmitter {
  private calls = new Map<string, PastCall[]>()
  /** Per-agent chain of file writes, so they land in order. */
  private writes = new Map<string, Promise<void>>()
  /** Agents deleted: a review that ends after that keeps nothing of its call. */
  private gone = new Set<string>()

  /** An agent's file: only for an id as Togle makes them (a path from the window, "../..", names nothing). */
  private file(agentId: string): string {
    if (typeof agentId !== 'string' || !/^[\w-]{1,100}$/.test(agentId)) throw new Error('No such agent.')
    return `past-calls/${agentId}.bin`
  }

  /** An agent's calls, newest first. */
  async list(agentId: string): Promise<PastCall[]> {
    const cached = this.calls.get(agentId)
    if (cached) return cached
    const stored = (await readSecret<PastCall[]>(this.file(agentId))) ?? []
    // Another read may have filled it meanwhile (or a write): that one is newer.
    const now = this.calls.get(agentId) ?? stored
    this.calls.set(agentId, now)
    return now
  }

  private async write(agentId: string, calls: PastCall[]): Promise<void> {
    this.calls.set(agentId, calls)
    const write = (this.writes.get(agentId) ?? Promise.resolve()).then(() => writeSecret(this.file(agentId), calls.length ? calls : null))
    this.writes.set(
      agentId,
      write.catch(() => undefined)
    )
    await write
    this.emit('changed', agentId, calls)
  }

  /** Keeps a call; the same call reviewed again (its callId) replaces what was kept of it. None for a deleted agent. */
  async add(agentId: string, draft: PastCallDraft): Promise<PastCall | undefined> {
    if (this.gone.has(agentId)) return undefined
    const calls = await this.list(agentId)
    if (this.gone.has(agentId)) return undefined
    const same = draft.callId ? calls.find((c) => c.callId === draft.callId) : undefined
    const call: PastCall = { ...draft, id: same?.id ?? randomUUID(), agentId }
    await this.write(agentId, [call, ...calls.filter((c) => c !== same)].slice(0, KEPT))
    return call
  }

  async remove(agentId: string, id: string): Promise<PastCall[]> {
    const calls = (await this.list(agentId)).filter((c) => c.id !== id)
    await this.write(agentId, calls)
    return calls
  }

  /** Forgets every call of an agent. */
  async clear(agentId: string): Promise<void> {
    await this.write(agentId, [])
  }

  /** The agent was deleted: its calls go, and none is kept for it again. */
  async forget(agentId: string): Promise<void> {
    this.gone.add(agentId)
    await this.clear(agentId)
  }

  /**
   * The earlier calls with the people of this one, newest first: those whose company, or one of whose people by first
   * and last name, the brief names or someone on the call says. A first name alone could be anyone, a product or a city
   * says nothing of who it is, and the user's own names (`own`) are in every call.
   */
  async recall(agentId: string, context: { brief: string; said: string; own?: Set<string> }): Promise<PastCall[]> {
    const calls = await this.list(agentId)
    if (!calls.length) return []
    // Words of the brief (typed, so written as meant), and the capitalized ones of what was said.
    const here = new Set([...wordsOf(context.brief), ...wordsOf(context.said, true)])
    for (const own of context.own ?? []) here.delete(own)
    const isHere = (entry: string): boolean => {
      const need = whoTokens(entry)
      return need.length > 0 && need.every((w) => here.has(w))
    }
    return calls.filter((c) => (c.with ?? []).some(isHere)).slice(0, RECALLED)
  }

  /** Earlier calls about something, for the agent's chat to look up. */
  async search(agentId: string, query: string): Promise<string> {
    const calls = await this.list(agentId)
    if (!calls.length) return 'There are no earlier calls yet.'
    const index = new SearchIndex(calls, (c) => [c.brief, ...(c.with ?? []), c.summary, ...c.about, ...c.asked.map((a) => `${a.question} ${a.answer}`)].join('\n'))
    const found = index.search(query, FOUND)
    return found.length ? pastCallsText(found, 4_000) : 'No earlier call mentions that.'
  }
}
