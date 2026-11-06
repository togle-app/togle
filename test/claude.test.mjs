// Claude through an Anthropic API key: what each request asks for, the tool and web-search rounds, and what errors say.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

workDir('claude')
const { ClaudeProvider, getSettings, updateSettings } = await import('./.build/togle.mjs')

const KEY = 'sk-ant-test-key'

/** A streamed Messages API response: the blocks as the API streams them, then why it stopped and what it cost. */
function message({ content, stop = 'end_turn', usage = {} }) {
  const events = [
    {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.input ?? 100, cache_creation_input_tokens: usage.written ?? 0, cache_read_input_tokens: usage.read ?? 0, output_tokens: 1 }
      }
    }
  ]
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } })
      for (const citation of block.citations ?? []) events.push({ type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } })
    } else if (block.type === 'thinking') {
      events.push({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: block.signature } })
    } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      events.push({ type: 'content_block_start', index, content_block: { type: block.type, id: block.id, name: block.name, input: {} } })
      events.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    } else {
      events.push({ type: 'content_block_start', index, content_block: block })
    }
    events.push({ type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: usage.output ?? 20 } })
  events.push({ type: 'message_stop' })
  return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' }
  })
}

const apiError = (status, type, text, headers = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message: text } }), { status, headers: { 'content-type': 'application/json', ...headers } })

/**
 * The API answers each Messages request with the next scripted response, and keeps what it was asked. The model
 * list (which the provider also asks for in the background) has its own answer: `models`, or none.
 */
function api(responses, models = []) {
  const sent = []
  electron.net.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === '/v1/models') return Response.json({ data: models, has_more: false, first_id: models[0]?.id ?? null, last_id: models.at(-1)?.id ?? null })
    const headers = new Headers(init?.headers)
    sent.push({ path, headers, body: init?.body ? JSON.parse(init.body) : undefined })
    const next = responses.shift()
    if (!next) throw new Error('the API was asked more often than scripted')
    return typeof next === 'function' ? next() : next
  }
  return sent
}

async function provider() {
  const claude = new ClaudeProvider()
  await claude.setApiKey(KEY)
  return claude
}

async function ask(claude, input, extra = {}) {
  let text = ''
  const usages = []
  const calls = []
  await claude.stream(
    { system: 'You are my sales agent. Our Growth plan is 35 euros a seat.', user: 'What does it cost for thirty seats?', ...input },
    { signal: new AbortController().signal, onDelta: (d) => (text += d), onToolCall: (name, args) => calls.push([name, args]), onUsage: (u) => usages.push(u), ...extra }
  )
  return { text, usage: usages[0], calls }
}

test("a quick answer: the lane's model and effort, the agent's setup cached, frames as images, and the cache in the tokens", async () => {
  const claude = await provider()
  const sent = api([message({ content: [{ type: 'text', text: 'LEVEL: quick\nThirty seats come to 1,050 euros a month.' }], usage: { input: 60, read: 900, output: 30 } })])
  const { text, usage } = await ask(claude, {
    lane: 'quick',
    images: [
      { url: 'data:image/jpeg;base64,QUJD', label: 'Frame F1 (shown 10:02:03)' },
      { url: '', label: 'Frame F2' }
    ]
  })
  assert.equal(text, 'LEVEL: quick\nThirty seats come to 1,050 euros a month.')
  const [{ path, headers, body }] = sent
  assert.equal(path, '/v1/messages')
  assert.equal(headers.get('authorization'), `Bearer ${KEY}`, 'the SDK sends the key as a bearer token')
  assert.match(headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/)
  assert.equal(body.model, 'claude-opus-5-5')
  assert.equal(body.max_tokens, 8000)
  assert.deepEqual(body.output_config, { effort: 'low' })
  assert.equal(body.fallbacks, 'default')
  assert.equal(body.thinking, undefined, 'thinking stays adaptive: effort is the control')
  assert.deepEqual(body.system, [{ type: 'text', text: 'You are my sales agent. Our Growth plan is 35 euros a seat.', cache_control: { type: 'ephemeral' } }])
  assert.equal(body.tools, undefined)
  assert.equal(body.cache_control, undefined, 'one round only: the question at the end would be written to the cache for nothing')
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What does it cost for thirty seats?' },
        { type: 'text', text: 'Frame F1 (shown 10:02:03)' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }
      ]
    }
  ])
  assert.deepEqual(
    { input: usage.input, cached: usage.cached, output: usage.output, rounds: usage.rounds, model: usage.model, end: usage.end },
    { input: 960, cached: 900, output: 30, rounds: 1, model: 'claude-opus-5-5', end: 'done' }
  )
})

