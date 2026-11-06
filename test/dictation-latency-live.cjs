// Known fixture played at microphone speed. Uses the signed-in Claude subscription,
// but never opens a microphone or writes into an actual application.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { readWave } = require('sherpa-onnx-node')
const root = path.resolve(__dirname, '..'), directory = path.join(__dirname, '.work/dictation-latency')
fs.mkdirSync(directory, { recursive: true }); app.setPath('userData', path.join(directory, 'profile')); app.getAppPath = () => root
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Dictation latency check timed out'); app.exit(1) }, 120_000)
let active, speechCleanup
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs'), { Segmenter } = require('../eval/.build/capture.cjs')
  await T.updateSettings({ provider: 'claude', claude: { auth: 'subscription' }, dictation: { speech: 'auto', polish: true } })
  const auth = new T.ClaudeCodeAuth(), claude = new T.ClaudeSubscriptionProvider(auth)
  assert.ok((await auth.status()).signedIn, 'Sign in to Claude before running the live check')
  if (process.argv.includes('--cleanup-only')) {
    const results = []
    for (const warm of [false, true, true]) {
      const provider = warm ? claude : { stream: claude.stream.bind(claude) }
      const speech = speechCleanup = new T.DictationSpeech({ settings: T.getSettings, claude: provider,
        // This mode opens no speech service; it measures only final-text cleanup.
        claudeAccount: () => auth.status(), claudeSpeech: async () => async () => '' })
      const controller = new AbortController()
      await speech.ready(controller.signal)
      if (warm) await sleep(6000)
      const released = performance.now()
      const text = await speech.polish('um is single sign on included in that plan', controller.signal)
      const cleanupMs = Math.round(performance.now() - released)
      assert.match(text, /single sign.?on/i); assert.match(text, /included.*plan/i); assert.match(text, /\?$/)
      speech.dispose(); speechCleanup = undefined
      const result = { prepared: warm, cleanupMs, text }; results.push(result); console.log(JSON.stringify(result))
    }
    fs.writeFileSync(path.join(directory, 'cleanup-result.json'), JSON.stringify({ checkedAt: new Date().toISOString(), results }, null, 2))
    return
  }
  const cloud = new T.ClaudeSpeech(new T.ClaudeSpeechAccess(auth, () => claude.listModels()))
  const wave = readWave(path.join(root, 'eval/audio/q2.wav'), false); assert.equal(wave.sampleRate, 16000)
  const run = async (name, streaming) => {
    const phases = [], inserted = []
    // This reproduces the previous cold cleanup path for the comparison.
    const provider = streaming ? claude : { id: claude.id, supportsTools: false, stream: claude.stream.bind(claude), listModels: claude.listModels.bind(claude) }
    active = new T.Dictation({
      target: { capture: async () => ({ token: 'fixture', label: 'Latency fixture' }), insert: async (_token, text) => { inserted.push(text); return { inserted: true } } },
      speech: () => new T.DictationSpeech({ settings: T.getSettings, claude: provider,
        chatgpt: { stream: async () => { throw Error('Wrong subscription') } }, chatgptAccount: () => ({ signedIn: false }), claudeAccount: () => auth.status(),
        remote: async () => { throw Error('No local or ChatGPT fallback') },
        claudeSpeech: (language, email, signal) => cloud.prepare(language, email, signal),
        ...(streaming ? { claudeStream: (language, email, signal) => cloud.open(language, email, signal) } : {})
      }),
      inCall: () => false,
      changed: state => { if (phases.at(-1)?.phase !== state.phase) phases.push({ phase: state.phase, at: performance.now() }) }
    })
    const opening = active.start(true), id = active.status().id
    const segmenter = new Segmenter((pcm, _at, _id, kind) => { if (kind === 'final' && pcm.length) active.push(id, pcm) }, false, 160)
    let pending = []
    const flush = () => { if (!pending.length) return; const pcm = new Float32Array(pending.reduce((n, part) => n + part.length, 0)); let at = 0; for (const part of pending) { pcm.set(part, at); at += part.length }; pending = []; active.push(id, pcm) }
    for (let at = 0; at < wave.samples.length; at += 512) {
      const frame = wave.samples.slice(at, at + 512)
      if (streaming) { pending.push(frame); if (pending.length === 4) flush() }
      else segmenter.push(frame)
      await sleep(frame.length / 16)
    }
    const released = performance.now(); active.stop()
    if (streaming) flush(); else segmenter.flush()
    await active.finish(id); await opening
    const ended = performance.now(), state = active.status()
    assert.equal(state.phase, 'done', state.message); assert.equal(inserted.length, 1)
    assert.match(inserted[0], /single sign.?on/i); assert.match(inserted[0], /included.*plan/i); assert.match(inserted[0], /\?$/)
    const cleanup = phases.find(item => item.phase === 'polishing')?.at ?? ended
    const insert = phases.find(item => item.phase === 'inserting')?.at ?? ended
    const result = { name, recordingMs: Math.round(released - phases[0].at), releaseToTextMs: Math.round(ended - released), transcriptionAfterReleaseMs: Math.max(0, Math.round(cleanup - released)), cleanupMs: Math.round(insert - cleanup), text: inserted[0] }
    active.dispose(); active = undefined
    console.log(JSON.stringify(result)); return result
  }
  const before = await run('previous-batch-and-cold-cleanup', false)
  const after = await run('live-audio-and-prepared-cleanup', true)
  const repeat = await run('live-audio-and-prepared-cleanup-repeat', true)
  const report = { checkedAt: new Date().toISOString(), fixture: 'q2.wav', before, after: [after, repeat], localRecognizerUsed: false, chatgptUsed: false }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
  console.log('LIVE DICTATION LATENCY PASS: same recorded question, realtime audio, final text exactly once, same Claude subscription, no local recognizer')
}).then(() => { clearTimeout(timeout); app.exit(0) }, error => { console.error(error); active?.dispose(); speechCleanup?.dispose(); clearTimeout(timeout); app.exit(1) })
