import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('claude-subscription')
const { ClaudeSubscriptionProvider, getSettings, updateSettings, loadSettings } = await import('./.build/togle.mjs')

const init = { type: 'system', subtype: 'init', mcp_servers: [{ name: 'togle', status: 'connected' }] }
const start = (id = 'm1') => ({ type: 'stream_event', event: { type: 'message_start', message: { id } } })
const delta = (text) => ({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
const assistant = (text, id = 'm1') => ({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } })
const result = (extra = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'LEVEL: quick\nHello.', num_turns: 1,
  modelUsage: { opus: { inputTokens: 20, cacheReadInputTokens: 70, cacheCreationInputTokens: 10, outputTokens: 12 } }, ...extra
})
const auth = {
  environment: () => ({}),
  status: async () => ({ available: true, signedIn: true, email: 'work@example.test' }), executable: () => 'official-claude.exe', directory: async () => '/togle/claude-runtime'
}

function setup(reply = async function* () { yield start(); yield delta('LEVEL: quick\nHello.'); yield assistant('LEVEL: quick\nHello.'); yield result() }) {
  const queries = []
  const models = [{ value: 'opus', displayName: 'Opus', supportsEffort: true, supportedEffortLevels: ['low', 'high'] }]
  const sdk = {
    createSdkMcpServer: (options) => options,
    tool: (name, description, inputSchema, handler) => ({ name, description, inputSchema, handler }),
    query: ({ prompt, options }) => {
      const call = { prompt: [], options, closed: false }
      queries.push(call)
      const query = (async function* () {
        for await (const message of prompt) call.prompt.push(message)
        yield init
        yield* reply(call)
      })()
      query.close = () => { call.closed = true }
      query.supportedModels = async () => models
      query.mcpServerStatus = async () => sdk.servers ?? []
      query.accountInfo = async () => ({ email: sdk.runtimeEmail ?? 'work@example.test' })
      return query
    }
  }
  const provider = new ClaudeSubscriptionProvider(auth, async () => sdk)
  return { provider, queries, sdk, models }
}

async function ask(provider, input = {}, extra = {}) {
  let text = ''
  const usages = []
  const calls = []
  await provider.stream({ lane: 'quick', system: 'Help on this call.', user: 'What does it cost?', ...input }, {
    signal: new AbortController().signal, onDelta: (part) => { text += part }, onUsage: (usage) => usages.push(usage),
    onToolCall: (...call) => calls.push(call), ...extra
  })
  return { text, usages, calls }
}

test('subscription requests stream once, carry images and chat history, and expose no built-in code tools or disk sessions', async () => {
  const { provider, queries } = setup()
  const { text, usages } = await ask(provider, {
    history: [{ role: 'user', text: 'Keep it short.' }, { role: 'assistant', text: 'I will.' }],
    images: [{ url: 'data:image/png;base64,QUJD', label: 'Frame F1' }]
  })
  assert.equal(text, 'LEVEL: quick\nHello.', 'the complete message does not repeat the streamed deltas')
  const [{ options, prompt, closed }] = queries
  assert.equal(options.model, 'opus')
  assert.equal(options.effort, 'low')
  assert.equal(options.systemPrompt, 'Help on this call.')
  assert.deepEqual(options.tools, [])
  assert.deepEqual(options.settingSources, [])
  assert.equal(options.persistSession, false)
  assert.equal(options.strictMcpConfig, true)
  assert.equal(options.pathToClaudeCodeExecutable, 'official-claude.exe')
  assert.equal(options.maxTurns, 1)
  assert.equal(options.env.ANTHROPIC_API_KEY, undefined)
  assert.match(prompt[0].message.content[0].text, /User:\nKeep it short\./)
  assert.match(prompt[0].message.content[0].text, /Assistant:\nI will\./)
  assert.deepEqual(prompt[0].message.content.at(-1), { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } })
  assert.equal(closed, true)
  assert.deepEqual([usages[0].input, usages[0].cached, usages[0].output, usages[0].rounds], [100, 70, 12, 1])
})

test('dictation can choose the fast SDK alias without a model-list round trip or changing call lanes', async () => {
  const { provider, queries } = setup()
  await ask(provider, { model: 'haiku', tools: [], webSearch: false })
  assert.equal(queries[0].options.model, 'haiku')
  await ask(provider)
  assert.equal(queries[1].options.model, 'opus')
})

