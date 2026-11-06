import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import electron from './electron.mjs'
import { copilotWith, workDir } from './helpers.mjs'
const root = workDir('voice-memory')
globalThis.__dirname = root
const { VoiceMemory, VoiceTracker, VoiceClusters, AgentStore, Copilot } = await import('./.build/togle.mjs')
const basis = index => Float32Array.from({ length: 64 }, (_, n) => n === index ? 1 : 0)
const shifted = (index, strength = .9, noise = 40) => Float32Array.from({ length: 64 }, (_, n) => n === index ? strength : n === noise ? Math.sqrt(1 - strength * strength) : 0)
function folder(name) { const directory = path.join(root, name); mkdirSync(directory, { recursive: true }); process.env.TOGLE_TEST_USER_DATA = directory; return directory }

test('confirmed identities survive a restart and only public metadata leaves voice memory', async () => {
  const directory = folder('restart'), memory = new VoiceMemory('model-v1')
  const diana = await memory.remember('Diana', [basis(0), shifted(0)])
  const ben = await memory.remember('Ben', [basis(1), shifted(1, .85, 41)])
  assert.ok(readFileSync(path.join(directory, 'voices/people.bin'), 'utf8').startsWith('ENC:'), 'storage uses the OS-encryption interface')
  const restored = new VoiceMemory('model-v1'); await restored.load()
  assert.equal(restored.match([shifted(0, .86, 42)], true)?.id, diana.id)
  assert.equal(restored.match([shifted(1, .88, 43)], true)?.id, ben.id)
  assert.deepEqual(Object.keys((await restored.list())[0]).sort(), ['createdAt', 'id', 'name', 'updatedAt'])
  assert.equal(restored.match([basis(3)]), undefined)
  assert.equal(restored.match([Float32Array.from({ length: 64 }, (_, n) => n === 0 || n === 1 ? Math.SQRT1_2 : 0)]), undefined, 'similar voices without a clear winner stay unknown')
})

test('different people with the same name stay separate; changed microphones require confirmation', async () => {
  folder('names'); const memory = new VoiceMemory('model-v1')
  const a = await memory.remember('Alex', [basis(0)]), b = await memory.remember('Alex', [basis(1)])
  assert.notEqual(a.id, b.id)
  assert.equal(memory.match([basis(0)])?.id, a.id)
  assert.equal(memory.match([basis(1)])?.id, b.id)
  await memory.remember('Alex', [basis(5)], a.id)
  assert.equal(memory.match([basis(5)])?.id, a.id)
  assert.equal(memory.match([basis(0)])?.id, a.id, 'the original reference survives the confirmed microphone change')
  assert.equal((await memory.list()).length, 2)
})

test('short replies require more evidence than sustained clean speech', async () => {
  folder('duration'); const memory = new VoiceMemory('model-v1')
  const person = await memory.remember('Diana', [basis(0)])
  await memory.remember('Ben', [basis(1)])
  assert.equal(memory.recognize(shifted(0, .80), 1).person, undefined)
  assert.equal(memory.recognize(shifted(0, .86), 1).person?.id, person.id)
  assert.equal(memory.recognize(shifted(0, .72), 4).person?.id, person.id)
  assert.equal(memory.recognize(shifted(0, .72), 4, false).person, undefined)
  assert.equal(memory.recognize(basis(0), .3).person, undefined)
})

test('recognizing someone never rewrites their saved samples or guesses a new identity', async () => {
  const directory = folder('immutable'); const memory = new VoiceMemory('model-v1')
  await memory.remember('Diana', [basis(0)])
  const file = path.join(directory, 'voices/people.bin'), before = readFileSync(file)
  for (let n = 0; n < 50; n++) memory.match([shifted(0, .8, 10 + n % 40)])
  assert.deepEqual(readFileSync(file), before)
  const differentModel = new VoiceMemory('model-v2'); await differentModel.load()
  assert.equal(differentModel.match([basis(0)]), undefined, 'embeddings from different model versions cannot be compared')
  const person = (await differentModel.list())[0]
  await differentModel.remember(person.name, [basis(1)], person.id)
  assert.equal(differentModel.match([basis(1)])?.id, person.id)
  assert.equal(differentModel.match([basis(0)]), undefined, 'explicit reenrollment replaces incompatible embeddings')
})

test('forgotten people stay forgotten after reopening; combining profiles retains both confirmed voices', async () => {
  folder('forget'); const memory = new VoiceMemory('model-v1')
  const a = await memory.remember('Diana', [basis(0)]), b = await memory.remember('Duplicate', [basis(1)])
  await memory.merge(b.id, a.id)
  assert.equal(memory.match([basis(1)])?.id, a.id)
  assert.equal((await memory.list()).length, 1)
  await memory.forget(a.id)
  const restored = new VoiceMemory('model-v1'); await restored.load()
  assert.deepEqual(await restored.list(), [])
  assert.equal(restored.match([basis(0)]), undefined)
  await assert.rejects(restored.remember('Diana', [basis(0)], a.id), /removed/)
})

