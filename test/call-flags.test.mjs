// What the person does during a call besides listening: tell the others it is written down, and mark a moment.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
process.env.TOGLE_TEST_USER_DATA = path.join(import.meta.dirname, '.work', 'call-flags-' + process.pid)
// Empty: Windows reuses process ids, and an earlier run's folder would still hold its calls.
rmSync(process.env.TOGLE_TEST_USER_DATA, { recursive: true, force: true })
mkdirSync(process.env.TOGLE_TEST_USER_DATA, { recursive: true })
const { CallSessions, OngoingCall, MeetingNotes, exportCall, intoCall, markedLineIds, meetingNoteChunks, tellOthersLine, toldOthersLine } = await import('./.build/togle.mjs')
const { ongoingCall } = await import('./helpers.mjs')

const line = (id, speaker, text, at, end = at + 2000) => ({ id, speaker, text, at, end })
const state = (extra = {}) => ({ transcript: [], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], ...extra })
const flagsSent = events => events.filter(event => event.channel === 'call:flags').map(event => event.payload)

test('telling the others and marking only count in a call, and the call keeps them', async () => {
  const { ongoing, events } = ongoingCall(OngoingCall)
  ongoing.setToldOthers(true)
  assert.deepEqual(ongoing.mark(), [], 'nothing to mark before a call')
  assert.equal(ongoing.callState().toldOthers, 0, 'nothing to tell the others about before a call')
  assert.deepEqual(flagsSent(events), [])

  ongoing.setListening(true)
  ongoing.setToldOthers(true)
  const first = ongoing.callState().toldOthers
  assert.ok(first > 0)
  ongoing.setToldOthers(true)
  assert.equal(ongoing.callState().toldOthers, first, 'said once, the first time stays')
  const marks = ongoing.mark()
  assert.equal(marks.length, 1)
  assert.equal(ongoing.mark().length, 2)
  assert.deepEqual(ongoing.callState().marks, ongoing.current().marks)
  assert.equal(ongoing.current().toldOthers, first)
  const sent = flagsSent(events)
  assert.equal(sent.length, 3, 'told once, marked twice')
  assert.equal(sent.at(-1).toldOthers, first)
  assert.equal(sent.at(-1).marks.length, 2)

  ongoing.setToldOthers(false)
  assert.equal(ongoing.callState().toldOthers, 0, 'it can be taken back')
})

test('a call picked up again keeps them, and a new call starts without them', async () => {
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.restore(state({ toldOthers: 5000, marks: [6000, 'x', 7000, null] }))
  assert.equal(ongoing.callState().toldOthers, 5000)
  assert.deepEqual(ongoing.callState().marks, [6000, 7000], 'only numbers are marks')
  ongoing.restore(state({ toldOthers: 'yes', marks: 'many' }))
  assert.equal(ongoing.callState().toldOthers, 0)
  assert.deepEqual(ongoing.callState().marks, [])
  ongoing.restore(state({ toldOthers: 5000, marks: [6000] }))
  await ongoing.clear()
  assert.equal(ongoing.callState().toldOthers, 0)
  assert.deepEqual(ongoing.callState().marks, [])
})

test('there are never more marks than a person makes on purpose', async () => {
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.setListening(true)
  for (let n = 0; n < 260; n++) ongoing.mark()
  assert.equal(ongoing.callState().marks.length, 200)
})

test('the saved call carries them, and an export says them', async () => {
  const sessions = new CallSessions()
  const info = { id: 'flags-call', agentId: 'work', agentName: 'Team', startedAt: 1000, endedAt: 600000, status: 'ended' }
  const transcript = [line('a', 'them', 'We ship the pricing page with two plans.', 61000), line('b', 'me', 'I will send the API timeline.', 130000)]
  await sessions.capture(info, 'frames', state({ transcript, toldOthers: 31000, marks: [64000, 133000] }))
  let saved = await sessions.get('flags-call')
  assert.equal(saved.toldOthers, 31000)
  assert.deepEqual(saved.marks, [64000, 133000])
  // A later save of the same call, from a state that does not say, keeps what was said before.
  await sessions.capture(info, 'frames', state({ transcript }))
  saved = await sessions.get('flags-call')
  assert.equal(saved.toldOthers, 31000)
  assert.deepEqual(saved.marks, [64000, 133000])
  const text = exportCall(saved)
  assert.match(text, /Told the others on the call it was written down: yes, 0:30 into the call\./)
  assert.match(text, /Marked: 1:03, 2:12/)
  assert.equal(toldOthersLine({ startedAt: 1000 }), 'Told the others on the call it was written down: not ticked.')
  assert.equal(intoCall(75_000), '1:15')
})

