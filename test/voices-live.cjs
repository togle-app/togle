// Real public speaker samples from the model publisher; no microphone, accounts or meeting audio.
const { app, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { readWave } = require('sherpa-onnx-node')
const profile = fs.mkdtempSync(path.join(__dirname, '.work/voice-samples/profile-'))
app.setPath('userData', profile)
const timeout = setTimeout(() => { console.error('Voice worker timed out'); app.exit(1) }, 30000)
app.whenReady().then(async () => {
  const { VoiceClusters, voiceSimilarity } = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  const model = path.join(__dirname, '.work/voice-samples/campplus-zh-en.onnx')
  const worker = utilityProcess.fork(process.env.TOGLE_VOICE_WORKER || path.join(__dirname, '../out/main/voice-worker.js'), [model, process.env.TOGLE_TEST_SEGMENTATION], { stdio: 'ignore' })
  const waiters = new Map()
  await new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (message.type === 'ready') resolve()
      else if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'result') { waiters.get(message.id)?.(message); waiters.delete(message.id) }
    })
  })
  const voices = new VoiceClusters(), results = [], enrolled = []
  const assigned = new Map()
  let at = 10000
  const run = async (id, pcm) => {
    const start = performance.now()
    const result = await new Promise(resolve => { waiters.set(id, resolve); worker.postMessage({ id, pcm }) })
    return { ...result, ms: Math.round(performance.now() - start) }
  }
  const observe = (id, result, pcm) => {
    const end = at + pcm.length / 16
    for (const assignment of voices.observe({ ...result, id, at, end })) assigned.set(assignment.id, assignment.voice)
    at = end + 500
    return assigned.get(id)
  }
  for (const name of ['fangjun', 'leijun', 'liudehua']) {
    const samples = []
    for (const suffix of ['sr-1', 'test-sr-1']) {
      const file = name + '-' + suffix + '.wav'
      const wave = readWave(path.join(__dirname, '.work/voice-samples', file), false)
      assert.equal(wave.sampleRate, 16000)
      const result = await run(file, wave.samples)
      const { embedding, ms } = result
      assert.ok(embedding, file + ' should have one identifiable voice')
      const voice = observe(file, result, wave.samples)
      samples.push({ id: file, embedding, pcm: wave.samples })
      results.push({ sample: file, voice, ms, seconds: +(wave.samples.length / 16000).toFixed(2), voicedSeconds: +result.seconds.toFixed(2), evidence: result.evidence })
    }
    assert.equal(assigned.get(samples[0].id), assigned.get(samples[1].id), name + ': separate recordings should match')
    assert.ok(assigned.get(samples[0].id), name + ': both recordings should confirm the voice')
    enrolled.push(samples[0])
    results.push({ sameSpeaker: name, similarity: +voiceSimilarity(samples[0].embedding, samples[1].embedding).toFixed(3) })
  }
  assert.equal(new Set(enrolled.map(sample => assigned.get(sample.id))).size, 3, 'different voices must not be merged')
  // Same people returning with different input levels, filtering, background noise and short pauses.
  for (let round = 0; round < 5; round++) for (const [index, sample] of enrolled.entries()) {
    let low = 0
    const pcm = Float32Array.from(sample.pcm, (value, n) => {
      low += 0.65 * (value - low)
      return (round % 2 ? low : value) * (0.4 + round * 0.2) + 0.001 * Math.sin(n * 0.73 + round)
    })
    const id = `return-${round}-${index}`, result = await run(id, pcm)
    const voice = observe(id, result, pcm)
    assert.equal(voice, assigned.get(sample.id), id + ': changes in level and sound must not invent a person')
    results.push({ sample: id, voice, ms: result.ms })
  }
  assert.equal(voices.size, 3)
  for (const [index, sample] of enrolled.entries()) {
    const quiet = Float32Array.from(sample.pcm, value => value * .02 + .01)
    const id = 'quiet-offset-' + index, result = await run(id, quiet)
    assert.equal(observe(id, result, quiet), assigned.get(sample.id), 'quiet speech with microphone DC offset keeps the same person')
    results.push({ sample: id, voice: assigned.get(sample.id), ms: result.ms })
  }
  const mixed = new Float32Array(8 * 16000)
  const a = enrolled[0].pcm, b = enrolled[1].pcm
  for (let i = 0; i < 4 * 16000; i++) { mixed[i] = a[i % a.length]; mixed[4 * 16000 + i] = b[i % b.length] }
  const mixedResult = await run('two-speakers', mixed)
  assert.equal(mixedResult.embedding, undefined, 'an obvious speaker change must not get one whole-turn label')
  results.push({ mixedTurn: 'unassigned', ms: mixedResult.ms })
  const longMixed = new Float32Array(28 * 16000)
  for (let n = 0; n < longMixed.length; n++) longMixed[n] = n < 16 * 16000 ? a[n % a.length] : b[n % b.length]
  assert.equal((await run('late-speaker-change', longMixed)).embedding, undefined, 'a change after 12 seconds must not be ignored')
  for (let n = 0; n < longMixed.length; n++) longMixed[n] = n < 8 * 16000 || n >= 20 * 16000 ? a[n % a.length] : b[n % b.length]
  assert.equal((await run('middle-speaker-change', longMixed)).embedding, undefined, 'matching first and last speakers must not hide a different person in the middle')
  assert.equal((await run('silence', new Float32Array(8 * 16000))).embedding, undefined)
  fs.writeFileSync(path.join(__dirname, '.work/voice-samples/results.json'), JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
  worker.kill(); clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error.stack); app.exit(1) })