test('the call so far goes in blocks, the newest that repeats marked for the cache, so the next answer reads it from there', async () => {
  const claude = await provider()
  const sent = api([message({ content: [{ type: 'text', text: 'LEVEL: quick\nYes.' }] })])
  const user = 'Task.\n\nTimeline:\n[10:00] Them: a\n[10:01] Me: b\n[10:02] Them: c\n\nWhat they just said: "c"'
  const cuts = [user.indexOf('[10:01]'), user.indexOf('[10:02]')]
  await ask(claude, { lane: 'quick', user, userCuts: cuts })
  const [{ body }] = sent
  assert.deepEqual(body.messages[0].content, [
    { type: 'text', text: 'Task.\n\nTimeline:\n[10:00] Them: a\n' },
    { type: 'text', text: '[10:01] Me: b\n', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '[10:02] Them: c\n\nWhat they just said: "c"' }
  ])
  assert.equal(body.messages[0].content.map((block) => block.text).join(''), user, 'the same text, only in blocks')
})

test("a lookup goes back with the model's whole turn and the tool's result; the conversation is cached for that round", async () => {
  const claude = await provider()
  const sent = api([
    message({
      content: [
        { type: 'thinking', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'search_knowledge', input: { query: 'Growth plan seats' } }
      ],
      stop: 'tool_use'
    }),
    message({ content: [{ type: 'text', text: 'Thirty seats come to 1,050 euros a month [1].' }] })
  ])
  const search = {
    name: 'search_knowledge',
    description: 'Search my knowledge base.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: async ({ query }) => `[1] Pricing: ${query} cost 35 euros each.`
  }
  const { text, usage, calls } = await ask(claude, { lane: 'quick', tools: [search], maxToolRounds: 1 })
  assert.equal(text, 'Thirty seats come to 1,050 euros a month [1].')
  assert.deepEqual(calls, [['search_knowledge', { query: 'Growth plan seats' }]])
  const [first, second] = sent.map((r) => r.body)
  assert.deepEqual(first.tools, [
    { name: 'search_knowledge', description: 'Search my knowledge base.', input_schema: search.parameters, eager_input_streaming: true }
  ])
  assert.deepEqual(first.tool_choice, { type: 'auto', disable_parallel_tool_use: true })
  assert.deepEqual(first.cache_control, { type: 'ephemeral' })
  assert.deepEqual(second.tool_choice, { type: 'auto', disable_parallel_tool_use: true }, 'the same in every round, so the cache stays valid')
  assert.deepEqual(second.messages.slice(1), [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '', signature: 'sig-1' },
        { type: 'tool_use', id: 'toolu_1', name: 'search_knowledge', input: { query: 'Growth plan seats' } }
      ]
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[1] Pricing: Growth plan seats cost 35 euros each.' }] }
  ])
  assert.equal(usage.rounds, 2)
})

