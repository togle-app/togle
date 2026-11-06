import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import electron from './electron.mjs'
import { copilotWith, workDir } from './helpers.mjs'
const profile = workDir('speakers')
globalThis.__dirname = profile // Production workers are bundled as CommonJS.
const { VoiceClusters, VoiceTracker, speechTurns, mergeSpeakers, Copilot, AgentStore } = await import('./.build/togle.mjs')
const basis = (i, dimensions = 64) => Float32Array.from({ length: dimensions }, (_, n) => n === i ? 1 : 0)
const variant = (i, strength, noise = 20) => Float32Array.from({ length: 64 }, (_, n) => n === i ? strength : n === noise ? Math.sqrt(1 - strength * strength) : 0)
const observation = (id, embedding, at, seconds = 3, evidence = 1) => ({ id, embedding, at, end: at + seconds * 1000, seconds, evidence })
const enroll = (voices, index, at = index * 10000) => voices.observe(observation('enroll-' + index, basis(index), at, 6.5, 2)).at(-1).voice

test('one short sample cannot create a person; confirmation backfills the earlier words', () => {
  const voices = new VoiceClusters()
  assert.deepEqual(voices.observe(observation('first', basis(0), 0, 2.5)), [])
  assert.equal(voices.size, 0)
  assert.deepEqual(voices.observe(observation('second', variant(0, .85), 3000, 2.5)), [{ id: 'first', voice: 1 }, { id: 'second', voice: 1 }])
  assert.equal(voices.size, 1)
})

test('five-person meeting keeps five identities through 150 changing, interrupted turns', () => {
  const voices = new VoiceClusters(), assigned = new Map()
  for (let person = 0; person < 5; person++) assigned.set(person, enroll(voices, person))
  let at = 60000
  for (let round = 0; round < 30; round++) for (let person = 0; person < 5; person++) {
    const id = `${round}-${person}`
    const found = voices.observe(observation(id, variant(person, .72 + round % 4 * .05, 10 + round % 40), at))
    assert.equal(found.at(-1)?.voice, assigned.get(person), id)
    at += 3300
    // A one-off sound or very weak clip must not become a sixth participant.
    if (round % 4 === 0) { assert.deepEqual(voices.observe(observation('noise-' + id, basis(60 + person % 4), at, .8)), []); at += 1000 }
  }
  assert.equal(voices.size, 5)
  // This is not an arbitrary five-person cap: another established speaker can join.
  assert.ok(enroll(voices, 6, at + 10000))
  assert.equal(voices.size, 6)
})

test('continuing speech survives a weaker chunk but a known speaker can interrupt immediately', () => {
  const voices = new VoiceClusters(), a = enroll(voices, 0), b = enroll(voices, 1)
  voices.observe(observation('a-start', basis(0), 20000))
  assert.equal(voices.observe(observation('a-continues', variant(0, .48), 23300)).at(-1)?.voice, a)
  assert.equal(voices.observe(observation('b-interrupts', basis(1), 26400)).at(-1)?.voice, b)
  assert.equal(voices.size, 2)
})

test('a pause, mixed speech or invalid audio breaks continuity; weak audio never trains a voice', () => {
  const voices = new VoiceClusters(); enroll(voices, 0)
  assert.deepEqual(voices.observe(observation('after-pause', variant(0, .48), 20000)), [])
  voices.observe(observation('known', basis(0), 24000))
  assert.deepEqual(voices.observe(observation('mixed', undefined, 27100)), [])
  assert.deepEqual(voices.observe(observation('after-mixed', variant(0, .48), 30200)), [])
  assert.deepEqual(voices.observe(observation('wrong-shape', new Float32Array([1, 0]), 34000)), [])
  assert.deepEqual(voices.observe(observation('nonfinite', new Float32Array([NaN]), 38000)), [])
  assert.equal(voices.size, 1)
  const other = voices.observe(observation('different', basis(20), 42000, 6.5, 2))
  assert.equal(other.at(-1)?.voice, 2, 'continuity must not train the noise component into the first profile')
})

test('ambiguous and repeated segment observations cannot inflate the roster', () => {
  const voices = new VoiceClusters(); enroll(voices, 0); enroll(voices, 1)
  const ambiguous = Float32Array.from({ length: 64 }, (_, n) => n === 0 || n === 1 ? .707 : 0)
  for (let i = 0; i < 5; i++) assert.deepEqual(voices.observe(observation('ambiguous-' + i, ambiguous, 30000 + i * 5000)), [])
  const candidate = observation('retry', basis(2), 60000, 3)
  assert.deepEqual(voices.observe(candidate), [])
  assert.deepEqual(voices.observe(candidate), [])
  assert.equal(voices.size, 2)
})

test('expired one-off voices need fresh evidence when they return', () => {
  const voices = new VoiceClusters()
  voices.observe(observation('old', basis(0), 0, 2.5))
  assert.deepEqual(voices.observe(observation('much-later', basis(0), 120000, 2.5)), [])
  assert.deepEqual(voices.observe(observation('confirmed', basis(0), 123000, 2.5)), [{ id: 'much-later', voice: 1 }, { id: 'confirmed', voice: 1 }])
})

