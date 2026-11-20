import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { hermesMeters } from './.build/togle.mjs'
import path from 'node:path'
import { claudePlan, codexPlan, codexThreadCost, codexThreadTokens, formatAgentMoney, HermesBackend, hermesPlan, hermesHistoryUsage, hermesSessionUsage, resetCountdown, RunnerHub, SessionCosts, TranscriptUsage } from './.build/togle.mjs'

test('Hermes reports its own API spend when the key also pays for other agents', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'togle-hermes-usage-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const cli = `if (process.argv[1] === 'usage') console.log(JSON.stringify({ provider: 'openrouter', details: ['API key usage: $9.00 total'] })); else console.log(process.env.TEST_HERMES_SPEND)`
  const read = (history) => new HermesBackend({ command: [process.execPath, '-e', cli], env: { ...process.env, HERMES_HOME: home, TEST_HERMES_SPEND: history }, told() {} }).usage()
  const priced = await read('Estimated: ~$1.25')
  assert.equal(priced.scope, 'hermes-history')
  assert.deepEqual(priced.amounts, [{ amount: 1.25, currency: 'USD' }])
  const unpriced = await read('Unknown: 2 session(s)')
  assert.equal(unpriced.kind, 'unavailable')
})

test('subscription meters use the reported duration, usage and reset, including a weekly-only plan', () => {
  assert.deepEqual(codexPlan({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 52, windowDurationMins: 300 }, secondary: { usedPercent: 23, windowDurationMins: 10080, resetsAt: 1800000000 } } } }),
    [{ label: 'weekly', usedPercent: 23, resetsAt: 1800000000000 }])
  assert.deepEqual(claudePlan({ rate_limits: { five_hour: { utilization: 0 }, seven_day: { utilization: null } } }), [])
  assert.deepEqual(hermesPlan({ provider: 'openai-codex', windows: [{ label: 'Session', used_percent: 50 }, { label: 'Weekly', used_percent: 11 }] }),
    [{ label: 'weekly', usedPercent: 11 }])
})

test('Hermes separates a ChatGPT subscription and Kimi API calls within one session and across its history', () => {
  const db = new DatabaseSync(':memory:')
  const cols = 'billing_provider TEXT, model TEXT, cost_status TEXT, billing_mode TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, actual_cost_usd REAL, estimated_cost_usd REAL'
  try {
    db.exec('CREATE TABLE sessions (id TEXT, ' + cols + '); CREATE TABLE session_model_usage (session_id TEXT, ' + cols + ')')
    const insert = (table, ...row) => db.prepare('INSERT INTO ' + table + ' VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(...row)
    insert('sessions', 'mixed', 'kimi', 'kimi-k', 'estimated', 'api', 1000, 0, 0, 0, 0, 0.20)
    insert('session_model_usage', 'mixed', 'openai-codex', 'gpt', 'included', 'subscription_included', 700, 0, 0, 0, 0, 0)
    insert('session_model_usage', 'mixed', 'kimi', 'kimi-k', 'estimated', 'api', 300, 0, 0, 0, 0, 0.20)
    insert('sessions', 'older', 'kimi', 'kimi-k', 'actual', 'api', 50, 0, 0, 0, 0.10, 0.11)
    const reading = hermesMeters(db, 'mixed')
    assert.deepEqual(reading, { kind: 'providers', period: 'session', sources: [
      { provider: 'ChatGPT', billing: 'subscription', tokens: 700 },
      { provider: 'Kimi', billing: 'api', tokens: 300, estimated: true, cost: { amount: 0.20, currency: 'USD' } }
    ] })
    const all = hermesMeters(db)
    assert.equal(all.period, 'all')
    assert.equal(all.sources[1].tokens, 350)
    assert.ok(Math.abs(all.sources[1].cost.amount - 0.3) < 1e-9)
  } finally { db.close() }
})

test('Hermes updates each subscription while an API provider is active and retains a reading after a temporary failure', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'togle-hermes-limits-'))
  t.after(() => fs.rm(home, { recursive: true, force: true }))
  const db = new DatabaseSync(path.join(home, 'state.db'))
  try { db.exec("CREATE TABLE sessions (billing_provider TEXT); INSERT INTO sessions VALUES ('kimi'), ('openai-codex'), ('anthropic')") } finally { db.close() }
  const marker = path.join(home, 'quota-unavailable')
  const command = path.join(home, 'hermes.cjs')
  await fs.writeFile(command, `
    const unavailable = require('node:fs').existsSync(process.env.TEST_QUOTA_MARKER)
    const index = process.argv.indexOf('--provider')
    const provider = index < 0 ? 'kimi' : process.argv[index + 1]
    if (unavailable && provider === 'anthropic') process.exit(2)
    const percent = provider === 'anthropic' ? 12 : unavailable ? 23 : 17
    const windows = provider === 'kimi' ? [] : [{ label: 'Session', used_percent: 50 }, { label: 'Weekly', used_percent: percent }]
    console.log(JSON.stringify({ provider, windows }))
  `)
  const backend = new HermesBackend({ command: [process.execPath, command], env: { ...process.env, HERMES_HOME: home, TEST_QUOTA_MARKER: marker }, told() {} })
  const readings = async () => (await backend.limits()).sort((a, b) => a.provider.localeCompare(b.provider)).map(w => [w.provider, w.label, w.usedPercent])
  assert.deepEqual(await readings(), [['Anthropic', 'weekly', 12], ['ChatGPT', 'weekly', 17]])
  await fs.writeFile(marker, '')
  assert.deepEqual(await readings(), [['Anthropic', 'weekly', 12], ['ChatGPT', 'weekly', 23]])
})