test('a deep answer may search the web: the search shows as it starts, a paused turn carries on, and the pages it cites end the answer', async () => {
  const claude = await provider()
  const result = { type: 'web_search_result', url: 'https://www.acme.com/pricing', title: 'Acme pricing', encrypted_content: 'enc', page_age: null }
  const sent = api([
    message({
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Acme pricing 2026' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [result] }
      ],
      stop: 'pause_turn'
    }),
    message({
      content: [
        {
          type: 'text',
          text: 'Acme raised its prices this year.',
          citations: [{ type: 'web_search_result_location', url: 'https://www.acme.com/pricing', title: 'Acme pricing', encrypted_index: 'idx', cited_text: 'New prices from 2026' }]
        }
      ]
    })
  ])
  const { text, calls } = await ask(claude, { lane: 'deep', user: 'How does Acme price this now?', webSearch: true })
  assert.equal(text, 'Acme raised its prices this year.\n\nFrom the web: Acme pricing (acme.com)')
  assert.deepEqual(calls, [['web_search', { query: 'Acme pricing 2026' }]])
  const [first, second] = sent.map((r) => r.body)
  assert.deepEqual(first.tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }])
  assert.deepEqual(first.output_config, { effort: 'high' })
  assert.equal(first.max_tokens, 32000)
  assert.equal(second.messages.length, 2, 'the paused turn goes back as it was')
  assert.deepEqual(second.tools, first.tools, 'the same tools in every round: changing them would throw away the cache')
  assert.equal(second.messages[1].role, 'assistant')
  assert.deepEqual(
    second.messages[1].content.map((b) => b.type),
    ['server_tool_use', 'web_search_tool_result']
  )

  await updateSettings({ claude: { webSearch: false } })
  try {
    const off = api([message({ content: [{ type: 'text', text: 'From what I know, …' }] })])
    await ask(claude, { lane: 'deep', webSearch: true })
    assert.equal(off[0].body.tools, undefined)
  } finally {
    await updateSettings({ claude: { webSearch: true } })
  }
  // Train runs on the deep lane too, but changes the agent: no web pages for it.
  const train = api([message({ content: [{ type: 'text', text: 'Saved the fact.' }] })])
  await ask(claude, { lane: 'deep' })
  assert.equal(train[0].body.tools, undefined)
})

test('Haiku goes without a fallback; another model per job comes from Settings', async () => {
  const claude = await provider()
  const lanes = getSettings().claude.lanes
  await updateSettings({ claude: { lanes: { ...lanes, background: { model: 'claude-haiku-5-5', effort: 'none' } } } })
  try {
    const sent = api([message({ content: [{ type: 'text', text: '## Notes' }] })])
    await ask(claude, { lane: 'background' })
    assert.equal(sent[0].body.model, 'claude-haiku-5-5')
    assert.deepEqual(sent[0].body.output_config, { effort: 'low' }, "below Claude's scale is its lowest")
    assert.equal(sent[0].body.fallbacks, undefined)
    assert.doesNotMatch(sent[0].headers.get('anthropic-beta') ?? '', /server-side-fallback/)
  } finally {
    await updateSettings({ claude: { lanes } })
  }
})

test('errors say what to do: the key, the account, the rate limit, and no key at all', async () => {
  const claude = await provider()
  api([apiError(401, 'authentication_error', 'invalid x-api-key')])
  await assert.rejects(ask(claude, { lane: 'quick' }), /^Error: Anthropic turned down the API key\. Check it in Settings\.$/)
  api([apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')])
  await assert.rejects(ask(claude, { lane: 'quick' }), /Anthropic turned the request down: .*credit balance is too low/)
  const limited = () => apiError(429, 'rate_limit_error', 'Number of request tokens has exceeded your per-minute rate limit', { 'retry-after': '20' })
  const sent = api([limited(), limited()])
  await assert.rejects(ask(claude, { lane: 'quick' }), /hit its rate limit\. Try again in 20 s\./)
  assert.equal(sent.length, 1, 'a quick answer does not wait 20 s to be tried again')
  const usages = []
  claude.onUsage = (u) => usages.push(u)
  await claude.setApiKey('')
  await assert.rejects(ask(claude, { lane: 'quick' }), /Add your Anthropic API key first, in Settings/)
  assert.equal(usages.at(-1).end, 'failed')
})

test('the model list carries the effort levels each model takes', async () => {
  const claude = await provider()
  const effort = (levels) => ({
    supported: true,
    ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, { supported: levels.includes(l) }]))
  })
  api(
    [],
    [
      { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z', capabilities: { effort: effort(['low', 'medium', 'high', 'xhigh', 'max']) } },
      { type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z', capabilities: { effort: effort(['low', 'medium', 'high', 'max']) } },
      { type: 'model', id: 'claude-old', display_name: 'Claude Old', created_at: '2025-01-01T00:00:00Z', capabilities: null }
    ]
  )
  assert.deepEqual(await claude.listModels(), [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', reasoningLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', reasoningLevels: ['low', 'medium', 'high', 'max'] },
    { id: 'claude-old', label: 'Claude Old', reasoningLevels: undefined }
  ])
})

