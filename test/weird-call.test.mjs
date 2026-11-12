// Weird moments of a call being written down: the PC's clock set back in the middle of it or after New call, and a
// call of hours. What is said still lands in the order it was said, and adding to a long call stays quick.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ongoingCall, workDir } from './helpers.mjs'

workDir('weird-call')
const { OngoingCall } = await import('./.build/togle.mjs')

test('the clock set back an hour mid-call: what comes after still comes after', () => {
  const { ongoing } = ongoingCall(OngoingCall)
  const t = Date.now()
  ongoing.add('them', 'What does onboarding look like?', t - 20_000, t - 18_000)
  // A time sync sets the clock an hour back: the window stamps the next words by it.
  ongoing.add('them', 'And how long until we are live?', t - 3_600_000, t - 3_598_000)
  const transcript = ongoing.current().transcript
  assert.equal(transcript.at(-1).text, 'And how long until we are live?', 'after what came before, not an hour back')
  assert.ok(transcript.at(-1).at > transcript.at(-2).end)
  // A clip transcribed late, stamped by the clock as it is now: a few seconds back stays where it was said.
  ongoing.add('me', 'Mm-hm.', t - 3_600_000 - 3000, t - 3_600_000 - 2500)
  assert.equal(ongoing.current().transcript.at(-2).text, 'Mm-hm.')
})

test('the clock set back after New call: what is said next is heard, not dropped as the call before', () => {
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.add('them', 'Earlier call.', Date.now() - 5000, Date.now() - 4000)
  ongoing.clear()
  ongoing.add('them', 'Hello, is this the new call?', Date.now() - 3_600_000, Date.now() - 3_599_000)
  assert.deepEqual(ongoing.current().transcript.map((e) => e.text), ['Hello, is this the new call?'])
})

test('what was said before New call and comes in late stays with the call before', () => {
  const { ongoing } = ongoingCall(OngoingCall)
  const said = Date.now() - 4000
  ongoing.clear()
  ongoing.add('them', 'A line of the call before, transcribed late.', said, said + 1500)
  assert.deepEqual(ongoing.current().transcript, [])
})

test('a call of hours stays quick to add to', () => {
  const { ongoing } = ongoingCall(OngoingCall)
  const t0 = Date.now() - 4 * 3600_000
  const started = Date.now()
  for (let i = 0; i < 2400; i++) ongoing.add(i % 2 ? 'me' : 'them', `Line ${i} of a four-hour call, with enough words to be a real sentence about the project.`, t0 + i * 6000, t0 + i * 6000 + 4000)
  assert.ok(Date.now() - started < 2000, `adding 2,400 lines took ${Date.now() - started} ms`)
  assert.equal(ongoing.current().transcript.length, 2400)
})