test('invalid or unreadable profiles are not silently overwritten, and zero vectors cannot be enrolled', async () => {
  const directory = folder('corrupt'); const memory = new VoiceMemory('model-v1')
  mkdirSync(path.join(directory, 'voices')); const file = path.join(directory, 'voices/people.bin')
  writeFileSync(file, 'broken encrypted file')
  await assert.rejects(memory.load(), /could not be opened/)
  await assert.rejects(memory.remember('Diana', [basis(0)]), /could not be opened/)
  assert.equal(readFileSync(file, 'utf8'), 'broken encrypted file')
  await assert.rejects(memory.remember('', [basis(0)]), /required/)
  await assert.rejects(memory.remember('Diana', [new Float32Array(64)]), /required/)
})

test('a verified familiar identity beats continuity and separates similar voices', () => {
  const voices = new VoiceClusters()
  const a = voices.observe({ id: 'a', at: 0, end: 3000, seconds: 3, embedding: basis(0), identity: 'person-a' })[0].voice
  const b = voices.observe({ id: 'b', at: 3100, end: 6100, seconds: 3, embedding: shifted(0, .8, 1), identity: 'person-b' })[0].voice
  assert.notEqual(a, b, 'two independently verified people cannot collapse into one ongoing turn')
  assert.equal(voices.observe({ id: 'a-return', at: 6200, end: 9200, seconds: 3, embedding: shifted(0, .82, 2), identity: 'person-a' })[0].voice, a)
})

test('learning a familiar name reuses the call identity and backfills earlier uncertain words', () => {
  const voices = new VoiceClusters()
  assert.deepEqual(voices.observe({ id: 'short', at: 0, end: 2000, seconds: 2, embedding: basis(0) }), [])
  const known = voices.preview(basis(0), { id: 'diana', samples: [basis(0)] })
  assert.equal(voices.profile(known).samples.length, 0, 'saved anchors are not observations from this call')
  const assigned = voices.observe({ id: 'clear', at: 2300, end: 6300, seconds: 4, embedding: shifted(0), identity: 'diana' })
  assert.deepEqual(assigned.map(a => a.id), ['short', 'clear'])
  assert.equal(new Set(assigned.map(a => a.voice)).size, 1)
  assert.equal(voices.profile(known).samples.length, 1, 'only actual completed speech may train a corrected identity')
  assert.ok(voices.profile(known).samples.every(sample => sample[40] > 0), 'the old identity’s saved anchor is not included in enrollment')
  const unnamed = new VoiceClusters()
  const local = unnamed.observe({ id: 'local', at: 0, end: 6000, seconds: 6, evidence: 2, embedding: basis(1) })[0].voice
  assert.equal(unnamed.preview(basis(1), { id: 'ben', samples: [basis(1)] }), local)
  assert.equal(unnamed.size, 1, 'recognizing an unnamed call participant cannot create a duplicate')
})

test('remembered names appear before or after transcription, persist in history and yield to user corrections', async () => {
  folder('copilot'); const store = new AgentStore(async () => ''); await store.load()
  const { copilot } = copilotWith(Copilot, store, store.list()[0].id, [])
  const person = { id: 'person-a', name: 'Diana', createdAt: 1, updatedAt: 1 }, now = Date.now()
  copilot.identifyVoice('a', 'v:1', person)
  copilot.add('them', 'The release is ready.', now, now + 2000, 'a')
  assert.equal(copilot.currentCall().transcript[0].voiceName, 'Diana')
  assert.equal(copilot.currentCall().transcript[0].voiceNamedBy, 'remembered')
  assert.equal(copilot.currentCall().transcript[0].voiceIdentityId, person.id)
  const restored = copilotWith(Copilot, store, store.list()[0].id, []).copilot; restored.restore(copilot.callState())
  assert.equal(restored.currentCall().transcript[0].voiceIdentityId, person.id)
  copilot.renameVoice('v:1', 'Alice'); copilot.identifyVoice('a', 'v:1', person)
  assert.equal(copilot.currentCall().transcript[0].voiceName, 'Alice')
  assert.equal(copilot.currentCall().transcript[0].voiceIdentityId, undefined)
  copilot.identifyVoice('preview', 'v:2', person)
  assert.equal(copilot.speakerForSegment('preview').voiceName, 'Diana')
  copilot.forgetVoiceSegment('preview')
  assert.equal(copilot.speakerForSegment('preview').voiceId, undefined)
  copilot.forgetVoiceSegment('a')
  assert.equal(copilot.currentCall().transcript[0].voiceId, undefined)
})

