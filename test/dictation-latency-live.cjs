// Dictation cleanup timing with known text. Uses the signed-in Claude subscription,
// but never opens a microphone or writes into an actual application.
const { app } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const root = path.resolve(__dirname, '..'), directory = path.join(__dirname, '.work/dictation-latency')
fs.mkdirSync(directory, { recursive: true }); app.setPath('userData', path.join(directory, 'profile')); app.getAppPath = () => root
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Dictation latency check timed out'); app.exit(1) }, 120_000)
let speechCleanup
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.updateSettings({ provider: 'claude', claude: { auth: 'subscription' }, dictation: { speech: 'auto', polish: true } })
  const auth = new T.ClaudeCodeAuth(), claude = new T.ClaudeSubscriptionProvider(auth)
  assert.ok((await auth.status()).signedIn, 'Sign in to Claude before running the live check')
  // Cleanup timing, cold and prepared: this PC hears the words, so only the account's cleanup goes over the network.
  const results = []
  for (const warm of [false, true, true]) {
    const provider = warm ? claude : { stream: claude.stream.bind(claude) }
    const speech = speechCleanup = new T.DictationSpeech({ settings: T.getSettings, claude: provider,
      claudeAccount: () => auth.status(), remote: async () => '' })
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
  console.log('DICTATION CLEANUP LATENCY PASS: the same known text, cold and prepared, through the signed-in Claude subscription')
}).then(() => { clearTimeout(timeout); app.exit(0) }, error => { console.error(error); speechCleanup?.dispose(); clearTimeout(timeout); app.exit(1) })
