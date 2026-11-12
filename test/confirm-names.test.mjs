// After a call: who spoke. The guesses and their reasons, the one clip kept of each voice, and its short life.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'
const directory = workDir('confirm-names')
globalThis.__dirname = import.meta.dirname
const { addressedNames, confirmVoices, namesToConfirm, ConfirmSound, VoiceTracker } = await import('./.build/togle.mjs')

const known = new Set(['marta', 'dario', 'ivan'])
const line = (id, speaker, voiceId, text, at, end, name, by) => ({ id, speaker, voiceId, text, at, end, ...(name ? { voiceName: name, voiceNamedBy: by } : {}) })

test('a name put to someone is found, and a word that is not a first name is not', () => {
  assert.deepEqual(addressedNames('Marta, can you take the staging logs?', known), ['Marta'])
  assert.deepEqual(addressedNames('What do you think, Marta?', known), ['Marta'])
  assert.deepEqual(addressedNames('Thanks, Ivan. That helps.', known), ['Ivan'])
  assert.deepEqual(addressedNames('Okay, over to Dario.', known), ['Dario'])
  assert.deepEqual(addressedNames('Márta? Are you there?', known), ['Márta'])
  assert.deepEqual(addressedNames('Monday, we ship the pricing page.', known), [], 'Monday is not a first name')
  assert.deepEqual(addressedNames('marta, lowercase is not a call-out', known), [], 'a name starts with a capital')
  assert.deepEqual(addressedNames('We asked Marta about it yesterday.', known), [], 'speaking about someone is not speaking to them')
})

