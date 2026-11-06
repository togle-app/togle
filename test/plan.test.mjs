// The ChatGPT plan's usage limits: reading them, saving near them, and waiting while one is reached.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { agentAccess, quick, say, wait, workDir } from './helpers.mjs'

workDir('plan')
const { AgentStore, ChatGPTProvider, Copilot, PlanWatch, getSettings, readRefusal, readStatus, updateSettings, windowsFromHeaders } = await import(
  './.build/togle.mjs'
)

const store = new AgentStore(async () => 'digest')
await store.load()

// What the backend sent with a real answer (a plan with only a weekly limit; the second window comes as zeros).
const REAL_HEADERS = new Headers({
  'x-codex-active-limit': 'premium',
  'x-codex-plan-type': 'prolite',
  'x-codex-primary-used-percent': '5',
  'x-codex-primary-window-minutes': '10080',
  'x-codex-primary-reset-at': '1793294059',
  'x-codex-primary-reset-after-seconds': '525170',
  'x-codex-secondary-used-percent': '0',
  'x-codex-secondary-window-minutes': '0',
  'x-codex-secondary-reset-at': ''
})

// And what GET /wham/usage said for the same plan (ids left out).
const REAL_STATUS = {
  plan_type: 'prolite',
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 525186, reset_at: 1793294059 },
    secondary_window: null
  },
  credits: { has_credits: true, unlimited: false, overage_limit_reached: false, balance: '75000.0000000000' },
  rate_limit_reached_type: null
}

test("an answer's headers and the usage status read the same: the weekly limit, a twentieth used", () => {
  const weekly = { usedPercent: 5, minutes: 10080, resetsAt: 1793294059000 }
  assert.deepEqual(windowsFromHeaders(REAL_HEADERS), [weekly])
  assert.deepEqual(readStatus(REAL_STATUS), { windows: [weekly] })
  const both = new Headers({
    'x-codex-primary-used-percent': '64.5',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-secondary-used-percent': '12',
    'x-codex-secondary-window-minutes': '300'
  })
  assert.deepEqual(
    windowsFromHeaders(both).map((w) => [w.minutes, w.usedPercent]),
    [
      [300, 12],
      [10080, 64.5]
    ],
    'the 5-hour limit first'
  )
})

test('the usage status says the limit is reached only when requests are turned down and no credits carry on', () => {
  const now = Date.parse('2026-10-23T10:00:00Z')
  const reached = {
    rate_limit: { allowed: false, limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: now / 1000 + 3600 } },
    credits: { has_credits: false }
  }
  assert.equal(readStatus(reached, now).limitedUntil, now + 3_600_000)
  assert.equal(readStatus({ ...reached, credits: { has_credits: true, overage_limit_reached: false } }, now).limitedUntil, undefined)
  assert.equal(readStatus({ ...reached, credits: { has_credits: true, overage_limit_reached: true } }, now).limitedUntil, now + 3_600_000)
})

