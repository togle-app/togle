// Speech recognition under noise: each question of the end-to-end call (Windows voices, so the exact words are
// known) through Togle's recognition, Parakeet first and Whisper for unclear speech (the hearing module), with
// background chatter and line hiss mixed in at falling signal-to-noise ratios. Prints the word error rate
// and how long each transcript took. Runs on this PC only: no requests to your plan.
//   npm run speech
// A speech API that Settings can pick for a side is scored beside them with `--server http://localhost:8000/v1` (and
// `--model`, for a server with several), or `--openai` with OPENAI_API_KEY set (gpt-transcribe unless `--model` says;
// billed by OpenAI, about a cent a run). A ChatGPT account has no speech recognition of its own (Sign in with ChatGPT
// doesn't include transcription): what this PC hears is what it gets.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { median, options, run, sleep, useCopyOfTogleData, within } = require('./data.cjs')
process.stdout._handle?.setBlocking?.(true)

const ROOT = path.resolve(__dirname, '..')
const RATE = 16000
// What the voices say (voices.ps1), the caller's questions.
const SPOKEN = {
  q1: "Thanks for the demo, it looks really good. We'd be about forty users. What would the Growth plan cost us per month?",
  q2: 'Okay. And is single sign-on included in that plan?',
  q3: 'Our security team will ask this first. Where would our data be stored?',
  q4: 'Good. Can we try it before we buy?',
  q5: 'One more thing. Does it work with SAP?'
}
const OPTS = options()
// `--set <folder>`: recordings of real people instead (clips.json: each one's file and the words said, as a set of
// public test recordings has them), scored the same way; `--levels clean,10` picks the noise levels.
const SET = typeof OPTS.set === 'string' ? JSON.parse(fs.readFileSync(path.join(OPTS.set, 'clips.json'), 'utf8')) : null
const LEVELS = typeof OPTS.levels === 'string' ? OPTS.levels.split(',').map((l) => (l === 'clean' ? null : Number(l))) : [null, 20, 10, 5]
// The agent's words to spell right, as the call's agent would give them (none for recordings of anything else).
const VOCABULARY = SET ? '' : 'Acme Analytics, Growth, Nordlink, SAP, SSO'

useCopyOfTogleData()
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

const rms = (pcm) => Math.sqrt(pcm.reduce((s, x) => s + x * x, 0) / pcm.length)

/** Chatter (other voices, reversed so no words come through) and hiss, scaled to `snr` dB below the speech. */
function noisy(speech, others, snr, seed) {
  if (snr === null) return speech
  const chatter = new Float32Array(speech.length)
  others.forEach((clip, k) => {
    for (let i = 0; i < speech.length; i++) chatter[i] += clip[clip.length - 1 - ((i + k * 7919) % clip.length)]
  })
  let x = seed
  const hiss = () => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5)
  for (let i = 0; i < speech.length; i++) chatter[i] += 0.15 * hiss()
  const gain = rms(speech) / rms(chatter) / Math.pow(10, snr / 20)
  return speech.map((s, i) => s + chatter[i] * gain)
}

