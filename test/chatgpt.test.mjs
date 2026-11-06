// The ChatGPT provider's requests: the public Responses API, signed in with ChatGPT (ChatGPT plan usage).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { call, completed, say, sse, workDir } from './helpers.mjs'

workDir('chatgpt')
const { ChatGPTProvider, getSettings, updateSettings } = await import('./.build/togle.mjs')

const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })

test('requests go to the public Responses API the way Sign in with ChatGPT asks: stored nowhere, streamed, only accepted fields', async () => {
  const sent = []
  const rounds = [[call(9, 'lookup', { query: 'seats' })], [say('Thirty seats.')], [say('Second answer.')]]
  electron.net.fetch = async (url, init) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
    sent.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) })
    const [events] = rounds.shift()
    return sse(...events, completed)
  }
  const lookup = { name: 'lookup', description: 'Looks it up.', parameters: { type: 'object', properties: {} }, run: async () => 'found' }
  const answer = (user) => provider.stream({ system: 'S', user, lane: 'quick', tools: [lookup] }, { signal: new AbortController().signal, onDelta: () => {} })
  await answer('first')
  await answer('second')
  const [toolRound, followUp, nextAnswer] = sent
  for (const request of sent) {
    assert.equal(request.url, 'https://api.openai.com/v1/responses')
    assert.equal(request.body.store, false)
    assert.equal(request.body.stream, true)
    assert.equal(request.headers.Authorization, 'Bearer token')
    for (const header of Object.keys(request.headers)) assert.doesNotMatch(header, /codex|chatgpt-account|originator|session-id|thread-id/i)
    // Fields this route rejects.
    for (const field of ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']) assert.equal(field in request.body, false, field)
    assert.ok(!request.body.input.some((item) => item.role === 'system'), 'instructions go as a developer message')
  }
  // Tools grouped in a namespace; the call comes back by its own name, and its result goes back in the input.
  assert.deepEqual(toolRound.body.tools, [{ type: 'namespace', name: 'functions', description: "Togle's tools", tools: [{ type: 'function', name: 'lookup', description: 'Looks it up.', parameters: { type: 'object', properties: {} }, strict: false }] }])
  assert.ok(followUp.body.input.some((item) => item.type === 'function_call_output' && item.output === 'found'))
  assert.equal(nextAnswer.body.prompt_cache_key, toolRound.body.prompt_cache_key, 'one cache key for the run')
})

test('the model list is the account’s own catalog, in its order, only models meant for a picker', async () => {
  const fresh = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  let asked
  electron.net.fetch = async (url) => {
    asked = String(url)
    return Response.json({ models: [{ slug: 'gpt-b', display_name: 'B', visibility: 'list' }, { slug: 'gpt-hidden', visibility: 'hide' }, { slug: 'gpt-a', display_name: 'A', visibility: 'list' }] })
  }
  const models = await fresh.listModels()
  assert.equal(asked, 'https://api.openai.com/v1/models')
  assert.deepEqual(models.map((m) => [m.id, m.label]), [['gpt-b', 'B'], ['gpt-a', 'A']])
})

test('ChatGPT plan errors say what to do, and a usage limit pauses automatic answers', async () => {
  const fresh = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const ask = () => fresh.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: () => {} })
  const answerWith = (status, body) => { electron.net.fetch = async (url) => String(url).includes('/models') ? Response.json({ models: [] }) : new Response(JSON.stringify(body), { status }) }
  answerWith(403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } })
  await assert.rejects(ask(), /can't use its plan in Togle/)
  answerWith(400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'model', message: 'no' } })
  await assert.rejects(ask(), /can't do this on your plan \(model\)/)
  answerWith(403, { detail: 'Not available in your region' })
  await assert.rejects(ask(), /Not available in your region/)
  assert.equal(fresh.plan.limited(), undefined)
  answerWith(429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })
  await assert.rejects(ask(), /Usage limit reached on your ChatGPT plan/)
  assert.ok(fresh.plan.limited() > Date.now(), 'automatic answers wait')
  // A limit reached after the stream opened fails the response.
  const later = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  electron.net.fetch = async (url) => String(url).includes('/models') ? Response.json({ models: [] }) : sse({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } })
  await assert.rejects(later.stream({ system: 'S', user: 'Q', lane: 'quick' }, { signal: new AbortController().signal, onDelta: () => {} }), /Usage limit reached/)
  assert.ok(later.plan.limited())
})

/** A backend whose answers start after the given delays, one per request in order; records what it was asked. */
function slowBackend(delays) {
  const requests = []
  electron.net.fetch = async (url, init) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
    const n = requests.length
    const request = { n, aborted: false }
    requests.push(request)
    const delay = delays[n] ?? 0
    const body = new ReadableStream({
      start(controller) {
        const timer = setTimeout(() => {
          const done = { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } }
          for (const e of [...say(`Answer from copy ${n + 1}.`), done]) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
          controller.close()
        }, delay)
        init.signal?.addEventListener('abort', () => {
          request.aborted = true
          clearTimeout(timer)
          controller.error(new DOMException('stopped', 'AbortError'))
        })
      }
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  return requests
}

async function hedgedAnswer(hedgeAfterMs) {
  let text = ''
  const usages = []
  provider.onUsage = (u) => usages.push(u)
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick', hedgeAfterMs }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
  provider.onUsage = undefined
  return { text, usage: usages[0] }
}

test('a quick answer that writes nothing for a while gets a second copy, and the first to write is kept', async () => {
  const requests = slowBackend([400, 0])
  const { text, usage } = await hedgedAnswer(100)
  assert.equal(text, 'Answer from copy 2.')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].aborted, true, 'the slow copy is stopped')
  assert.equal(usage.hedged, true)
})