test("a request turned down for the plan's limit says which limit and when it starts over; other refusals don't hold anything", () => {
  const now = Date.parse('2026-10-23T10:00:00Z')
  const body = JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', plan_type: 'plus', resets_at: now / 1000 + 5400 } })
  const full = [
    { usedPercent: 40, minutes: 300 },
    { usedPercent: 100, minutes: 10080, resetsAt: now + 5_400_000 }
  ]
  const limit = readRefusal(body, full, now)
  assert.equal(limit.limitedUntil, now + 5_400_000)
  assert.match(limit.message, /^You've reached your ChatGPT plan's weekly limit\. It starts over at .+\.$/)
  // Nothing in the body but the type: the window that's full says when.
  assert.equal(readRefusal(JSON.stringify({ error: { type: 'usage_limit_reached' } }), full, now).limitedUntil, now + 5_400_000)
  const busy = readRefusal(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Please try again in 10s.' } }), full, now)
  assert.equal(busy.limitedUntil, undefined)
  assert.match(busy.message, /too many requests/)
  assert.match(readRefusal(JSON.stringify({ error: { type: 'usage_not_included' } }), [], now).message, /doesn't include use in other apps/)
  const plan = readRefusal(JSON.stringify({ error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } }), [], now)
  assert.match(plan.message, /Usage limit reached on your ChatGPT plan/)
  assert.equal(plan.limitedUntil, now + 5 * 60_000, 'no end is given: automatic answers pause for a few minutes')
})

test("past 90% of a limit it saves (unless that's off); a call's share counts from its start, across a window starting over", () => {
  let saving = 'GPT-6 Luna'
  const changes = []
  const plan = new PlanWatch(() => saving)
  plan.onChange = (usage) => changes.push(usage)
  const at = (used, resetAt = '1793294059') =>
    new Headers({ 'x-codex-primary-used-percent': String(used), 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': resetAt })
  plan.callStarted()
  assert.equal(plan.usage().call, undefined, 'nothing known yet')
  plan.seen(at(40), true)
  assert.equal(plan.usage().call, 0, 'the first figures are where the call started')
  const told = changes.length
  plan.seen(at(40), true)
  assert.equal(changes.length, told, 'the same figures again change nothing')
  plan.seen(at(89), true)
  assert.equal(plan.saving(), undefined)
  plan.seen(at(91), true)
  assert.equal(plan.saving(), 'GPT-6 Luna')
  assert.equal(plan.usage().call, 51)
  saving = undefined
  assert.equal(plan.saving(), undefined, 'turned off in settings')
  plan.seen(at(3, '1793312059'), true)
  assert.equal(plan.usage().call, 3, 'the window started over during the call: what it used since')
})

test('a reached limit holds until it starts over or an answer comes through', () => {
  const now = Date.now()
  const plan = new PlanWatch(() => undefined)
  plan.refused(JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: Math.round(now / 1000) + 600 } }), now)
  assert.ok(plan.limited(now + 1000))
  assert.equal(plan.limited(now + 601_000), undefined, 'started over')
  plan.seen(new Headers(), false)
  assert.ok(plan.limited(now + 1000), 'a failed request says nothing about it')
  plan.seen(new Headers(), true)
  assert.equal(plan.limited(now + 1000), undefined, 'an answer came through: credits, or it started over early')
})

/** A backend for the provider: the model list, the usage status, and answers with the given headers. */
function planBackend({ answerHeaders = {}, status = REAL_STATUS, refuse } = {}) {
  const sent = []
  const asked = { usage: 0 }
  electron.net.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/v1/models')) {
      const tiers = [{ id: 'priority', description: '1.5x speed, more usage' }]
      return Response.json({
        models: [
          { slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], service_tiers: tiers },
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], service_tiers: tiers }
        ]
      })
    }
    if (path.endsWith('/wham/usage')) {
      asked.usage++
      return Response.json(status)
    }
    assert.ok(path.endsWith('/v1/responses'), path)
    sent.push(JSON.parse(init.body))
    if (refuse) return new Response(JSON.stringify(refuse.body), { status: 429, headers: refuse.headers })
    const events = [...say('Ok.'), { type: 'response.completed', response: {} }]
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', ...answerHeaders }
    })
  }
  return { sent, asked }
}

const ask = (provider, input) => provider.stream({ system: 'S', user: 'Q', ...input }, { signal: new AbortController().signal, onDelta: () => {} })

test('near the limit every job goes to the quick answers’ model, without the Fast tier; with saving off, to its own', async () => {
  const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const lanes = getSettings().chatgpt.lanes
  await updateSettings({ chatgpt: { lanes: { ...lanes, quick: { ...lanes.quick, fast: true } } } })
  try {
    const { sent } = planBackend({ answerHeaders: { 'x-codex-primary-used-percent': '93', 'x-codex-primary-window-minutes': '300' } })
    await ask(provider, { lane: 'quick' })
    assert.equal(sent[0].service_tier, 'priority', 'not known to be near the limit yet')
    assert.equal(provider.plan.saving(), 'GPT-6 Luna')
    await ask(provider, { lane: 'deep', model: 'gpt-6.1-sol' })
    await ask(provider, { lane: 'vision' })
    await ask(provider, { lane: 'quick' })
    assert.deepEqual(
      sent.slice(1).map((b) => [b.model, b.reasoning?.effort, b.service_tier]),
      [
        ['gpt-6-luna', 'medium', undefined],
        ['gpt-6-luna', 'low', undefined],
        ['gpt-6-luna', 'low', undefined]
      ],
      'each at its own effort'
    )
    await updateSettings({ chatgpt: { saveNearLimit: false } })
    await ask(provider, { lane: 'deep', model: 'gpt-6.1-sol' })
    assert.equal(sent.at(-1).model, 'gpt-6.1-sol')
  } finally {
    await updateSettings({ chatgpt: { lanes, saveNearLimit: true } })
  }
})

