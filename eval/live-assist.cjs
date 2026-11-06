// Fictional recorded questions -> production VAD -> real Whisper -> hearing -> Copilot.
// Default: a fixed 400 ms answer isolates local latency. --live: official Claude subscription.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { options, run, sleep, within, median } = require('./data.cjs')
const root = path.resolve(__dirname, '..')
const work = path.join(root, 'test', '.work', 'live-assist')
if (!process.env.TOGLE_LATENCY_DATA) throw new Error('Run through test/live-assist-launch.cjs.')
app.setPath('userData', process.env.TOGLE_LATENCY_DATA)
app.getAppPath = () => root
const opts = options()
const bundle = opts.baseline ? path.join(work, 'before.cjs') : path.join(__dirname, '.build', 'togle.cjs')
for (const worker of ['parakeet-worker.js', 'whisper-worker.js']) fs.copyFileSync(path.join(root, 'out', 'main', worker), path.join(path.dirname(bundle), worker))
fs.cpSync(path.join(root, 'out', 'main', 'chunks'), path.join(path.dirname(bundle), 'chunks'), { recursive: true })
const T = require(bundle)
const { Segmenter } = require('./.build/capture.cjs')
const rate = 16000, frame = 512
function wav(name) {
  const data = fs.readFileSync(path.join(__dirname, 'audio', name + '.wav'))
  const at = data.indexOf('data')
  assert.ok(at >= 0, 'a PCM WAV fixture is required')
  const samples = data.readUInt32LE(at + 4) / 2
  const pcm = new Float32Array(samples + rate)
  for (let i = 0; i < samples; i++) pcm[i] = data.readInt16LE(at + 8 + i * 2) / 32768
  return pcm
}
run(async () => {
  await T.loadSettings()
  const lanes = Object.fromEntries(Object.keys(T.getSettings().claude.subscriptionLanes).map(lane => [lane, { model: 'haiku', effort: 'low' }]))
  await T.updateSettings({ provider: 'claude', assist: { auto: true }, transcription: { language: 'en' }, claude: { auth: 'subscription', subscriptionLanes: lanes } })
  const local = new T.SpeechInstaller(T.speechHome(), path.join(root, 'resources', 'whisper')).local()
  if (!local?.whisperModel) throw new Error('Install local speech before running this recorded-audio benchmark.')
  const whisper = new T.LocalWhisper(() => local)
  try {
    await within(120000, 'Starting local speech', whisper.start())
    await within(30000, 'Warming local speech', whisper.transcribe(wav('q4'), { language: 'en', stream: 'warm' }))
    let native
    if (opts.live) {
      const auth = new T.ClaudeCodeAuth()
      if (!(await auth.status(true)).signedIn) throw new Error('Sign in with Claude before using --live.')
      native = new T.ClaudeSubscriptionProvider(auth)
    }
    const store = new T.AgentStore(async () => { throw new Error('The benchmark never trains an agent.') })
    await store.load()
    const agent = await store.update(store.list()[0].id, { name: 'Demo assistant', instructions: 'Answer briefly using these demo facts. Acme Analytics: single sign-on is included in Growth. All customer data is stored in Frankfurt, Germany. The free trial lasts 14 days without a credit card.', vocabulary: 'Acme Analytics, Growth, SSO, Frankfurt' })
    const results = []
    let requests = 0
    for (const clip of ['q2', 'q3', 'q4']) {
      let deliveredAt, requestAt, firstAt, done = false, error, text = ''
      const heard = [], timings = []
      const provider = {
        id: native?.id ?? 'benchmark', supportsTools: !!native, listModels: async () => [],
        stream: async (input, handlers) => {
          if (++requests > 3) throw new Error('Three-request benchmark budget exceeded.')
          requestAt = Date.now()
          if (native) return native.stream(input, handlers)
          await sleep(400)
          handlers.signal.throwIfAborted()
          handlers.onDelta('LEVEL: quick\nConfirm the relevant detail with the caller.')
        }
      }
      const copilot = new T.Copilot((channel, event) => {
        if (channel === 'transcript') deliveredAt = Date.now()
        if (channel !== 'assist') return
        if (event.type === 'delta' && event.part === 'main') { firstAt ??= Date.now(); text += event.text }
        if (event.type === 'done' && event.part === 'main') done = true
        if (event.type === 'error') { error = event.message; done = true }
      }, () => provider, { snapshot: async () => { throw new Error('No screen capture in this benchmark.') }, dataUrl: async () => '', reset: async () => {} }, {
        active: () => agent, get: () => agent,
        knowledgeFor: (a, q, seen) => store.knowledgeFor(a, q, seen), search: (a, q, seen, n) => store.search(a, q, seen, n), facts: (a, q) => store.factsFor(a, q), code: () => undefined
      }, timing => timings.push(timing))
      const onSegment = T.hearing({ parakeet: () => null, whisper, language: () => 'en', vocabulary: () => store.vocabularyFor(agent), copilot, caption: () => {}, heard: timing => heard.push(timing) })
      const segmenter = new Segmenter((pcm, at, id, kind) => { void onSegment('them', pcm, at, id, kind) }, true)
      copilot.setListening(true)
      try {
        const pcm = wav(clip), started = performance.now()
        for (let at = 0; at + frame <= pcm.length; at += frame) {
          await sleep(Math.max(0, started + at / rate * 1000 - performance.now()))
          segmenter.push(pcm.slice(at, at + frame))
        }
        segmenter.flush()
        await within(65000, 'Waiting for a live answer', (async () => { while (!done) await sleep(20) })())
        if (error) throw new Error(error)
        assert.ok(text.trim(), 'each question must produce an answer')
        if (native) {
          const expected = { q2: [/single sign-on|SSO/i, /included/i], q3: [/Frankfurt/i], q4: [/14[ -]day|14 days/i] }
          for (const fact of expected[clip]) assert.match(text, fact, 'a faster answer must retain the supplied fact')
          assert.doesNotMatch(text, /\n\s*\**Facts:?\**\s*\n/i, 'quick replies must not repeat their content as a second facts section')
        }
        assert.ok(timings.length && heard.length, 'the real recognition and reply pipelines must complete')
        const timing = timings.at(-1)
        const result = { clip, recognitionMs: heard.at(-1).ms, transcriptToProviderMs: requestAt - deliveredAt, speechToAnswerMs: timing.shown, providerToAnswerMs: firstAt - requestAt, text: opts.live ? text : undefined }
        results.push(result)
        console.log(JSON.stringify(result))
      } finally { copilot.setListening(false); copilot.cancel(); onSegment.reset() }
    }
    const report = { at: new Date().toISOString(), mode: opts.live ? 'real Whisper + native Claude' : 'real Whisper + fixed 400ms model', speech: local.gpu ? 'Whisper GPU' : 'Whisper CPU', requests, medianTranscriptToProviderMs: median(results.map(r => r.transcriptToProviderMs)), medianSpeechToAnswerMs: median(results.map(r => r.speechToAnswerMs)), results }
    const label = opts.live ? 'live' : opts.baseline ? 'before' : 'after'
    fs.writeFileSync(path.join(work, label + '.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
  } finally { whisper.stop() }
})
