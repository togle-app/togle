const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { options, run } = require('./data.cjs')
const { replayScenario } = require('./replay-scenario.cjs')
const cases = require('./realistic-cases.cjs')

if (process.env.TOGLE_SCENARIO_DATA) app.setPath('userData', process.env.TOGLE_SCENARIO_DATA)
const opts = options()
const model = typeof opts.model === 'string' ? opts.model : 'haiku'
const maximum = Number(opts['max-calls'] ?? 16)
const only = typeof opts.only === 'string' ? opts.only.split(',') : null
const selected = cases.filter(c => !only || only.includes(c.id))
const output = path.join(__dirname, 'results', 'realistic-claude.json')

run(async () => {
  if (!process.env.TOGLE_SCENARIO_DATA) throw new Error('Use npm run test:scenarios:live.')
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 100) throw new Error('--max-calls must be an integer from 1 to 100.')
  if (!selected.length || only?.some(id => !cases.some(c => c.id === id))) throw new Error('Unknown scenario id. Use R1 through R9.')
  const T = require('./.build/togle.cjs')
  await T.loadSettings()
  const lanes = Object.fromEntries(Object.keys(T.getSettings().claude.subscriptionLanes).map(lane => [lane, { model, effort: 'low' }]))
  await T.updateSettings({ provider: 'claude', assist: { auto: true, names: 'Luka' }, claude: { auth: 'subscription', subscriptionLanes: lanes } })
  const auth = new T.ClaudeCodeAuth()
  const status = await auth.status(true)
  if (!status.signedIn) throw new Error(status.error || 'Sign in with Claude in Togle or Claude Code first.')
  const native = new T.ClaudeSubscriptionProvider(auth)
  await native.listModels()
  let calls = 0
  let halted = ''
  const provider = {
    id: native.id, supportsTools: native.supportsTools, listModels: () => native.listModels(),
    stream: async (input, handlers) => {
      if (halted) throw new Error(halted)
      if (calls >= maximum) throw new Error('The --max-calls budget was reached.')
      calls++
      try { await native.stream(input, handlers) }
      catch (error) {
        if (/rate limit|too many requests|at its limit|\b429\b|sign in|organization.*disabled|oauth_org/i.test(error.message)) halted = error.message
        throw error
      }
    }
  }
  const results = []
  console.log('Live Claude scenarios, model ' + model + ', at most ' + maximum + ' model calls.')
  for (const scenario of selected) {
    const before = calls
    const result = await replayScenario(T, scenario, () => provider)
    const { prompt: _prompt, ...saved } = result
    saved.modelCalls = calls - before
    results.push(saved)
    console.log((result.pass ? 'PASS ' : 'FAIL ') + scenario.id + ': ' + scenario.title + ' (' + result.ms + ' ms)')
    for (const check of result.checks.filter(c => !c.pass)) console.log('  Failed: ' + check.label)
    if (halted || calls >= maximum) break
  }
  const report = {
    at: new Date().toISOString(), mode: 'live-claude', model, modelCalls: calls,
    requested: selected.length, completed: results.length,
    passed: results.filter(r => r.pass).length, results
  }
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(report, null, 2))
  console.log(report.passed + '/' + selected.length + ' passed; ' + calls + ' model calls. Report: ' + output)
  if (results.length !== selected.length || results.some(r => !r.pass)) throw new Error('Scenario checks failed; see the JSON report.')
})
