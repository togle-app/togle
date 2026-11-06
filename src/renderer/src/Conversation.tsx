import {
  Component,
  Fragment,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  type Ref
} from 'react'
import { lineEdit } from '@shared/edit'
import { workspaceEntries, type Workspace } from '@shared/workspace'
import type { Agent, KnowledgeDoc, Lessons, PastCall, TrainingChange } from '@shared/types'
import { AnswerCard, saidNothing, type AnswerItem } from './AnswerCard'
import { Avatar } from './Avatar'
import { ErrorText } from './ErrorText'
import { timeOf, type AgentMessage, type CallBlock, type Chats, type Entry, type ReviewEntry, type TryEntry } from './chats'
import { useHotkey } from './hotkeys'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

const api = window.togle

const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const clock = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
// How a change line says a document went in (Train's tools, a call's notes kept, attached): Undo takes it out again.
const ADDED_DOCUMENT = 'Added to Knowledge: '
// How a change line says it reads a project's code now: Undo stops it.
const CODE_FOLDER = 'Reads the code in: '
// What it learned from a call, shown with an Undo each: more, they're said in a line, and shown when asked for.
const LEARNED_SHOWN = 3
// A change line this long at most: the rest of a long rule is in its tip.
const LINE_CHARS = 120
// More documents than this from one reply (a folder) are said in a line.
const DOCS_LISTED = 4
// The box to write in grows with what's written up to this tall (about six lines); shorter than this, a line fits.
const BOX_MAX = 140
const SHORT_LINE = 20

/**
 * A change to its setup in its own words, from what the change did: the rule it added, what it learned about me, the
 * name it took. Its history keeps the line as Train wrote it ("Updated instructions"), which says none of that.
 */
function fieldLine(change: Extract<TrainingChange['change'], { kind: 'field' }>): string | null {
  const { field, before, after } = change
  if (field === 'name') return after.trim() && `Name: ${after.trim()}`
  if (field === 'description') return after.trim() && `What it's for: ${after.trim()}`
  if (field === 'vocabulary') {
    const had = new Set(before.split(',').map((w) => w.trim().toLowerCase()))
    const added = after
      .split(',')
      .map((w) => w.trim())
      .filter((w) => w && !had.has(w.toLowerCase()))
    return added.length ? `Words to recognize: ${added.join(', ')}` : null
  }
  const { added, removed } = lineEdit(before, after)
  const text = (lines: string[]): string => lines.map((l) => l.replace(/^(?:[-*•]|\d+[.)])\s+/, '')).join(' ')
  if (field === 'instructions') {
    if (!before.trim() && added.length > 1) return `Instructions: ${text(added)}`
    if (added.length && !removed.length) return `${added.length > 1 ? 'Rules' : 'Rule'}: ${text(added)}`
    if (added.length) return `Changed a rule: ${text(added)}`
    return removed.length ? `Took out a rule: ${text(removed)}` : null
  }
  if (added.length && !removed.length) return `About you: ${text(added)}`
  if (added.length) return `Changed what it knows about you: ${text(added)}`
  return removed.length ? `Forgot about you: ${text(removed)}` : null
}