test('a mark names the line being said, or the one just before, and nothing said for a long while names none', () => {
  const transcript = [
    line('one', 'them', 'First thing.', 10_000, 14_000),
    line('two', 'them', 'Second thing, spoken for a while.', 20_000, 40_000),
    line('three', 'me', 'Much later.', 200_000, 203_000)
  ]
  assert.deepEqual([...markedLineIds({ transcript, marks: [30_000] })], ['two'], 'during a line')
  assert.deepEqual([...markedLineIds({ transcript, marks: [45_000] })], ['two'], 'right after a line')
  assert.deepEqual([...markedLineIds({ transcript, marks: [150_000] })], [], 'too long after the last line')
  assert.deepEqual([...markedLineIds({ transcript, marks: [5_000] })], [], 'before anything was said')
  assert.deepEqual([...markedLineIds({ transcript, marks: [30_000, 31_000, 205_000] })].sort(), ['three', 'two'], 'two marks on one line name it once')
  assert.deepEqual([...markedLineIds({ transcript })], [], 'no marks')
})

test('the notes are asked to list the marked lines first, and are written again if the marks differ', async () => {
  const sessions = new CallSessions()
  const info = { id: 'flags-notes', agentId: 'work', agentName: 'Team', accountId: 'claude-work', startedAt: 1000, endedAt: 600000, status: 'ended' }
  const transcript = [line('x', 'them', 'The API timeline has to move to the end of the month.', 61000, 65000), line('y', 'them', 'Fine.', 90000, 91000)]
  await sessions.capture(info, 'frames', state({ transcript, marks: [66000] }))
  const record = await sessions.get('flags-notes')
  const chunks = meetingNoteChunks(record)
  assert.equal(chunks.length, 1)
  assert.match(chunks[0], /\[1:00\] \[MARKED\] Call: The API timeline/)
  assert.doesNotMatch(chunks[0], /\[MARKED\] Call: Fine/)
  const requests = []
  const provider = { id: 'chatgpt', stream: async (request, handlers) => { requests.push(request); handlers.onFinal('# Pricing sync\n\n## Marked\n- Them: the API timeline has to move. [1:00]') } }
  const notes = new MeetingNotes(sessions, () => provider)
  const written = await notes.generate('flags-notes')
  assert.match(requests[0].system, /Lines flagged \[MARKED\]/)
  assert.match(requests[0].system, /Marked, Decided, To do\./, 'the sections the design shows, and no others')
  assert.equal(written.minutes.state, 'ready')
  assert.equal(written.minutes.by, 'chatgpt', 'the notes say what wrote them')
  // The same transcript with other marks is another source: the notes of a call that gained a mark are written again.
  const key = written.minutes.sourceKey
  await sessions.update('flags-notes', latest => ({ ...latest, marks: [66000, 90500] }))
  const again = await notes.generate('flags-notes', undefined, undefined, true)
  assert.equal(requests.length, 2, 'another mark is another request')
  assert.notEqual(again.minutes.sourceKey, key)
})

test('the line to tell the others says where the sound goes: it stays on the computer, whatever an earlier Togle was set to', () => {
  assert.equal(tellOthersLine(), "I'm writing this call down with Togle. The sound stays on my computer.", "the design's words")
  // An earlier Togle could send a side of a call to a speech service, and its line said so. This PC hears every call now.
  for (const [me, them] of [['openai', 'local'], ['local', 'server'], ['server', 'openai']]) {
    const said = tellOthersLine({ me, them })
    assert.equal(said, tellOthersLine())
    assert.doesNotMatch(said, /speech service/)
  }
})
