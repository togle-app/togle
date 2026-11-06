import { useEffect, useRef, useState } from 'react'
import { reviewAfterCall, reviewText, trainHistory, triedTurns, type ChatTurnSource, type LessonOffer, type Review, type SavedConversation } from '@shared/chat'
import { lessonItems } from '@shared/learning'
import type { Agent, AssistEvent, CallChatContext, TrainEvent, TrainTurn } from '@shared/types'
import { applyAnswerEvent, restoredCards, sayPart, type AnswerItem } from './AnswerCard'

export type { LessonOffer, Review }

const api = window.togle

const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// What's kept of an agent's conversation: its latest entries, and the suggestions of its latest calls.
const KEPT_ENTRIES = 500
const KEPT_CALLS = 40
// Saved this long after it last changed (a reply streaming in changes it all the time).
const SAVE_DELAY_MS = 800
// What's said to the agent goes with the conversation before it. Its model reads only the last 20 turns of that, so
// only the latest entries go, not all 500.
const HISTORY_ENTRIES = 120
// What a kept conversation may come to, as JSON: Togle's main process refuses one over 8 million characters.
const KEPT_CHARS = 6_000_000
// A message longer than this (a whole log pasted in) is kept by its start.
const KEPT_TEXT_CHARS = 50_000

/** A message kept as it is, or by its start when it's too long to keep (cut once, kept so for each save after). */
const cut = new WeakMap<Entry, Entry>()
function cutDown(entry: Entry): Entry {
  if ((entry.role !== 'user' && entry.role !== 'agent') || entry.text.length <= KEPT_TEXT_CHARS) return entry
  let short = cut.get(entry)
  if (!short) {
    const left = (entry.text.length - KEPT_TEXT_CHARS).toLocaleString('en-US')
    short = { ...entry, text: `${entry.text.slice(0, KEPT_TEXT_CHARS)}\n\n[… ${left} more characters weren't kept …]` }
    cut.set(entry, short)
  }
  return short
}

// How long each entry or card is as JSON, measured once: they don't change (a change is a new one).
const sizes = new WeakMap<object, number>()
function sizeOf(value: Entry | AnswerItem): number {
  let size = sizes.get(value)
  if (size === undefined) {
    size = JSON.stringify(value).length + 2
    sizes.set(value, size)
  }
  return size
}

/** A reply of the agent's: what it said, and what it changed in itself, a line each (with Undo). */
export interface AgentMessage {
  id: string
  role: 'agent'
  /** The Train turn it's the reply to; none for one made without the model (what a call taught it, kept as asked). */
  turnId?: string
  text: string
  /** What it changed in the agent, a line each. */
  changes: string[]
  /** Those changes' entries in the agent's history, when known as they're made. */
  changeIds?: string[]
  /** When it started: its changes are the ones in the agent's history since. */
  at: number
  status: 'streaming' | 'done' | 'error'
  /** What it's doing while there's nothing to show yet ("Writing the notes…"). */
  activity?: string
  error?: string
}

/** A stretch of a call, from Start to Stop, with the suggestions it brought, oldest first. */
export interface CallBlock {
  id: string
  role: 'call'
  /** Which call it's of (its key, kept with the call): only the call open now shows its suggestions unfolded. */
  call: string
  startedAt: number
  endedAt?: number
  cards: string[]
  /** Started again a moment after it stopped: the same call going on. */
  resumed?: boolean
  /** Picked up when Togle started, as it was saved then. */
  restoredFrom?: number
}

export interface ReviewEntry {
  id: string
  role: 'review'
  /** The agent it reviewed the call for: what it keeps goes to that one. */
  agentId: string
  at: number
  review: Review
}

/** Something I said to the agent; when (not kept by conversations from before it was). */
export interface UserMessage {
  id: string
  role: 'user'
  text: string
  at?: number
  call?: CallChatContext
}

/** A question tried as if someone on a call asked it, and the answer it gets: what I'd see on the call. */
export interface TryEntry {
  id: string
  role: 'try'
  at: number
  question: string
  /** Its answer, as it comes in. */
  item?: AnswerItem
}

/** The agent's conversation, before, during and after calls: what I said, its replies, the calls, what it learned, the questions tried. */
export type Entry = UserMessage | AgentMessage | CallBlock | ReviewEntry | TryEntry

const said = (text: string, call?: CallChatContext): UserMessage => ({ id: crypto.randomUUID(), role: 'user', text, at: Date.now(), ...(call ? { call } : {}) })

