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
  /** The id of the newest entry of the conversation then: what the agent writes after it has a bigger id. */
  after: number
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

/** How much earlier than its press an entry's time may be and still be the message: the agent's clock is the computer's own. */
const SLACK_MS = 10_000

const realTime = (at: number | undefined): at is number => typeof at === 'number' && at > 946_684_800_000

/**
 * What a message says, for telling it from another: its words with spaces as one, and the files of its pictures. The agent keeps what
 * was typed on its screen, which is one line (line breaks become spaces) without the marks Togle puts for a picture.
 */
export function messageKey(text: string): string {
  const said = splitPictures(text.replace(/\[Image #\d+\]\s*/g, ''))
  return `${said.words.replace(/\s+/g, ' ').trim()}\n${said.files.join('\n')}`
}

/**
 * Where each sent message is: in the conversation (the agent's record has it as something the person said, newer than the press), in
 * the agent's own queue (`queued`), in what Togle holds for the agent (`held`), or nowhere yet (`tail`: the window draws it at the end
 * of the conversation, with the ticks of how far it got). An entry, a queued line or a held line is one message's only: a second message
 * with the same words finds the next one. A message that could not be sent stays at the end, failed.
 */
export function placeSent(sent: readonly SentMessage[], entries: readonly LogEntry[], queued: readonly string[], held: readonly string[]): Placed[] {
  const said = entries.filter((entry) => entry.kind === 'you')
  const claimedEntries = new Set<LogEntry>()
  const claimedQueued = new Set<number>()
  const claimedHeld = new Set<number>()
  return sent.map((message): Placed => {
    if (message.state === 'failed') return { message, place: 'tail' }
    const key = messageKey(message.text)
    // Newer than the press: by the entry's time when the agent kept one, else by its place in the conversation.
    const entry = said.find((candidate) => !claimedEntries.has(candidate) && messageKey(candidate.text) === key && (realTime(candidate.at) ? candidate.at >= message.at - SLACK_MS : candidate.id > message.after))
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
