// Real public speaker samples from the model publisher; no microphone, accounts or meeting audio. The tracker is the
// production one, running the real speaker models: the clip kept of each voice, to play when its name is confirmed after
// a call, must be that voice and nobody else's.
const { app, utilityProcess } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { readWave, SpeakerEmbeddingExtractor } = require('sherpa-onnx-node')

const work = path.join(__dirname, '.work/voice-samples')
const profile = fs.mkdtempSync(path.join(work, 'clips-profile-'))
const speech = path.join(profile, 'speech')
app.setPath('userData', profile)
process.env.TOGLE_TEST_USER_DATA = profile
process.env.TOGLE_SPEECH_HOME = speech
fs.mkdirSync(path.join(speech, 'voices'), { recursive: true })
fs.copyFileSync(path.join(work, 'campplus-zh-en.onnx'), path.join(speech, 'voices', 'campplus-zh-en.onnx'))
fs.copyFileSync(process.env.TOGLE_TEST_SEGMENTATION, path.join(speech, 'voices', 'segmentation-3.onnx'))
globalThis.__dirname = __dirname
const timeout = setTimeout(() => { console.error('Voice clips timed out'); app.exit(1) }, 120000)
const until = async (check, what, ms = 30000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Waited too long for ' + what)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

app.whenReady().then(async () => {
  // The tracker forks its worker through the test's stand-in for Electron: this one gives it the real worker.
  const fake = (await import(pathToFileURL(path.join(__dirname, 'electron.mjs')).href)).default
  fake.utilityProcess.fork = (_file, args, options) => utilityProcess.fork(process.env.TOGLE_VOICE_WORKER || path.join(__dirname, '../out/main/voice-worker.js'), args, options)
  const { VoiceTracker, ConfirmSound, voiceSimilarity } = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  const extractor = new SpeakerEmbeddingExtractor({ model: path.join(speech, 'voices', 'campplus-zh-en.onnx'), numThreads: 1, provider: 'cpu', debug: false })
  const embed = samples => {
    const stream = extractor.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples }); stream.inputFinished()
    return new Float32Array(extractor.compute(stream, false))
  }

  const assigned = new Map()
  const tracker = new VoiceTracker((segment, voice) => assigned.set(segment, voice), () => {})
  tracker.keepClips = () => true
  await tracker.start()
  await until(() => tracker.status().state === 'ready', 'the speaker models')

  const names = ['fangjun', 'leijun', 'liudehua']
  const wave = file => readWave(path.join(work, file), false).samples
  let at = 10000
  // Where each recording began on the call's clock, to tell which recording a clip was cut from.
  const starts = new Map()
  // A new voice is confirmed by a second recording of it, which also gives the first its voice.
  const heard = id => [...assigned.keys()].some(key => key === id || key.startsWith(id + ':turn:'))
  for (const name of names) {
    const ids = ['sr-1', 'test-sr-1'].map(suffix => name + '-' + suffix)
    for (const id of ids) {
      const pcm = wave(id + '.wav')
      starts.set(id, { at, end: at + pcm.length / 16 })
      tracker.hear(id, pcm, at)
      at += pcm.length / 16 + 500
    }
    await until(() => ids.every(heard), ids.join(' and ') + ' to be heard')
  }
  const voiceOf = name => assigned.get(name + '-sr-1') ?? assigned.get(name + '-sr-1:turn:0')
  assert.equal(new Set(names.map(voiceOf)).size, 3, 'three people, three voices')

  const clips = tracker.takeClips()
  assert.equal(clips.size, 3, 'one clip each')
  assert.equal(tracker.takeClips().size, 0, 'the tracker does not keep them after')
  // Each recording of each person, heard by the speaker model on its own.
  const recordings = Object.fromEntries(names.flatMap(name => ['sr-1', 'test-sr-1'].map(suffix => [name + '-' + suffix, embed(wave(name + '-' + suffix + '.wav'))])))
  const results = []
  for (const name of names) {
    const clip = clips.get(voiceOf(name))
    assert.ok(clip, name + ' has a clip')
    assert.ok(clip.pcm.length >= 1.5 * 16000 && clip.pcm.length <= 8 * 16000, name + ': the clip is a few seconds, not the whole recording: ' + clip.pcm.length / 16000)
    // Cut from one recording, it is compared with the person's other recording (not itself), and with everyone else's.
    const source = [...starts].find(([id, span]) => id.startsWith(name) && clip.at >= span.at - 1 && clip.at < span.end)?.[0]
    assert.ok(source, name + ': the clip is from one of their recordings')
    const other = name + (source.endsWith('test-sr-1') ? '-sr-1' : '-test-sr-1')
    const vector = embed(clip.pcm)
    const own = voiceSimilarity(vector, recordings[other])
    const others = names.filter(person => person !== name).flatMap(person => ['sr-1', 'test-sr-1'].map(suffix => voiceSimilarity(vector, recordings[person + '-' + suffix])))
    assert.ok(own > 0.4, name + ': the clip sounds like them (' + own.toFixed(2) + ')')
    assert.ok(own > Math.max(...others) + 0.15, name + ': and not like anyone else (' + own.toFixed(2) + ' against ' + others.map(value => value.toFixed(2)).join(', ') + ')')
    results.push({ name, seconds: +(clip.pcm.length / 16000).toFixed(2), sameVoice: +own.toFixed(3), otherVoices: others.map(value => +value.toFixed(3)) })
  }

  // Kept encrypted, and played back as it was heard.
  const store = new ConfirmSound()
  await store.save('live-call', [...clips.values()].map((clip, index) => ({ name: 'v' + index, pcm: clip.pcm })))
  const back = await store.pcm('live-call', 'v0')
  assert.equal(back.length, [...clips.values()][0].pcm.length)
  assert.ok(fs.readFileSync(path.join(profile, 'confirm-sound', 'live-call', 'v0.bin'), 'utf8').startsWith('ENC:'))
  await store.remove('live-call')
  assert.equal(await store.pcm('live-call', 'v0'), null)

  tracker.stop()
  fs.writeFileSync(path.join(work, 'clips-results.json'), JSON.stringify(results, null, 2))
  console.log('Voice clips, with the real speaker models: ' + JSON.stringify(results))
  clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error.stack); app.exit(1) })