const cut = (line: string): string => (line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1).trimEnd()}…` : line)

/** What a folded call holds, in a few words: its suggestions, and its summary apart ("3 suggestions · summary"). */
function folded(cards: AnswerItem[]): string {
  const suggestions = cards.filter((c) => c.kind !== 'summary').length
  const summary = cards.some((c) => c.kind === 'summary')
  const said = suggestions ? `${suggestions} suggestion${suggestions === 1 ? '' : 's'}` : ''
  return [said, summary ? 'summary' : ''].filter(Boolean).join(' · ')
}

/**
 * A change as the conversation says it: in plain words, not the names of the parts of the agent's training. The line in
 * its history stays as it was written: Undo, and what its calls read of the conversation, go by that.
 */
function said(line: string): string {
  const answer = /^(Added|Updated|Removed) approved answer: (.+)$/s.exec(line)
  if (answer) return `${answer[1] === 'Added' ? 'New answer' : answer[1] === 'Updated' ? 'Changed answer' : 'Removed the answer'} for “${answer[2]}”`
  return line.startsWith(ADDED_DOCUMENT) ? `Added: ${line.slice(ADDED_DOCUMENT.length)}` : line
}


// Nothing recalled: the same empty list each time, so stretches of other calls aren't drawn again.
const NONE: PastCall[] = []
// Scrolled up less than this from the newest, it still follows what comes in.
const FOLLOW_SLACK_PX = 48
// A conversation opens with its latest entries drawn; earlier ones come in as it's scrolled up to them, these many at
// a time (kept for weeks it holds 500: drawing them all made opening it freeze, with thousands of elements).
const SHOWN_AT_FIRST = 60
const SHOWN_MORE = 60
// This near the top, the entries before come in.
const MORE_AT_PX = 400

const dayOf = (ms: number): string => new Date(ms).toDateString()

/** The day a conversation's line marks: Today, Yesterday, a weekday within the week, or its date. */
function dayLabel(ms: number): string {
  const day = new Date(ms)
  day.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const ago = Math.round((today.getTime() - day.getTime()) / 86_400_000)
  if (ago === 0) return 'Today'
  if (ago === 1) return 'Yesterday'
  if (ago > 1 && ago < 7) return day.toLocaleDateString([], { weekday: 'long' })
  return day.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' })
  })
}

// What's written and not sent yet, by agent: still there after talking to another one.
const drafts = new Map<string, string>()

/** The same function from one render to the next, calling the latest one given: memoized parts keep it. */
function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn)
  latest.current = fn
  return useCallback((...args: A) => latest.current(...args), [])
}

interface Props {
  workspace?: Workspace
  agent: Agent
  chats: Chats
  onSaved: (agent: Agent) => void
  /** A suggestion of a call by its id: this call's, or one of an earlier call this session. */
  card: (id: string) => AnswerItem | undefined
  /** This call's suggestions: as they change, the call's stretches show them again. */
  cards: AnswerItem[]
  /** The call open now (its key): its stretches show their suggestions, earlier calls fold away. */
  call: string
  listening: boolean
  autoReplies: boolean
  /** Earlier calls with the people of this one, which answers draw on. */
  recalled: PastCall[]
  /** Something was said on the call open now: once it's over, its summary and what was said are a click away. */
  heard: boolean
  /** Nothing of the call can be heard (no speech recognition): its hint says so, not that suggestions come. */
  deaf?: boolean
  /** Above the conversation: connecting a model. */
  banner?: ReactNode
  /** Between the conversation and the box to write in: the call as it goes. */
  callStrip?: ReactNode
  /** In the box to write in: giving the agent files. */
  attach?: ReactNode
  /** Beside the box: starting or stopping the call. */
  callButton?: ReactNode
  /** What's written: asked about the call while listening, said to the agent otherwise. */
  onSend: (text: string) => void
  onDeeper: (item: AnswerItem) => void
  /** A card that failed, asked again. */
  onAgain: (item: AnswerItem) => void
  onStop: (item: AnswerItem) => void
  /** The call open now has something to look back at, and nothing is looking back at it. */
  canLearn: boolean
  onLearn: () => void
  /** After the call: what it covered, as a suggestion of its own. */
  onSummary: () => void
  /** After the call: what was said and shown. */
  onTranscript: () => void
  /** Shown after an entry: the call's questions asked again, after its review. */
  after?: (entry: Entry) => ReactNode
  /** Files or folders dropped into the conversation, by where they are on this PC. */
  onDropFiles: (paths: string[]) => void
  /** A review that can show how it answers now (it learned something): its link. */
  canAskAgain: (review: ReviewEntry) => boolean
  onAskAgain: (review: ReviewEntry) => void
  /** A question tried as if someone on a call asked it. */
  onTry: (question: string) => void
}

/**
 * The agent's conversation, the way Hermes Agent is one chat: what I tell it and its replies, each call with the
 * suggestions it brought, and after each call what it learned (with Undo), asking about what it held back. Below it,
 * the call as it goes and the box to write in.
 *
 * Each entry is drawn again only when it changed: a caption, a line of the call or a key pressed in the box doesn't
 * draw the whole conversation.
 */
export function Conversation(props: Props) {
  const { agent, chats, onSaved, call, listening, recalled, canLearn, heard, deaf, banner, callStrip, after, onDropFiles, canAskAgain } = props
  const chat = chats.of(agent.id)
  const callWorkspace = props.workspace === 'call'
  const box = useRef<HTMLDivElement>(null)
  const composer = useRef<ComposerHandle>(null)
  // Kept scrolled to the newest, unless scrolled up to read.
  const stick = useRef(true)
  // Scrolled up to read: a button goes back to the newest, saying so when a suggestion or a message came in meanwhile.
  const [away, setAway] = useState(false)
  const [fresh, setFresh] = useState<'suggestion' | 'message' | null>(null)
  const [error, setError] = useState('')
  // Documents taken out again with Undo on the line that said they went in: each name a line may give one, to the name
  // it had then, and when.
  const [removed, setRemoved] = useState<Map<string, Removed>>(() => new Map())
  // Files dragged over the conversation, to drop in.
  const [dragging, setDragging] = useState(false)
  // What's written next is a question to try, as if asked on a call (not while one is on: the box asks about it then).
  const [trying, setTrying] = useState(false)
  const tryingNow = trying && !listening && !callWorkspace
  const replying = !!chat.turn && !callWorkspace
  const hasFiles = (e: DragEvent): boolean => e.dataTransfer.types.includes('Files')

  // The earliest entry drawn (its id: entries come in before it as the kept conversation loads); none yet, the latest.
  const [firstShown, setFirstShown] = useState<string | null>(null)
  const entries = useMemo(() => props.workspace ? workspaceEntries(chat.entries, props.workspace, call) : chat.entries, [chat.entries, props.workspace, call])
  const pinned = firstShown ? entries.findIndex((e) => e.id === firstShown) : -1
  const start = pinned >= 0 ? pinned : Math.max(0, entries.length - SHOWN_AT_FIRST)
  // Where the view was as earlier entries were asked for: what was in view stays where it was once they're above it.
  const earlier = useRef<{ height: number; top: number } | null>(null)
  const showEarlier = (): void => {
    const el = box.current
    if (!el || start === 0 || earlier.current) return
    earlier.current = { height: el.scrollHeight, top: el.scrollTop }
    setFirstShown(entries[Math.max(0, start - SHOWN_MORE)].id)
  }
  const loaded = chats.loaded(agent.id)
  const counted = useRef(entries.length)
  useEffect(() => {
    const grew = entries.length > counted.current
    counted.current = entries.length
    // Back from disk, where it starts is pinned: entries coming in at the end don't push the top out of view.
    if (firstShown === null && loaded && entries.length) setFirstShown(entries[start].id)
    // At the newest as more comes in, what's drawn above shrinks back to the latest. Only then: earlier entries
    // asked for (a window too tall for the latest) are never taken away again at once.
    else if (grew && stick.current && entries.length - start > 2 * SHOWN_AT_FIRST) setFirstShown(entries[entries.length - SHOWN_AT_FIRST].id)
  }, [entries.length, loaded, firstShown])

  // Another agent's conversation opens at its newest.
  useLayoutEffect(() => {
    stick.current = true
    earlier.current = null
    setAway(false)
    setFresh(null)
    setFirstShown(null)
  }, [agent.id, call, props.workspace])
  // At the newest after what it shows changed, and as the call strip or the box to write in change its height.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (earlier.current) {
      el.scrollTop = earlier.current.top + (el.scrollHeight - earlier.current.height)
      earlier.current = null
    } else if (stick.current) el.scrollTop = el.scrollHeight
    // Too little to scroll, and more before it: that comes in too.
    if (el.scrollHeight <= el.clientHeight && start > 0) showEarlier()
  })
  useEffect(() => {
    const el = box.current
    if (!el) return
    const resized = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight
    })
    resized.observe(el)
    return () => resized.disconnect()
  }, [])

  // What came in while scrolled up: this call's newest suggestion, or another entry.
  const newestCard = props.cards[0]?.id
  const seen = useRef({ card: newestCard, entries: chat.entries.length })
  useEffect(() => {
    if (away) {
      if (newestCard && newestCard !== seen.current.card) setFresh('suggestion')
      else if (chat.entries.length > seen.current.entries) setFresh((was) => was ?? 'message')
    }
    seen.current = { card: newestCard, entries: chat.entries.length }
  }, [newestCard, chat.entries.length, away])
  const toNewest = (): void => {
    const el = box.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  // The day of each entry: a line marks where a new one begins, once the conversation goes back before today.
  const days = useMemo(
    () =>
      entries.map((entry) => {
        const at = timeOf(entry)
        return at === undefined ? undefined : dayOf(at)
      }),
    [entries]
  )
  const today = dayOf(Date.now())
  const showDays = days.some((day) => day && day !== today)
  let lastDay: string | undefined

  const undo = useStable(async (ids: string[]): Promise<void> => {
    setError('')
    // Newest first, and one that changed since doesn't stop the rest.
    for (const id of ids) {
      try {
        onSaved(await api.undoChange(agent.id, id))
      } catch (err) {
        setError(errorText(err))
      }
    }
  })
  const removeDocument = useStable(async (doc: KnowledgeDoc): Promise<void> => {
    setError('')
    try {
      onSaved(await api.removeAgentDoc(agent.id, doc.id))
      // The lines about it give the name it went in under, or (a work session named since) the one it has.
      setRemoved((prev) => {
        const next = new Map(prev)
        for (const name of [doc.name, doc.addedAs]) if (name !== undefined) next.set(name, { name: doc.name, at: Date.now() })
        return next
      })
    } catch (err) {
      setError(errorText(err))
    }
  })
  const removeCodeFolder = useStable(async (folder: string): Promise<void> => {
    setError('')
    try {
      onSaved(await api.updateAgent(agent.id, { codeFolders: agent.codeFolders.filter((f) => f !== folder) }))
    } catch (err) {
      setError(errorText(err))
    }
  })
  const keepHeld = useStable((review: ReviewEntry) => void chats.keepHeld(agent, review))
  const dropHeld = useStable((review: ReviewEntry) => chats.dropHeld(agent.id, review))
  const keepNotes = useStable((review: ReviewEntry) => void chats.keepNotes(agent.id, review))
  const learn = useStable(props.onLearn)
  const summary = useStable(props.onSummary)
  const transcript = useStable(props.onTranscript)
  const deeper = useStable(props.onDeeper)
  const againCard = useStable(props.onAgain)
  const stopCard = useStable(props.onStop)
  const askAgain = useStable(props.onAskAgain)
  const card = useStable(props.card)

  /** Taken unless a reply is still coming in (while listening, it's a question about the call: never held back). */
  const send = (text: string): boolean => {
    if (tryingNow) {
      // One at a time: then the box talks to it again, to say what it should have said.
      setTrying(false)
      stick.current = true
      props.onTry(text)
      return true
    }
    if (replying && !listening) return false
    stick.current = true
    props.onSend(text)
    return true
  }
  const startTrying = useStable(() => {
    setTrying(true)
    composer.current?.focus()
  })
  const tryAgain = useStable((question: string) => {
    stick.current = true
    props.onTry(question)
  })
  const stopTry = useStable((item: AnswerItem) => api.cancelAssist(item.id))

  const last = chat.entries.at(-1)
  // Where I last wrote to it: a review after that still waits for Keep or Don't keep, calls since or not.
  const lastSaid = entries.findLastIndex((e) => e.role === 'user')
  // The call open now: its latest stretch shows what earlier calls with them said, and what to do once it's over.
  const latestStretch = chat.entries.findLast((e) => e.role === 'call' && e.call === call)?.id
  const lines = { agent, removed, onUndo: undo, onRemoveDocument: removeDocument, onRemoveCodeFolder: removeCodeFolder }

  return (
    <div
      className={`conversation ${callWorkspace ? 'call-workspace' : ''} ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if (callWorkspace || !hasFiles(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        if (callWorkspace || !hasFiles(e)) return
        e.preventDefault()
        setDragging(false)
        const paths = [...e.dataTransfer.files].map((f) => api.pathOf(f)).filter(Boolean)
        if (paths.length) {
          stick.current = true
          onDropFiles(paths)
        }
      }}
    >
      {dragging && <div className="drop-hint">Drop to teach {agent.name} from it</div>}
      {/* Above the conversation, not in it: at the newest of a long one, connecting a model would be out of sight. */}
      {banner}
      <div className="stream-wrap">
        <div
          className={`stream ${entries.length ? 'filled' : ''}`}
          ref={box}
          onScroll={(e) => {
            const el = e.currentTarget
            const atNewest = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
            stick.current = atNewest
            if (atNewest === away) {
              setAway(!atNewest)
              if (atNewest) setFresh(null)
            }
            if (el.scrollTop < MORE_AT_PX) showEarlier()
          }}
        >
          {!entries.length && !banner && !callWorkspace && <Welcome agent={agent} onPick={(example) => composer.current?.fill(example)} />}
          {entries.slice(start).map((entry, j) => {
            const open = entry.role === 'call' && entry.call === call
            const latest = open && entry.id === latestStretch
            const day = days[start + j]
            const newDay = showDays && day !== undefined && day !== lastDay
            if (day !== undefined) lastDay = day
            return (
              <Fragment key={entry.id}>
                {newDay && <p className="day">{dayLabel(timeOf(entry)!)}</p>}
                <EntryBoundary>
                {entry.role === 'user' ? (
                  <UserMessage text={entry.text} callTitle={entry.call?.title} />
                ) : entry.role === 'agent' ? (
                  <AgentReply message={entry} {...lines} />
                ) : entry.role === 'call' ? (
                  <CallStretch
                    block={entry}
                    open={open}
                    latest={latest}
                    cards={open ? props.cards : undefined}
                    card={card}
                    recalled={latest ? recalled : NONE}
                    canLearn={latest && canLearn && agent.learning !== 'auto'}
                    heard={latest && heard}
                    deaf={!!deaf}
                    autoReplies={props.autoReplies}
                    onLearn={learn}
                    onSummary={summary}
                    onTranscript={transcript}
                    onDeeper={deeper}
                    onAgain={againCard}
                    onStop={stopCard}
                  />
                ) : entry.role === 'try' ? (
                  <TryMessage entry={entry} latest={entry === last} onAgain={tryAgain} onAnother={startTrying} onStop={stopTry} />
                ) : (
                  <ReviewMessage
                    {...lines}
                    entry={entry}
                    latest={entry === last}
                    waiting={start + j > lastSaid}
                    canAskAgain={canAskAgain(entry)}
                    onKeep={keepHeld}
                    onDrop={dropHeld}
                    onKeepNotes={keepNotes}
                    onLearn={learn}
                    onAskAgain={askAgain}
                  />
                )}
                </EntryBoundary>
                {after?.(entry)}
              </Fragment>
            )
          })}
        </div>
        {away && (
          <button className={`jump ${fresh ? 'fresh' : ''}`} title="Go to the newest" onClick={toNewest}>
            <Icon name="chevron" size={12} />
            {fresh === 'suggestion' ? 'New suggestion' : fresh === 'message' ? 'New message' : 'Newest'}
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {callStrip}
      <Composer
        key={callWorkspace ? `call-${call}` : agent.id}
        ref={composer}
        agentId={callWorkspace ? `call-${call}` : agent.id}
        placeholder={callWorkspace || listening ? 'Ask about the call…' : tryingNow ? 'What might they ask you on a call?' : `Message ${agent.name}…`}
        sendTitle={callWorkspace || listening ? 'Ask about the call' : tryingNow ? 'Try it' : 'Send'}
        busy={replying && !listening && !tryingNow}
        onSend={send}
        onStop={() => chats.stop(agent.id)}
        attach={props.attach}
        trying={listening || callWorkspace ? undefined : tryingNow}
        onTrying={setTrying}
        callButton={props.callButton}
      />
    </div>
  )
}