/** A response that streams these events, then breaks off the way a dropped connection does. */
function cutOff(events) {
  const body = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`))
      // A moment later: erroring at once would throw away what's still queued.
      setTimeout(() => controller.error(new TypeError('net::ERR_CONNECTION_RESET')), 20)
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
const started = { type: 'message_start', message: { id: 'msg_x', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }

test('a round that broke off before writing anything is asked again; once its words are on the card it is not', async () => {
  const claude = await provider()
  api([cutOff([started]), message({ content: [{ type: 'text', text: 'Thirty seats are 1,050 euros.' }] })])
  assert.equal((await ask(claude, { lane: 'quick' })).text, 'Thirty seats are 1,050 euros.')
  const overloaded = new Response(
    `event: message_start\ndata: ${JSON.stringify(started)}\n\nevent: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
  api([overloaded, message({ content: [{ type: 'text', text: 'Yes.' }] })])
  assert.equal((await ask(claude, { lane: 'quick' })).text, 'Yes.', 'overloaded while streaming, before any text')
  const writing = [
    started,
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Thirty seats are' } }
  ]
  const sent = api([cutOff(writing), message({ content: [{ type: 'text', text: 'Thirty seats are 1,050 euros.' }] })])
  let shown = ''
  await assert.rejects(
    claude.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: (d) => (shown += d) }),
    (err) => !/Thirty seats/.test(err.message)
  )
  assert.equal(shown, 'Thirty seats are', 'no second copy of what was already shown')
  assert.equal(sent.length, 1)
  // An error the API sends while streaming says what it is, in words.
  const overloadedAgain = () =>
    new Response(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  api([overloadedAgain(), overloadedAgain()])
  await assert.rejects(ask(claude, { lane: 'quick' }), /^Error: Claude is overloaded right now/)
})

test("the effort fits the model, the agent's own Claude model is used, and another provider's model is not", async () => {
  const claude = await provider()
  const effort = (levels) => (levels ? { supported: true, ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((l) => [l, { supported: levels.includes(l) }])) } : { supported: false })
  const model = (id, levels) => ({ type: 'model', id, display_name: id, created_at: '2026-01-01T00:00:00Z', capabilities: { effort: effort(levels) } })
  const listed = [model('claude-opus-5-5', ['low', 'medium', 'high', 'xhigh', 'max']), model('claude-opus-4-6', ['low', 'medium', 'high', 'max']), model('claude-haiku-4-5')]
  const sent = api(
    [
      message({ content: [{ type: 'text', text: '- one' }] }),
      message({ content: [{ type: 'text', text: '- two' }] }),
      message({ content: [{ type: 'text', text: '- three' }] }),
      message({ content: [{ type: 'text', text: '- four' }] })
    ],
    listed
  )
  await claude.listModels()
  await ask(claude, { lane: 'deep', model: 'claude-opus-4-6', effort: 'xhigh' })
  await ask(claude, { lane: 'deep', model: 'claude-haiku-4-5' })
  await ask(claude, { lane: 'deep', model: 'gpt-6.1-sol' })
  await ask(claude, { lane: 'deep', model: 'claude-not-listed' })
  assert.deepEqual(
    sent.map((r) => [r.body.model, r.body.output_config?.effort]),
    [
      ['claude-opus-4-6', 'high'],
      ['claude-haiku-4-5', undefined],
      ['claude-opus-5-5', 'high'],
      ['claude-opus-5-5', 'high']
    ]
  )
})

