// Opt-in subscription evaluation: at most eight distinct task requests, fictional content only.
// Reads existing auth through its owners; no mic, real documents, meetings, apps or preference writes.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), directory = path.join(__dirname, '.work/presets-live')
fs.mkdirSync(directory, { recursive: true })
const profile = path.join(app.getPath('appData'), 'Togle')
app.setPath('userData', profile); app.setPath('sessionData', profile); app.getAppPath = () => root
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => { console.error('Preset evaluation timed out'); app.exit(1) }, 240_000)
app.whenReady().then(async () => {
  const T = require('../eval/.build/togle.cjs')
  await T.loadSettings()
  const chatgpt = new T.ChatGPTAuth(); await chatgpt.load()
  const claude = new T.ClaudeCodeAuth()
  const accounts = new T.SubscriptionAccounts(chatgpt, new T.ChatGPTProvider(chatgpt), claude, new T.ClaudeSubscriptionProvider(claude))
  await accounts.load()
  const list = await accounts.list(), catalogs = []
  for (const provider of ['claude', 'chatgpt']) {
    const connected = list.filter(item => item.provider === provider && item.signedIn)
    const account = connected.find(item => item.id === T.getSettings().subscriptionAccountId) || connected[0]
    if (!account) { console.log(JSON.stringify({ provider, signedIn: false })); continue }
    const models = await accounts.pinned(account.id, false).listModels()
    catalogs.push({ source: { id: account.id, provider, label: provider, subscription: true, ready: true }, models })
    console.log(JSON.stringify({ provider, signedIn: true, models: models.map(model => ({ id: model.id, label: model.label })) }))
  }
  if (process.argv.includes('--catalog-only')) return
  assert.equal(catalogs.length, 2, 'Both subscriptions must be connected to evaluate all three presets.')
  const window = new BrowserWindow({ show: false, width: 800, height: 500, webPreferences: { offscreen: true, backgroundThrottling: false } })
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="margin:0;padding:30px;background:#122033;color:white;font:28px Arial"><h2>Fictional team results</h2><p>Alpha: 20</p><div style="height:35px;width:200px;background:#6195ff"></div><p>Beta: 35</p><div style="height:35px;width:350px;background:#55d7ae"></div></body>'))
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const image = (await window.webContents.capturePage()).toJPEG(85).toString('base64'); window.destroy()
  const cases = {
    quick: { system: 'Assist a live work call. Reply in one short sentence, at most 35 words. Facts: the trial includes SSO; the plan is $60 per seat. Do not invent discounts.', user: 'Is single sign-on included in the trial?', check: text => { assert.match(text, /yes|included|includes/i); assert.match(text, /SSO|single.sign.on/i); assert.ok(text.split(/\s+/).length <= 45) } },
    deep: { system: 'Use only these notes. State the decision, the technical risk, the next actions with their owners and deadlines, and whether a new launch date exists. Be concise.', user: 'We postponed Friday’s release because of an OAuth callback bug. Denis will fix the callback by Thursday. Luka will verify the fix on Friday. The customer requested a new launch date, but none was agreed.', check: text => { for (const pattern of [/Denis/, /Thursday/, /Luka/, /Friday/, /OAuth|callback/i, /no .*date|not .*agreed|not .*set|none|unconfirmed|TBD|not .*established/i]) assert.match(text, pattern) } },
    vision: { system: 'Read this fictional chart. Return only JSON with numeric keys alpha, beta, difference and total. Do not infer hidden data.', user: 'What are the two values, their difference and total?', images: [{ url: 'data:image/jpeg;base64,' + image }], check: text => { const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); assert.deepEqual(parsed, { alpha: 20, beta: 35, difference: 15, total: 55 }) } },
    background: { system: 'Extract only explicit action items. Return only a JSON array of objects with owner, task and deadline. Do not invent an owner or date.', user: 'Denis will send the incident report by Friday. Luka will review billing on Monday. Someone should update the FAQ, but there is no owner or deadline.', check: text => { const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '')); assert.ok(Array.isArray(parsed)); assert.ok(parsed.some(item => item.owner === 'Denis' && /Friday/i.test(item.deadline))); assert.ok(parsed.some(item => item.owner === 'Luka' && /Monday/i.test(item.deadline))); assert.ok(!parsed.some(item => /FAQ/i.test(item.task) && item.owner && !/unknown|unassigned|none/i.test(item.owner))) } }
  }
  const profiles = T.PRESETS.map(preset => ({ id: preset.id, profile: T.presetProfile(preset.id, catalogs) })), unique = new Map()
  for (const { profile } of profiles) for (const [lane, task] of Object.entries(profile.tasks)) unique.set(JSON.stringify([lane, task.sourceId, task.model, task.effort]), { lane, task })
  const results = [], pending = [...unique.values()]
  const worker = async () => { while (pending.length) {
    const { lane, task } = pending.shift(), fixture = cases[lane], startedAt = performance.now()
    const provider = accounts.pinned(task.sourceId, false)
    let text = '', final, firstTextMs
    try {
      await provider.stream({ lane, model: task.model, effort: task.effort, fixedModel: true, system: fixture.system, user: fixture.user, ...(fixture.images ? { images: fixture.images } : {}) }, { signal: AbortSignal.timeout(90_000), onDelta: part => { firstTextMs ??= Math.round(performance.now() - startedAt); text += part }, onFinal: value => { final = value } })
      text = final || text; fixture.check(text)
      results.push({ lane, provider: accounts.get(task.sourceId).kind, model: task.model, effort: task.effort, passed: true, firstTextMs, elapsedMs: Math.round(performance.now() - startedAt), text })
    } catch (error) { results.push({ lane, provider: accounts.get(task.sourceId).kind, model: task.model, passed: false, reason: error.message.replace(/[\w.+-]+@[\w.-]+/g, '[account]'), elapsedMs: Math.round(performance.now() - startedAt), text }) }
    console.log(JSON.stringify(results.at(-1)))
  } }
  await Promise.all([worker(), worker()])
  const report = { checkedAt: new Date().toISOString(), version: T.PRESET_VERSION, fixtureOnly: true, profiles: profiles.map(({ id, profile }) => ({ id, tasks: Object.fromEntries(Object.entries(profile.tasks).map(([lane, task]) => [lane, { ...task, sourceId: accounts.get(task.sourceId).kind }])) })), results }
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
  assert.ok(results.every(result => result.passed), 'All task quality checks must pass before calling the preset evaluation complete.')
}).then(() => { clearTimeout(watchdog); app.exit(0) }, error => { console.error(error.message); clearTimeout(watchdog); app.exit(1) })