test('prepared dictation starts the SDK without inference and delivers final text once in the same process', async () => {
  const { provider, queries } = setup()
  const output = [], controller = new AbortController()
  const prepared = await provider.prepareText({ lane: 'quick', system: 'Edit dictation.', user: 'Must not be sent early', model: 'haiku', tools: [], webSearch: false }, { signal: controller.signal, onDelta: value => output.push(value) })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(queries.length, 1, 'Runtime starts while the microphone is active')
  assert.deepEqual(queries[0].prompt, [], 'Warm-up never sends an empty or speculative inference request')
  assert.deepEqual(output, [])
  assert.equal(queries[0].closed, false)
  await prepared.send('{"dictated_text":"Please send the report."}')
  assert.equal(queries.length, 1)
  assert.equal(queries[0].prompt.length, 1)
  assert.equal(queries[0].prompt[0].message.content[0].text, '{"dictated_text":"Please send the report."}')
  assert.equal(queries[0].options.model, 'haiku'); assert.equal(queries[0].closed, true)
  await assert.rejects(prepared.send('Do not send twice'), /already been used/)
  prepared.close()
})

test('cancelled prepared cleanup releases the waiting SDK prompt without sending text', async () => {
  for (const via of ['close', 'signal']) {
    const { provider, queries } = setup(), controller = new AbortController()
    const prepared = await provider.prepareText({ lane: 'quick', system: 'Edit.', user: '' }, { signal: controller.signal, onDelta: () => assert.fail('No inference on cancellation') })
    await new Promise(resolve => setImmediate(resolve))
    if (via === 'close') prepared.close(); else controller.abort(new Error('Cancelled'))
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(queries[0].closed, true)
    assert.equal(queries[0].options.abortController.signal.aborted, true)
    assert.deepEqual(queries[0].prompt, [])
    await assert.rejects(async () => prepared.send('Late private words'), /closed|Cancelled/)
  }
})

test('final output excludes commentary from earlier tool rounds while live deltas remain unchanged', async () => {
  const { provider } = setup(async function* () {
    yield start('lookup')
    yield delta('I will read the calendar first. [not JSON]')
    yield assistant('I will read the calendar first. [not JSON]', 'lookup')
    yield start('answer')
    yield delta('[]')
    yield assistant('[]', 'answer')
    yield result({ result: '[]', num_turns: 2 })
  })
  const final = []
  const response = await ask(provider, {}, { onFinal: text => final.push(text) })
  assert.equal(response.text, 'I will read the calendar first. [not JSON][]')
  assert.deepEqual(final, ['[]'])

  const broken = setup(async function* () { yield result({ subtype: 'error_max_turns', is_error: true }) }).provider
  await assert.rejects(ask(broken, {}, { onFinal: text => final.push(text) }), /kept looking/)
  assert.deepEqual(final, ['[]'], 'an unsuccessful request has no final answer')
})

const connectedApp = (name = 'claude.ai Slack') => ({
  name, status: 'connected', source: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://example.test/mcp', id: 'private-connector-id' },
  tools: [
    { name: 'search', annotations: { readOnly: true } },
    { name: 'send_message', annotations: { openWorld: true } },
    { name: 'delete', annotations: { readOnly: true, destructive: true } },
    { name: 'unknown', annotations: {} }
  ]
})
const selection = { account: 'work@example.test', servers: ['claude.ai Slack'] }

test('connector discovery sends no prompt, returns no credentials, and shares concurrent discovery', async () => {
  const { provider, sdk, queries } = setup()
  sdk.servers = [connectedApp(), { ...connectedApp('claude.ai Spoof'), source: 'user' }]
  const [a, b] = await Promise.all([provider.connections(), provider.connections()])
  assert.deepEqual(a, b)
  assert.deepEqual(a, { account: 'work@example.test', apps: [{ name: 'claude.ai Slack', label: 'Slack', status: 'connected', readTools: 1 }] })
  assert.equal(queries.length, 1)
  assert.deepEqual(queries[0].prompt, [])
  assert.deepEqual(queries[0].options.settings.allowedMcpServers, [{ serverUrl: 'https://*' }])
  assert.ok(queries[0].closed)
  await provider.connections()
  assert.equal(queries.length, 1, 'reuse inventory, not another cold discovery')
  provider.clearConnections()
  await provider.connections()
  assert.equal(queries.length, 2)
})