/** When an entry happened, as far as it says. */
export const timeOf = (entry: Entry): number | undefined => (entry.role === 'call' ? entry.startedAt : entry.at)

export interface Conversation {
  entries: Entry[]
  /** The Train reply under way. */
  turn?: string
}

const EMPTY: Conversation = { entries: [] }

function withEvent(m: AgentMessage, event: TrainEvent): AgentMessage {
  switch (event.type) {
    case 'delta':
      return { ...m, text: m.text + event.text }
    case 'change':
      return { ...m, changes: [...m.changes, event.text] }
    case 'done':
      return { ...m, status: 'done' }
    case 'error':
      return { ...m, status: 'error', error: event.message }
  }
}

/** An entry as it comes back after Togle closed: what was under way then ended there. */
function settled(entry: Entry): Entry {
  if (entry.role === 'agent' && entry.status === 'streaming') return { ...entry, status: 'done', activity: undefined, turnId: undefined }
  if (entry.role === 'review' && entry.review.state === 'loading') {
    return { ...entry, review: { state: 'error', message: 'Togle closed before it finished.', lesson: entry.review.lesson } }
  }
  if (entry.role === 'call' && !entry.endedAt) return { ...entry, endedAt: entry.startedAt }
  if (entry.role === 'try' && entry.item) return { ...entry, item: restoredCards([entry.item])[0] }
  return entry
}

const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The conversation so far, for the Train model: a call is a line (read_call reads it), a review what it said. */
const historyOf = (entries: Entry[], changesOf: (review: ReviewEntry) => string[]): TrainTurn[] =>
  trainHistory(
    entries.flatMap((e): ChatTurnSource[] => {
      if (e.role === 'user' || e.role === 'agent') return [e]
      // As I'd ask it to try one: what it would say on a call, in its words then.
      if (e.role === 'try') return triedTurns(e.question, e.item?.text ? sayPart(e.item.text) : e.item?.error ? `(no answer: ${e.item.error})` : '(no answer yet)')
      if (e.role === 'call') {
        const end = e.endedAt ? `–${clock(e.endedAt)}` : ', going on'
        return [{ role: 'agent', text: `[A call, ${clock(e.startedAt)}${end}: ${e.cards.length} suggestion${e.cards.length === 1 ? '' : 's'}]`, changes: [] }]
      }
      return [{ role: 'agent', text: reviewText(e.review), changes: changesOf(e) }]
    })
  )

export interface Chats {
  of: (agentId: string) => Conversation
  /** Brings an agent's conversation back as it was last kept (once; until then it isn't saved over). */
  load: (agentId: string) => void
  loaded: (agentId: string) => boolean
  /** A suggestion of a call kept with a conversation, by its id. */
  keptCard: (id: string) => AnswerItem | undefined
  /** Something said to the agent: its Train model replies, changing its training as asked. */
  teach: (agent: Agent, message: string, call?: CallChatContext) => void
  stop: (agentId: string) => void
  /** A new agent set up from a description: the conversation starts with it, and with each change it made (to undo). */
  greet: (agent: Agent, description: string) => void
  add: (agentId: string, entry: Entry) => void
  /** Changes one entry in place: a review as it goes, a call stretch as it ends. */
  update: (agentId: string, id: string, change: (entry: Entry) => Entry) => void
  /** A stretch of the call starts, in the conversation of the agent on it. */
  callStarted: (agentId: string, at: number, call: string, resumed: boolean) => void
  /** A suggestion of the call: into its open stretch, or the last one of the same call, or a stretch of its own. */
  cardStarted: (agentId: string, cardId: string, at: number, call: string) => void
  /** Something said on the call with no stretch of it in the conversation yet: one from then (still open while listening). */
  callSaid: (agentId: string, at: number, call: string, listening: boolean) => void
  /** Listening stopped: the stretch open in any conversation ends. */
  callEnded: (at: number) => void
  /** Keeps what a review held back, as the quick reply says it: "Keep them". */
  keepHeld: (agent: Agent, review: ReviewEntry) => Promise<void>
  /** "Don't keep them": nothing of it is kept. */
  dropHeld: (agentId: string, review: ReviewEntry) => void
  /** "Keep notes": the call the review found taught it, written up as one of its documents (one more request). */
  keepNotes: (agentId: string, review: ReviewEntry) => Promise<void>
  /** A question tried as if asked on a call: its entry, for its answer to come into (by its id, which it returns). */
  tried: (agentId: string, question: string) => string
  /** An answer to a question tried, as it comes in. */
  tryEvent: (agentId: string, entryId: string, event: AssistEvent) => void
}

