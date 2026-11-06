// The OpenAI-compatible provider: what its requests cost, for the performance log.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { sse, workDir } from './helpers.mjs'

workDir('compat')
const { CompatProvider, updateSettings } = await import('./.build/togle.mjs')

test('every request is reported as it ends, with the tokens the server sent', async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const reported = []
  provider.onUsage = (u) => reported.push(u)
  electron.net.fetch = async () =>
    sse(
      { choices: [{ delta: { content: 'Thirty seats.' } }] },
      { choices: [], usage: { prompt_tokens: 120, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 100 } } }
    )
  let text = ''
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
  assert.equal(text, 'Thirty seats.')
  electron.net.fetch = async () => new Response('no such model', { status: 404 })
  await assert.rejects(provider.stream({ system: 'S', user: 'Q', lane: 'vision' }, { signal: new AbortController().signal, onDelta: () => {} }))
  assert.deepEqual(
    reported.map((u) => [u.lane, u.end, u.input, u.cached, u.output]),
    [
      ['quick', 'done', 120, 100, 4],
      ['vision', 'failed', 0, 0, 0]
    ]
  )
})

test("it asks for each request's tokens, and asks a server that refuses that without it from then on", async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:5678/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const sent = []
  electron.net.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    sent.push(!!body.stream_options?.include_usage)
    if (body.stream_options) return new Response(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }), { status: 400 })
    return sse({ choices: [{ delta: { content: 'Ok.' } }] })
  }
  const ask = () => provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: () => {} })
  await ask()
  await ask()
  assert.deepEqual(sent, [true, false, false])
})

test('a server that refuses it with a 422 and a list of what was wrong is asked without it too', async () => {
  // As Mistral answers: the message is a list of validation errors, not text.
  await updateSettings({ compat: { baseUrl: 'http://localhost:4321/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const sent = []
  electron.net.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    sent.push(!!body.stream_options)
    if (body.stream_options)
      return new Response(
        JSON.stringify({ object: 'error', message: { detail: [{ type: 'extra_forbidden', loc: ['body', 'stream_options'], msg: 'Extra inputs are not permitted' }] } }),
        { status: 422 }
      )
    return sse({ choices: [{ delta: { content: 'Ok.' } }] })
  }
  let text = ''
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
  assert.equal(text, 'Ok.')
  assert.deepEqual(sent, [true, false])
  // Any other 422 is the error it is, shown as what it says.
  electron.net.fetch = async () => new Response(JSON.stringify({ message: { detail: [{ loc: ['body', 'model'], msg: 'Unknown model' }] } }), { status: 422 })
  await assert.rejects(
    provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: () => {} }),
    /The AI service turned the request down \(422\): .*Unknown model/
  )
})

test("a request that runs out of its caller's time limit failed; one stopped by the caller didn't", async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:1234/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const reported = []
  provider.onUsage = (u) => reported.push(u.end)
  electron.net.fetch = (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
  const ask = (signal) => provider.stream({ system: 'S', user: 'Q', lane: 'vision' }, { signal, onDelta: () => {} })
  await assert.rejects(ask(AbortSignal.timeout(20)))
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 20)
  await assert.rejects(ask(stop.signal))
  assert.deepEqual(reported, ['failed', 'stopped'])
})

/** A server that answers each request with the next scripted stream (a list of chunks), and keeps what it was sent. */
function server(rounds) {
  const sent = []
  electron.net.fetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    sent.push(body)
    const next = rounds.shift()
    return typeof next === 'function' ? next(body) : sse(...next)
  }
  return sent
}
const lookup = {
  name: 'search_knowledge',
  description: 'Search.',
  parameters: { type: 'object', properties: { query: { type: 'string' } } },
  run: async ({ query }) => `[1] Scale plan: 49 euros a seat (${query})`
}

