// Explicit live check: known fixture audio -> Claude speech service -> Claude subscription cleanup.
// No real microphone, documents, apps, call history or destination text box is accessed.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { readWave } = require('sherpa-onnx-node')
const root = path.resolve(__dirname, '..'), directory = path.join(__dirname, '.work/dictation-live')
fs.mkdirSync(directory, { recursive: true })
app.setPath('userData', path.join(directory, 'profile'))
app.getAppPath = () => root
const timeout = setTimeout(() => { console.error('Dictation live check timed out'); app.exit(1) }, 55_000)
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.updateSettings({ provider: 'claude', claude: { auth: 'subscription' }, transcription: { language: 'en' }, dictation: { speech: 'auto', polish: true } })
  const auth = new T.ClaudeCodeAuth(), claude = new T.ClaudeSubscriptionProvider(auth)
  const account = await auth.status(); assert.ok(account.signedIn, 'Sign in to Claude before running the live check')
  const cloud = new T.ClaudeSpeech(new T.ClaudeSpeechAccess(auth, () => claude.listModels()))
  const speech = new T.DictationSpeech({ settings: T.getSettings, claude,
    chatgpt: { stream: async () => { throw Error('Must not call another provider') } },
    chatgptAccount: () => ({ signedIn: false }), claudeAccount: () => auth.status(),
    localReady: () => false,
    local: async () => { throw Error('Claude dictation must not use local transcription') },
    remote: async () => { throw Error('Claude dictation must not use ChatGPT transcription') },
    claudeSpeech: (language, email, signal) => cloud.prepare(language, email, signal)
  })
  await speech.ready()
  const wave = readWave(path.join(root, 'eval/audio/q2.wav'), false); assert.equal(wave.sampleRate, 16000)
  const signal = AbortSignal.timeout(40_000), start = performance.now()
  const raw = await speech.transcribe(wave.samples, signal), recognized = performance.now()
  const cleaned = await speech.polish(raw, signal), end = performance.now()
  assert.match(raw, /single sign.?on/i)
  assert.match(cleaned, /single sign.?on/i); assert.match(cleaned, /included.*plan/i); assert.match(cleaned, /\?$/)
  assert.ok(cleaned.length < 160, 'A dictated question must remain a question, not an AI answer')
  const repeated = new Float32Array(wave.samples.length * 2 + 16000)
  repeated.set(wave.samples); repeated.set(wave.samples, wave.samples.length + 16000)
  const repeatedText = await speech.transcribe(repeated, signal)
  assert.equal((repeatedText.match(/single sign.?on/gi) || []).length, 2, 'Later utterances and intentional repetitions must both survive')
  const quiet = await speech.transcribe(new Float32Array(8000), signal)
  assert.equal(quiet, '', 'Silence must not invent words')
  const cancelled = new AbortController(); cancelled.abort(new Error('Cancelled'))
  await assert.rejects(speech.transcribe(wave.samples, cancelled.signal), /Cancelled/)
  const report = { checkedAt: new Date().toISOString(), fixture: 'q2.wav', raw, cleaned, repeatedText, silence: quiet, speechMs: Math.round(recognized - start), cleanupMs: Math.round(end - recognized), transcription: 'Claude account speech service', cleanup: 'Claude subscription', localRecognizerUsed: false, chatgptUsed: false }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
}).then(() => { clearTimeout(timeout); app.exit(0) }, error => { console.error(error); clearTimeout(timeout); app.exit(1) })