// Numbers as the test recordings' transcripts write them (in words), whichever way a recognizer writes them.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']
const spelled = (n) => (n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`)

const words = (text) =>
  text
    .toLowerCase()
    .replace(/\b\d{1,2}\b/g, (n) => spelled(Number(n)))
    .replace(/\bmr\b\.?/g, 'mister')
    .replace(/\bmrs\b\.?/g, 'missus')
    .replace(/\bdr\b\.?/g, 'doctor')
    .replace(/sign-on/g, 'sign on')
    .replace(/[-–—]/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, ' ')
    .split(/\s+/)
    .filter(Boolean)

/** Word error rate: edits (substitutions, insertions, deletions) per spoken word. */
function wer(spoken, heard) {
  const a = words(spoken)
  const b = words(heard)
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length] / a.length
}

run(async () => {
  const T = require('./.build/togle.cjs')
  await T.loadSettings()
  const dir = SET ? String(OPTS.set) : path.join(__dirname, 'audio')
  const calls = path.join(__dirname, 'audio')
  if (!fs.existsSync(path.join(calls, 'r5.wav'))) throw new Error('No call audio yet: run npm run e2e -- --dry once (it speaks it).')
  // What's said, and in which file: the call's questions, or the set's recordings.
  const spoken = SET ? SET.map((c) => ({ name: c.name, file: c.file, text: c.text, set: c.set })) : Object.entries(SPOKEN).map(([name, text]) => ({ name, file: `${name}.wav`, text }))
  // What the app runs: what Settings installed, else the development copy. `--whisper-library` runs Whisper through
  // its library (whisper-worker.ts) instead of whisper-server, as on macOS, whose release has no server.
  const local = new T.SpeechInstaller(T.speechHome(), path.join(ROOT, 'resources', 'whisper')).local()
  if (!local?.whisperModel) throw new Error('No speech recognition on this PC: install it in Settings → Speech recognition, or run npm run setup:whisper')
  const lib = process.platform === 'win32' ? 'whisper.dll' : 'libwhisper.so'
  const whisperLocal = OPTS['whisper-library'] && local.server ? { ...local, server: null, library: path.join(local.binDir, lib) } : local
  const whisper = new T.LocalWhisper(() => whisperLocal)
  void whisper.start()
  const parakeet = new T.LocalParakeet(local, () => {})
  parakeet.start()
  for (const started = Date.now(); !(parakeet.available && whisper.status().state === 'ready'); await sleep(250)) {
    if (Date.now() - started > 120_000) throw new Error("Speech recognition didn't start")
  }
  // The chatter under a line: other voices, played backwards (the set's own people, for its recordings).
  const chatterOf = (name) =>
    SET
      ? spoken
          .filter((c) => c.name !== name)
          .slice(0, 3)
          .map((c) => readWav(path.join(dir, c.file)))
      : ['r1', 'r2', 'r3'].map((n) => readWav(path.join(calls, `${n}.wav`)))
  const warm = readWav(path.join(calls, 'q4.wav'))
  await within(60_000, 'Warming up Parakeet', parakeet.transcribe(warm, { partial: false, stream: 'them' }))
  await within(60_000, 'Warming up Whisper', whisper.transcribe(warm, { language: 'en', prompt: '', partial: false, stream: 'them' }))
  let speechApi = null
  if (OPTS.chatgpt) throw new Error("A ChatGPT account has no speech recognition of its own: Sign in with ChatGPT doesn't include transcription.")
  if (OPTS.server || OPTS.openai) {
    const baseUrl = OPTS.openai ? T.OPENAI_URL : String(OPTS.server)
    const model = typeof OPTS.model === 'string' ? OPTS.model : OPTS.openai ? T.OPENAI_MODEL : ''
    speechApi = new T.SpeechApi(OPTS.openai ? 'openai' : 'server', 'eval-speech-key.bin', () => ({ baseUrl, model }))
    if (OPTS.openai) {
      if (!process.env.OPENAI_API_KEY) throw new Error('--openai needs OPENAI_API_KEY set.')
      // Kept in the copy of Togle's data, which is deleted after the run.
      await speechApi.setKey(process.env.OPENAI_API_KEY)
    }
    await within(60_000, `Warming up ${speechApi.label()}`, speechApi.transcribe(warm, { language: 'en', vocabulary: '' }))
  }

  let heard = null
  let byWhisper = false
  // Counts every utterance Whisper hears: when Parakeet is unsure, and on a noisy line.
  const counted = { transcribe: (...args) => ((byWhisper = true), whisper.transcribe(...args)) }
  const onSegment = T.hearing({
    parakeet: () => parakeet,
    whisper: counted,
    language: () => 'en',
    vocabulary: async () => VOCABULARY,
    copilot: { anticipate: () => {}, dropAnticipated: () => {}, talkedOn: () => {}, add: (_speaker, text) => (heard = text) },
    caption: () => {}
  })

  const rows = []
  const clips = []
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
  // Of all the words said, the share heard wrong (edits over words), and the slowest in ten (90th percentile).
  const errorRate = (list, who) => list.reduce((n, c) => n + c[who].wer * c.words, 0) / list.reduce((n, c) => n + c.words, 0)
  const p90 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]
  const seedOf = (name) => [...name].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 7)
  for (const snr of LEVELS) {
    const level = []
    for (const clip of spoken) {
      const pcm = noisy(readWav(path.join(dir, clip.file)), chatterOf(clip.name), snr, seedOf(clip.name))
      const row = { set: clip.set, name: clip.name, snr, words: words(clip.text).length, said: clip.text }
      heard = null
      byWhisper = false
      let t = performance.now()
      await within(60_000, `Transcribing ${clip.name}`, onSegment('them', pcm, Date.now(), `${clip.name}-${snr}`, 'final'))
      row.togle = { wer: wer(clip.text, heard ?? ''), ms: performance.now() - t, heard: heard ?? '', byWhisper }
      // For comparison: Whisper alone, with the agent's words, on every utterance.
      t = performance.now()
      const alone = await within(60_000, `Whisper on ${clip.name}`, whisper.transcribe(pcm, { language: 'en', prompt: VOCABULARY, partial: false, stream: 'them' }))
      row.whisper = { wer: wer(clip.text, alone.text), ms: performance.now() - t, heard: alone.text.trim() }
      if (speechApi) {
        t = performance.now()
        const byApi = await within(60_000, `${speechApi.label()} on ${clip.name}`, speechApi.transcribe(pcm, { language: 'en', vocabulary: VOCABULARY }))
        row.api = { wer: wer(clip.text, byApi), ms: performance.now() - t, heard: byApi }
      }
      level.push(row)
      clips.push(row)
    }
    const label = snr === null ? 'clean' : `${snr} dB`
    // By set (a set of recordings has an easier and a harder part), then all of them.
    const parts = SET ? [...new Set(level.map((c) => c.set)), 'all'] : ['all']
    for (const part of parts) {
      const list = part === 'all' ? level : level.filter((c) => c.set === part)
      const whispered = list.filter((c) => c.togle.byWhisper).length
      const api = speechApi ? { api: speechApi.label(), apiWer: errorRate(list, 'api'), apiMs: median(list.map((c) => c.api.ms)), apiP90: p90(list.map((c) => c.api.ms)) } : {}
      const row = {
        snr,
        part,
        clips: list.length,
        words: list.reduce((n, c) => n + c.words, 0),
        wer: errorRate(list, 'togle'),
        ms: median(list.map((c) => c.togle.ms)),
        p90: p90(list.map((c) => c.togle.ms)),
        whispered,
        whisperWer: errorRate(list, 'whisper'),
        whisperMs: median(list.map((c) => c.whisper.ms)),
        ...api
      }
      rows.push(row)
      console.log(
        `${label.padEnd(6)} ${part.padEnd(5)} ${String(row.words).padStart(3)} words | this PC ${(100 * row.wer).toFixed(1)}% in ${Math.round(row.ms)} ms (p90 ${Math.round(row.p90)}; Whisper took ${whispered} of ${list.length}) | ` +
          `Whisper alone ${(100 * row.whisperWer).toFixed(1)}% in ${Math.round(row.whisperMs)} ms` +
          (speechApi ? ` | ${speechApi.label()} ${(100 * api.apiWer).toFixed(1)}% in ${Math.round(api.apiMs)} ms (p90 ${Math.round(api.apiP90)})` : '')
      )
    }
  }
  // Where they differ most: what was said, and what each heard.
  if (speechApi) {
    const apart = clips.filter((c) => c.togle.wer !== c.api.wer).sort((a, b) => Math.abs(b.togle.wer - b.api.wer) - Math.abs(a.togle.wer - a.api.wer))
    for (const c of apart.slice(0, 6)) {
      console.log(`  ${c.snr === null ? 'clean' : `${c.snr} dB`} ${c.name} said: "${c.said.toLowerCase()}"`)
      console.log(`    this PC (${(100 * c.togle.wer).toFixed(0)}%): "${c.togle.heard}"`)
      console.log(`    ${speechApi.label()} (${(100 * c.api.wer).toFixed(0)}%): "${c.api.heard}"`)
    }
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'results', SET ? 'speech-set.json' : 'speech.json'), JSON.stringify({ rows, clips }, null, 2))
  parakeet.stop()
  whisper.stop()
})