test('a fourth, similar voice is identified after sustained clean evidence instead of staying invisible', () => {
  const voices = new VoiceClusters()
  for (let person = 0; person < 3; person++) enroll(voices, person)
  const denis = variant(0, .50, 4)
  assert.deepEqual(voices.observe(observation('denis-1', denis, 40000)), [])
  assert.deepEqual(voices.observe(observation('denis-2', denis, 46000)), [])
  const found = voices.observe(observation('denis-3', denis, 52000))
  assert.deepEqual(found.map(item => item.id), ['denis-1', 'denis-2', 'denis-3'])
  assert.equal(voices.size, 4)
  const denisId = found.at(-1).voice
  assert.notEqual(denisId, 1)
  assert.equal(voices.observe(observation('denis-later', denis, 200000)).at(-1)?.voice, denisId)
  assert.equal(voices.observe(observation('original', basis(0), 210000)).at(-1)?.voice, 1)
})

test('repeated mixed audio and inconsistent weak clips never establish a similar new person', () => {
  const voices = new VoiceClusters(); enroll(voices, 0)
  for (let n = 0; n < 8; n++) voices.observe({ ...observation('overlap-' + n, variant(0, .5, 4), 30000 + n * 6000), clean: false })
  for (let n = 0; n < 8; n++) voices.observe(observation('unstable-' + n, variant(0, .5, 10 + n), 90000 + n * 6000))
  assert.equal(voices.size, 1)
})

test('combining duplicate acoustic profiles recognizes both sound variations on future turns', () => {
  const voices = new VoiceClusters(), a = enroll(voices, 0), b = enroll(voices, 1), other = enroll(voices, 2)
  voices.merge(b, a)
  assert.equal(voices.size, 2)
  assert.equal(voices.observe(observation('new-b', basis(1), 40000)).at(-1)?.voice, a)
  assert.equal(voices.observe(observation('new-a', basis(0), 45000)).at(-1)?.voice, a)
  assert.equal(voices.observe(observation('other', basis(2), 50000)).at(-1)?.voice, other)
  const opposite = voices.observe(observation('opposite', Float32Array.from(basis(2), n => -n), 60000, 6.5, 2)).at(-1).voice
  voices.merge(opposite, other)
  assert.equal(voices.observe(observation('opposite-return', Float32Array.from(basis(2), n => -n), 70000)).at(-1)?.voice, other, 'even very different merged samples cannot poison a profile with a zero centroid')
})

const line = (id, voiceId, at, end, text = id) => ({ id, segmentId: id, speaker: voiceId === 'me' ? 'me' : 'them', voiceId, at, end, text })
test('display groups continuous confirmed speech, preserving every raw word, time and segment', () => {
  const lines = [line('a', 'v:1', 0, 2000, 'Here is the plan.'), line('b', 'v:1', 2400, 5000, 'We ship on Tuesday.'), line('c', 'v:2', 5100, 6000), line('d', 'v:1', 6100, 7000), line('e', 'v:1', 10000, 11000)]
  const before = structuredClone(lines), turns = speechTurns(lines)
  assert.equal(turns.length, 4)
  assert.equal(turns[0].text, 'Here is the plan. We ship on Tuesday.')
  assert.equal(turns[0].id, 'a'); assert.equal(turns[0].at, 0); assert.equal(turns[0].end, 5000)
  assert.deepEqual(lines, before)
  assert.equal(speechTurns([line('x', undefined, 0, 1000), line('y', undefined, 1100, 2000)]).length, 2)
  assert.equal(speechTurns([line('x', 'me', 0, 1000), line('y', 'me', 1100, 2000)]).length, 1)
  assert.equal(speechTurns([line('x', 'v:1', 0, 4000), line('y', 'v:1', 1000, 5000)]).length, 2, 'substantial overlapping speech is not assumed to be one turn')
})

test('explicit transcript merge keeps confirmed names, original timing and unrelated speakers', () => {
  const lines = [{ ...line('a', 'v:1', 0, 2000), voiceName: 'Dana', voiceNamedBy: 'suggested' }, { ...line('b', 'v:2', 2400, 5000), voiceName: 'Diana', voiceNamedBy: 'user' }, line('c', 'v:3', 5100, 6000), line('me', 'me', 6100, 7000)]
  const merged = mergeSpeakers(lines, 'v:1', 'v:2')
  assert.deepEqual(merged.map(item => [item.id, item.at, item.end, item.text]), lines.map(item => [item.id, item.at, item.end, item.text]))
  assert.ok(merged.slice(0, 2).every(item => item.voiceId === 'v:2' && item.voiceName === 'Diana' && item.voiceNamedBy === 'user'))
  assert.equal(merged[2], lines[2]); assert.equal(lines[0].voiceId, 'v:1')
  for (const pair of [['v:1', 'v:1'], ['v:1', 'me'], ['me', 'v:1'], ['missing', 'v:1']]) assert.throws(() => mergeSpeakers(lines, ...pair), /different speakers/)
})

