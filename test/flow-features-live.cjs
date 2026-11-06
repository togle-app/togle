// Explicit opt-in integration check. Uses the signed-in Claude subscription with
// fictional text only. No microphone, real meeting archive or target application.
const { app } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const directory = path.join(__dirname, '.work', 'flow-features-live-' + process.pid)
fs.mkdirSync(directory, { recursive: true }); app.setPath('userData', directory); app.getAppPath = () => root
const timeout = setTimeout(() => { console.error('Live feature checks timed out'); app.exit(1) }, 120000)
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.updateSettings({ provider: 'claude', claude: { auth: 'subscription' }, dictation: { speech: 'claude', polish: true } })
  const auth = new T.ClaudeCodeAuth(), provider = new T.ClaudeSubscriptionProvider(auth)
  assert.ok((await auth.status()).signedIn, 'A Claude subscription sign-in is required for this opt-in check')
  const vocabulary = { words: [{ id: 'word', word: 'Togle', heardAs: 'toggle' }], snippets: [{ id: 'email', phrase: 'my demo email', text: 'luka@example.test' }] }
  const speech = new T.DictationSpeech({ settings: T.getSettings, vocabulary: Promise.resolve(vocabulary), claude: provider, chatgpt: provider,
    claudeAccount: () => auth.status(), chatgptAccount: () => ({ signedIn: false }), claudeSpeech: async () => async () => '', remote: async () => '' })
  const controller = new AbortController()
  let dictation
  try {
    await speech.ready(controller.signal)
    // Match the normal runtime warmup while a user speaks, without opening an audio device.
    await new Promise(resolve => setTimeout(resolve, 3000))
    dictation = await speech.polish('um send the toggle update to my demo email tomorrow', controller.signal)
    assert.match(dictation, /Togle/); assert.match(dictation, /luka@example\.test/); assert.match(dictation, /tomorrow/i)
    assert.ok(!dictation.includes('TOGLE_SNIPPET_'))
  } finally { speech.dispose(); controller.abort() }
  console.log('PASS live Claude cleanup: custom spelling, filler cleanup and exact shortcut insertion')
  const store = new T.AgentStore(async () => ''); await store.load(); const agent = store.list()[0]
  const startedAt = Date.UTC(2026, 10, 2, 10)
  const call = { id: 'fictional-team-sync', title: 'Fictional team sync', status: 'ended', startedAt, summary: '', brief: '', transcript: [
    { id: 'one', speaker: 'me', voiceName: 'Luka', voiceNamedBy: 'user', at: startedAt + 60000, text: 'We agreed to postpone the launch. No new date yet.' },
    { id: 'two', speaker: 'them', voiceName: 'Denis', voiceNamedBy: 'user', at: startedAt + 240000, text: 'I will send the incident report by Friday.' },
    { id: 'three', speaker: 'them', at: startedAt + 360000, text: 'Someone should review the billing flow, but no owner has been assigned.' }
  ] }
  let answer = '', reads = 0
  await T.train(store, provider, agent.id, [], 'Summarize the decisions and action items. Distinguish proposals, identify owners and deadlines only where stated, and cite timestamps.', AbortSignal.timeout(90000), {
    selectedCall: { id: call.id, title: call.title }, onDelta: part => { answer += part }, onChange: () => { throw Error('Read-only question attempted a mutation') },
    savedCall: async (id, query, fromLine) => { assert.equal(id, call.id); reads++; return T.savedCallContext(call, query, fromLine) },
    pastCalls: async () => JSON.stringify({ results: [{ id: call.id, title: call.title }] })
  })
  assert.ok(reads > 0); assert.match(answer, /Denis/); assert.match(answer, /Friday/i); assert.match(answer, /(?:4:00|04:00)/)
  assert.match(answer, /postpon/i); assert.match(answer, /(?:unassigned|not assigned|no owner|owner[^\n]{0,40}(?:none|unknown)|no one)/i)
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ fixtureOnly: true, dictation, answer, reads }, null, 2))
  console.log('PASS live Claude meeting Q&A: reads the selected transcript, cites evidence, and leaves an unstated owner unassigned')
  console.log('Fixture result: ' + path.join(directory, 'result.json'))
  clearTimeout(timeout); app.quit()
}).catch(error => { console.error(error.message); clearTimeout(timeout); app.exit(1) })