test('an answer that starts in time sends no copy', async () => {
  const requests = slowBackend([0])
  const { text, usage } = await hedgedAnswer(200)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(text, 'Answer from copy 1.')
  assert.equal(requests.length, 1)
  assert.equal(usage.hedged, undefined)
})

test('when the first copy writes first after all, it is kept and the second is stopped', async () => {
  const requests = slowBackend([150, 600])
  const { text } = await hedgedAnswer(50)
  assert.equal(text, 'Answer from copy 1.')
  assert.equal(requests[1].aborted, true)
})

test('a quick answer already at work on a lookup gets no second copy, however long the lookup takes to write', async () => {
  const sent = []
  const encode = (e) => new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`)
  electron.net.fetch = async (url, init) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
    const body = JSON.parse(init.body)
    sent.push(body)
    const toolRound = !body.input.some((item) => item.type === 'function_call_output')
    const stream = new ReadableStream({
      start(controller) {
        if (!toolRound) {
          for (const e of [...say('Thirty seats.'), completed]) controller.enqueue(encode(e))
          return controller.close()
        }
        // The call starts at once; its arguments are done only after the copy would have been sent.
        controller.enqueue(encode(call(7, 'lookup', { query: 'seats' })[0]))
        const timer = setTimeout(() => {
          for (const e of [call(7, 'lookup', { query: 'seats' })[1], completed]) controller.enqueue(encode(e))
          controller.close()
        }, 300)
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          controller.error(new DOMException('stopped', 'AbortError'))
        })
      }
    })
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  const lookup = { name: 'lookup', description: 'Looks it up.', parameters: { type: 'object', properties: {} }, run: async () => 'Thirty seats.' }
  let text = ''
  await provider.stream({ system: 'S', user: 'Q', lane: 'quick', tools: [lookup], hedgeAfterMs: 100 }, { signal: new AbortController().signal, onDelta: (d) => (text += d) })
  assert.equal(text, 'Thirty seats.')
  assert.equal(sent.length, 2, 'the lookup round and the answer after it, no copy of the first')
})

test('a lane set to Fast asks for the Fast tier, when the plan offers it for the model', async () => {
  const sent = []
  electron.net.fetch = async (url, init) => {
    if (String(url).includes('/models')) {
      const models = [
        { slug: 'gpt-6-luna', supported_reasoning_levels: [{ effort: 'low' }], service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }] },
        { slug: 'gpt-6.1-sol', supported_reasoning_levels: [{ effort: 'medium' }] }
      ]
      return new Response(JSON.stringify({ models }), { status: 200 })
    }
    sent.push({ headers: init.headers, body: JSON.parse(init.body) })
    return sse(...say('Ok.'), completed)
  }
  const lanes = getSettings().chatgpt.lanes
  await updateSettings({ chatgpt: { lanes: { ...lanes, quick: { ...lanes.quick, fast: true }, deep: { ...lanes.deep, fast: true } } } })
  const ask = (lane) => provider.stream({ system: 'S', user: 'Q', lane }, { signal: new AbortController().signal, onDelta: () => {} })
  await ask('quick')
  await ask('deep')
  await updateSettings({ chatgpt: { lanes } })
  await ask('quick')
  const [fast, noTier, standard] = sent
  assert.equal(fast.body.service_tier, 'priority')
  assert.equal(noTier.body.service_tier, undefined, "the deep model's plan has no Fast tier")
  assert.equal(standard.body.service_tier, undefined)
})

test('every request is reported as it ends: answered, stopped, or failed', async () => {
  const reported = []
  provider.onUsage = (u) => reported.push(u)
  slowBackend([0, 5000])
  const ask = (signal) => provider.stream({ system: 'S', user: 'Q', lane: 'vision' }, { signal, onDelta: () => {} })
  await ask(new AbortController().signal)
  const stop = new AbortController()
  setTimeout(() => stop.abort(), 50)
  await assert.rejects(ask(stop.signal))
  electron.net.fetch = async (url) =>
    String(url).includes('/models') ? new Response(JSON.stringify({ models: [] }), { status: 200 }) : new Response('nope', { status: 400 })
  await assert.rejects(ask(new AbortController().signal))
  provider.onUsage = undefined
  assert.deepEqual(
    reported.map((u) => [u.lane, u.end, u.input]),
    [
      ['vision', 'done', 10],
      ['vision', 'stopped', 0],
      ['vision', 'failed', 0]
    ]
  )
})

test("an agent's deep-answer model picked while Claude answered is not sent to ChatGPT", async () => {
  const sent = []
  electron.net.fetch = async (url, init) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
    sent.push(JSON.parse(init.body))
    return sse(...say('Ok.'), completed)
  }
  // A provider that hasn't listed its models yet: any of ChatGPT's goes.
  const fresh = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const answer = (model) => fresh.stream({ system: 'S', user: 'Q', lane: 'deep', model }, { signal: new AbortController().signal, onDelta: () => {} })
  await answer('claude-opus-5-5')
  await answer('gpt-6-astra')
  assert.deepEqual(
    sent.map((b) => b.model),
    [getSettings().chatgpt.lanes.deep.model, 'gpt-6-astra']
  )
})