test('a request turned down at the usage limit says so plainly, and automatic answers pause a few minutes', async () => {
  const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  planBackend({ refuse: { body: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'Usage limit exceeded' } }, headers: {} } })
  const before = Date.now()
  await assert.rejects(ask(provider, { lane: 'quick' }), /^Error: Usage limit reached on your ChatGPT plan\. Review your plan, or Togle's limit, in ChatGPT settings/)
  const until = provider.plan.limited()
  assert.ok(until >= before + 5 * 60_000 && until <= Date.now() + 5 * 60_000, 'no end time is given: a short pause, not a guess')
  assert.deepEqual(provider.plan.usage().windows, [], 'no figures are made up')
})

test("nothing asks ChatGPT for the plan's usage figures: they are in ChatGPT's settings", async () => {
  const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const { asked } = planBackend()
  const usage = await provider.refreshUsage()
  assert.deepEqual(usage.windows, [])
  assert.equal(usage.limitedUntil, undefined)
  assert.equal(asked.usage, 0)
})

/** A copilot whose model has a plan: `state.until` is when its reached limit starts over, `state.saving` the model it saves with. */
function copilotWithPlan(agentId, reply) {
  const state = { until: 0, saving: undefined }
  const inputs = []
  const model = {
    id: 'fake',
    supportsTools: false,
    plan: { limited: (now = Date.now()) => (state.until > now ? state.until : undefined), saving: () => state.saving },
    listModels: async () => [],
    stream: async (input, { onDelta, onAccepted }) => {
      inputs.push(input)
      onAccepted?.()
      await wait(0)
      onDelta(reply(input))
    }
  }
  const frames = { snapshot: async () => assert.fail('no screen here'), dataUrl: async () => 'data:', reset: async () => {} }
  const copilot = new Copilot(() => {}, () => model, frames, agentAccess(store, agentId))
  return { copilot, inputs, state }
}

test("while the plan's limit is reached nothing is suggested on its own; once it starts over, it is again", async () => {
  const sales = await store.create('sales')
  const { copilot, inputs, state } = copilotWithPlan(sales.id, () => 'LEVEL: quick\nThirty seats come to 1,050 euros.')
  copilot.setListening(true)
  state.until = Date.now() + 60_000
  copilot.anticipate('How much is it for thirty seats?', Date.now() - 2000, 'seg-1')
  copilot.add('them', 'How much is it for thirty seats?', Date.now() - 2000, Date.now(), 'seg-1')
  await wait(500)
  assert.equal(inputs.length, 0)
  await copilot.assist({ kind: 'suggest' })
  assert.equal(quick(inputs).length, 1, 'Suggest still tries')
  state.until = 0
  copilot.add('them', 'And for forty?', Date.now() - 1000, Date.now())
  await wait(500)
  assert.equal(quick(inputs).length, 2)
  copilot.setListening(false)
})

test('frames wait out a reached limit, and are described once it starts over', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  const sales = await store.create('sales')
  const { copilot, inputs, state } = copilotWithPlan(sales.id, (input) => (input.lane === 'vision' ? 'F1: Slide: pricing for the Growth plan.' : 'LEVEL: quick\nOk.'))
  state.until = Date.now() + 120_000
  copilot.addFrame({ id: 'f1', n: 1, at: Date.now(), kind: 'snapshot', thumbUrl: '', imageUrl: '' })
  await flush()
  t.mock.timers.tick(100_000)
  await flush()
  assert.equal(inputs.length, 0)
  t.mock.timers.tick(30_001)
  await flush()
  assert.deepEqual(
    inputs.map((i) => i.lane),
    ['vision']
  )
})

