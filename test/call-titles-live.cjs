// Opt-in Claude subscription check with fictional meetings, no real calendar/archive or microphone.
const { app } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const directory = path.join(__dirname, '.work', 'call-titles-live-' + process.pid)
fs.mkdirSync(directory, { recursive: true }); app.setPath('userData', directory); app.getAppPath = () => path.resolve(__dirname, '..')
const timeout = setTimeout(() => { console.error('Meeting naming check timed out'); app.exit(1) }, 100000)
let titles
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.updateSettings({ provider: 'claude', claude: { auth: 'subscription' } })
  const auth = new T.ClaudeCodeAuth(), provider = new T.ClaudeSubscriptionProvider(auth)
  assert.ok((await auth.status()).signedIn, 'Connect a Claude subscription before running this opt-in check.')
  const sessions = new T.CallSessions(); titles = new T.CallTitles(sessions, () => provider)
  const cases = [
    { id: 'daily', lines: ['Hi guys.', 'Let us start our daily stand-up. What did you finish yesterday, what are you doing today, and any blockers?', 'Yesterday I fixed the checkout validation. Today I will run QA. I am waiting for the staging environment.'], expected: /daily|stand.?up/iu },
    { id: 'webhooks', lines: ['All right.', 'Today we are reviewing the webhook consumer design, especially idempotency.', 'Duplicate deliveries must use the same event ID. We will store processed IDs and avoid charging a customer twice.'], expected: /webhook|idempoten/iu },
    { id: 'french', lines: ['Bonjour à tous.', 'Commençons notre point quotidien. Qu’avez-vous terminé hier et quels sont les blocages ?', 'Hier, nous avons corrigé la connexion. Aujourd’hui, nous préparons les tests. Aucun blocage.'], expected: /quotidien/iu }
  ]
  const results = []
  for (const fixture of cases) {
    const transcript = fixture.lines.map((text, n) => ({ id: String(n), speaker: n === 2 ? 'me' : 'them', text, at: 1000 + n * 2000, end: 2000 + n * 2000 }))
    await sessions.capture({ id: fixture.id, agentId: 'fictional-team', agentName: 'Fictional team', startedAt: 1000, endedAt: 10000, status: 'ended' }, 'fixture-frames', { transcript, frames: [], notes: '', notesUntil: 0, answeredUntil: 0, callAnswers: [], brief: '', group: true })
    const started = performance.now(), record = await titles.generate(fixture.id)
    assert.equal(record.titleSource, 'generated'); assert.match(record.title, fixture.expected)
    results.push({ id: fixture.id, title: record.title, ms: Math.round(performance.now() - started) })
  }
  fs.writeFileSync(path.join(__dirname, '.work', 'call-titles-live.json'), JSON.stringify(results, null, 2))
  console.log('LIVE CALL TITLES PASS: ' + JSON.stringify(results))
}).then(async () => { await titles?.stop(); clearTimeout(timeout); app.exit(0) }, async error => { console.error(error.stack); await titles?.stop(); clearTimeout(timeout); app.exit(1) })