test('live merge corrects past words and queued and late labels without resurrecting a duplicate', async () => {
  const store = new AgentStore(async () => ''); await store.load()
  const { copilot, events } = copilotWith(Copilot, store, store.list()[0].id, [])
  const now = Date.now()
  copilot.add('them', 'My name is Dana.', now, now + 2000, 'a'); copilot.identifyVoice('a', 'v:1')
  copilot.add('them', 'We ship on Tuesday.', now + 2300, now + 5000, 'b'); copilot.identifyVoice('b', 'v:2')
  copilot.renameVoice('v:1', 'Diana')
  copilot.identifyVoice('queued', 'v:2')
  copilot.mergeVoices('v:2', 'v:1')
  copilot.add('them', 'The first followup.', now + 5500, now + 6000, 'queued')
  copilot.add('them', 'The second followup.', now + 6100, now + 7000, 'late'); copilot.identifyVoice('late', 'v:2')
  assert.ok(copilot.currentCall().transcript.every(item => item.voiceId === 'v:1' && item.voiceName === 'Diana'))
  assert.equal(speechTurns(copilot.currentCall().transcript).length, 1)
  assert.ok(events.some(event => event.channel === 'transcript:updated' && event.payload.length >= 2))
  await copilot.clear()
  copilot.add('them', 'A new meeting.', Date.now() + 20000, Date.now() + 22000, 'new'); copilot.identifyVoice('new', 'v:2')
  assert.equal(copilot.currentCall().transcript[0].voiceId, 'v:2', 'corrections do not leak into another call')
})

test('worker backfill, bounded queues, whole-turn audio, merge, pause and stale callbacks work together', async () => {
  process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
  const directory = path.join(process.env.TOGLE_SPEECH_HOME, 'voices'); mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, 'campplus-zh-en.onnx'), '')
  writeFileSync(path.join(directory, 'segmentation-3.onnx'), '')
  const original = electron.utilityProcess.fork, children = [], assignments = []
  electron.utilityProcess.fork = () => {
    const child = new EventEmitter(); child.jobs = []; child.postMessage = job => child.jobs.push(job); child.kill = () => {}
    children.push(child); return child
  }
  const tracker = new VoiceTracker((id, voice) => assignments.push({ id, voice }), () => {})
  const pcm = new Float32Array(3 * 16000).fill(.1)
  try {
    await tracker.start(); const child = children.at(-1); child.emit('message', { type: 'ready' })
    tracker.hear('a', pcm, 10000)
    child.emit('message', { type: 'result', id: 'stale', embedding: basis(0), seconds: 3 })
    assert.equal(assignments.length, 0)
    child.emit('message', { type: 'result', id: 'a', embedding: basis(0), seconds: 3 })
    tracker.hear('b', pcm, 13500); child.emit('message', { type: 'result', id: 'b', embedding: basis(0), seconds: 3 })
    assert.deepEqual(assignments.map(item => item.id), ['a', 'b']); assert.equal(assignments[0].voice, assignments[1].voice)
    tracker.hear('c', pcm, 17000); child.emit('message', { type: 'result', id: 'c', embedding: basis(1), seconds: 6, evidence: 2 })
    const second = assignments.at(-1).voice; assert.notEqual(second, assignments[0].voice)
    tracker.merge(second, assignments[0].voice)
    tracker.stop(); await tracker.start(); const resumed = children.at(-1); resumed.emit('message', { type: 'ready' })
    tracker.hear('after-pause', pcm, 30000); resumed.emit('message', { type: 'result', id: 'after-pause', embedding: basis(1), seconds: 3 })
    assert.equal(assignments.at(-1).voice, assignments[0].voice, 'pause retains the corrected acoustic profile')
    const quiet = Float32Array.from({ length: 3 * 16000 }, (_, n) => Math.sin(n / 4) * .0003)
    tracker.hear('quiet', quiet, 33500)
    assert.equal(resumed.jobs.at(-1).id, 'quiet', 'recoverable quiet speech must reach the worker for normalization')
    resumed.emit('message', { type: 'result', id: 'quiet', embedding: basis(1), seconds: 3 })
    const whole = new Float32Array(28 * 16000).fill(.1); tracker.hear('long', whole, 34000)
    assert.equal(resumed.jobs.at(-1).pcm.length, whole.length, 'the tail must be checked, not truncated at 12 seconds')
    for (let n = 0; n < 10; n++) tracker.hear('queue-' + n, pcm, 65000 + n * 3500)
    resumed.emit('message', { type: 'result', id: 'long', seconds: 28 })
    assert.equal(resumed.jobs.at(-1).id, 'queue-6', 'only the most recent four waiting clips are retained')
    const before = assignments.length; tracker.reset()
    resumed.emit('message', { type: 'result', id: 'queue-6', embedding: basis(1), seconds: 3 })
    assert.equal(assignments.length, before, 'a dead worker cannot add people to a new call')
  } finally { tracker.stop(); electron.utilityProcess.fork = original; delete process.env.TOGLE_SPEECH_HOME }
})