/** First-use prompts complement the header and composer without repeating profile controls. */
function Welcome({ agent, onPick }: { agent: Agent; onPick: (example: string) => void }) {
  // Started blank: nothing says yet what it's for, so that's what it asks first.
  const blank = !agent.description.trim() && !agent.instructions.trim() && !agent.skills.length
  return (
    <div className="welcome">
      <h3>{blank ? 'What should I help with?' : 'How can I help?'}</h3>
      <p className="hint">
        {blank
          ? 'Describe the kinds of calls you want help with.'
          : 'Ask a question or prepare for your next call.'}
      </p>
      <div className="welcome-actions">
        <button className="quick" onClick={() => onPick(blank ? 'Help me set up an agent for ' : 'Help me prepare for a call about ')}><Icon name="phone" size={13} />{blank ? 'Set my role' : 'Prepare for a call'}</button>
        {!blank && <button className="quick" onClick={() => onPick('Review these talking points for my call: ')}><Icon name="check" size={13} />Review talking points</button>}
      </div>
    </div>
  )
}

/**
 * A question tried as if someone on a call asked it, and what I'd see then: the same answer a call would get. Not
 * right? Saying what it should be, after it, teaches that (its model reads the question and the answer), and Try again
 * shows what it says now.
 */
const TryMessage = memo(function TryMessage({
  entry,
  latest,
  onAgain,
  onAnother,
  onStop
}: {
  entry: TryEntry
  latest: boolean
  onAgain: (question: string) => void
  onAnother: () => void
  onStop: (item: AnswerItem) => void
}) {
  const done = !!entry.item && entry.item.status !== 'streaming'
  return (
    <div className="try">
      <p className="try-q">
        <Icon name="ask" size={12} />
        <span className="try-asked">Tried: “{entry.question}”</span>
        {done && (
          <button className="link" onClick={() => onAgain(entry.question)}>
            Try again
          </button>
        )}
      </p>
      {entry.item ? <AnswerCard item={entry.item} asked={false} onStop={onStop} /> : <p className="thinking">Thinking…</p>}
      {latest && done && <QuickReplies replies={[{ label: 'Try another', onSelect: onAnother }]} hint="or tell me what to say instead" />}
    </div>
  )
})

