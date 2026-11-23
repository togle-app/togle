// A message the person sends from Chat, and how far it has got, said as a chat app says it with ticks: a clock while it is being sent,
// one tick once it was handed to the agent, two grey ticks once the agent has it (in its own queue), two ticks in the accent once the
// agent took it into the conversation. The window draws the message the moment it is sent (it does not wait for the agent's record to
// show it), and this decides where each sent message is now: still at the end of the conversation, in what is queued, or in the
// conversation itself. The same ladder is meant for a message that comes from another device through Studio's courier, with the hops
// before the computer in front of these (not built: nothing sends words from another device yet).
import { splitPictures } from './pasted-pictures'
import type { LogEntry } from './runner'

/** How far a message has got. `failed`: it could not be sent (the window says why, and offers to send it again). */
export type Delivery = 'sending' | 'sent' | 'delivered' | 'taken' | 'failed'

/** What each stage says, for a tooltip and for a screen reader. */
export const DELIVERY_WORDS: Record<Delivery, string> = {
  sending: 'Sending',
  sent: 'Sent to the agent',
  delivered: 'The agent has it, and will take it in',
  taken: 'The agent took it in',
  failed: 'Not sent'
}

/** A message sent from Chat, as the window keeps it until the agent's own record shows it. */
export interface SentMessage {
  id: number
  /** The words and the paths of the pictures, as they were sent. */
  text: string
  /** When Send was pressed. */
  at: number
  /**
   * The ids of the entries of the conversation that said the same words when it was sent: they are not this message. Told by what was there,
   * and not by time or by order, because neither can be trusted across agents (Codex's ids are hashes, and the time it keeps for a message is
   * the start of the turn, which is older than the press when the message steers a turn that was already running).
   */
  known: readonly number[]
  /** `sending` until the window was told it went in; `failed` when it did not. */
  state: 'sending' | 'sent' | 'failed'
  /** Why it did not go in. */
  error?: string
  /** Where it was last seen when it was not in the conversation: a message seen in a queue that then is nowhere was taken back, not lost. */
  seen?: 'queued' | 'held'
}

/** Where a sent message is now. */
export type Place = 'thread' | 'queued' | 'held' | 'tail'

export interface Placed {
  message: SentMessage
  place: Place
  /** For `thread`: the entry of the conversation that is this message. */
  entry?: LogEntry
}

/** The most of a message an agent's record keeps (each reader cuts what the person said at this). */
export const RECORD_WORDS_MOST = 20_000

/**
 * How many of a long message's letters are compared: fewer than a record keeps of it. A record keeps RECORD_WORDS_MOST characters of the
 * line as the screen got it, spaces among them, so its cut falls at another place than a cut of the words as they were sent; the letters
 * before this many are in both.
 */
export const KEY_LETTERS_MOST = 12_000

/**
 * What a message says, for telling it from another: its letters in order, with no space or line break among them, and the files of its
 * pictures. The agent keeps what was typed on its screen, which is not what was sent letter for letter: line breaks became spaces, the
 * marks Togle puts for a picture are gone, and a screen may break a long line where it likes (Claude Code took a long reply as pasted text,
 * cut inside a word, and the message that was sent was not found in the record: it showed twice). The letters are the same whatever the
 * screen did with the space between them. A message with more letters than KEY_LETTERS_MOST is told by that many alone, without its
 * pictures: the record has cut it, and the paths at its end with it.
 */
export function messageKey(text: string): string {
  const said = splitPictures(text.slice(0, RECORD_WORDS_MOST * 2).replace(/\[Image #\d+\]\s*/g, ''))
  const letters = said.words.replace(/\s+/g, '')
  return letters.length >= KEY_LETTERS_MOST ? letters.slice(0, KEY_LETTERS_MOST) : `${letters}\n${said.files.join('\n')}`
}

/** The ids of what the person said in these entries with the words of a message about to be sent: what `SentMessage.known` holds. */
export function knownWith(entries: readonly LogEntry[], text: string): number[] {
  const key = messageKey(text)
  return entries.filter((entry) => entry.kind === 'you' && messageKey(entry.text) === key).map((entry) => entry.id)
}

/**
 * Where each sent message is: in the conversation (the agent's record has something the person said with its words that was not there
 * when it was sent), in the agent's own queue (`queued`), in what Togle holds for the agent (`held`), or nowhere yet (`tail`: the window
 * draws it at the end of the conversation, with the ticks of how far it got). An entry, a queued line or a held line is one message's
 * only: a second message with the same words finds the next one. A message that could not be sent stays at the end, failed.
 */
export function placeSent(sent: readonly SentMessage[], entries: readonly LogEntry[], queued: readonly string[], held: readonly string[]): Placed[] {
  const said = entries.filter((entry) => entry.kind === 'you')
  const claimedEntries = new Set<LogEntry>()
  const claimedQueued = new Set<number>()
  const claimedHeld = new Set<number>()
  return sent.map((message): Placed => {
    if (message.state === 'failed') return { message, place: 'tail' }
    const key = messageKey(message.text)
    // New since it was sent: not one of the entries that already said these words then (the agent's ids are told apart, not ordered).
    const entry = said.find((candidate) => !claimedEntries.has(candidate) && !message.known.includes(candidate.id) && messageKey(candidate.text) === key)
    if (entry) {
      claimedEntries.add(entry)
      return { message, place: 'thread', entry }
    }
    const inQueue = queued.findIndex((words, at) => !claimedQueued.has(at) && messageKey(words) === key)
    if (inQueue >= 0) {
      claimedQueued.add(inQueue)
      return { message, place: 'queued' }
    }
    const inHeld = held.findIndex((words, at) => !claimedHeld.has(at) && messageKey(words) === key)
    if (inHeld >= 0) {
      claimedHeld.add(inHeld)
      return { message, place: 'held' }
    }
    return { message, place: 'tail' }
  })
}

/** How far a message that is at the end of the conversation has got (a sent one is not `delivered`: the agent does not have it yet). */
export const tailDelivery = (message: SentMessage): Delivery => (message.state === 'failed' ? 'failed' : message.state === 'sending' ? 'sending' : 'sent')

/** How long a message the agent has not shown stays at the end once the task is not at work: it was taken in somewhere the window cannot see. */
export const SENT_GIVE_UP_MS = 45_000