test('a model that looks something up gets the result, then answers with it', async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:1111/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const sent = server([
    [
      // The call comes in pieces: its name, then its arguments a few characters at a time.
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_knowledge', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query": "sca' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'le plan"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 900, completion_tokens: 12 } }
    ],
    [{ choices: [{ delta: { content: 'The Scale plan is 49 euros a seat.' } }] }, { choices: [], usage: { prompt_tokens: 950, completion_tokens: 9 } }]
  ])
  const looked = []
  let text = ''
  let usage
  await provider.stream(
    { system: 'S', user: 'What does the Scale plan cost?', lane: 'quick', tools: [lookup], maxToolRounds: 2 },
    { signal: new AbortController().signal, onDelta: (d) => (text += d), onToolCall: (name, args) => looked.push([name, args]), onUsage: (u) => (usage = u) }
  )
  assert.equal(text, 'The Scale plan is 49 euros a seat.')
  assert.deepEqual(looked, [['search_knowledge', { query: 'scale plan' }]])
  assert.deepEqual(sent[0].tools, [{ type: 'function', function: { name: 'search_knowledge', description: 'Search.', parameters: lookup.parameters } }])
  assert.equal(sent[0].tool_choice, 'auto')
  assert.deepEqual(sent[1].messages.slice(-2), [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'search_knowledge', arguments: '{"query": "scale plan"}' } }] },
    { role: 'tool', tool_call_id: 'call_a', content: '[1] Scale plan: 49 euros a seat (scale plan)' }
  ])
  assert.deepEqual([usage.rounds, usage.input, usage.output], [2, 1850, 21], 'both rounds counted')
})

test('past the lookups allowed it has to answer; a server that numbers no calls still pairs them with results', async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:2222/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const sent = server([
    // Whole calls in one chunk, without index or id, as some local servers send them.
    [{ choices: [{ delta: { tool_calls: [{ function: { name: 'search_knowledge', arguments: '{"query":"seats"}' } }] } }] }],
    [{ choices: [{ delta: { content: 'Thirty seats.' } }] }]
  ])
  let text = ''
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick', tools: [lookup], maxToolRounds: 1 }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
  assert.equal(sent[1].tool_choice, 'none')
  const [asked, result] = sent[1].messages.slice(-2)
  assert.equal(asked.tool_calls[0].id, result.tool_call_id)
  assert.ok(result.tool_call_id)
  assert.equal(text, 'Thirty seats.')
})

