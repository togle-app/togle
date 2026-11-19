// A message the person sends from Chat is drawn at once, and the ticks say how far it got (shared/sent-messages.ts): where each sent message
// is now (the end of the conversation, the agent's queue, what Togle holds, the conversation itself) and what it is told apart by.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('sent-messages')
const T = await import('./.build/togle.mjs')

const now = Date.parse('2026-11-19T14:00:00Z')
const sent = (id, text, extra = {}) => ({ id, text, at: now, after: 10, state: 'sent', ...extra })
const you = (id, text, at = now + 1_000) => ({ id, at, kind: 'you', text })
const places = (result) => result.map((one) => one.place)

test('a message nobody has recorded yet is at the end of the conversation, with how far it got', () => {
  const result = T.placeSent([sent(1, 'Fix the header', { state: 'sending' }), sent(2, 'And the footer', { state: 'sent' })], [you(5, 'Older words', now - 60_000)], [], [])
  assert.deepEqual(places(result), ['tail', 'tail'])
  assert.deepEqual(result.map((one) => T.tailDelivery(one.message)), ['sending', 'sent'])
  assert.equal(T.tailDelivery(sent(3, 'x', { state: 'failed' })), 'failed')
})

test('once the agent\u2019s record has it as something the person said, newer than the press, it is in the conversation', () => {
  const entry = you(12, 'Fix the header')
  const result = T.placeSent([sent(1, 'Fix the header')], [you(5, 'Fix the header', now - 3_600_000), entry], [], [])
  assert.deepEqual(places(result), ['thread'], 'the older words that are the same are not it')
  assert.equal(result[0].entry, entry)
})

test('an entry with no time of its own is told by its place: it must be after what was there when the message was sent', () => {
  const old = { id: 5, at: 0, kind: 'you', text: 'Fix the header' }
  const fresh = { id: 11, at: 0, kind: 'you', text: 'Fix the header' }
  assert.deepEqual(places(T.placeSent([sent(1, 'Fix the header', { after: 10 })], [old], [], [])), ['tail'])
  assert.deepEqual(places(T.placeSent([sent(1, 'Fix the header', { after: 10 })], [old, fresh], [], [])), ['thread'])
})

test('words are compared as the agent keeps them: spaces as one, the marks and paths of pictures left out', () => {
  const file = 'C:\\Users\\someone\\AppData\\Roaming\\togle\\pasted\\paste-20261119-123644.png'
  assert.deepEqual(places(T.placeSent([sent(1, 'Fix  the\nheader')], [you(12, 'Fix the header')], [], [])), ['thread'], 'a line break is a space on the screen')
  assert.deepEqual(places(T.placeSent([sent(1, `Look at this ${file}`)], [you(12, `[Image #1] Look at this ${file}`)], [], [])), ['thread'])
  assert.deepEqual(places(T.placeSent([sent(1, `Look at this ${file}`)], [you(12, 'Look at that')], [], [])), ['tail'])
  // Two pictures and no words are two messages, not one.
  const other = file.replace('123644', '123700')
  assert.deepEqual(places(T.placeSent([sent(1, `Picture: ${file}`), sent(2, `Picture: ${other}`)], [you(12, `Picture: ${other}`)], [], [])), ['tail', 'thread'])
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
