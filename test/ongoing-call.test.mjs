// The call being written down: what goes into its transcript, in which order, and who each voice is.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ongoingCall, workDir } from './helpers.mjs'

workDir('ongoing-call')
const { OngoingCall, isEcho } = await import('./.build/togle.mjs')

const texts = (ongoing) => ongoing.current().transcript.map((line) => `${line.speaker}: ${line.text}`)

test('the microphone hearing the other side from the speakers is taken out, whichever line came first', () => {
  const { ongoing, events } = ongoingCall(OngoingCall)
  const t = Date.now()
  // Theirs first: my microphone's copy of it never goes in.
  ongoing.add('them', 'Can you send the report by Tuesday?', t, t + 3000, 'a')
  ongoing.add('me', 'can you send the report by tuesday', t + 200, t + 3100, 'b')
  assert.deepEqual(texts(ongoing), ['them: Can you send the report by Tuesday?'])
  // Mine first: it comes out once their line arrives, and the window is told.
  ongoing.add('me', 'we could start with a pilot', t + 5000, t + 7000, 'c')
  ongoing.add('them', 'We could start with a pilot.', t + 4900, t + 7100, 'd')
  assert.deepEqual(texts(ongoing), ['them: Can you send the report by Tuesday?', 'them: We could start with a pilot.'])
  assert.equal(events.filter((e) => e.channel === 'transcript:remove').length, 1)
  // My own words over theirs, or the same words much later, stay.
  ongoing.add('me', 'Yes, I will send it today.', t + 7500, t + 9000, 'e')
  assert.equal(texts(ongoing).at(-1), 'me: Yes, I will send it today.')
  const line = (speaker, text, at, end) => ({ id: text, speaker, text, at, end })
  assert.equal(isEcho(line('me', 'send the report', 60_000, 62_000), line('them', 'Send the report.', 1000, 3000)), false, 'not at the same moment')
})

test('lines transcribed out of order go in the order they were said', () => {
  const { ongoing } = ongoingCall(OngoingCall)
  const t = Date.now()
  ongoing.add('them', 'Second.', t + 3000, t + 4000)
  ongoing.add('me', 'First.', t, t + 1000)
  ongoing.add('them', 'Third.', t + 6000, t + 7000)
  assert.deepEqual(texts(ongoing), ['me: First.', 'them: Second.', 'them: Third.'])
})

test('my voice has the name my AI account knows me by until I give another; a voice that says who it is gets a guess', () => {
  const { ongoing } = ongoingCall(OngoingCall, { ownName: () => 'Dario' })
  const t = Date.now()
  ongoing.add('me', 'Let us plan our next step.', t, t + 2000, 'self-1')
  assert.equal(ongoing.current().transcript.at(-1).voiceName, 'Dario')
  ongoing.renameVoice('me', 'Dario M.')
  ongoing.add('me', 'We can finish tomorrow.', t + 3000, t + 5000, 'self-2')
  assert.equal(ongoing.current().transcript.at(-1).voiceName, 'Dario M.')
  assert.equal(ongoing.current().transcript.at(-1).voiceNamedBy, 'user')
  ongoing.add('them', 'Hi, my name is Marta.', t + 6000, t + 8000, 'intro')
  ongoing.identifyVoice('intro', 'voice:1')
  const marta = ongoing.current().transcript.find((line) => line.voiceId === 'voice:1')
  assert.equal(marta.voiceName, 'Marta')
  assert.equal(marta.voiceNamedBy, 'suggested')
  // "Not them": the guess comes off; a name the person gave stays.
  ongoing.dropVoiceName('voice:1')
  assert.equal(ongoing.current().transcript.find((line) => line.voiceId === 'voice:1').voiceName, undefined)
  ongoing.dropVoiceName('me')
  assert.equal(ongoing.current().transcript.find((line) => line.voiceId === 'me').voiceName, 'Dario M.')
})

test('a voice heard before its line came in is put on the line when it arrives, and on its live caption', () => {
  const { ongoing } = ongoingCall(OngoingCall)
  ongoing.identifyVoice('early', 'voice:2')
  assert.equal(ongoing.speakerForSegment('early').voiceId, 'voice:2')
  ongoing.add('them', 'Shall we start?', Date.now(), Date.now() + 1500, 'early')
  assert.equal(ongoing.current().transcript[0].voiceId, 'voice:2')
  assert.equal(ongoing.speakerForSegment('early').voiceId, undefined, 'used once')
})