/**
 * One entry of the conversation that can't be drawn (a saved one from an older Togle, say) is said in its place: the
 * rest of the conversation, and the window, go on. Without it, that entry would break the window on every start.
 */
class EntryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(err: Error): void {
    console.warn('[conversation] an entry could not be shown:', err.message)
  }

  render(): ReactNode {
    return this.state.failed ? <p className="hint">This part of the conversation can't be shown.</p> : this.props.children
  }
}

interface ComposerHandle {
  /** Writes it in the box, to send as it is or change first. */
  fill: (text: string) => void
  focus: () => void
}

interface ComposerProps {
  ref: Ref<ComposerHandle>
  agentId: string
  placeholder: string
  sendTitle: string
  /** A reply is still coming in: the button stops it instead. */
  busy: boolean
  /** Whether it was taken: then the box empties. */
  onSend: (text: string) => boolean
  onStop: () => void
  attach?: ReactNode
  /** What's written is a question to try, as if asked on a call; none: it can't be now (on a call). */
  trying?: boolean
  onTrying: (on: boolean) => void
  callButton?: ReactNode
}

/** The box to write in. What's typed is its own: a key pressed draws the box, not the conversation above it. */
function Composer({ ref, agentId, placeholder, sendTitle, busy, onSend, onStop, attach, trying, onTrying, callButton }: ComposerProps) {
  const [text, setText] = useState(() => drafts.get(agentId) ?? '')
  const input = useRef<HTMLTextAreaElement>(null)
  const change = (value: string): void => {
    setText(value)
    if (value) drafts.set(agentId, value)
    else drafts.delete(agentId)
  }
  useImperativeHandle(ref, () => ({
    fill: (value) => {
      change(value)
      input.current?.focus()
    },
    focus: () => input.current?.focus()
  }))
  const send = (e?: FormEvent): void => {
    e?.preventDefault()
    const said = text.trim()
    if (said && onSend(said)) change('')
  }
  // As tall as what's written, wrapped lines too, up to BOX_MAX: then it scrolls. A short line needs no measuring, so
  // most keys pressed don't lay the window out again.
  useLayoutEffect(() => {
    const box = input.current
    if (!box) return
    box.style.height = ''
    if (text.length < SHORT_LINE && !text.includes('\n')) return
    const borders = box.offsetHeight - box.clientHeight
    box.style.height = `${Math.min(box.scrollHeight + borders, BOX_MAX)}px`
  }, [text])
  return (
    <form className="composer" onSubmit={send}>
      <div className={`input-box ${trying ? 'trying' : ''}`}>
        {/* Multi-line, so an error message or a piece of code can be pasted in: Enter sends, Shift+Enter adds a line. */}
        <textarea
          ref={input}
          rows={1}
          aria-label={trying ? 'Question to try' : sendTitle === 'Ask about the call' ? 'Ask about the call' : 'Message your agent'}
          value={text}
          onChange={(e) => change(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && trying) {
              e.stopPropagation()
              onTrying(false)
              return
            }
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
            e.preventDefault()
            send()
          }}
          placeholder={placeholder}
        />
        <div className="composer-toolbar">
          <div className="composer-context">
            {attach}
            {trying !== undefined && <button type="button" className={`icon try-toggle ${trying ? 'on' : ''}`} title={trying ? 'Back to chat' : 'Practice a call question'} aria-label="Try a question" aria-pressed={trying} onClick={() => { onTrying(!trying); input.current?.focus() }}><Icon name="ask" /></button>}
          </div>
          <div className="composer-actions">
        {busy ? (
          <button type="button" className="send" title="Stop" aria-label="Stop" onClick={onStop}>
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="send" title={sendTitle} aria-label="Send" disabled={!text.trim()}>
            <Icon name="send" />
          </button>
        )}
      {/* Started or stopped, the box is ready to write in: Enter then asks or says something, it doesn't press Stop. */}
      <span className="call-slot" onClick={() => input.current?.focus()}>
        {callButton}
      </span>
          </div>
        </div>
      </div>
    </form>
  )
}