test('selected connected apps work in a call while writes, unselected apps, and impersonating servers are denied', async () => {
  const { provider, sdk, queries } = setup(async function* (call) {
    const hook = call.options.hooks.PreToolUse[0].hooks[0]
    const event = { hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Slack__search', tool_input: { query: 'release blockers' }, mcp_server: { name: 'claude.ai Slack', source: 'claudeai' } }
    assert.deepEqual(await hook(event), {})
    for (const denied of [
      { ...event, tool_name: 'mcp__claude_ai_Slack__send_message' },
      { ...event, tool_name: 'mcp__claude_ai_Slack__delete' },
      { ...event, tool_name: 'mcp__claude_ai_Slack__unknown' },
      { ...event, tool_name: 'mcp__claude_ai_Gmail__search', mcp_server: { name: 'claude.ai Gmail', source: 'claudeai' } },
      { ...event, mcp_server: { name: 'claude.ai Slack', source: 'user' } },
      { ...event, mcp_server: undefined },
      { ...event, tool_name: 'Bash' }
    ]) assert.equal((await hook(denied)).hookSpecificOutput.permissionDecision, 'deny')
    assert.ok(call.options.disallowedTools.includes('mcp__claude_ai_Slack__send_message'))
    assert.deepEqual(call.options.settings.allowedMcpServers, [{ serverUrl: 'https://example.test/mcp' }])
    assert.ok(call.options.allowedTools.includes('mcp__claude_ai_Slack__search'))
    assert.ok(call.options.tools.includes('ToolSearch'))
    assert.match(JSON.stringify(call.prompt), /Connected work apps/)
    yield start(); yield delta('Release blockers found in Slack.'); yield result({ result: 'Release blockers found in Slack.' })
  })
  sdk.servers = [connectedApp(), connectedApp('claude.ai Gmail')]
  const response = await ask(provider, { claudeConnections: selection })
  assert.equal(response.text, 'Release blockers found in Slack.')
  assert.deepEqual(response.calls, [['claude_connection', { app: 'Slack' }]])
  assert.ok(queries.every(query => query.closed))
})

test('quick assistance starts with pending work apps and checks their live provenance when a tool is used', async () => {
  const { provider, sdk, queries } = setup(async function* (call) {
    assert.match(JSON.stringify(call.prompt), /pending/)
    const hook = call.options.hooks.PreToolUse[0].hooks[0]
    const event = { hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Slack__search', tool_input: { query: 'ticket status' }, mcp_server: { name: 'claude.ai Slack', source: 'claudeai' } }
    assert.equal((await hook(event)).hookSpecificOutput.permissionDecision, 'deny', 'a pending connector cannot claim a successful read')
    sdk.servers = [connectedApp()]
    assert.deepEqual(await hook(event), {}, 'the same request can read after the selected app finishes connecting')
    sdk.servers = [{ ...connectedApp(), source: 'user' }]
    assert.equal((await hook(event)).hookSpecificOutput.permissionDecision, 'deny', 'stale cached grants cannot authorize a spoofed server')
    yield start(); yield delta('I will verify the ticket status.'); yield result()
  })
  sdk.servers = [connectedApp()]
  await provider.connections()
  sdk.servers = [{ ...connectedApp(), status: 'pending' }]
  const started = performance.now()
  const response = await ask(provider, { claudeConnections: selection })
  assert.ok(performance.now() - started < 1000, 'a quick answer cannot wait the eight-second connector readiness window')
  assert.ok(response.usages[0].phases.connectionsMs < 1000)
  assert.equal(queries.length, 2, 'cached discovery is reused for the actual request')
  assert.ok(queries.every(query => query.closed))
})

test('changing Claude account does not inherit another account’s connector grants', async () => {
  const { provider, queries } = setup()
  await assert.rejects(ask(provider, { claudeConnections: { ...selection, account: 'personal@example.test' } }), /belong to personal@example.test/)
  assert.equal(queries.length, 0)
})

test('connector tools are rechecked in the actual request, even when the inventory was cached', async () => {
  const { provider, sdk } = setup(async function* (call) {
    const hook = call.options.hooks.PreToolUse[0].hooks[0]
    assert.equal((await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude_ai_Slack__search', mcp_server: { name: 'claude.ai Slack', source: 'claudeai' } })).hookSpecificOutput.permissionDecision, 'deny')
    yield result()
  })
  sdk.servers = [connectedApp()]
  await provider.connections()
  sdk.servers = [{ ...connectedApp(), tools: [{ name: 'search', annotations: {} }] }]
  await ask(provider, { claudeConnections: selection })
})

test('an account switched outside Togle cannot receive a meeting prompt through cached login status', async () => {
  const { provider, sdk, queries } = setup()
  sdk.servers = [connectedApp()]
  await provider.connections()
  sdk.runtimeEmail = 'personal@example.test'
  await assert.rejects(ask(provider, { claudeConnections: selection }), /Claude account changed/)
  assert.deepEqual(queries.at(-1).prompt, [], 'no company prompt sent to the replacement account')
  assert.ok(queries.at(-1).closed)
})

test('unavailable connectors are reported in context and cannot be used', async () => {
  const { provider, sdk } = setup(async function* (call) {
    assert.match(JSON.stringify(call.prompt), /needs-auth/)
    assert.ok(!call.options.allowedTools.includes('mcp__claude_ai_Slack__search'))
    yield result()
  })
  sdk.servers = [{ ...connectedApp(), status: 'needs-auth' }]
  await ask(provider, { claudeConnections: selection })
})

test('model discovery makes no inference request, closes its process, and reports model effort capabilities', async () => {
  const { provider, queries } = setup()
  assert.deepEqual(await provider.listModels(), [{ id: 'opus', label: 'Opus', reasoningLevels: ['low', 'high'] }])
  assert.deepEqual(queries[0].prompt, [], 'no prompt was sent')
  assert.equal(queries[0].closed, true)
  await ask(provider, { effort: 'max' })
  assert.equal(queries[1].options.effort, 'high')
})

test('Togle tools retain their schemas, run in the host, and feed the next SDK answer', async () => {
  let taught = ''
  const { provider } = setup(async function* (call) {
    yield start('tool-round')
    const [tool] = call.options.mcpServers.togle.tools
    assert.equal(tool.name, 'teach')
    assert.equal(tool.inputSchema.rule.safeParse(23).success, false)
    const answer = await tool.handler({ rule: 'Never invent a discount.' })
    assert.deepEqual(answer.content, [{ type: 'text', text: 'Kept.' }])
    yield start('answer-round')
    yield delta('I kept that rule.')
    yield assistant('I kept that rule.', 'answer-round')
    yield result({ result: 'I kept that rule.', num_turns: 2 })
  })
  const { text, calls } = await ask(provider, {
    toolsRequired: true,
    tools: [{ name: 'teach', description: 'Keep a rule.', parameters: { type: 'object', properties: { rule: { type: 'string' } }, required: ['rule'], additionalProperties: false }, run: async ({ rule }) => { taught = rule; return 'Kept.' } }]
  })
  assert.equal(taught, 'Never invent a discount.')
  assert.equal(text, 'I kept that rule.')
  assert.deepEqual(calls, [['teach', { rule: taught }]])
})

test('tool failures go back to Claude, and the lookup budget stops further host changes', async () => {
  const { provider } = setup(async function* (call) {
    const [tool] = call.options.mcpServers.togle.tools
    yield start()
    const failed = await tool.handler({})
    assert.equal(failed.isError, true)
    assert.match(failed.content[0].text, /Could not save/)
    yield start('second')
    const stopped = await tool.handler({})
    assert.match(stopped.content[0].text, /No more lookups/)
    yield result()
  })
  let asked = 0
  await ask(provider, { maxToolRounds: 1, tools: [{ name: 'teach', description: 'Keep a rule.', parameters: { type: 'object', properties: {} }, run: async () => { asked++; throw new Error('Could not save') } }] })
  assert.equal(asked, 1)
})

test('web search is optional, bounded to three calls, and reports progress', async () => {
  const { provider, queries } = setup(async function* (call) {
    const hook = call.options.hooks.PreToolUse[0].hooks[0]
    const search = { hook_event_name: 'PreToolUse', tool_name: 'WebSearch', tool_input: { query: 'What changed?' } }
    for (let i = 0; i < 3; i++) assert.deepEqual(await hook(search), {})
    assert.equal((await hook(search)).hookSpecificOutput.permissionDecision, 'deny')
    assert.equal((await hook({ ...search, tool_name: 'Bash' })).hookSpecificOutput.permissionDecision, 'deny')
    yield { type: 'assistant', message: { id: 'search', content: [{ type: 'tool_use', name: 'WebSearch', input: search.tool_input }] } }
    yield result()
  })
  const answer = await ask(provider, { webSearch: true })
  assert.deepEqual(queries[0].options.tools, ['WebSearch'])
  assert.deepEqual(answer.calls, [['web_search', { query: 'What changed?' }]])
  assert.equal(queries[0].options.permissionMode, 'dontAsk')
})

test('an expired subscription login never falls back to an API key', async () => {
  let loaded = false
  const provider = new ClaudeSubscriptionProvider({ ...auth, status: async () => ({ available: true, signedIn: false }) }, async () => { loaded = true; return setup().sdk })
  await assert.rejects(ask(provider), /Sign in with your Claude subscription/)
  assert.equal(loaded, false, 'neither SDK loading nor inference starts without a subscription login')
})

test('subscription errors are actionable and partial answers survive a failed result', async () => {
  for (const [error, expected] of [['authentication_failed', /Sign in again/], ['rate_limit', /rate limit/], ['billing_error', /subscription/]]) {
    const { provider, queries } = setup(async function* () { yield { type: 'assistant', error, message: { id: 'error', content: [] } } })
    await assert.rejects(ask(provider), expected)
    assert.equal(queries[0].closed, true)
  }
  let text = ''
  const { provider } = setup(async function* () { yield start(); yield delta('The first point.'); yield result({ subtype: 'error_during_execution', is_error: true, errors: ['Connection lost'] }) })
  await assert.rejects(ask(provider, {}, { onDelta: (part) => { text += part } }), /Connection lost/)
  assert.equal(text, 'The first point.')
  const org = setup(async function* () {
    yield { ...assistant('Your organization has disabled Claude subscription access for Claude Code.'), error: 'oauth_org_not_allowed' }
  })
  await assert.rejects(ask(org.provider), /organization has disabled Claude subscription access/)
})

test('API-key models and subscription models keep separate choices across restarts', async () => {
  await updateSettings({ claude: { auth: 'subscription', subscriptionLanes: { ...getSettings().claude.subscriptionLanes, quick: { model: 'haiku', effort: 'low' } } } })
  const apiModel = getSettings().claude.lanes.quick.model
  await loadSettings()
  const { provider, queries } = setup()
  await ask(provider)
  assert.equal(queries[0].options.model, 'haiku')
  assert.equal(getSettings().claude.lanes.quick.model, apiModel)
})

test('stopping a subscription answer aborts its SDK query and closes the process', async () => {
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  const { provider, queries } = setup(async function* (call) {
    yield start()
    ready()
    await new Promise((resolve) => call.options.abortController.signal.addEventListener('abort', resolve, { once: true }))
    yield result()
  })
  const controller = new AbortController()
  const reply = ask(provider, {}, { signal: controller.signal })
  await started
  controller.abort(new Error('Stopped on purpose'))
  await assert.rejects(reply, /Stopped on purpose/)
  assert.equal(queries[0].options.abortController.signal.aborted, true)
  assert.equal(queries[0].closed, true)
})

test('Train refuses an SDK run whose training server did not connect', async () => {
  const { provider, sdk, queries } = setup()
  const original = sdk.query
  sdk.query = (params) => {
    const query = original(params)
    const failed = (async function* () { yield { ...init, mcp_servers: [{ name: 'togle', status: 'failed' }] } })()
    failed.close = query.close
    return failed
  }
  await assert.rejects(ask(provider, {
    toolsRequired: true,
    tools: [{ name: 'teach', description: 'Keep a rule.', parameters: { type: 'object', properties: {} }, run: async () => assert.fail('a disconnected tool cannot run') }]
  }), /could not connect/)
  assert.equal(queries[0].closed, true)
})
