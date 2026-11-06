// One fictional shared chart through the real subscription adapter and Copilot tool loop.
// Uses the official CLI's existing sign-in, a fresh profile, and at most four provider stream calls.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const artifacts = path.resolve(__dirname, '../test/.work/screen-live')
fs.mkdirSync(artifacts, { recursive: true })
app.setPath('userData', fs.mkdtempSync(path.join(artifacts, 'profile-')))
app.on('window-all-closed', () => {})
let copilot, monitor, sampling
const timeout = setTimeout(() => { copilot?.cancel(); monitor?.stop(undefined, true); console.error('Live screen context check timed out.'); app.exit(1) }, 90000)

app.whenReady().then(async () => {
  const T = require('./.build/togle.cjs')
  await T.loadSettings()
  const lanes = Object.fromEntries(Object.keys(T.getSettings().claude.subscriptionLanes).map(lane => [lane, { model: 'haiku', effort: 'low' }]))
  await T.updateSettings({ provider: 'claude', assist: { auto: false }, claude: { auth: 'subscription', subscriptionLanes: lanes } })
  const auth = new T.ClaudeCodeAuth()
  const status = await auth.status(true)
  assert.ok(status.signedIn, status.error || 'Claude Code is not signed in.')
  const native = new T.ClaudeSubscriptionProvider(auth)
  let calls = 0, vision = 0, wrongWindow = false
  const provider = { id: native.id, supportsTools: true, listModels: () => native.listModels(), stream: async (input, opts) => {
    if (++calls > 4) throw new Error('The live screen check reached its four-request budget.')
    if (input.lane === 'vision') {
      vision++
      const correctWindow = input.images.every(item => Buffer.from(item.url.split(',')[1], 'base64').equals(spokenImage))
      if (!correctWindow) wrongWindow = true
      assert.ok(correctWindow, 'a past-time request must upload the spoken chart, not the later chart')
    }
    return native.stream(input, opts)
  } }
  const store = new T.AgentStore(async () => { throw new Error('No agent training in this check.') })
  await store.load()
  const agent = store.list()[0]
  const window = new BrowserWindow({ show: false, width: 960, height: 540, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:#112039;color:white;font:32px Arial;padding:40px"><h2>Fictional team results</h2><p>Alpha: 20</p><div style="width:240px;height:45px;background:#6195ff"></div><p>Beta: 35</p><div style="width:420px;height:45px;background:#55d7ae"></div></body></html>'))
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const spokenImage = (await window.webContents.capturePage()).toJPEG(85)
  let image = spokenImage
  monitor = new T.ScreenMonitor(() => provider)
  const scope = monitor.start({ id: 'window:fictional', name: 'Fictional chart', kind: 'window' })
  monitor.add(scope.id, Date.now(), image)
  sampling = setInterval(() => monitor.add(scope.id, Date.now(), image), 500)
  const events = []
  copilot = new T.Copilot((channel, event) => { if (channel === 'assist') events.push(event) }, () => provider, { monitor, snapshot: async () => { throw new Error('Real screen capture is forbidden in this check.') }, dataUrl: async () => '', reset: async () => {} }, {
    active: () => agent, get: () => agent, knowledgeFor: (agent, query, seen) => store.knowledgeFor(agent, query, seen), search: (agent, query, seen, first) => store.search(agent, query, seen, first), facts: (agent, query) => store.factsFor(agent, query), code: () => undefined
  })
  await copilot.assist({ kind: 'ask', question: 'What is 2 plus 2? Answer briefly.' })
  assert.equal(vision, 0, 'an ordinary question must not upload a screen picture')
  const referenceStart = Date.now()
  monitor.add(scope.id, referenceStart, spokenImage)
  await new Promise(resolve => setTimeout(resolve, 1200))
  const referenceEnd = Date.now()
  monitor.add(scope.id, referenceEnd, spokenImage)
  copilot.add('them', 'As you can see on my screen, these are the team results.', referenceStart, referenceEnd)
  // Change the visible chart before the AI decides: Alpha now wins, but the referenced chart had Beta = 35.
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="background:#391120;color:white;font:32px Arial;padding:40px"><h2>Later chart</h2><p>Alpha: 99</p><p>Beta: 1</p></body></html>'))
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  image = (await window.webContents.capturePage()).toJPEG(85)
  monitor.add(scope.id, Date.now(), image)
  events.length = 0
  await copilot.assist({ kind: 'ask', question: 'When they said "as you can see on my screen", which team had the larger value, and what was that value? Read the chart from that spoken interval.' })
  const answer = events.filter(event => event.type === 'delta' && event.part === 'main').map(event => event.text).join('')
  const failures = events.filter(event => event.type === 'error')
  assert.ok(vision >= 1, 'Claude must request the look_at_screen tool for the visual question. ' + JSON.stringify(failures))
  assert.match(answer, /Beta/i)
  assert.match(answer, /35/)
  assert.equal(wrongWindow, false, 'a retry must not hide a lookup of the wrong time')
  const used = monitor.status().lastLook
  assert.ok(used.capturedAt.every(at => at <= referenceEnd && at >= referenceStart - 1000))
  const report = { at: new Date().toISOString(), pass: true, provider: 'claude-subscription', calls, vision, answer, referenceStart, referenceEnd, used }
  fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Live Claude temporal screen context passed: it retrieved the earlier spoken chart (Beta = 35) after the screen changed to Alpha = 99. ${calls} provider stream calls, ${vision} vision call(s).`)
  clearInterval(sampling)
  monitor.stop(undefined, true)
  window.destroy(); clearTimeout(timeout); app.exit(0)
}).catch(error => { clearInterval(sampling); copilot?.cancel(); monitor?.stop(undefined, true); clearTimeout(timeout); console.error(error.stack); app.exit(1) })