// A message of mine this long (a chat or a log pasted in) shows folded to its start, with Show all.
const FOLDED_CHARS = 1_500
const SHOWN_FOLDED = 900

const UserMessage = memo(function UserMessage({ text, callTitle }: { text: string; callTitle?: string }) {
  const [open, setOpen] = useState(false)
  const folded = !open && text.length > FOLDED_CHARS
  return (
    <div className="msg user">
      {callTitle && <small className="call-question-source">About: {callTitle}</small>}
      <Markdown text={folded ? `${text.slice(0, SHOWN_FOLDED).trimEnd()}…` : text} />
      {text.length > FOLDED_CHARS && (
        <button type="button" className="link" onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all (${text.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  )
})

/** A document taken out again: the name it had then, and when. */
interface Removed {
  name: string
  at: number
}

interface LineProps {
  agent: Agent
  /** Documents taken out again: each name a line may give one, to the name it had then, and when. */
  removed: Map<string, Removed>
  onUndo: (ids: string[]) => Promise<void>
  onRemoveDocument: (doc: KnowledgeDoc) => Promise<void>
  onRemoveCodeFolder: (folder: string) => Promise<void>
}

/**
 * What a reply changed in the agent, a line each: with Undo for a change in its history, for a document it added (the
 * newest of that name), or for a project's code it reads, until it's undone.
 */
function ChangeLines({
  agent,
  lines,
  entries,
  at,
  removed,
  onUndo,
  onRemoveDocument,
  onRemoveCodeFolder
}: LineProps & { lines: string[]; entries: (TrainingChange | undefined)[]; at?: number }) {
  // Many documents at once (a folder): said in a line, with Undo all, and each listed when asked for.
  const [listed, setListed] = useState(false)
  const docs = lines.filter((line) => line.startsWith(ADDED_DOCUMENT))
  if (!listed && docs.length > DOCS_LISTED && docs.length === lines.length) {
    const names = new Set(docs.map((line) => line.slice(ADDED_DOCUMENT.length)))
    const still = agent.knowledge.filter((d) => names.has(d.name) || (d.addedAs !== undefined && names.has(d.addedAs)))
    return (
      <ul className="changes">
        <li className={still.length ? '' : 'undone'}>
          <Icon name="sparkle" size={11} />
          <span>Added {docs.length} documents</span>
          {still.length ? (
            <button
              className="link"
              onClick={async () => {
                for (const doc of still) await onRemoveDocument(doc)
              }}
            >
              Undo all
            </button>
          ) : (
            <span className="undone-tag">undone</span>
          )}
          <button className="link" onClick={() => setListed(true)}>
            Show them
          </button>
        </li>
      </ul>
    )
  }
  return (
    <ul className="changes">
      {lines.map((line, j) => {
        const entry = entries[j]
        const name = !entry && line.startsWith(ADDED_DOCUMENT) ? line.slice(ADDED_DOCUMENT.length) : undefined
        // By the name it went in under; a work session is named by what it's about once studied, and the line says that.
        // Taken out, and one of that name added again since: that one isn't this line's.
        const found = name ? agent.knowledge.findLast((d) => d.name === name || d.addedAs === name) : undefined
        const out = name !== undefined ? removed.get(name) : undefined
        const later = !!found && !!out && at !== undefined && at < out.at && found.addedAt > out.at
        const doc = later ? undefined : found
        const folder = !entry && line.startsWith(CODE_FOLDER) ? line.slice(CODE_FOLDER.length) : undefined
        const undone = entry?.undone || (!!out && !doc) || (folder !== undefined && !agent.codeFolders.includes(folder))
        const undo = entry ? () => onUndo([entry.id]) : doc ? () => onRemoveDocument(doc) : folder ? () => onRemoveCodeFolder(folder) : undefined
        const shown = (entry?.change.kind === 'field' && fieldLine(entry.change)) || said(doc ? ADDED_DOCUMENT + doc.name : out ? ADDED_DOCUMENT + out.name : line)
        return (
          <Fragment key={j}>
            <li className={undone ? 'undone' : ''}>
              <Icon name="sparkle" size={11} />
              <span title={shown.length > LINE_CHARS ? shown : undefined}>{cut(shown)}</span>
              {undone ? (
                <span className="undone-tag">undone</span>
              ) : (
                undo && (
                  <button className="link" onClick={() => void undo()}>
                    Undo
                  </button>
                )
              )}
            </li>
            {doc?.kind === 'session' && !undone && (
              <li className="gist-item">
                <SessionGist doc={doc} />
              </li>
            )}
          </Fragment>
        )
      })}
    </ul>
  )
}

/** Where a work session it read stands, as it studied it: under the line that says the session went in. */
function SessionGist({ doc }: { doc: KnowledgeDoc }) {
  if (doc.status === 'studying' && !doc.digest) return <p className="thinking">Reading it for where the work stands…</p>
  if (!doc.digest) return doc.error ? <p className="hint">{doc.error}. Answers on calls still search it.</p> : null
  const [about, ...rest] = doc.digest.trim().split('\n')
  return (
    <div className="gist">
      {/* Named by it, the line above says it already. */}
      {doc.addedAs === undefined && <p className="gist-about">{about.replace(/^\**About:?\**\s*/i, '')}</p>}
      {rest.join('\n').trim() && <Markdown text={rest.join('\n').trim()} />}
      {/* Worked on since: where it stood, until what's new in it is read. */}
      {doc.restudy && doc.status === 'studying' && <p className="thinking">Reading what's new in it…</p>}
    </div>
  )
}

const AgentReply = memo(function AgentReply({ message: m, ...changes }: LineProps & { message: AgentMessage }) {
  const { agent } = changes
  // Each change line's entry in the history: given as it was made, or the one of its text since the reply began (its
  // own changes, or tidying up's when it was asked to).
  const taken = new Set<string>()
  const entries = m.changeIds
    ? m.changeIds.map((id) => agent.history.find((h) => h.id === id))
    : m.changes.map((change) => {
        const entry = agent.history.find((h) => (h.origin === 'train' || h.origin === 'tidy') && h.at >= m.at && h.text === change && !taken.has(h.id))
        if (entry) taken.add(entry.id)
        return entry
      })
  return (
    <div className="msg agent">
      <Avatar agent={agent} size={20} />
      <div className="bubble">
        {m.text ? <Markdown text={m.text} streaming={m.status === 'streaming'} /> : m.status === 'streaming' && <p className="thinking">{m.activity ?? 'Working on it…'}</p>}
        {m.changes.length > 0 && <ChangeLines {...changes} lines={m.changes} entries={entries} at={m.at} />}
        {m.status === 'done' && !m.text && !m.changes.length && <p className="hint">Stopped.</p>}
        {m.error && <ErrorText text={m.error} />}
      </div>
    </div>
  )
})

interface StretchProps {
  block: CallBlock
  /** Of the call open now: its suggestions show; another call's fold away. */
  open: boolean
  /** The open call's latest stretch: what earlier calls with them said, and once it's over, what to do with it. */
  latest: boolean
  /** The open call's suggestions as they are now (drawn again as they change); none for other calls. */
  cards?: AnswerItem[]
  card: (id: string) => AnswerItem | undefined
  recalled: PastCall[]
  canLearn: boolean
  heard: boolean
  deaf: boolean
  autoReplies: boolean
  onLearn: () => void
  onSummary: () => void
  onTranscript: () => void
  onDeeper: (item: AnswerItem) => void
  onAgain: (item: AnswerItem) => void
  onStop: (item: AnswerItem) => void
}

/** A stretch of a call: its suggestions while it's the call open now, folded away once another call began. */
const CallStretch = memo(function CallStretch({
  block,
  open,
  latest,
  card,
  recalled,
  canLearn,
  heard,
  deaf,
  autoReplies,
  onLearn,
  onSummary,
  onTranscript,
  onDeeper,
  onAgain,
  onStop
}: StretchProps) {
  const [unfolded, setUnfolded] = useState(false)
  const suggestKeys = useHotkey('suggest')
  // A suggestion a newer one replaced before it said anything isn't shown: it would look like an empty answer.
  const cards = block.cards.flatMap((id) => card(id) ?? []).filter((c) => !saidNothing(c))
  const span = block.endedAt && block.endedAt - block.startedAt >= 60_000 ? `–${clock(block.endedAt)}` : ''
  const head = block.restoredFrom
    ? `Call picked up · ${clock(block.restoredFrom)}`
    : `${block.resumed ? 'Call, going on' : 'Call'} · ${clock(block.startedAt)}${span}`
  // Once the call is over: what it covered, what was said, and looking back at it.
  const over = latest && !!block.endedAt && (heard || canLearn)
  return (
    <section className={`call-block ${block.endedAt ? '' : 'live'}`}>
      <div className="call-head">
        <Icon name="phone" size={11} />
        <span>{head}</span>
        {!open && cards.length > 0 && (
          <button className="link" onClick={() => setUnfolded(!unfolded)}>
            {unfolded ? 'Fold' : folded(cards)}
          </button>
        )}
      </div>
      {latest && recalled.length > 0 && (
        <div className="recall-note">
          <p className="recall-head">From your earlier call{recalled.length === 1 ? '' : 's'} with them</p>
          {recalled.map((c) => (
            <p key={c.id}>
              <span className="recall-date">
                {new Date(c.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                {c.brief ? ` · ${c.brief}` : ''}
              </span>{' '}
              {c.summary}
            </p>
          ))}
        </div>
      )}
      {(open || unfolded) &&
        cards.map((item, i) => (
          <AnswerCard
            key={item.id}
            item={item}
            // The newest stays open, also once the call is over (what it said last, or what was asked for after): the
            // ones before it are a line each.
            older={i < cards.length - 1}
            onDeeper={open ? onDeeper : undefined}
            onAgain={open ? onAgain : undefined}
            onStop={onStop}
          />
        ))}
      {open && !block.endedAt && !cards.length && (
        <p className="call-hint">
          <strong>Replies appear here</strong>
          <span>
          {deaf
            ? 'Nothing is heard until speech recognition is set up.'
            : !autoReplies
              ? 'Automatic replies are paused. Click Suggest reply whenever you need help.'
              : `Suggestions show here when you're asked something.${suggestKeys ? ` ${suggestKeys} asks for one, from any app.` : ''}`}
          </span>
        </p>
      )}
      {over && (
        <div className="call-links">
          {heard && (
            <button className="link" title="What the call covered, and what was agreed" onClick={onSummary}>
              Summary
            </button>
          )}
          {heard && (
            <button className="link" title="What was said and shown, line by line" onClick={onTranscript}>
              Transcript
            </button>
          )}
          {canLearn && (
            <button className="link learn-link" title="It looks back at the call and learns what's worth knowing" onClick={onLearn}>
              Learn from this call
            </button>
          )}
        </div>
      )}
    </section>
  )
})

/** What a review held back, a line each with its kind, as it asks about them. */
function Held({ lessons, agent }: { lessons: Lessons; agent: Agent }) {
  const items = [
    ...lessons.answers.map((a) => ({ kind: 'answers', tag: 'Answer', body: <><strong>{a.question}</strong> {a.answer}</> })),
    ...lessons.facts.map((fact) => ({ kind: 'facts', tag: 'Fact', body: <>{fact}</> })),
    ...lessons.updates.map((u) => ({ kind: 'updates', tag: 'Changed', body: <><s className="old">{u.from}</s> → {u.to}</> })),
    ...lessons.forget.map((fact) => ({ kind: 'forget', tag: 'Forget', body: <s className="old">{fact}</s> })),
    ...lessons.skills.map((skill) => ({
      kind: 'skills',
      tag: skill.purpose === 'assistance' ? 'Assistance skill' : 'Reference',
      body: (
        <>
          <strong>{skill.name}</strong>
          {agent.skills.some((s) => s.name.toLowerCase() === skill.name.toLowerCase()) && <span className="skill-when"> · improves your skill</span>}
          {skill.when && <span className="skill-when"> · {skill.when}</span>}
          <Markdown text={skill.how} />
        </>
      )
    }))
  ]
  return (
    <ul className="held-items">
      {items.map((item, i) => (
        <li key={i}>
          <span className={`kind-tag lesson-${item.kind}`}>{item.tag}</span>
          <span className="fact-body">{item.body}</span>
        </li>
      ))}
    </ul>
  )
}

/** Replies to the agent's latest message, a click away: they say it in the conversation as if written. */
function QuickReplies({ replies, hint }: { replies: { label: string; onSelect: () => void }[]; hint?: string }) {
  return (
    <div className="quick-replies">
      {replies.map((r) => (
        <button key={r.label} className="quick" onClick={r.onSelect}>
          {r.label}
        </button>
      ))}
      {hint && <span className="hint">{hint}</span>}
    </div>
  )
}

interface ReviewProps extends LineProps {
  entry: ReviewEntry
  /** The conversation's last word: the replies it asks for are a click away. */
  latest: boolean
  /** What it held is still to keep or not, and nothing I said to it since answered that: Keep and Don't keep stay. */
  waiting: boolean
  canAskAgain: boolean
  onKeep: (review: ReviewEntry) => void
  onDrop: (review: ReviewEntry) => void
  onKeepNotes: (review: ReviewEntry) => void
  onLearn: () => void
  onAskAgain: (review: ReviewEntry) => void
}

/**
 * The call review as the agent tells it, as Hermes says "Memory updated" in its chat: what it learned, each with Undo;
 * what it held back, to keep with a yes (or as I say it); and a call that taught it, to keep notes of.
 */
const ReviewMessage = memo(function ReviewMessage({
  agent,
  entry,
  latest,
  waiting,
  canAskAgain,
  onKeep,
  onDrop,
  onKeepNotes,
  onLearn,
  onAskAgain,
  removed,
  onUndo,
  onRemoveDocument,
  onRemoveCodeFolder
}: ReviewProps) {
  const { review } = entry
  const quietLearning = agent.learning === 'auto'
  // What it learned, more than one thing: said in a line, the list of them (each with Undo) when asked for.
  const [shown, setShown] = useState(false)
  const learned = review.state === 'learned' ? review.changes.flatMap((id) => agent.history.find((h) => h.id === id) ?? []) : []
  const kept = learned.filter((h) => !h.undone)
  const folded = learned.length > LEARNED_SHOWN && !shown
  const held = review.state === 'learned' ? review.held : undefined
  const count = held ? Object.values(held).flat().length : 0
  const offer = review.lesson?.state === 'offer' ? review.lesson : undefined
  const nothing = review.state === 'learned' && !learned.length && !held && !review.left.length && !offer && !review.error
  if (quietLearning && (review.state !== 'learned' || !held && !review.error)) return null
  // Held items are asked about until they're answered, also once a call came after; the rest, while it's the last word.
  const replies = [
    ...(held && review.state === 'learned' && !review.decided && (latest || waiting)
      ? [
          { label: count === 1 ? 'Keep it' : 'Keep them', onSelect: () => onKeep(entry) },
          { label: count === 1 ? "Don't keep it" : "Don't keep them", onSelect: () => onDrop(entry) }
        ]
      : []),
    ...(latest && offer ? [{ label: 'Keep notes', onSelect: () => onKeepNotes(entry) }] : [])
  ]
  return (
    <div className="msg agent review">
      <Avatar agent={agent} size={20} />
      <div className="bubble">
        {review.state === 'loading' && <p className="thinking">Looking back at the call…</p>}
        {review.state === 'error' && (
          <>
            <p className="error">I couldn't look back at the call: {review.message}</p>
            {latest && <QuickReplies replies={[{ label: 'Try again', onSelect: onLearn }]} />}
          </>
        )}
        {review.state === 'learned' && (
          <>
            {learned.length > LEARNED_SHOWN ? (
              <p>
                I learned {learned.length} things from this call{review.remembered ? ', and kept a summary of it for the next one with them' : ''}.{' '}
                <button className="link" onClick={() => setShown(!shown)}>
                  {shown ? 'Hide' : 'Show'}
                </button>
                {folded && kept.length > LEARNED_SHOWN && (
                  <>
                    {' · '}
                    <button className="link" onClick={() => void onUndo(kept.map((h) => h.id).reverse())}>
                      Undo all
                    </button>
                  </>
                )}
              </p>
            ) : (
              learned.length > 0 && <p>From this call I learned:</p>
            )}
            {learned.length > 0 && !folded && (
              <ChangeLines
                agent={agent}
                removed={removed}
                onUndo={onUndo}
                onRemoveDocument={onRemoveDocument}
                onRemoveCodeFolder={onRemoveCodeFolder}
                lines={learned.map((h) => h.text)}
                entries={learned}
              />
            )}
            {nothing && <p>Nothing new worth keeping from this call.</p>}
            {held && (
              <div className="held">
                <p>
                  {review.asking
                    ? `Shall I keep ${count === 1 ? 'this' : 'these'}?`
                    : `I haven't kept ${count === 1 ? 'this' : 'these'} yet: ${count === 1 ? 'it changes' : 'they change'} what I know, or I may have misheard ${count === 1 ? 'it' : 'them'}.`}
                </p>
                <Held lessons={held} agent={agent} />
              </div>
            )}
            {review.left.length > 0 && (
              <p>
                My memory is full, so I didn't keep: {review.left.join(' · ').replace(/([^.!?])$/, '$1.')} Tell me what to merge or forget, and I'll add
                them.
              </p>
            )}
            {offer && (
              <p>
                This call taught me about your work (“{offer.title}”). Shall I keep notes of it as a document? Later calls can then answer from all of it.
              </p>
            )}
            {replies.length > 0 && <QuickReplies replies={replies} hint={held ? "or tell me what's right" : undefined} />}
            {review.remembered && learned.length <= LEARNED_SHOWN && <p className="hint">Kept a summary for your next call with them.</p>}
            {review.error && <p className="error">{review.error}</p>}
            {!folded && (canAskAgain || kept.length > LEARNED_SHOWN) && (
              <div className="links">
                {canAskAgain && (
                  <button className="link" onClick={() => onAskAgain(entry)}>
                    See how I'd answer now
                  </button>
                )}
                {kept.length > LEARNED_SHOWN && (
                  <button className="link" onClick={() => void onUndo(kept.map((h) => h.id).reverse())}>
                    Undo all
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
})
