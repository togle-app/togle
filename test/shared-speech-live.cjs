// Known synthetic audio through both production subscription adapters. No device capture,
// target textbox, meeting history or user-setting writes. Credentials stay with their auth owners.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const { readWave } = require('sherpa-onnx-node')
const root = path.resolve(__dirname, '..'), directory = path.join(__dirname, '.work/shared-speech-live')
fs.mkdirSync(directory, { recursive: true })
app.setPath('userData', path.join(app.getPath('appData'), 'Togle'))
// safeStorage must use the same session key context as the installed app.
app.setPath('sessionData', app.getPath('userData'))
app.getAppPath = () => root
const timeout = setTimeout(() => { console.error('Shared speech live check timed out'); app.exit(1) }, 100_000)
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.loadSettings()
  const chatgpt = new T.ChatGPTAuth(); await chatgpt.load()
  const claude = new T.ClaudeCodeAuth()
  const accounts = new T.SubscriptionAccounts(chatgpt, new T.ChatGPTProvider(chatgpt), claude, new T.ClaudeSubscriptionProvider(claude))
  await accounts.load()
  const profiles = await accounts.list()
  const wave = readWave(path.join(root, 'eval/audio/q2.wav'), false)
  assert.equal(wave.sampleRate, 16000)
  const results = []
  for (const provider of ['chatgpt', 'claude']) {
    const profile = profiles.find(item => item.provider === provider && item.signedIn && item.id === T.getSettings().transcription.accountId)
      || profiles.find(item => item.provider === provider && item.signedIn)
    if (!profile) { results.push({ provider, status: 'not-run', reason: 'No signed-in account' }); continue }
    const entry = accounts.get(profile.id), startedAt = performance.now()
    const language = provider === 'claude' ? 'en' : 'auto'
    const api = T.subscriptionRecognizer(entry, () => new T.ClaudeSpeech(new T.ClaudeSpeechAccess(entry.auth, () => entry.provider.listModels())), entry.auth.identity(), () => language)
    try {
      const text = await api.transcribe(wave.samples, { language, vocabulary: '', signal: AbortSignal.timeout(35_000) })
      assert.match(text, /single sign.?on/i); assert.match(text, /included.*plan/i)
      results.push({ provider, status: 'passed', fixture: 'q2.wav', language, text, elapsedMs: Math.round(performance.now() - startedAt) })
    } catch (error) {
      results.push({ provider, status: 'failed', reason: error.message.replace(/[\w.+-]+@[\w.-]+/g, '[account]'), elapsedMs: Math.round(performance.now() - startedAt) })
    } finally { api.reset() }
  }
  accounts.close()
  const report = { checkedAt: new Date().toISOString(), fixtureOnly: true, results }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (results.some(result => result.status !== 'passed')) throw new Error('Both subscriptions must pass before this live check is complete.')
}).then(() => { clearTimeout(timeout); app.exit(0) }, error => { console.error(error.message); clearTimeout(timeout); app.exit(1) })