test('early recognition is throttled, cannot train on repeated prefixes and is withdrawn on mixed speech', async () => {
  folder('preview'); const memory = new VoiceMemory('model-v1'), results = [], revoked = []
  const known = await memory.remember('Diana', [basis(0)])
  const home = path.join(root, 'preview-speech'); process.env.TOGLE_SPEECH_HOME = home
  mkdirSync(path.join(home, 'voices'), { recursive: true }); writeFileSync(path.join(home, 'voices/campplus-zh-en.onnx'), '')
  writeFileSync(path.join(home, 'voices/segmentation-3.onnx'), '')
  const original = electron.utilityProcess.fork
  const child = new EventEmitter(); child.jobs = []; child.postMessage = job => child.jobs.push(job); child.kill = () => {}
  electron.utilityProcess.fork = () => child
  const tracker = new VoiceTracker((segment, voice, person) => results.push({ segment, voice, person }), () => {}, { memory, enabled: () => true, remembered: () => {}, revoked: id => revoked.push(id) })
  const pcm = seconds => new Float32Array(seconds * 16000).fill(.1)
  const reply = (job, embedding, seconds = 3) => child.emit('message', { type: 'result', id: job.id, request: job.request, embedding, seconds })
  try {
    await tracker.start(); child.emit('message', { type: 'ready' })
    tracker.hear('long', pcm(3), 10000, true)
    for (let n = 0; n < 30; n++) tracker.hear('long', pcm(3), 10000, true)
    assert.equal(child.jobs.length, 1)
    reply(child.jobs.at(-1), basis(0))
    assert.equal(results.at(-1).person.id, known.id)
    const voice = results.at(-1).voice
    assert.equal((await tracker.remember(voice, 'Diana')).state, 'learning')
    tracker.hear('long', pcm(6), 10000, true); reply(child.jobs.at(-1), basis(0), 6)
    assert.equal((await tracker.remember(voice, 'Diana')).state, 'learning', 'overlapping prefixes cannot count as separate enrollment samples')
    tracker.hear('long', pcm(8), 10000); reply(child.jobs.at(-1), undefined, 8)
    assert.deepEqual(revoked, ['long'])
    tracker.hear('next', pcm(3), 20000, true); const preview = child.jobs.at(-1)
    tracker.hear('next', pcm(6), 20000)
    reply(preview, basis(0))
    const final = child.jobs.at(-1), before = results.length
    assert.notEqual(preview.request, final.request)
    reply(preview, basis(1))
    assert.equal(results.length, before, 'late preview replies cannot masquerade as final-turn results')
    const finishing = tracker.finish()
    reply(final, basis(0), 6)
    await finishing; await tracker.flush()
    assert.equal(tracker.status().state, 'off')
    assert.equal(results.at(-1).person.id, known.id, 'call end finishes the last captured voice before stopping')
    assert.equal((await memory.list()).length, 1)
  } finally { tracker.stop(); electron.utilityProcess.fork = original; delete process.env.TOGLE_SPEECH_HOME }
})

test('worker recognition recalls across calls, waits for clean enrollment, and does not learn unconfirmed names', async () => {
  folder('tracker'); const memory = new VoiceMemory('model-v1'), changes = [], results = []
  const home = path.join(root, 'speech'); process.env.TOGLE_SPEECH_HOME = home
  mkdirSync(path.join(home, 'voices'), { recursive: true }); writeFileSync(path.join(home, 'voices/campplus-zh-en.onnx'), '')
  writeFileSync(path.join(home, 'voices/segmentation-3.onnx'), '')
  const original = electron.utilityProcess.fork, children = []
  electron.utilityProcess.fork = () => { const child = new EventEmitter(); child.jobs = []; child.postMessage = job => child.jobs.push(job); child.kill = () => {}; children.push(child); return child }
  let enabled = true
  const tracker = new VoiceTracker((segment, voice, person) => results.push({ segment, voice, person }), () => {}, { memory, enabled: () => enabled, remembered: (voice, person) => changes.push({ voice, person }) })
  const pcm = new Float32Array(3 * 16000).fill(.1)
  let at = 10000
  const hear = (id, embedding, seconds = 3) => { tracker.hear(id, pcm, at); at += 3500; children.at(-1).emit('message', { type: 'result', id, embedding, seconds }) }
  try {
    await tracker.start(); children.at(-1).emit('message', { type: 'ready' })
    hear('first', basis(0), 2); hear('second', basis(0), 2)
    const voice = results.at(-1).voice
    assert.deepEqual(await memory.list(), [])
    assert.equal((await tracker.remember(voice, 'Diana')).state, 'learning')
    hear('third', shifted(0))
    await tracker.flush()
    const person = (await memory.list())[0]
    assert.equal(person.name, 'Diana'); assert.equal(changes.at(-1).person.id, person.id)
    tracker.reset(); await tracker.start(); children.at(-1).emit('message', { type: 'ready' })
    hear('returning', shifted(0, .86, 41))
    assert.equal(results.at(-1).person?.id, person.id, 'a new call recognizes the saved person on their first clear turn')
    assert.notEqual(results.at(-1).voice, voice, 'call-local cluster IDs remain separate from remembered identities')
    assert.equal((await memory.list()).length, 1)
    enabled = false; tracker.memoryChanged(); tracker.reset(); await tracker.start(); children.at(-1).emit('message', { type: 'ready' })
    hear('disabled-a', basis(0)); hear('disabled-b', basis(0))
    assert.equal(results.at(-1).person, undefined)
    assert.equal((await tracker.remember(results.at(-1).voice, 'Do not save')).state, 'off')
    assert.equal((await memory.list()).length, 1)
  } finally { tracker.stop(); electron.utilityProcess.fork = original; delete process.env.TOGLE_SPEECH_HOME }
})