interface Options {
  onSaved: (agent: Agent) => void
  /** What a review held back was kept as asked. */
  onKept?: (agent: Agent, review: ReviewEntry) => void
  /** A suggestion of a call by its id, to keep with the conversation. */
  cardOf: (id: string) => AnswerItem | undefined
  /** Whether what calls brought is kept too (Settings → Privacy: Remember calls). */
  keepCalls: () => boolean
}

/**
 * Every agent's conversation, kept across restarts as Hermes Agent keeps its sessions (encrypted on this PC): leaving
 * it for Settings, or for another agent, loses nothing, and a reply still coming in lands in its own conversation.
 */
export function useChats({ onSaved, onKept, cardOf, keepCalls }: Options): Chats {
  const [chats, setChats] = useState<Record<string, Conversation>>({})
  const latest = useRef(chats)
  latest.current = chats
  // Approval in History and approval in the agent chat are two views of the same durable proposal.
  useEffect(() => api.onCallSessions((change) => {
    const id = change?.id
    if (!id || !Object.values(latest.current).some(chat => chat.entries.some(entry => entry.role === 'review' && entry.review.sessionId === id))) return
    void api.callSession(id).then(record => {
      setChats(previous => {
        let next = previous
        for (const [agentId, chat] of Object.entries(previous)) {
          let changed = false
          const entries = chat.entries.map(entry => {
            if (entry.role !== 'review' || entry.review.sessionId !== id) return entry
            const review = reviewAfterCall(entry.review, record)
            if (review === entry.review) return entry
            changed = true
            return { ...entry, review }
          })
          if (changed) {
            if (next === previous) next = { ...previous }
            next[agentId] = { ...chat, entries }
          }
        }
        return next
      })
    }).catch(error => console.warn('[call learning] could not refresh the review:', (error as Error).message))
  }), [])
  // Conversations asked for, and those back from disk (only those are saved: never one half loaded over what was kept).
  const requested = useRef(new Set<string>())
  const [loadedIds, setLoadedIds] = useState<Set<string>>(() => new Set())
  const loadedNow = useRef(loadedIds)
  loadedNow.current = loadedIds
  // The suggestions kept with the conversations, by their ids.
  const kept = useRef(new Map<string, AnswerItem>())
  // What each conversation was when last saved.
  const saved = useRef(new Map<string, Entry[]>())
  // Which agent each Train reply under way is for.
  const turns = useRef(new Map<string, string>())
  const change = (agentId: string, update: (chat: Conversation) => Conversation): void =>
    setChats((prev) => ({ ...prev, [agentId]: update(prev[agentId] ?? EMPTY) }))
  const reply = (fields: Partial<AgentMessage>): AgentMessage => ({ id: crypto.randomUUID(), role: 'agent', text: '', changes: [], at: Date.now(), status: 'done', ...fields })
  // A review's held items answered (Keep or Don't keep): it stops asking; asks again if keeping them failed.
  const decided = (agentId: string, reviewId: string, yes = true): void =>
    change(agentId, (chat) => ({
      ...chat,
      entries: chat.entries.map((e) =>
        e.id === reviewId && e.role === 'review' && e.review.state === 'learned' ? { ...e, review: { ...e.review, decided: yes } } : e
      )
    }))

  const load = (agentId: string): void => {
    if (requested.current.has(agentId)) return
    requested.current.add(agentId)
    const back = (stored: SavedConversation | null): void => {
      // As they ended when Togle closed: nothing more to ask of them.
      for (const card of restoredCards(Object.values(stored?.cards ?? {}))) kept.current.set(card.id, card)
      const entries = ((stored?.entries ?? []) as Entry[]).map(settled)
      // What came in meanwhile (a review, a call's first words) goes after what was kept.
      setChats((prev) => {
        const now = prev[agentId] ?? EMPTY
        const here = new Set(now.entries.map((e) => e.id))
        return { ...prev, [agentId]: { ...now, entries: [...entries.filter((e) => !here.has(e.id)), ...now.entries] } }
      })
      setLoadedIds((prev) => new Set(prev).add(agentId))
    }
    api.loadConversation(agentId).then(back, () => back(null))
  }
  const add = (agentId: string, entry: Entry): void => {
    load(agentId)
    change(agentId, (chat) => ({ ...chat, entries: [...chat.entries, entry] }))
  }

  /**
   * What's kept of a conversation: its latest entries, and the suggestions of its latest calls (when calls are kept),
   * newest first while they fit in what a conversation may hold. One that grew past it was refused whole, and with it
   * everything said since.
   */
  const keepable = (entries: Entry[]): SavedConversation => {
    let room = KEPT_CHARS
    const latestEntries: Entry[] = []
    for (const entry of entries.slice(-KEPT_ENTRIES).reverse()) {
      const keep = cutDown(entry)
      const size = sizeOf(keep)
      if (size > room) break
      room -= size
      latestEntries.unshift(keep)
    }
    const cards: Record<string, AnswerItem> = {}
    if (keepCalls()) {
      const calls = latestEntries.filter((e): e is CallBlock => e.role === 'call').slice(-KEPT_CALLS)
      for (const block of calls.reverse()) {
        for (const id of block.cards) {
          const card = cardOf(id) ?? kept.current.get(id)
          if (!card || sizeOf(card) > room) continue
          room -= sizeOf(card)
          cards[id] = card
        }
      }
    }
    return { entries: latestEntries, cards }
  }
  const saveChanged = (): void => {
    for (const [agentId, chat] of Object.entries(latest.current)) {
      if (!loadedNow.current.has(agentId) || saved.current.get(agentId) === chat.entries) continue
      saved.current.set(agentId, chat.entries)
      api.saveConversation(agentId, keepable(chat.entries))
    }
  }
  const saveNow = useRef(saveChanged)
  saveNow.current = saveChanged

  // Saved a moment after it changes, and as the window closes.
  useEffect(() => {
    const timer = setTimeout(() => saveNow.current(), SAVE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [chats, loadedIds])
  useEffect(() => {
    const flush = (): void => saveNow.current()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  useEffect(
    () =>
      api.onAgentTrain((event) => {
        const agentId = turns.current.get(event.id)
        if (!agentId) return
        const ended = event.type === 'done' || event.type === 'error'
        if (ended) turns.current.delete(event.id)
        change(agentId, (chat) => ({
          ...chat,
          turn: ended && chat.turn === event.id ? undefined : chat.turn,
          entries: chat.entries.map((e) => (e.role === 'agent' && e.turnId === event.id ? withEvent(e, event) : e))
        }))
      }),
    []
  )

  const of = (agentId: string): Conversation => chats[agentId] ?? EMPTY

  return {
    of,
    load,
    loaded: (agentId) => loadedIds.has(agentId),
    keptCard: (id) => kept.current.get(id),
    teach: (agent, message, call) => {
      if ((latest.current[agent.id] ?? EMPTY).turn) return
      const turnId = crypto.randomUUID()
      turns.current.set(turnId, agent.id)
      // What its reviews changed, by their lines in the agent's history.
      const changesOf = (review: ReviewEntry): string[] =>
        review.review.state === 'learned' ? review.review.changes.flatMap((id) => agent.history.find((h) => h.id === id)?.text ?? []) : []
      const history = historyOf((latest.current[agent.id] ?? EMPTY).entries.slice(-HISTORY_ENTRIES), changesOf)
      load(agent.id)
      change(agent.id, (chat) => ({
        ...chat,
        turn: turnId,
        entries: [...chat.entries, said(message, call), reply({ turnId, status: 'streaming' })]
      }))
      api.trainAgent(agent.id, turnId, history, message, call?.id)
    },
    stop: (agentId) => {
      const turn = of(agentId).turn
      if (turn) api.stopTraining(turn)
    },
    greet: (agent, description) => {
      add(agent.id, said(description))
      add(
        agent.id,
        reply({
          text: "Here's how I set myself up for these calls. Tell me more about them (who's on them, what you need from them, what goes wrong), try a question, or start a call.",
          changes: agent.history.map((h) => h.text),
          changeIds: agent.history.map((h) => h.id)
        })
      )
    },
    add,
    update: (agentId, id, update) => change(agentId, (chat) => ({ ...chat, entries: chat.entries.map((e) => (e.id === id ? update(e) : e)) })),
    callStarted: (agentId, at, call, resumed) => add(agentId, { id: crypto.randomUUID(), role: 'call', call, startedAt: at, cards: [], resumed }),
    cardStarted: (agentId, cardId, at, call) => {
      load(agentId)
      change(agentId, (chat) => {
        const entries = [...chat.entries]
        const last = entries.findLastIndex((e) => e.role === 'call')
        const block = entries[last] as CallBlock | undefined
        // Its open stretch; or, after it ended, the stretch of the same call with nothing after it but its review (a
        // Summary asked for then is the call's). Once something was said since, it's a stretch of its own, after that.
        if (block && block.call === call && (!block.endedAt || entries.slice(last + 1).every((e) => e.role === 'review'))) {
          if (!block.cards.includes(cardId)) entries[last] = { ...block, cards: [...block.cards, cardId] }
          return { ...chat, entries }
        }
        return { ...chat, entries: [...entries, { id: crypto.randomUUID(), role: 'call', call, startedAt: at, endedAt: at, cards: [cardId] }] }
      })
    },
    callSaid: (agentId, at, call, listening) => {
      load(agentId)
      change(agentId, (chat) =>
        chat.entries.some((e) => e.role === 'call' && e.call === call)
          ? chat
          : { ...chat, entries: [...chat.entries, { id: crypto.randomUUID(), role: 'call', call, startedAt: at, endedAt: listening ? undefined : at, cards: [] }] }
      )
    },
    callEnded: (at) =>
      setChats((prev) =>
        Object.fromEntries(
          Object.entries(prev).map(([agentId, chat]) => [
            agentId,
            chat.entries.some((e) => e.role === 'call' && !e.endedAt)
              ? { ...chat, entries: chat.entries.map((e) => (e.role === 'call' && !e.endedAt ? { ...e, endedAt: at } : e)) }
              : chat
          ])
        )
      ),
    keepHeld: async (agent, review) => {
      if (review.review.state !== 'learned' || !review.review.held) return
      decided(agent.id, review.id)
      add(agent.id, said('Keep them.'))
      const known = new Set(agent.history.map((h) => h.id))
      try {
        const updated = review.review.sessionId && review.review.reviewId
          ? (await api.approveCallLearning(review.review.sessionId, review.review.reviewId, lessonItems(review.review.held).map(item => item.id))).agent
          : await api.remember(review.agentId, review.review.held)
        onSaved(updated)
        const added = updated.history.filter((h) => !known.has(h.id))
        add(agent.id, reply({ text: added.length ? '' : 'Nothing in them was new to me.', changes: added.map((h) => h.text), changeIds: added.map((h) => h.id) }))
        if (added.length) onKept?.(updated, review)
      } catch (err) {
        decided(agent.id, review.id, false)
        add(agent.id, reply({ status: 'error', error: errorText(err) }))
      }
    },
    dropHeld: (agentId, review) => {
      if (review.review.sessionId && review.review.reviewId) void api.dismissCallLearning(review.review.sessionId, review.review.reviewId).catch(err => {
        decided(agentId, review.id, false)
        add(agentId, reply({ status: 'error', error: errorText(err) }))
      })
      decided(agentId, review.id)
      add(agentId, said("Don't keep them."))
      add(agentId, reply({ text: "Okay, I won't." }))
    },
    keepNotes: async (agentId, review) => {
      const lesson = review.review.lesson
      if (lesson?.state !== 'offer') return
      const setLesson = (patch: Partial<LessonOffer>): void =>
        change(agentId, (chat) => ({
          ...chat,
          entries: chat.entries.map((e) =>
            e.id === review.id && e.role === 'review' && e.review.lesson ? { ...e, review: { ...e.review, lesson: { ...e.review.lesson, ...patch } } } : e
          )
        }))
      const message = reply({ status: 'streaming', activity: 'Writing the notes…' })
      add(agentId, said('Keep notes of this call.'))
      add(agentId, message)
      setLesson({ state: 'writing', error: undefined })
      const done = (fields: Partial<AgentMessage>): void =>
        change(agentId, (chat) => ({ ...chat, entries: chat.entries.map((e) => (e.id === message.id ? { ...message, activity: undefined, ...fields } : e)) }))
      try {
        const { docId, name } = await api.keepLesson(lesson.id)
        setLesson({ state: 'kept', docId, name })
        done({ status: 'done', changes: [`Added to Knowledge: ${name}`] })
      } catch (err) {
        setLesson({ state: 'offer' })
        done({ status: 'error', error: errorText(err) })
      }
    },
    tried: (agentId, question) => {
      const id = crypto.randomUUID()
      add(agentId, { id, role: 'try', at: Date.now(), question: question.slice(0, KEPT_TEXT_CHARS) })
      return id
    },
    tryEvent: (agentId, entryId, event) =>
      change(agentId, (chat) => ({
        ...chat,
        entries: chat.entries.map((e) => (e.id === entryId && e.role === 'try' ? { ...e, item: applyAnswerEvent(e.item ? [e.item] : [], event, 1)[0] } : e))
      }))
  }
}