test('near the limit, code on the screen is no reason to start the deep answer before the verdict', async () => {
  const sales = await store.create('sales')
  const lanes = async (saving) => {
    const { copilot, inputs, state } = copilotWithPlan(sales.id, (input) =>
      input.lane === 'vision' ? 'F1: Code: a TypeScript function mergeOrders that skips undefined orders.' : 'LEVEL: quick\nIt skips undefined orders, so check the input.'
    )
    state.saving = saving
    copilot.addFrame({ id: 'f1', n: 1, at: Date.now() - 1000, kind: 'snapshot', thumbUrl: '', imageUrl: '' })
    await wait(20)
    copilot.add('them', 'Why does this return null?', Date.now() - 1000, Date.now())
    await copilot.assist({ kind: 'suggest' })
    await wait(50)
    return inputs.map((i) => i.lane).filter((lane) => lane !== 'vision')
  }
  assert.deepEqual(await lanes(undefined), ['quick', 'deep'], 'a weak hunch starts it early')
  assert.deepEqual(await lanes('GPT-6 Luna'), ['quick'], 'saving: the quick verdict decides')
})

test('frames waiting out a limit a month away look again every minute, and are described once it lifts sooner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-23T10:00:00Z') })
  const flush = async () => {
    for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve))
  }
  const sales = await store.create('sales')
  const { copilot, inputs, state } = copilotWithPlan(sales.id, (input) => (input.lane === 'vision' ? 'F1: Slide: pricing for the Growth plan.' : 'LEVEL: quick\nOk.'))
  // Past what a timer can hold (about 24.8 days): it must not fire at once, again and again.
  state.until = Date.now() + 30 * 86_400_000
  copilot.addFrame({ id: 'f1', n: 1, at: Date.now(), kind: 'recorded', thumbUrl: '', imageUrl: '' })
  await flush()
  t.mock.timers.tick(5 * 60_000)
  await flush()
  assert.equal(inputs.length, 0)
  // An answer came through on credits, or another provider was picked: the limit is gone.
  state.until = 0
  t.mock.timers.tick(60_000)
  await flush()
  assert.deepEqual(
    inputs.map((i) => i.lane),
    ['vision']
  )
})

test("a call's share counts from the figures that come in after it starts, not from older ones", () => {
  const plan = new PlanWatch(() => undefined)
  const at = (used) => new Headers({ 'x-codex-primary-used-percent': String(used), 'x-codex-primary-window-minutes': '300', 'x-codex-primary-reset-at': '1793294059' })
  // Hours before the call.
  plan.seen(at(30), true)
  plan.callStarted()
  plan.update()
  assert.equal(plan.usage().call, undefined, 'not from what was used hours ago')
  plan.seen(at(40), true)
  plan.seen(at(44), true)
  assert.equal(plan.usage().call, 4)
})

test('a reached limit is the same one however often its end is estimated again; one reached after it ended is new', () => {
  const plan = new PlanWatch(() => undefined)
  const t0 = Date.parse('2026-10-23T10:00:00Z')
  // No reset time in the refusal: its end is estimated from each one.
  const refusal = (seconds) => JSON.stringify({ error: { type: 'usage_limit_reached', resets_in_seconds: seconds } })
  plan.refused(refusal(600), t0)
  const first = plan.usage(t0 + 1000).limitedSince
  plan.refused(refusal(540), t0 + 60_000)
  assert.equal(plan.usage(t0 + 61_000).limitedSince, first, 'the same reached limit')
  assert.notEqual(plan.usage(t0 + 61_000).limitedUntil, undefined)
  plan.seen(new Headers(), true)
  assert.equal(plan.usage().limitedSince, undefined, 'over: an answer came through')
  plan.refused(refusal(600))
  assert.notEqual(plan.usage().limitedSince, first, 'reached again: a new one')
})

test('a limit whose end is only estimated stays the same limit when it is found still reached after that', () => {
  const plan = new PlanWatch(() => undefined)
  const t0 = Date.parse('2026-10-23T10:00:00Z')
  // Turned down with no full window to say until when (an overage limit): estimated a few minutes ahead.
  const status = {
    rate_limit: { allowed: false, primary_window: { used_percent: 62, limit_window_seconds: 18000, reset_at: t0 / 1000 + 9000 } },
    credits: { has_credits: true, overage_limit_reached: true }
  }
  plan.status(status, t0)
  const first = plan.usage(t0 + 1000)
  // Asked again just after that estimate, as Togle does: still reached.
  plan.status(status, first.limitedUntil + 5000)
  assert.equal(plan.usage(first.limitedUntil + 6000).limitedSince, first.limitedSince, 'its notice, once dismissed, stays away')
})
