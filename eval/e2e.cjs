// End to end: a sales call spoken by Windows voices, played at real speed through Togle's voice detection (the
// renderer's Segmenter), speech recognition (Parakeet and Whisper, started as the app starts them), the main
// process's audio handling and the copilot, with the real models. Measures, for each question, from the moment
// its last word ends to the first words of the answer on screen.
//   npm run e2e                                   one session with your settings (5 requests of your plan)
//   npm run e2e -- --compare gpt-6-luna:low,gpt-6-luna:low:fast
//                                                 quick-answer settings A and B, sessions in the order A B B A
//                                                 so a backend getting faster or slower favours neither (20)
//   npm run e2e -- --dry                          a stand-in model that answers in 400 ms: the audio side, free
//   npm run e2e -- --questions 1                  only the call's first question
// A setting is model[:effort[:fast]]. Needs `npm run setup:whisper`; `npm run e2e` builds the app first.
const { app } = require('electron')
const { execFileSync } = require('node:child_process')
// Progress lines appear as they happen, even when the output goes to a pipe.
process.stdout._handle?.setBlocking?.(true)
const fs = require('node:fs')
const path = require('node:path')
const { median, options, run, signIn, sleep, useCopyOfTogleData, within } = require('./data.cjs')

const opts = options()
const DRY = opts.dry === true
// --questions 2: only the call's first questions.
const QUESTIONS_PLAYED = Number(opts.questions) || 5
const LABEL = typeof opts.label === 'string' ? opts.label : 'latest'
const ROOT = path.resolve(__dirname, '..')
const RATE = 16000
const FRAME = 512
const FRAME_MS = (FRAME / RATE) * 1000
const LEAD_IN_S = 3
// After each question, this long for the answer before I reply; then a breath before the next question.
const ANSWER_WINDOW_S = 5
const AFTER_REPLY_S = 1.5

useCopyOfTogleData()
// Speech recognition is found as the app finds it (the development copy under the app's folder), and the workers
// are forked from next to the main bundle: the repo, and the workers the app build made.
app.getAppPath = () => ROOT
for (const worker of ['parakeet-worker.js', 'whisper-worker.js']) fs.copyFileSync(path.join(ROOT, 'out/main', worker), path.join(__dirname, '.build', worker))
fs.cpSync(path.join(ROOT, 'out/main/chunks'), path.join(__dirname, '.build/chunks'), { recursive: true })

function readWav(file) {
  const buf = fs.readFileSync(file)
  const at = buf.indexOf('data')
  const pcm = new Float32Array(buf.readUInt32LE(at + 4) / 2)
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(at + 8 + i * 2) / 32768
  return pcm
}

/** Where the last word ends: the last sample loud enough to be speech. */
function voicedEnd(pcm) {
  for (let i = pcm.length - 1; i >= 0; i--) if (Math.abs(pcm[i]) > 0.02) return i + 1
  return pcm.length
}

/** Both sides of the call, with a faint line noise under everything, and when each question's last word ends. */
function buildCall() {
  const dir = path.join(__dirname, 'audio')
  if (!fs.existsSync(path.join(dir, 'r5.wav'))) {
    console.log('Speaking the call with Windows voices…')
    // No input for PowerShell: given one that never closes, it waits on it after the script.
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'voices.ps1')], {
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 120_000
    })
  }
  const clip = (name) => readWav(path.join(dir, `${name}.wav`))
  const parts = []
  const questionEnds = []
  let t = LEAD_IN_S * RATE
  for (let q = 1; q <= QUESTIONS_PLAYED; q++) {
    const question = clip(`q${q}`)
    parts.push(['them', question, t])
    questionEnds.push((t + voicedEnd(question)) / RATE)
    t += question.length + ANSWER_WINDOW_S * RATE
    const reply = clip(`r${q}`)
    parts.push(['me', reply, t])
    t += reply.length + AFTER_REPLY_S * RATE
  }
  const length = t + 3 * RATE
  let seed = 7
  const noise = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5) * 0.006
  const streams = { them: new Float32Array(length), me: new Float32Array(length) }
  for (const pcm of Object.values(streams)) for (let i = 0; i < length; i++) pcm[i] = noise()
  for (const [speaker, pcm, at] of parts) for (let i = 0; i < pcm.length; i++) streams[speaker][at + i] += pcm[i]
  return { streams, questionEnds }
}

/** The quick-answer settings to compare, in the order A B B A (or one session of what's set). */
function sessionPlan(current) {
  const configs = typeof opts.compare === 'string' ? opts.compare.split(',').map((s) => s.trim()) : [`${current.model}:${current.effort}`]
  const parsed = configs.map((s) => {
    const [model, effort = current.effort, tier] = s.split(':')
    return { label: s, model, effort, fast: tier === 'fast' }
  })
  return parsed.length === 1 ? parsed : [...parsed, ...[...parsed].reverse()]
}