test("a server that looks things up when told to answer (Ollama doesn't take tool_choice) is asked again with no tools", async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1' } })
  const provider = new CompatProvider()
  const call = (query) => [{ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${query}`, function: { name: 'search_knowledge', arguments: JSON.stringify({ query }) } }] } }] }]
  const sent = server([call('seats'), call('more seats'), [{ choices: [{ delta: { content: 'Thirty seats.' } }] }], call('price'), [{ choices: [{ delta: { content: '49 euros.' } }] }]])
  const looked = []
  const ask = async (user) => {
    let text = ''
    await provider.stream(
      { system: 'S', user, lane: 'quick', tools: [lookup], maxToolRounds: 1 },
      { signal: new AbortController().signal, onDelta: (d) => (text += d), onToolCall: (_name, args) => looked.push(args.query) }
    )
    return text
  }
  assert.equal(await ask('How many seats?'), 'Thirty seats.', 'an answer, not an empty card')
  assert.deepEqual(looked, ['seats'], 'the lookup it was told not to make is not made')
  assert.equal(sent[2].tools, undefined)
  assert.equal(sent[2].messages.at(-1).role, 'tool', 'it answers from what the first lookup found')
  // The next question's last round lists no tools to begin with: no request wasted on a lookup it can't make.
  assert.equal(await ask('And the price?'), '49 euros.')
  assert.deepEqual(
    sent.map((body) => !!body.tools),
    [true, true, false, true, false]
  )
  assert.equal(provider.supportsTools, true, 'its lookups still work')
})

test("a reasoning model's thinking written into the answer text is left out", async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:1234/v1', model: 'qwen3' } })
  const provider = new CompatProvider()
  const ask = async (...pieces) => {
    server([pieces.map((content) => ({ choices: [{ delta: { content } }] }))])
    let text = ''
    await provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
    return text
  }
  // As the server streams it: the tags come split across pieces.
  assert.equal(await ask('<thi', 'nk>\nThey ask about seats; the brief says thirty.\n</th', 'ink>\n\nThirty', ' seats.'), 'Thirty seats.')
  assert.equal(await ask('\n<think>Short.</think>Thirty seats.'), 'Thirty seats.')
  assert.equal(await ask('<5 seats', ' left.'), '<5 seats left.', 'text that only starts like the tag is the answer')
  assert.equal(await ask('<'), '<')
  assert.equal(await ask('Thirty seats, <think> is a tag.'), 'Thirty seats, <think> is a tag.', 'only thinking before the answer is left out')
})

test('a prompt too long with its tools is the error it is, not a model that turns tools down', async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:5555/v1', model: 'gpt-4o-mini' } })
  const provider = new CompatProvider()
  const message =
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens (129000 in the messages, 1000 in the functions). Please reduce the length of the messages or functions."
  server([() => new Response(JSON.stringify({ error: { message } }), { status: 400 })])
  await assert.rejects(
    provider.stream({ system: 'S', user: 'Q', lane: 'quick', tools: [lookup] }, { signal: new AbortController().signal, onDelta: () => {} }),
    /maximum context length/
  )
  assert.equal(provider.supportsTools, true, 'Train still works with it')
})

test('a model the server gives no tools answers without them from then on; Train, which needs them, says so', async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:3333/v1', model: 'gemma-local' } })
  const provider = new CompatProvider()
  const refusal = () => new Response(JSON.stringify({ error: { message: 'registry.ollama.ai/library/gemma-local does not support tools' } }), { status: 400 })
  const sent = server([refusal, [{ choices: [{ delta: { content: 'About 49 euros.' } }] }], [{ choices: [{ delta: { content: 'Ok.' } }] }]])
  let text = ''
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick', tools: [lookup] }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
  assert.equal(text, 'About 49 euros.')
  assert.equal(sent[1].tools, undefined, 'asked again without them')
  await provider.stream({ system: 'S', user: 'Q2', lane: 'quick', tools: [lookup] }, { signal: new AbortController().signal, onDelta: () => {} })
  assert.equal(sent[2].tools, undefined, 'and from then on')
  await assert.rejects(
    provider.stream({ system: 'S', user: 'Remember our prices', lane: 'deep', tools: [lookup], toolsRequired: true }, { signal: new AbortController().signal, onDelta: () => {} }),
    /This model can't change your agent/
  )
  assert.equal(sent.length, 3, 'Train sends nothing it knows will be turned down')
})

test('once tools are turned down, the provider says it has none, so answers are not told they can search', async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:4444/v1', model: 'tiny-local' } })
  const provider = new CompatProvider()
  assert.equal(provider.supportsTools, true)
  server([() => new Response(JSON.stringify({ error: { message: 'tools are not supported for this model' } }), { status: 400 }), [{ choices: [{ delta: { content: 'Ok.' } }] }]])
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick', tools: [lookup] }, { signal: new AbortController().signal, onDelta: () => {} })
  assert.equal(provider.supportsTools, false)
  await updateSettings({ compat: { baseUrl: 'http://localhost:4444/v1', model: 'bigger-local' } })
  assert.equal(provider.supportsTools, true, 'another model is asked afresh')
})

test("a server's refusals are said in words, and what it sent (an HTML page, ids) stays out of the window", async () => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:4322/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  const ask = () => provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: () => {} })
  electron.net.fetch = async () => new Response(JSON.stringify({ error: { message: 'Rate limit reached for gpt-5-mini in organization org-123 on requests per min (RPM)' } }), { status: 429 })
  await assert.rejects(ask(), (err) => err.message === 'The AI service is at its limit right now. Try again in a moment.')
  electron.net.fetch = async () => new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', { status: 502 })
  await assert.rejects(ask(), (err) => err.message === 'The AI service had a problem. Try again.')
  electron.net.fetch = async () => new Response('bad key', { status: 401 })
  await assert.rejects(ask(), /turned down the API key \(401\)\. Check it in Settings\./)
})

test("a server that takes the request and never answers is given up on, said so; a stop asked for is no such failure", async (t) => {
  await updateSettings({ compat: { baseUrl: 'http://localhost:4323/v1', model: 'local-model' } })
  const provider = new CompatProvider()
  // It holds the request until it's stopped.
  electron.net.fetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const hung = provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: () => {} })
  await Promise.resolve()
  t.mock.timers.tick(60_000)
  await assert.rejects(hung, (err) => err.message === "The AI didn't answer in time. Try again.")
  const stop = new AbortController()
  const stopped = provider.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: stop.signal, onDelta: () => {} })
  stop.abort()
  await assert.rejects(stopped, (err) => err.message !== "The AI didn't answer in time. Try again.")
})