test('amounts preserve actual zero, native dollars and estimates specific to the agent', () => {
  const report = { threadUsage: { threadId: 'a', nativeUsageUsdMicros: 0, estimatedUsageUsdMicros: 80000 } }
  assert.deepEqual(codexThreadCost(report, 'a'), { currency: 'USD', amount: 0 })
  report.threadUsage.nativeUsageUsdMicros = null
  assert.deepEqual(codexThreadCost(report, 'a'), { currency: 'USD', amount: .08, estimated: true })
  assert.equal(codexThreadCost(report, 'other'), undefined)
  assert.equal(codexThreadCost({ threadUsage: { threadId: 'a', estimatedUsageCreditsMicros: 10 } }, 'a'), undefined)
  assert.deepEqual(hermesPlan({ provider: 'openrouter', details: ['API key usage: $1.00 total'] }), [])
  const insights = hermesHistoryUsage('  Estimated:          ~$0.0025\n  Included:           5 session(s)\n  Unknown:            1 session(s)')
  assert.equal(insights.amounts[0].amount, .0025)
  assert.equal(insights.partial, true)
  assert.equal(hermesHistoryUsage('Unknown: 2 session(s)').kind, 'unavailable')
  assert.deepEqual(hermesSessionUsage({ id: 'a', cost_status: 'included', estimated_cost_usd: 0, input_tokens: 10, output_tokens: 2, cache_read_tokens: 3, reasoning_tokens: 2 }, 'a'), { kind: 'tokens', period: 'session', total: 15 })
  assert.deepEqual(codexThreadTokens({threadUsage: {threadId: 'a', groups: [{totalTokens: 3}, {totalTokens: 4}]}}, 'a'), {kind: 'tokens', period: 'session', total: 7})
  assert.equal(codexThreadTokens({threadUsage: {threadId: 'b', groups: [{totalTokens: 42}]}}, 'a').kind, 'unavailable')
  assert.ok(formatAgentMoney({ currency: 'USD', amount: .000012 }).startsWith('<'))
})

test('cumulative session costs survive restarts, replays and concurrent reads without mixing currencies or subscription runs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'togle-agent-cost-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'cost.json'), costs = new SessionCosts(file)
  await Promise.all([costs.record('a', { currency: 'USD', amount: .02 }), costs.record('b', { currency: 'EUR', amount: .5 })])
  await costs.record('a', { currency: 'USD', amount: .04 })
  await costs.record('a', { currency: 'USD', amount: .02 }, true)
  const later = new SessionCosts(file)
  await later.track('api')
  const tasks = ['api', 'subscription'].map(id => ({ id, updatedAt: 1, state: 'idle' }))
  const read = async id => { assert.equal(id, 'api'); return { currency: 'USD', amount: 1 } }
  await later.refresh(tasks, read)
  await later.closeTracked()
  await later.refresh(tasks.map(task => ({ ...task, updatedAt: 2 })), async () => assert.fail('frozen billing route'))
  assert.deepEqual((await new SessionCosts(file).total('api-tasks')).amounts, [{ currency: 'USD', amount: 1.04 }, { currency: 'EUR', amount: .5 }])
  assert.deepEqual((await new SessionCosts(file).total('api-tasks', 'b')).amounts, [{ currency: 'EUR', amount: .5 }])
  assert.deepEqual((await later.total('api-tasks', 'unknown')).amounts, [])
  const mixed = await later.withTrackedApi({ kind: 'tokens', period: 'session', total: 50 }, 'b')
  assert.equal(mixed.total, 50)
  assert.deepEqual(mixed.trackedApi.amounts, [{ currency: 'EUR', amount: .5 }])
})