test('each voice is asked about with a guess and what says so, and what the person gave is not asked again', () => {
  const transcript = [
    line('1', 'them', 'v:1', "Hi everyone. I'm Dario. Can we ship the pricing page with two plans first?", 0, 6000, 'Dario', 'suggested'),
    line('2', 'them', 'v:1', 'Marta, what do you think?', 7000, 9000, 'Dario', 'suggested'),
    line('3', 'them', 'v:2', 'Then the API timeline has to move to the end of the month.', 10_000, 15_000),
    line('4', 'me', 'me', 'Fine by me.', 16_000, 17_000, 'You', 'user'),
    line('5', 'them', 'v:3', 'I can take the staging logs.', 18_000, 21_000),
    line('6', 'them', 'v:4', 'Quick yes.', 22_000, 22_800),
    line('7', 'them', 'v:5', 'I am already named by you, thanks.', 23_000, 27_000, 'Ivan', 'user')
  ]
  const asked = confirmVoices(transcript, known)
  assert.deepEqual(asked.map(voice => voice.id), ['v:1', 'v:2', 'v:3'], 'you, a named voice and a very short one are not asked')
  assert.equal(asked[0].guess, 'Dario')
  assert.match(asked[0].reason, /^Introduced themselves: “Hi everyone. I'm Dario/)
  assert.equal(asked[1].guess, 'Marta')
  assert.equal(asked[1].reason, 'Dario said “Marta” just before.')
  assert.equal(asked[2].guess, undefined, 'nothing says who the third voice is')
  assert.equal(asked[2].reason, undefined)
  assert.equal(asked[2].said, 'I can take the staging logs.')
  assert.ok(asked.every(voice => voice.seconds >= 2))
})

test('a name said just after a voice first spoke is a guess too, and two voices never get the same name', () => {
  const transcript = [
    line('1', 'them', 'v:1', 'I can take the staging logs before Friday.', 0, 4000),
    line('2', 'me', 'me', 'Thanks, Ivan.', 4500, 6000, 'You', 'user'),
    line('3', 'them', 'v:2', 'Marta, Ivan, did you see the numbers?', 20_000, 24_000),
    line('4', 'them', 'v:3', 'Yes I did, they look right to me.', 24_500, 28_000),
    line('5', 'them', 'v:4', 'Same here, they look fine.', 29_000, 33_000)
  ]
  const asked = confirmVoices(transcript, known)
  const byId = Object.fromEntries(asked.map(voice => [voice.id, voice]))
  assert.equal(byId['v:1'].guess, 'Ivan')
  assert.equal(byId['v:1'].reason, 'You said “Ivan” just after.')
  assert.equal(byId['v:3'].guess, 'Marta', 'the voice after a call-out takes the first name of it that nobody has')
  assert.equal(byId['v:4'].guess, undefined, 'a name given to one voice is not guessed for another')
})

test('a remembered voice is asked to be confirmed, and the clip shown with what it said is the one nearest it', () => {
  const transcript = [
    line('1', 'them', 'v:1', 'First thing said.', 0, 3000, 'Marta', 'remembered'),
    line('2', 'them', 'v:1', 'A longer thing said much later in the call.', 60_000, 66_000, 'Marta', 'remembered')
  ]
  const [voice] = confirmVoices(transcript, known, new Map([['v:1', { name: 'v0', at: 60_500, end: 65_000 }]]))
  assert.equal(voice.reason, 'Recognized from a previous call.')
  assert.equal(voice.clip, 'v0')
  assert.equal(voice.said, 'A longer thing said much later in the call.')
  const [without] = confirmVoices(transcript, known)
  assert.equal(without.clip, undefined)
  assert.equal(without.said, 'A longer thing said much later in the call.', 'with no clip, the longest line shows')
})

test('only voices not yet answered count, and none once it is closed or the sound has expired', () => {
  const confirm = { until: 10_000, voices: [{ id: 'a', seconds: 5 }, { id: 'b', seconds: 5, answered: 'Marta' }, { id: 'c', seconds: 5, answered: '' }] }
  assert.equal(namesToConfirm(confirm, 5000), 1)
  assert.equal(namesToConfirm(confirm, 10_000), 0, 'the sound is gone by then')
  assert.equal(namesToConfirm({ ...confirm, closed: 6000 }, 5000), 0)
  assert.equal(namesToConfirm(undefined, 5000), 0)
})

test('the tracker keeps one clip of each voice only when asked to, never longer than a few seconds, and gives them up once', async () => {
  process.env.TOGLE_SPEECH_HOME = path.join(directory, 'speech')
  const voices = path.join(process.env.TOGLE_SPEECH_HOME, 'voices'); fs.mkdirSync(voices, { recursive: true })
  for (const name of ['campplus-zh-en.onnx', 'segmentation-3.onnx']) fs.writeFileSync(path.join(voices, name), '')
  const original = electron.utilityProcess.fork, assignments = []
  const child = new EventEmitter(); child.postMessage = job => { child.latest = job }; child.kill = () => {}
  electron.utilityProcess.fork = () => child
  const basis = n => Float32Array.from({ length: 64 }, (_, i) => i === n ? 1 : 0)
  const tracker = new VoiceTracker((id, voice) => assignments.push({ id, voice }), () => {})
  const speech = seconds => Float32Array.from({ length: seconds * 16000 }, (_, n) => Math.sin(n / 10) * .1)
  const heard = async (id, seconds, person, at, clean = true) => {
    tracker.hear(id, speech(seconds), at)
    child.emit('message', { type: 'result', id, request: child.latest.request, embedding: basis(person), seconds, evidence: 2, clean })
  }
  try {
    await tracker.start(); child.emit('message', { type: 'ready' })
    await heard('off-1', 7, 0, 0)
    assert.equal(tracker.takeClips().size, 0, 'nothing is kept unless asked')
    tracker.keepClips = () => true
    await heard('a-1', 3, 0, 10_000)
    await heard('a-2', 12, 0, 20_000)
    await heard('a-3', 5, 0, 40_000)
    await heard('b-1', 6, 1, 50_000)
    await heard('b-2', 1, 1, 60_000)
    const voiceOf = id => assignments.find(item => item.id === id).voice
    assert.equal(voiceOf('a-2'), voiceOf('a-1'))
    assert.notEqual(voiceOf('b-1'), voiceOf('a-1'))
    const clips = tracker.takeClips()
    assert.equal(clips.size, 2, 'one clip each')
    const first = clips.get(voiceOf('a-1'))
    assert.equal(first.pcm.length, 8 * 16000, 'the longest speech, cut to eight seconds')
    assert.equal(first.at, 20_000)
    assert.equal(clips.get(voiceOf('b-1')).pcm.length, 6 * 16000, 'a one second reply is no clip')
    assert.equal(tracker.takeClips().size, 0, 'given up once')
    // Merging two voices keeps the better of their clips for the one that remains.
    await heard('c-1', 4, 2, 70_000)
    await heard('d-1', 9, 3, 80_000)
    const [c, d] = [voiceOf('c-1'), voiceOf('d-1')]
    await tracker.merge(c, d)
    const merged = tracker.takeClips()
    assert.equal(merged.size, 1)
    assert.equal(merged.get(d).pcm.length, 8 * 16000)
    assert.equal(merged.has(c), false)
  } finally { tracker.stop(); electron.utilityProcess.fork = original; delete process.env.TOGLE_SPEECH_HOME }
})

test('a kept clip comes back as it was heard and is gone when removed or swept', async () => {
  const store = new ConfirmSound()
  const wave = Float32Array.from({ length: 16000 }, (_, n) => Math.sin(n / 20) * .5)
  await store.save('call-one', [{ name: 'v0', pcm: wave }, { name: 'v1', pcm: wave.slice(0, 8000) }, { name: '../escape', pcm: wave }])
  const back = await store.pcm('call-one', 'v0')
  assert.equal(back.length, 16000)
  assert.ok(Math.abs(back[1234] - wave[1234]) < 0.001, 'within what 16 bits keep')
  assert.equal((await store.pcm('call-one', 'v1')).length, 8000)
  assert.equal(await store.pcm('call-one', '../escape'), null, 'a name outside the clips is refused')
  assert.equal(await store.pcm('../call-one', 'v0'), null, 'so is a call outside them')
  const file = path.join(directory, 'confirm-sound', 'call-one', 'v0.bin')
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('ENC:'), 'kept encrypted')
  await store.save('call-two', [{ name: 'v0', pcm: wave }])
  await store.sweep(id => id === 'call-two')
  assert.equal(await store.pcm('call-one', 'v0'), null, 'swept: not asked for any more')
  assert.notEqual(await store.pcm('call-two', 'v0'), null)
  await store.remove('call-two')
  assert.equal(await store.pcm('call-two', 'v0'), null)
  assert.equal(fs.existsSync(path.join(directory, 'confirm-sound', 'call-two')), false)
})