run(async () => {
  const T = require('./.build/togle.cjs')
  const { Segmenter } = require('./.build/capture.cjs')
  const cases = require('./cases.cjs')
  await T.loadSettings()
  const { streams, questionEnds } = buildCall()

  // Speech recognition, started the way index.ts starts it.
  console.log('Starting speech recognition…')
  const local = new T.SpeechInstaller(T.speechHome(), path.join(ROOT, 'resources', 'whisper')).local()
  if (!local?.whisperModel) throw new Error('No speech recognition on this PC: install it in Settings → Speech recognition, or run npm run setup:whisper')
  const whisper = new T.LocalWhisper(() => local)
  void whisper.start()
  const parakeet = new T.LocalParakeet(local, () => {})
  parakeet.start()
  for (const started = Date.now(); !(parakeet.available && whisper.status().state === 'ready'); await sleep(250)) {
    if (Date.now() - started > 120_000) throw new Error(`Speech recognition didn't start: Parakeet ${parakeet.available}, Whisper ${JSON.stringify(whisper.status())}`)
  }
  // Warm both up, as a call's first seconds would.
  const warm = readWav(path.join(__dirname, 'audio', 'q4.wav'))
  await within(60_000, 'Warming up Parakeet', parakeet.transcribe(warm, { partial: false, stream: 'them' }))
  await within(60_000, 'Warming up Whisper', whisper.transcribe(warm, { language: 'en', prompt: '', partial: false, stream: 'them' }))

  const provider = DRY
    ? {
        id: 'dry',
        supportsTools: false,
        listModels: async () => [],
        async stream(input, { onDelta }) {
          await sleep(400)
          onDelta('LEVEL: quick\nA stand-in answer.')
        }
      }
    : new T.ChatGPTProvider(await signIn(T.readSecret))
  await provider.listModels()
  const store = new T.AgentStore(async () => {
    throw new Error('no studying during the test')
  })
  await store.load()
  const acme = await cases.acmeAgent(store)
  console.log(`Speech recognition ready (Parakeet on ${stt.gpu ? 'GPU' : 'CPU'}); the call is ${Math.round(streams.them.length / RATE)} s long`)

  // What happened when, for the timings: the measuring wraps the real code, it doesn't replace it.
  let log = []
  const note = (what, extra = {}) => log.push({ at: performance.now(), what, ...extra })
  const stream = provider.stream.bind(provider)
  provider.stream = (input, streamOptions) => {
    note('request', { lane: input.lane })
    let first = true
    return stream(input, {
      ...streamOptions,
      onDelta: (text) => {
        if (first && text) {
          first = false
          note('model text', { lane: input.lane })
        }
        streamOptions.onDelta(text)
      }
    })
  }
  if (!DRY) provider.onUsage = (u) => u.lane === 'quick' && u.hedged && note('second copy')

  const access = {
    active: () => store.list().find((a) => a.id === acme.id),
    get: (id) => store.list().find((a) => a.id === id),
    knowledgeFor: (a, q, seen) => store.knowledgeFor(a, q, seen),
    search: (a, q, seen, first) => store.search(a, q, seen, first),
    facts: (a, question) => store.factsFor(a, question),
    code: () => undefined
  }
  const frames = { snapshot: async () => Promise.reject(new Error('no screen')), dataUrl: async () => '', reset: async () => {} }
  const plan = sessionPlan(T.getSettings().chatgpt.lanes.quick)
  // The app's own timing log as well, to check it against what this test measures (npm run perf -- --file ...).
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true })
  const perfFile = path.join(__dirname, 'results', `e2e-${LABEL}-perf.jsonl`)
  fs.rmSync(perfFile, { force: true })
  const perf = new T.PerfLog(perfFile)
  const sessions = []
  for (const config of plan) {
    await T.updateSettings({ chatgpt: { lanes: { ...T.getSettings().chatgpt.lanes, quick: { model: config.model, effort: config.effort, fast: config.fast } } } })
    log = []
    const shown = new Map()
    const copilot = new T.Copilot(
      (channel, payload) => {
        if (channel !== 'assist') return
        if (payload.type === 'start') shown.set(payload.id, { text: '' })
        if (payload.type === 'error') note('error', { message: payload.message })
        if (payload.type === 'facts' || payload.type === 'match') {
          note('instant', { text: payload.type === 'match' ? `approved answer: ${payload.answer}` : payload.facts.map((f) => f.text).join(' | ') })
        }
        // An approved answer is words to say; asked just its question, it's the only answer.
        if (payload.type === 'match') {
          const job = shown.get(payload.id)
          if (job) job.matched = { at: performance.now(), text: `(approved) ${payload.answer}` }
        }
        if (payload.type === 'delta' && payload.part === 'main') {
          const job = shown.get(payload.id)
          if (job && !job.firstAt && payload.text) job.firstAt = performance.now()
          if (job) job.text += payload.text
        }
      },
      () => provider,
      frames,
      access,
      (timing) => perf.answer(timing)
    )
    copilot.setListening(true)
    const onSegment = T.hearing({
      parakeet: () => parakeet,
      whisper,
      language: () => T.getSettings().transcription.language,
      vocabulary: () => store.vocabularyFor(acme),
      copilot: {
        anticipate: (text, at, id) => {
          note('anticipate', { text })
          copilot.anticipate(text, at, id)
        },
        dropAnticipated: (id) => copilot.dropAnticipated(id),
        talkedOn: (id, heard) => copilot.talkedOn(id, heard),
        add: (speaker, text, ...rest) => {
          note('transcript', { speaker, text })
          copilot.add(speaker, text, ...rest)
        }
      },
      caption: () => {},
      heard: (timing) => perf.heard(timing)
    })
    const segmenters = Object.fromEntries(
      ['them', 'me'].map((speaker) => [
        speaker,
        new Segmenter((pcm, at, id, kind) => {
          if (kind !== 'partial') note(kind, { speaker })
          void onSegment(speaker, pcm, at, id, kind)
        }, speaker === 'them')
      ])
    )

    // Real time: each 32 ms frame goes in when its moment comes, as the audio worklet delivers them.
    const total = Math.floor(streams.them.length / FRAME)
    const start = performance.now()
    await new Promise((resolve) => {
      let next = 0
      const tick = () => {
        const due = Math.min(total, Math.floor((performance.now() - start) / FRAME_MS))
        for (; next < due; next++) {
          for (const speaker of ['them', 'me']) segmenters[speaker].push(streams[speaker].slice(next * FRAME, (next + 1) * FRAME))
        }
        if (next >= total) resolve()
        else setTimeout(tick, 4)
      }
      tick()
    })
    await sleep(4000)
    copilot.setListening(false)

    // Each question's timeline, from the moment its last word ended.
    const ends = questionEnds.map((s) => start + s * 1000)
    // A card with only its approved answer had those words on screen when the answer showed.
    for (const j of shown.values()) if (!j.firstAt && j.matched) Object.assign(j, { firstAt: j.matched.at, text: j.matched.text })
    const rows = ends.map((end, q) => {
      const until = ends[q + 1] ?? Infinity
      const during = log.filter((e) => e.at > end && e.at < until)
      const after = (what, test = () => true) => {
        const e = during.find((x) => x.what === what && test(x))
        return e ? Math.round(e.at - end) : null
      }
      const them = (e) => e.speaker === 'them'
      const job = [...shown.values()].find((j) => j.firstAt > end && j.firstAt < until)
      return {
        q: q + 1,
        pause: after('pause', them),
        startedAtPause: after('anticipate'),
        request: after('request', (e) => e.lane === 'quick'),
        endOfSpeech: after('final', them),
        transcript: after('transcript', them),
        heard: during.find((e) => e.what === 'transcript' && them(e))?.text ?? null,
        modelText: after('model text', (e) => e.lane === 'quick'),
        shown: job ? Math.round(job.firstAt - end) : null,
        instant: after('instant'),
        instantText: during.find((e) => e.what === 'instant')?.text ?? null,
        errors: during.filter((e) => e.what === 'error').map((e) => e.message),
        secondCopy: during.some((e) => e.what === 'second copy'),
        answer: job?.text.trim() ?? null
      }
    })
    sessions.push({ config: config.label, rows })
    console.log(`\nSESSION ${config.label}`)
    for (const r of rows) {
      const step = (ms) => (ms === null ? '-' : `+${ms}`)
      console.log(
        `  Q${r.q}: words on screen ${step(r.shown)} ms | pause ${step(r.pause)}, request ${step(r.request)}, end of speech ${step(r.endOfSpeech)}, ` +
          `transcript ${step(r.transcript)}, model's first text ${step(r.modelText)}${r.secondCopy ? ' (a second copy was sent)' : ''}` +
          `${r.errors.length ? ` | ERROR ${r.errors.join(' / ')}` : ''}`
      )
      console.log(`      heard "${r.heard}" -> ${(r.answer ?? '(no answer shown)').split('\n')[0].slice(0, 110)}`)
      if (r.instantText) console.log(`      at once (${step(r.instant)} ms): ${r.instantText.slice(0, 120)}`)
    }
    await sleep(3000)
  }

  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'results', `e2e-${LABEL}.json`), JSON.stringify(sessions, null, 2))
  console.log('')
  for (const label of [...new Set(sessions.map((s) => s.config))]) {
    const rows = sessions.filter((s) => s.config === label).flatMap((s) => s.rows)
    const shown = rows.map((r) => r.shown).filter((x) => x !== null)
    const model = rows.filter((r) => r.modelText !== null && r.request !== null).map((r) => r.modelText - r.request)
    console.log(
      `${label}: words on screen ${median(shown)} ms after the last word (median of ${shown.length}, ${Math.min(...shown)}-${Math.max(...shown)}); ` +
        `the model took ${median(model)} ms to its first text; ${rows.length - shown.length} answer(s) missing`
    )
  }
  console.log(`-> eval/results/e2e-${LABEL}.json`)
  parakeet.stop()
  whisper.stop()
})