test('token readings separate sessions, charge streamed messages once, and age events out of the weekly window', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'togle-usage-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const now = Date.now(), hour = 3600000
  const files = ['a', 'b'].map(id => ({ file: path.join(dir, id), id }))
  const line = (id, message, tokens, hours) => JSON.stringify({ type: 'assistant', sessionId: id, timestamp: new Date(now - hours * hour),
    message: { id: message, usage: { input_tokens: 1, output_tokens: tokens - 1 } } })
  await fs.writeFile(files[0].file, [line('a', 'old', 200, 190), line('a', 'day', 10, 24), line('a', 'current', 9, 1), line('a', 'current', 11, 1)].join('\n') + '\n')
  await fs.writeFile(files[1].file, line('b', 'other', 20, 3) + '\n')
  const meter = new TranscriptUsage('claude', async () => files)
  const [week, a] = await Promise.all([meter.read(undefined, now), meter.read('a', now)])
  assert.deepEqual(week, { kind: 'tokens', period: '7d', total: 41 })
  assert.equal(a.total, 221)
  assert.equal((await meter.read('b', now)).total, 20)
  assert.equal((await meter.read('unknown', now)).kind, 'unavailable')
  const latest = line('a', 'new', 50, 0)
  await fs.appendFile(files[0].file, latest.slice(0, -4))
  assert.equal((await meter.read('a', now)).total, 221)
  await fs.appendFile(files[0].file, latest.slice(-4) + '\n')
  assert.deepEqual(await meter.read(undefined, now + 2.5 * hour), { kind: 'tokens', period: '7d', total: 91 })
  assert.equal((await meter.read('a', now)).total, 271)

  const codex = (n, hours) => JSON.stringify({type: 'event_msg', timestamp: new Date(now - hours * hour), payload: {type:'token_count', info:{total_token_usage:{total_tokens:n}}}})
  await fs.writeFile(files[0].file, [codex(100, 190), codex(150, 18), codex(175, 2), codex(175, 1)].join('\n') + '\n')
  const rollouts = new TranscriptUsage('codex', async () => [files[0]])
  assert.deepEqual(await rollouts.read(undefined, now), {kind:'tokens', period:'7d', total:75})
  assert.equal((await rollouts.read('a', now)).total, 175)
})

test('account limits refresh in the background every three minutes, retain the last reading on failure and stop on quit', async t => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let reads = 0, fail = false
  const sent = []
  const backend = { runner: 'codex', detect: async () => ({ installed: true }),
    limits: async () => { reads++; if (fail) throw new Error('offline'); return [{ label:'weekly', usedPercent:reads }] }, close: async () => {} }
  const hub = new RunnerHub({ backends:[backend], changed() {}, limitsChanged: (...event) => sent.push(event) })
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    await settle()
    assert.equal(reads, 1)
    assert.equal(hub.limits('codex')[0].usedPercent, 1)
    assert.equal(hub.limits('codex')[0].usedPercent, 1)
    t.mock.timers.tick(179_999); await settle()
    assert.equal(reads, 1)
    t.mock.timers.tick(1); await settle()
    assert.equal(reads, 2)
    assert.equal(sent.at(-1)[1][0].usedPercent, 2)
    fail = true
    t.mock.timers.tick(180_000); await settle()
    assert.equal(reads, 3)
    assert.equal(hub.limits('codex')[0].usedPercent, 2)
  } finally { await hub.dispose() }
  t.mock.timers.tick(360_000); await settle()
  assert.equal(reads, 3)
  assert.equal(resetCountdown(101 * 3_600_000, 0), 'resets in 4d 5h')
  assert.equal(resetCountdown(60_001, 0), 'resets in 2m')
  assert.equal(resetCountdown(10, 11), 'reset due')
})
