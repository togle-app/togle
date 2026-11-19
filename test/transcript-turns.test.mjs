// How a call's words are drawn, live and saved: which lines go on from the same voice's last one (no head of their own), and which saved
// turns hold a line the person marked (a turn joins lines and keeps the first one's id, so a mark on a later line needs finding).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { CONTINUES_WITHIN_MS, STRETCH_MS, continuations, markedTurnIds, speechTurns } = await import('./.build/togle.mjs')

const them = (voiceId, at, seconds = 3) => ({ speaker: 'them', ...(voiceId ? { voiceId } : {}), at: at * 1000, end: (at + seconds) * 1000 })
const me = (at, seconds = 3) => ({ speaker: 'me', at: at * 1000, end: (at + seconds) * 1000 })

test('a line goes on from the same voice soon after it, and has its own head after a pause, another voice or a long stretch', () => {
  assert.equal(CONTINUES_WITHIN_MS, 30_000)
  assert.equal(STRETCH_MS, 60_000)
  // The first line has a head; the same voice again 3 s after goes on; another voice has its own; the first voice again has its own too.
  assert.deepEqual(continuations([them('voice:1', 0), them('voice:1', 6), them('voice:2', 12), them('voice:1', 18)]), [false, true, false, false])
  // You are one voice; a voice with no id is one ("Call"), and it does not go on from a named one.
  assert.deepEqual(continuations([me(0), me(5), them(undefined, 10), them(undefined, 14), them('voice:1', 18), me(22)]), [false, true, false, true, false, false])
  // A pause longer than 30 s from where the last one ended starts a new head (exactly 30 s still goes on).
  assert.deepEqual(continuations([them('voice:1', 0, 3), them('voice:1', 33), them('voice:1', 67)]), [false, true, false])
  // A long speech shows where it is: every minute the next line has a head again, and the minute counts from it.
  const speech = [0, 10, 20, 30, 40, 50, 60, 70, 119, 120].map((at) => them('voice:1', at, 2))
  assert.deepEqual(continuations(speech), [false, true, true, true, true, true, false, true, false, true])
  // A live caption has no end yet: it goes on from the line before it by its start.
  assert.deepEqual(continuations([them('voice:1', 0), { speaker: 'them', voiceId: 'voice:1', at: 8000 }]), [false, true])
  assert.deepEqual(continuations([]), [])
})

test('a turn that joins lines is marked when any of its lines is, and a mark finds a turn it is not the first line of', () => {
  const line = (id, speaker, voiceId, text, at, seconds) => ({ id, speaker, voiceId, text, at: at * 1000, end: (at + seconds) * 1000 })
  const transcript = [
    line('a1', 'them', 'voice:1', 'We could ship two plans.', 0, 3),
    line('a2', 'them', 'voice:1', 'And the third later.', 3.5, 2.5),
    line('b1', 'me', undefined, 'Agreed.', 10, 2),
    line('c1', 'them', 'voice:2', 'I will take the logs.', 20, 3)
  ]
  const turns = speechTurns(transcript)
  assert.deepEqual(turns.map((turn) => turn.id), ['a1', 'b1', 'c1'], 'a1 and a2 are one turn, with the id of the first')
  // Marked while the second line of the first turn was being said: the mark names a2, and the turn is a1.
  assert.deepEqual([...markedTurnIds({ transcript, marks: [5000] })], ['a1'])
  // Marked on a turn of its own, and marked twice in different turns.
  assert.deepEqual([...markedTurnIds({ transcript, marks: [11000] })], ['b1'])
  assert.deepEqual([...markedTurnIds({ transcript, marks: [1000, 21000] })].sort(), ['a1', 'c1'])
  // No marks, marks made long after anything was said, and a call with no lines mark nothing.
  assert.equal(markedTurnIds({ transcript }).size, 0)
  assert.equal(markedTurnIds({ transcript, marks: [] }).size, 0)
  assert.equal(markedTurnIds({ transcript, marks: [10 * 60_000] }).size, 0)
  assert.equal(markedTurnIds({ transcript: [], marks: [1000] }).size, 0)
})
