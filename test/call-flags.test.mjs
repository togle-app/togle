// What the person does during a call besides listening: tell the others it is written down, and mark a moment.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
process.env.TOGLE_TEST_USER_DATA = path.join(import.meta.dirname, '.work', 'call-flags-' + process.pid)
mkdirSync(process.env.TOGLE_TEST_USER_DATA, { recursive: true })
const { AgentStore, CallSessions, Copilot, MeetingNotes, exportCall, intoCall, markedLineIds, meetingNoteChunks, tellOthersLine, toldOthersLine } = await import('./.build/togle.mjs')
const { copilotWith } = await import('./helpers.mjs')

const store = new AgentStore(async () => 'digest')
await store.load()
const line = (id, speaker, text, at, end = at + 2000) => ({ id, speaker, text, at, end })
const state = (extra = {}) => ({ transcript: [], frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], ...extra })
const flagsSent = events => events.filter(event => event.channel === 'call:flags').map(event => event.payload)

test('telling the others and marking only count in a call, and the call keeps them', async () => {
  const agent = await store.create('sales')
  const { copilot, events } = copilotWith(Copilot, store, agent.id, [])
  copilot.setToldOthers(true)
  assert.deepEqual(copilot.mark(), [], 'nothing to mark before a call')
  assert.equal(copilot.callState().toldOthers, 0, 'nothing to tell the others about before a call')
  assert.deepEqual(flagsSent(events), [])

  copilot.setListening(true)
  copilot.setToldOthers(true)
  const first = copilot.callState().toldOthers
  assert.ok(first > 0)
  copilot.setToldOthers(true)
  assert.equal(copilot.callState().toldOthers, first, 'said once, the first time stays')
  const marks = copilot.mark()
  assert.equal(marks.length, 1)
  assert.equal(copilot.mark().length, 2)
  assert.deepEqual(copilot.callState().marks, copilot.currentCall().marks)
  assert.equal(copilot.currentCall().toldOthers, first)
  const sent = flagsSent(events)
  assert.equal(sent.length, 3, 'told once, marked twice')
  assert.equal(sent.at(-1).toldOthers, first)
  assert.equal(sent.at(-1).marks.length, 2)

  copilot.setToldOthers(false)
  assert.equal(copilot.callState().toldOthers, 0, 'it can be taken back')
})

test('a call picked up again keeps them, and a new call starts without them', async () => {
  const agent = await store.create('sales')
  const { copilot } = copilotWith(Copilot, store, agent.id, [])
  copilot.restore(state({ toldOthers: 5000, marks: [6000, 'x', 7000, null] }))
  assert.equal(copilot.callState().toldOthers, 5000)
  assert.deepEqual(copilot.callState().marks, [6000, 7000], 'only numbers are marks')
  copilot.restore(state({ toldOthers: 'yes', marks: 'many' }))
  assert.equal(copilot.callState().toldOthers, 0)
  assert.deepEqual(copilot.callState().marks, [])
  copilot.restore(state({ toldOthers: 5000, marks: [6000] }))
  await copilot.clear()
  assert.equal(copilot.callState().toldOthers, 0)
  assert.deepEqual(copilot.callState().marks, [])
})

test('there are never more marks than a person makes on purpose', async () => {
  const agent = await store.create('sales')
  const { copilot } = copilotWith(Copilot, store, agent.id, [])
  copilot.setListening(true)
  for (let n = 0; n < 260; n++) copilot.mark()
  assert.equal(copilot.callState().marks.length, 200)
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
  assert.match(chunks[0], /\[1:00\] \[MARKED\] Them: The API timeline/)
  assert.doesNotMatch(chunks[0], /\[MARKED\] Them: Fine/)
  const requests = []
  const provider = { stream: async (request, handlers) => { requests.push(request); handlers.onFinal('# Pricing sync\n\n## Marked\n- Them: the API timeline has to move. [1:00]') } }
  const notes = new MeetingNotes(sessions, () => provider)
  const written = await notes.generate('flags-notes')
  assert.match(requests[0].system, /Lines flagged \[MARKED\]/)
  assert.match(requests[0].system, /Marked, Decided, To do, Open questions/)
  assert.equal(written.minutes.state, 'ready')
  // The same transcript with other marks is another source: the notes of a call that gained a mark are written again.
  const key = written.minutes.sourceKey
  await sessions.update('flags-notes', latest => ({ ...latest, marks: [66000, 90500] }))
  const again = await notes.generate('flags-notes', undefined, undefined, true)
  assert.equal(requests.length, 2, 'another mark is another request')
  assert.notEqual(again.minutes.sourceKey, key)
})

test('the line to tell the others says where the sound goes', () => {
  assert.equal(tellOthersLine({ me: 'local', them: 'local' }), "I'm writing this call down with Togle. The sound stays on my computer, and an AI writes the notes from the words.")
  for (const [me, them] of [['openai', 'local'], ['local', 'server'], ['server', 'openai']]) {
    const said = tellOthersLine({ me, them })
    assert.match(said, /sent to a speech service/)
    assert.match(said, /an AI writes the notes from the words./)
    assert.doesNotMatch(said, /stays on my computer/)
  }
})
