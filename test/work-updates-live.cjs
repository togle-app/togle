// Explicit live subscription evaluation. Fictional work tools only: no real Jira/Slack reads or writes,
// microphone, text insertion or changes to settings, agents and meeting records.
const { app } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), directory = path.join(__dirname, '.work/work-updates-live')
fs.mkdirSync(directory, { recursive: true })
const profile = path.join(app.getPath('appData'), 'togle')
app.setPath('userData', profile); app.setPath('sessionData', path.join(directory, 'session'))
app.getAppPath = () => root
const watchdog = setTimeout(() => { console.error('Work-update evaluation timed out'); app.exit(1) }, 150000)
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.loadSettings()
  const settings = T.getSettings()
  const auth = new T.ChatGPTAuth(); await auth.load()
  const claude = new T.ClaudeCodeAuth()
  const accounts = new T.SubscriptionAccounts(auth, new T.ChatGPTProvider(auth), claude, new T.ClaudeSubscriptionProvider(claude))
  await accounts.load()
  const connected = await accounts.list()
  let selected
  try { selected = JSON.parse(fs.readFileSync(path.join(profile, 'agents', settings.activeAgentId + '.json'), 'utf8')) } catch {}
  const task = selected?.preferences?.ai?.tasks?.quick || settings.ai?.tasks?.quick
  const accountId = task?.sourceId || selected?.subscriptionAccountId || settings.subscriptionAccountId
  const account = connected.find(item => item.id === accountId && item.signedIn)
  assert.ok(account, 'Connect the selected quick-answer subscription before running the live evaluation.')
  const provider = accounts.pinned(account.id, false)
  const now = new Date('2026-11-03T10:00:00+01:00').getTime()
  const agent = { id: 'fixture', name: 'Fictional team', description: '', instructions: '', aboutMe: '', memory: [], factSources: {}, knowledge: [], answers: [], skills: [], model: '', vocabulary: '', codeFolders: [], workHomes: [], learning: 'ask', history: [], createdAt: now, updatedAt: now }
  const results = []
  for (const missing of [false, true]) {
    let reads = 0, text = '', final
    const prompt = T.buildPrompt({ agent, knowledge: { passages: [], documents: [], searchable: false }, canSearch: false,
      request: { kind: 'suggest', auto: true }, part: 'main', question: 'Luka, hello. Let us synchronize. How your yesterday day passed?', transcript: [], frames: [], attached: new Set(), ownName: 'Luka', now })
    const started = performance.now()
    await provider.stream({ ...prompt, lane: 'quick', ...(task ? { model: task.model, effort: task.effort } : {}), maxToolRounds: 4,
      tools: [{ name: 'read_work_updates', description: 'Read verified Jira work activity for the signed-in user Luka for yesterday and today, including owners, status, evidence dates and blockers. Use before answering a daily update.', parameters: { type: 'object', properties: {}, additionalProperties: false }, run: async () => {
        reads++
        return JSON.stringify(missing ? { user: 'Luka', date: '2026-11-02', result: 'No verified activity, blockers or plan are available. Do not invent them.' } : { user: 'Luka', evidenceDate: '2026-11-02', tasks: [
          { id: 'TC-152', title: 'Goodwill credits', owner: 'Luka', status: 'QA completed on November 2', source: 'https://jira.example.test/browse/TC-152' },
          { id: 'TC-171', title: 'Safari login fix', owner: 'Luka', status: 'Blocked: waiting for QA environment', source: 'https://jira.example.test/browse/TC-171' },
          { id: 'TC-188', title: 'Database migration', owner: 'Denis', status: 'In progress' }
        ], todayPlan: null })
      } }]
    }, { signal: AbortSignal.timeout(65000), onDelta: part => { text += part }, onFinal: value => { final = value } })
    text = final || text
    fs.writeFileSync(path.join(directory, missing ? 'missing-evidence.json' : 'verified-work.json'), JSON.stringify({ fixtureOnly: true, reads, text }, null, 2))
    assert.ok(reads > 0, 'The model must check the work tool rather than fill a template.')
    assert.ok(!/\[(?!\d+\])[^\]\n]*(?:your|yesterday|today|blocker|focus|worked|e\.g\.)[^\]\n]*\]/i.test(text), 'No placeholder templates')
    assert.ok(!/no blockers/i.test(text), 'No invented absence of blockers')
    if (!missing) {
      assert.match(text, /TC-152/); assert.match(text, /QA.*(?:complete|done|finish|pass)|(?:complete|finish|pass).*QA/i)
      assert.match(text, /TC-171/); assert.match(text, /blocked|waiting/i)
      assert.ok(!/TC-188/.test(text), 'Do not present Denis’s task as Luka’s update')
      assert.ok(!/two things done|completed (?:both|two)|finished (?:both|two)/i.test(text), 'Blocked work must not be counted as completed')
      assert.ok(text.split(/\s+/).length <= 90, 'A live suggestion stays short')
    } else {
      assert.ok(!/TC-\d+|I (?:finished|completed|shipped)|today I (?:will|plan)/i.test(text), 'No fabricated work or commitments')
      assert.ok(!/let me check|then I(?:'|’)ll|I(?:'|’)ll.{0,30}(?:check|send|give)|I will.{0,30}(?:check|send|give)/i.test(text), 'No invented follow-up promise')
      assert.match(text, /verif|confirm|don't have|do not have|cannot|can't|couldn't|not.*available|need to check|check.*(?:first|before)/i)
    }
    results.push({ case: missing ? 'missing-evidence' : 'verified-work', provider: account.provider, reads, ms: Math.round(performance.now() - started), passed: true, text })
    console.log(JSON.stringify(results.at(-1)))
  }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ fixtureOnly: true, checkedAt: new Date().toISOString(), results }, null, 2))
}).then(() => { clearTimeout(watchdog); app.exit(0) }, error => { console.error(error.message); clearTimeout(watchdog); app.exit(1) })