test("the key goes to Anthropic whatever the environment says for other tools, and a chat may start with Togle's turn", async () => {
  const saved = { base: process.env.ANTHROPIC_BASE_URL, headers: process.env.ANTHROPIC_CUSTOM_HEADERS, token: process.env.ANTHROPIC_AUTH_TOKEN }
  process.env.ANTHROPIC_BASE_URL = 'https://gateway.example.com'
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'X-Gateway-Team: platform\nX-Other: 1'
  process.env.ANTHROPIC_AUTH_TOKEN = 'someone-elses-token'
  try {
    const claude = await provider()
    const urls = []
    const sent = api([message({ content: [{ type: 'text', text: 'Saved.' }] })])
    const fetchBefore = electron.net.fetch
    electron.net.fetch = (url, init) => {
      urls.push(String(url))
      return fetchBefore(url, init)
    }
    await ask(claude, {
      lane: 'deep',
      history: [
        { role: 'assistant', text: 'What should I learn?' },
        { role: 'user', text: 'Our Growth plan is 35 euros.' },
        { role: 'assistant', text: 'Noted.' }
      ]
    })
    assert.ok(urls.length && urls.every((u) => u.startsWith('https://api.anthropic.com/v1/')), JSON.stringify(urls))
    assert.equal(sent[0].headers.get('x-gateway-team'), null)
    assert.equal(sent[0].headers.get('x-other'), null)
    assert.equal(sent[0].headers.get('authorization'), `Bearer ${KEY}`)
    assert.deepEqual(
      sent[0].body.messages.map((m) => m.role),
      ['user', 'assistant', 'user', 'assistant', 'user'],
      "the chat opens with the user's turn"
    )
  } finally {
    for (const [name, value] of [
      ['ANTHROPIC_BASE_URL', saved.base],
      ['ANTHROPIC_CUSTOM_HEADERS', saved.headers],
      ['ANTHROPIC_AUTH_TOKEN', saved.token]
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

/** A response that writes some text, then sends nothing but pings (as while the model searches), then finishes. */
function quietThenDone({ quietMs, pings }) {
  const enc = (e) => new TextEncoder().encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(enc(started))
      controller.enqueue(enc({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }))
      controller.enqueue(enc({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me look that up. ' } }))
      for (let t = 0; t < quietMs; t += 100) {
        await new Promise((r) => setTimeout(r, 100))
        if (pings) controller.enqueue(enc({ type: 'ping' }))
      }
      controller.enqueue(enc({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'It is in Frankfurt.' } }))
      controller.enqueue(enc({ type: 'content_block_stop', index: 0 }))
      controller.enqueue(enc({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }))
      controller.enqueue(enc({ type: 'message_stop' }))
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

test('an answer that goes quiet while the model searches keeps going on its pings; one with no bytes at all is given up', async () => {
  const claude = new ClaudeProvider(300)
  await claude.setApiKey(KEY)
  api([quietThenDone({ quietMs: 900, pings: true })])
  assert.equal((await ask(claude, { lane: 'deep' })).text, 'Let me look that up. It is in Frankfurt.')
  api([quietThenDone({ quietMs: 900, pings: false })])
  await assert.rejects(ask(claude, { lane: 'deep' }), /Claude stopped responding/)
})

test('a lookup past the ones allowed is answered with "no more lookups", and the next round answers', async () => {
  const claude = await provider()
  const sent = api([
    message({ content: [{ type: 'tool_use', id: 'toolu_1', name: 'search_knowledge', input: { query: 'seats' } }], stop: 'tool_use' }),
    message({ content: [{ type: 'tool_use', id: 'toolu_2', name: 'search_knowledge', input: { query: 'more seats' } }], stop: 'tool_use' }),
    message({ content: [{ type: 'text', text: 'Thirty seats come to 1,050 euros a month.' }] })
  ])
  const looked = []
  const search = { name: 'search_knowledge', description: 'Search.', parameters: { type: 'object', properties: { query: { type: 'string' } } }, run: async ({ query }) => (looked.push(query), `found ${query}`) }
  const { text } = await ask(claude, { lane: 'quick', tools: [search], maxToolRounds: 1 })
  assert.equal(text, 'Thirty seats come to 1,050 euros a month.')
  assert.deepEqual(looked, ['seats'], 'the second lookup is not run')
  assert.deepEqual(sent[2].body.messages.at(-1).content, [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'No more lookups: answer now with what you have.' }])
  assert.deepEqual(new Set(sent.map((r) => JSON.stringify(r.body.tool_choice))).size, 1, 'tool choice never changes')
})

test("custom headers in the environment for another tool can't replace Togle's key or beta header", async () => {
  const saved = process.env.ANTHROPIC_CUSTOM_HEADERS
  process.env.ANTHROPIC_CUSTOM_HEADERS = 'anthropic-beta: context-1m-2025-08-07\nAuthorization: Bearer someone-else\nX-Team: platform'
  try {
    const claude = await provider()
    const sent = api([message({ content: [{ type: 'text', text: 'Ok.' }] })])
    await ask(claude, { lane: 'quick' })
    assert.equal(sent[0].headers.get('authorization'), `Bearer ${KEY}`)
    assert.match(sent[0].headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/)
    assert.doesNotMatch(sent[0].headers.get('anthropic-beta') ?? '', /context-1m/)
    assert.equal(sent[0].headers.get('x-team'), null)
    assert.equal(sent[0].headers.get('x-togle-round'), null, 'the tag for watching the response stays on this PC')
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS
    else process.env.ANTHROPIC_CUSTOM_HEADERS = saved
  }
})

test('running out of time reads as that, not as a problem at Anthropic', async () => {
  const claude = await provider()
  api([quietThenDone({ quietMs: 2000, pings: true })])
  await assert.rejects(
    claude.stream({ system: 'S', user: 'Q', lane: 'deep' }, { signal: AbortSignal.timeout(300), onDelta: () => {} }),
    (err) => err.name === 'TimeoutError'
  )
})

test('a saved task model that disappeared from the API catalog cannot silently become the global model', async () => {
  const claude = await provider()
  const sent = api([], [{ id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' }])
  await claude.listModels()
  await assert.rejects(claude.stream({ system: 'S', user: 'Q', lane: 'deep', model: 'claude-opus-retired', fixedModel: true }, { signal: AbortSignal.timeout(1000), onDelta: () => {} }), /no longer available/)
  assert.equal(sent.length, 0)
})

test('an explicit task model does not opt into a different server-side fallback model', async () => {
  const claude = await provider()
  const sent = api([message({ content: [{ type: 'text', text: 'Pinned reply.' }] })], [{ id: 'claude-opus-5-5', display_name: 'Opus 5.5' }])
  await claude.listModels()
  await claude.stream({ system: 'S', user: 'Q', lane: 'deep', model: 'claude-opus-5-5', fixedModel: true }, { signal: AbortSignal.timeout(3000), onDelta: () => {} })
  assert.equal(sent[0].body.model, 'claude-opus-5-5')
  assert.equal(sent[0].body.fallbacks, undefined)
  assert.doesNotMatch(sent[0].headers.get('anthropic-beta') || '', /server-side-fallback/)
})
