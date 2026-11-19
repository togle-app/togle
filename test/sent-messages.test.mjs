// A message the person sends from Chat is drawn at once, and the ticks say how far it got (shared/sent-messages.ts): where each sent message
// is now (the end of the conversation, the agent's queue, what Togle holds, the conversation itself) and what it is told apart by.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('sent-messages')
const T = await import('./.build/togle.mjs')

const now = Date.parse('2026-11-19T14:00:00Z')
const sent = (id, text, extra = {}) => ({ id, text, at: now, known: [], state: 'sent', ...extra })
const you = (id, text, at = now + 1_000) => ({ id, at, kind: 'you', text })
const places = (result) => result.map((one) => one.place)

test('a message nobody has recorded yet is at the end of the conversation, with how far it got', () => {
  const result = T.placeSent([sent(1, 'Fix the header', { state: 'sending' }), sent(2, 'And the footer', { state: 'sent' })], [you(5, 'Older words', now - 60_000)], [], [])
  assert.deepEqual(places(result), ['tail', 'tail'])
  assert.deepEqual(result.map((one) => T.tailDelivery(one.message)), ['sending', 'sent'])
  assert.equal(T.tailDelivery(sent(3, 'x', { state: 'failed' })), 'failed')
})

test('once the agent\u2019s record has an entry with its words that was not there when it was sent, it is in the conversation', () => {
  const entry = you(12, 'Fix the header')
  // The same words were said before (entry 5, known when the message was sent): that one is not it.
  const result = T.placeSent([sent(1, 'Fix the header', { known: [5] })], [you(5, 'Fix the header', now - 3_600_000), entry], [], [])
  assert.deepEqual(places(result), ['thread'])
  assert.equal(result[0].entry, entry)
  assert.deepEqual(places(T.placeSent([sent(1, 'Fix the header', { known: [5] })], [you(5, 'Fix the header', now - 3_600_000)], [], [])), ['tail'], 'with only the old one, it is not in the conversation yet')
})

test('what is new is told by what was there, not by ids or time: Codex keeps hashes for ids, and the start of the turn for a message that steered it', () => {
  // A Codex record: ids are hashes (no order), and the time of a message is when its turn began, which is long before the press.
  const steered = { id: 3_405_691_582, at: now - 600_000, kind: 'you', text: 'Also keep the old link' }
  const older = { id: 17, at: now - 900_000, kind: 'you', text: 'Fix the login' }
  assert.deepEqual(places(T.placeSent([sent(1, 'Also keep the old link')], [older, steered], [], [])), ['thread'], 'a smaller id and an older time are no reason to refuse it')
  // The same words said before, with a bigger id and a later time than the press could ever have: it was known, so it is not the message.
  const before = { id: 4_000_000_000, at: now + 5_000, kind: 'you', text: 'Also keep the old link' }
  assert.deepEqual(places(T.placeSent([sent(1, 'Also keep the old link', { known: [before.id] })], [before], [], [])), ['tail'])
})

test('words are compared as the agent keeps them: spaces as one, the marks and paths of pictures left out, and no more than the agent keeps', () => {
  const file = 'C:\\Users\\someone\\AppData\\Roaming\\togle\\pasted\\paste-20261119-123644.png'
  assert.deepEqual(places(T.placeSent([sent(1, 'Fix  the\nheader')], [you(12, 'Fix the header')], [], [])), ['thread'], 'a line break is a space on the screen')
  assert.deepEqual(places(T.placeSent([sent(1, `Look at this ${file}`)], [you(12, `[Image #1] Look at this ${file}`)], [], [])), ['thread'])
  assert.deepEqual(places(T.placeSent([sent(1, `Look at this ${file}`)], [you(12, 'Look at that')], [], [])), ['tail'])
  // Two pictures and no words are two messages, not one.
  const other = file.replace('123644', '123700')
  assert.deepEqual(places(T.placeSent([sent(1, `Picture: ${file}`), sent(2, `Picture: ${other}`)], [you(12, `Picture: ${other}`)], [], [])), ['tail', 'thread'])
  // A long message is kept cut by the agent's record: it is still that message.
  const long = 'word '.repeat(6_000)
  assert.ok(long.length > T.RECORD_WORDS_MOST)
  assert.deepEqual(places(T.placeSent([sent(1, long)], [you(12, long.slice(0, T.RECORD_WORDS_MOST))], [], [])), ['thread'])
})

test('what is known when a message is sent is the ids of the entries with the same words', () => {
  const entries = [you(5, 'Fix the header'), you(6, 'Something else'), { id: 7, at: now, kind: 'agent', text: 'Fix the header' }, you(8, 'Fix   the header')]
  assert.deepEqual(T.knownWith(entries, 'Fix the header'), [5, 8], 'only what the person said, with the words as the agent keeps them')
  assert.deepEqual(T.knownWith(entries, 'New words'), [])
})

test('what the agent has queued, and what Togle holds, is where the message is until the agent takes it in', () => {
  assert.deepEqual(places(T.placeSent([sent(1, 'Also the footer')], [], ['Also the footer'], [])), ['queued'])
  assert.deepEqual(places(T.placeSent([sent(1, 'Also the footer')], [], [], ['Also the footer'])), ['held'])
  assert.deepEqual(places(T.placeSent([sent(1, 'Also the footer')], [], ['Something else'], ['Something else'])), ['tail'])
})

test('each line of the record is one message\u2019s: a second message with the same words finds the next one', () => {
  const messages = [sent(1, 'ok'), sent(2, 'ok'), sent(3, 'ok')]
  assert.deepEqual(places(T.placeSent(messages, [you(12, 'ok')], ['ok'], [])), ['thread', 'queued', 'tail'])
  assert.deepEqual(places(T.placeSent(messages, [you(12, 'ok'), you(13, 'ok')], ['ok'], [])), ['thread', 'thread', 'queued'])
})

test('a message that could not be sent stays at the end, failed, whatever the record holds', () => {
  assert.deepEqual(places(T.placeSent([sent(1, 'ok', { state: 'failed', error: 'It waits for you on its screen.' })], [you(12, 'ok')], ['ok'], [])), ['tail'])
})

test('every stage has words for a tooltip', () => {
  assert.deepEqual(Object.keys(T.DELIVERY_WORDS).sort(), ['delivered', 'failed', 'sending', 'sent', 'taken'])
  assert.ok(Object.values(T.DELIVERY_WORDS).every((words) => words.length > 3))
})
