// Public, held-out voices through the real Electron worker, tracker and OS-encrypted store.
// Names are fixture IDs. No user profile, credentials or meeting recordings are accessed.
const electron = require('electron')
const { app, utilityProcess, safeStorage } = electron
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const { readWave } = require('sherpa-onnx-node')
const folder = path.join(__dirname, '.work/voice-benchmark')
const profile = fs.mkdtempSync(path.join(__dirname, '.work/voice-memory-live-'))
app.setPath('userData', profile)
globalThis.__togleTestElectron = electron
globalThis.__dirname = path.resolve(__dirname, '../out/main')
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
const timeout = setTimeout(() => { console.error('Voice memory audio test timed out'); app.exit(1) }, 120000)

app.whenReady().then(async () => {
  const { VoiceMemory, VoiceTracker, VOICE_MODEL } = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  assert.ok(safeStorage.isEncryptionAvailable(), 'real OS encryption must be available')
  const model = path.join(folder, '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx')
  assert.equal(createHash('sha256').update(fs.readFileSync(model)).digest('hex'), VOICE_MODEL.sha256)
  fs.mkdirSync(path.join(process.env.TOGLE_SPEECH_HOME, 'voices'), { recursive: true })
  fs.copyFileSync(model, path.join(process.env.TOGLE_SPEECH_HOME, 'voices/campplus-zh-en.onnx'))
  fs.copyFileSync(process.env.TOGLE_TEST_SEGMENTATION, path.join(process.env.TOGLE_SPEECH_HOME, 'voices/segmentation-3.onnx'))
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
  // Optional migration replay using enrollment embeddings captured before an engine upgrade.
  const legacy = process.env.TOGLE_TEST_VOICE_ENROLLMENT ? JSON.parse(fs.readFileSync(process.env.TOGLE_TEST_VOICE_ENROLLMENT, 'utf8'))['3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'] : undefined
  assert.equal(manifest.people.length, 16)
  const identities = new Map(), assignments = new Map(), revoked = [], latencies = []
  let pending, ready, enabled = true, at = 10000, sequence = 0
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (...args) => {
    const child = fork(...args)
    child.on('message', message => {
      if (message.type === 'result' && pending?.id === message.id) { const next = pending; pending = undefined; next.resolve(message) }
    })
    return child
  }
  const makeTracker = memory => new VoiceTracker((id, voice, person) => assignments.set(id, { voice, person }), state => {
    if (state.state === 'ready') ready?.resolve()
    if (state.state === 'error') ready?.reject(new Error(state.error))
  }, { memory, enabled: () => enabled, remembered: () => {}, revoked: id => { revoked.push(id); assignments.delete(id) } })
  const start = async tracker => {
    const prepared = new Promise((resolve, reject) => { ready = { resolve, reject } })
    await tracker.start(); await prepared; ready = undefined
  }
  function audio(person, index, altered = false) {
    const wave = readWave(path.join(folder, person.clips[index].file), false)
    assert.equal(wave.sampleRate, 16000)
    const pcm = wave.samples.slice(0, 8 * 16000)
    if (altered) {
      let low = 0
      for (let n = 0; n < pcm.length; n++) { low += .55 * (pcm[n] - low); pcm[n] = (index % 2 ? low : pcm[n]) * .65 + .0015 * Math.sin(n * .79 + index) }
    }
    return pcm
  }
  async function hear(tracker, pcm, preview = false, id = 'turn-' + ++sequence, timestamp = at) {
    const began = performance.now()
    const response = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = undefined; reject(new Error('No voice result for ' + id)) }, 12000)
      pending = { id, resolve: message => { clearTimeout(timer); resolve(message) } }
    })
    tracker.hear(id, pcm, timestamp, preview)
    const message = await response
    latencies.push(performance.now() - began)
    if (!preview) at += pcm.length / 16 + 300
    return { id, message, assignment: assignments.get(id) }
  }
  let memory = new VoiceMemory(VOICE_MODEL.sha256), tracker = makeTracker(memory)
  // Confirm people in separate calls using three utterances, never the recordings used below.
  for (const person of manifest.people.slice(0, 12)) {
    if (legacy) {
      const references = legacy.filter(row => row.speaker === person.speaker && row.index < 3 && row.embedding).map(row => new Float32Array(row.embedding))
      assert.equal(references.length, 3)
      identities.set(person.speaker, (await memory.remember('Person ' + person.speaker, references)).id)
      continue
    }
    tracker.reset(); await start(tracker)
    let last
    for (let index = 0; index < 3; index++) last = await hear(tracker, audio(person, index))
    assert.ok(last.assignment, 'enrollment voice must stabilize for ' + person.speaker)
    const saved = await tracker.remember(last.assignment.voice, 'Person ' + person.speaker)
    assert.equal(saved.state, 'remembered', 'enrollment needs enough clean speech')
    identities.set(person.speaker, saved.person.id)
  }
  await tracker.finish(); await tracker.flush()
  const file = path.join(profile, 'voices/people.bin'), encrypted = fs.readFileSync(file)
  assert.equal(encrypted.includes(Buffer.from('Person ')), false)
  assert.equal(JSON.parse(safeStorage.decryptString(encrypted)).people.length, 12)
  // Restore from disk into a fresh store and tracker, as after reopening Togle.
  memory = new VoiceMemory(VOICE_MODEL.sha256); await memory.load(); tracker = makeTracker(memory)
  assert.deepEqual(new Set((await memory.list()).map(person => person.id)), new Set(identities.values()))
  await start(tracker)
  const report = { speakers: 16, enrollmentRecordings: 36, heldOutRecordings: 80, returning: { correct: 0, wrong: 0, unknown: 0 }, unfamiliar: { falseKnown: 0, unnamed: 0 }, early: { correct: 0, wrong: 0, unknown: 0 }, failures: [] }
  // Interleave all 16 people: first utterances, rapid handoffs, returns, quiet/filter/noise changes.
  for (let index = 3; index < 8; index++) for (const person of manifest.people) {
    const pcm = audio(person, index, true), expected = identities.get(person.speaker), id = 'held-' + person.speaker + '-' + index
    if (pcm.length >= 3 * 16000) {
      const early = await hear(tracker, pcm.slice(0, 3 * 16000), true, id)
      const predicted = early.assignment?.person?.id
      if (expected && predicted === expected) report.early.correct++
      else if (predicted) { report.early.wrong++; report.failures.push({ phase: 'early', speaker: person.speaker, predicted }) }
      else report.early.unknown++
    }
    const final = await hear(tracker, pcm, false, id), predicted = final.assignment?.person?.id
    if (expected) {
      if (predicted === expected) report.returning.correct++
      else if (predicted) { report.returning.wrong++; report.failures.push({ phase: 'final', speaker: person.speaker, predicted }) }
      else report.returning.unknown++
    } else if (predicted) { report.unfamiliar.falseKnown++; report.failures.push({ phase: 'novel', speaker: person.speaker, predicted }) }
    else report.unfamiliar.unnamed++
  }
  await tracker.finish(); await tracker.flush()
  assert.deepEqual(fs.readFileSync(file), encrypted, 'recognition alone never trains or rewrites saved identities')
  // Saved identities should separate a five-person call without inventing extra people.
  tracker.reset(); await start(tracker)
  const roster = new Set(), people = manifest.people.slice(0, 5)
  let labeled = 0
  for (let index = 3; index < 8; index++) for (const person of people) {
    const result = await hear(tracker, audio(person, index, true))
    if (result.assignment) { roster.add(result.assignment.voice); labeled++ }
    if (result.assignment?.person) assert.equal(result.assignment.person.id, identities.get(person.speaker))
  }
  report.fivePersonCall = { profiles: roster.size, labeled, turns: 25 }
  assert.equal(roster.size, 5, 'five known people should have five stable call identities')
  // An early known name must be withdrawn when the completed utterance changes speaker.
  const first = audio(people[0], 3), second = audio(people[1], 3), mixed = new Float32Array(8 * 16000)
  for (let n = 0; n < 4 * 16000; n++) { mixed[n] = first[n % first.length]; mixed[4 * 16000 + n] = second[n % second.length] }
  const early = await hear(tracker, mixed.slice(0, 3 * 16000), true, 'mixed')
  const final = await hear(tracker, mixed, false, 'mixed')
  assert.equal(final.assignment, undefined, 'mixed turn must not keep one person’s name')
  if (early.assignment) assert.ok(revoked.includes('mixed'))
  await tracker.finish()
  await memory.forget(identities.get(people[0].speaker)); tracker.forget(identities.get(people[0].speaker))
  const restored = new VoiceMemory(VOICE_MODEL.sha256); await restored.load()
  assert.equal(restored.get(identities.get(people[0].speaker)), undefined)
  enabled = false; tracker.memoryChanged(); tracker.reset(); await start(tracker)
  const disabled = await hear(tracker, audio(people[1], 3))
  assert.equal(disabled.assignment?.person, undefined)
  await tracker.finish()
  latencies.sort((a, b) => a - b)
  report.workerLatency = { medianMs: Math.round(latencies[Math.floor(latencies.length / 2)]), p95Ms: Math.round(latencies[Math.floor(latencies.length * .95)]) }
  fs.writeFileSync(path.join(folder, legacy ? 'memory-migration-report.json' : 'memory-report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  assert.equal(report.returning.wrong, 0, 'never identify one known person as a different person')
  assert.equal(report.unfamiliar.falseKnown, 0, 'never give an unfamiliar speaker a remembered name')
  assert.equal(report.early.wrong, 0, 'early names must be reliable too')
  assert.ok(report.returning.correct >= 54, 'at least 90% of held-out familiar turns must be recognized')
  clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
