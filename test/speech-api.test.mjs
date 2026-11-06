// The speech APIs that can hear a side of the call in place of this PC's models: OpenAI's, and any server that
// speaks it. What a clip is sent with, what's done with a refusal, and what the window is told.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { wait, workDir } from './helpers.mjs'

workDir('speech-api')
const { hearingStatus, keywordsOf, SpeechApi } = await import('./.build/togle.mjs')

const second = new Float32Array(16000)
const OPENAI = () => ({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-transcribe' })

/** A request as the server gets it: its address, its key, and its form (the clip as its type and size). */
function received(url, init) {
  const fields = {}
  for (const [name, value] of init.body.entries()) {
    const v = typeof value === 'string' ? value : `${value.type} ${value.size}`
    fields[name] = name in fields ? [fields[name]].flat().concat(v) : v
  }
  return { url: String(url), key: init.headers.Authorization ?? null, fields }
}

/** The server answers each request with what `answer` gives for it, and keeps what it was sent. */
function server(answer) {
  const requests = []
  electron.net.fetch = async (url, init) => {
    const request = received(url, init)
    requests.push(request)
    return answer(request)
  }
  return requests
}

test("gpt-transcribe is sent the call's language and the words to spell as lists, with the key", async () => {
  const requests = server(() => Response.json({ text: 'Does it work with SAP?' }))
  const api = new SpeechApi('openai', 'openai-1.bin', OPENAI)
  await api.setKey('sk-test')
  assert.equal(await api.transcribe(second, { language: 'en', vocabulary: 'Nordlink, SAP, Luka, Luke.' }), 'Does it work with SAP?')
  assert.deepEqual(requests, [
    {
      url: 'https://api.openai.com/v1/audio/transcriptions',
      key: 'Bearer sk-test',
      fields: {
        file: 'audio/wav 32044',
        model: 'gpt-transcribe',
        response_format: 'json',
        'languages[]': 'en',
        'keywords[]': ['Nordlink', 'SAP', 'Luka', 'Luke']
      }
    }
  ])
})

test('a server is sent one language and a prompt, as Whisper takes them; no key, no model, no language when there are none', async () => {
  const requests = server(() => Response.json({ text: 'Koliko košta?' }))
  let target = { baseUrl: 'http://localhost:8000/v1/', model: 'whisper-large-v3-turbo' }
  const api = new SpeechApi('server', 'server-1.bin', () => target)
  assert.equal(await api.transcribe(second, { language: 'hr', vocabulary: 'Nordlink, SAP' }), 'Koliko košta?')
  target = { baseUrl: 'http://127.0.0.1:9000/v1', model: '' }
  await api.transcribe(second, { language: 'auto', vocabulary: '' })
  assert.deepEqual(requests, [
    {
      url: 'http://localhost:8000/v1/audio/transcriptions',
      key: null,
      fields: { file: 'audio/wav 32044', model: 'whisper-large-v3-turbo', response_format: 'json', language: 'hr', prompt: 'Nordlink, SAP' }
    },
    { url: 'http://127.0.0.1:9000/v1/audio/transcriptions', key: null, fields: { file: 'audio/wav 32044', response_format: 'json' } }
  ])
})

test('a server that turns down the language or the words is asked again without them, and without them from then on', async () => {
  const requests = server(({ fields }) =>
    fields.language ? Response.json({ error: { message: "Unsupported language 'bs'" } }, { status: 400 }) : Response.json({ text: 'Koliko košta?' })
  )
  const api = new SpeechApi('server', 'server-2.bin', () => ({ baseUrl: 'http://localhost:8001/v1', model: 'whisper-1' }))
  assert.equal(await api.transcribe(second, { language: 'bs', vocabulary: 'Nordlink' }), 'Koliko košta?')
  assert.equal(await api.transcribe(second, { language: 'bs', vocabulary: 'Nordlink' }), 'Koliko košta?')
  assert.deepEqual(
    requests.map((r) => [r.fields.language ?? null, r.fields.prompt ?? null]),
    [
      ['bs', 'Nordlink'],
      [null, null],
      [null, null]
    ]
  )
  assert.equal(api.problem, null)
})

test("a line it couldn't hear says why, and the next one it hears clears that", async () => {
  const api = new SpeechApi('openai', 'openai-2.bin', OPENAI)
  await api.setKey('sk-wrong')
  let changes = 0
  api.onChange = () => changes++
  const said = { language: 'en', vocabulary: '' }
  const failures = [
    [() => Response.json({ error: { message: 'Incorrect API key provided: sk-wrong' } }, { status: 401 }), 'it turned down the API key'],
    [
      () => Response.json({ error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }, { status: 429 }),
      'the account has no credit left'
    ],
    [() => Response.json({ error: { message: 'Rate limit reached' } }, { status: 429 }), 'too many requests just now'],
    [() => Response.json({ error: { message: 'The server had an error' } }, { status: 500 }), 'it answered 500: The server had an error'],
    [
      () => {
        throw new Error('net::ERR_NAME_NOT_RESOLVED')
      },
      "couldn't reach api.openai.com"
    ],
    [
      () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
      },
      'no answer in 20 s'
    ]
  ]
  for (const [answer, why] of failures) {
    server(answer)
    await assert.rejects(api.transcribe(second, said), (err) => err.message === why)
    assert.equal(api.problem, why)
    // A key turned down stays turned down: no more lines go to it until the key or the setup changes.
    assert.equal(api.canHear(), false, why)
  }
  server(() => Response.json({ text: 'Okay, thanks.' }))
  assert.equal(await api.transcribe(second, said), 'Okay, thanks.')
  assert.equal(api.problem, null)
  assert.equal(api.canHear(), true, 'a line heard shows the key works')
  assert.equal(changes, failures.length + 1, 'the window hears of each new problem, and of it going')
  server(() => Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }))
  await assert.rejects(api.transcribe(second, said))
  await api.setKey('sk-another')
  assert.equal(api.canHear(), true, 'another key is tried')
  await assert.rejects(api.transcribe(second, said))
  api.reset()
  assert.equal(api.canHear(), true, 'so is the same key once what it hears with changes (its model, say)')
})

test("nothing answering at a server's address says so", async () => {
  server(() => {
    throw new Error('net::ERR_CONNECTION_REFUSED')
  })
  const api = new SpeechApi('server', 'server-3.bin', () => ({ baseUrl: 'http://localhost:8002/v1', model: '' }))
  await assert.rejects(api.transcribe(second, { language: 'en', vocabulary: '' }), /nothing answers at localhost:8002/)
})

test("what Whisper invents on a short clip is dropped, as this PC's Whisper drops it; text that isn't JSON is read as it is", async () => {
  const api = new SpeechApi('server', 'server-4.bin', () => ({ baseUrl: 'http://localhost:8003/v1', model: '' }))
  const said = { language: 'en', vocabulary: '' }
  for (const [answer, heard] of [
    [() => Response.json({ text: ' Thank you. ' }), ''],
    [() => Response.json({ text: '[Music]' }), ''],
    [() => Response.json({ text: '  Forty   seats.  ' }), 'Forty seats.'],
    [() => new Response('Does it work with SAP?', { headers: { 'Content-Type': 'text/plain' } }), 'Does it work with SAP?'],
    [() => Response.json({}), '']
  ]) {
    server(answer)
    assert.equal(await api.transcribe(second, said), heard)
  }
})

test('what each API needs before it can hear: OpenAI a key, a server its address', async () => {
  let address = ''
  const openai = new SpeechApi('openai', 'openai-3.bin', OPENAI)
  const local = new SpeechApi('server', 'server-5.bin', () => ({ baseUrl: address, model: '' }))
  assert.equal(openai.missing(), 'an OpenAI API key')
  for (const [url, missing] of [
    ['', "the speech server's address"],
    ['localhost:8000/v1', "the speech server's address"],
    ['http://localhost:8000/v1', null]
  ]) {
    address = url
    assert.equal(local.missing(), missing, url)
  }
  const requests = server(() => Response.json({ text: 'Hi.' }))
  await assert.rejects(openai.transcribe(second, { language: 'en', vocabulary: '' }), /an OpenAI API key/)
  assert.equal(requests.length, 0, 'nothing is sent without it')
  let told = 0
  openai.onChange = () => told++
  await openai.setKey('  sk-test  ')
  assert.equal(openai.missing(), null)
  assert.equal(openai.hasKey(), true)
  assert.equal(told, 1, 'the window hears that it has its key now')
})

test('the key is kept encrypted and read back as Togle starts again', async () => {
  const first = new SpeechApi('openai', 'openai-4.bin', OPENAI)
  await first.setKey('sk-kept')
  const again = new SpeechApi('openai', 'openai-4.bin', OPENAI)
  await again.load()
  assert.equal(again.hasKey(), true)
  const requests = server(() => Response.json({ text: 'Hi.' }))
  await again.transcribe(second, { language: 'en', vocabulary: '' })
  assert.equal(requests[0].key, 'Bearer sk-kept')
})

test("the words to spell are hints of their own, without what gpt-transcribe turns a request down for", () => {
  assert.deepEqual(keywordsOf('Nordlink, SAP,, sap, <script>, AC-42\nLuka Dutina.'), ['Nordlink', 'SAP', 'script', 'AC-42', 'Luka Dutina'])
  assert.equal(keywordsOf(Array.from({ length: 100 }, (_, i) => `Term${i}`).join(', ')).length, 60)
  assert.deepEqual(keywordsOf(`${'x'.repeat(61)}, Kafka`), ['Kafka'])
})

test("the window is told what hears each side, and why the API picked for one can't", async () => {
  const pc = { state: 'ready', detail: 'Parakeet, with Whisper for unclear speech' }
  const openai = new SpeechApi('openai', 'openai-5.bin', OPENAI)
  // Nothing picked: this PC's state as it is.
  assert.deepEqual(hearingStatus(pc, { me: null, them: null }), pc)
  // Picked, but no key yet: this PC hears that side meanwhile, and its state counts.
  assert.equal(hearingStatus(pc, { me: null, them: openai }).problem, 'Add an OpenAI API key in Settings: until then this PC hears other people.')
  assert.equal(
    hearingStatus(pc, { me: openai, them: openai }).problem,
    'Add an OpenAI API key in Settings: until then this PC hears your voice and other people.'
  )
  // Nor installed on this PC: nothing went wrong, and nothing hears it meanwhile; what it needs is for the window to ask.
  assert.deepEqual(hearingStatus({ state: 'missing', detail: 'Local Whisper is not installed.' }, { me: null, them: openai }), {
    state: 'missing',
    detail: 'Local Whisper is not installed.',
    needs: 'an OpenAI API key'
  })
  await openai.setKey('sk-test')
  assert.deepEqual(hearingStatus(pc, { me: null, them: openai }), {
    state: 'ready',
    detail: 'Your voice: this PC (Parakeet, with Whisper for unclear speech). Other people: OpenAI gpt-transcribe'
  })
  // Both sides heard by it: nothing waits on this PC's models, which only caption.
  assert.deepEqual(hearingStatus({ state: 'starting' }, { me: openai, them: openai }), {
    state: 'ready',
    detail: 'Your voice: OpenAI gpt-transcribe. Other people: OpenAI gpt-transcribe'
  })
  const local = new SpeechApi('server', 'server-6.bin', () => ({ baseUrl: 'http://localhost:8000/v1', model: 'whisper-large-v3' }))
  assert.equal(hearingStatus(pc, { me: local, them: openai }).detail, 'Your voice: whisper-large-v3 at localhost:8000. Other people: OpenAI gpt-transcribe')
  // A line it didn't hear, and who heard it instead.
  server(() => Response.json({ error: { message: 'The server had an error' } }, { status: 500 }))
  await assert.rejects(openai.transcribe(second, { language: 'en', vocabulary: '' }))
  assert.equal(
    hearingStatus(pc, { me: null, them: openai }).problem,
    "OpenAI didn't hear a line: it answered 500: The server had an error. This PC heard it instead."
  )
  assert.equal(hearingStatus({ state: 'missing' }, { me: null, them: openai }).problem, "OpenAI didn't hear a line: it answered 500: The server had an error.")
  // The key turned down: this PC hears that side until there's another.
  server(() => Response.json({ error: { message: 'Incorrect API key provided' } }, { status: 401 }))
  await assert.rejects(openai.transcribe(second, { language: 'en', vocabulary: '' }))
  assert.deepEqual(hearingStatus(pc, { me: null, them: openai }), {
    state: 'ready',
    detail: 'Your voice: this PC (Parakeet, with Whisper for unclear speech). Other people: this PC (Parakeet, with Whisper for unclear speech)',
    problem: "OpenAI turned down the API key: until there's another in Settings, this PC hears other people."
  })
  assert.equal(
    hearingStatus({ state: 'missing' }, { me: openai, them: openai }).problem,
    "OpenAI turned down the API key: until there's another in Settings, Togle can't hear the call."
  )
  await assert.rejects(local.transcribe(second, { language: 'en', vocabulary: '' }))
  assert.equal(
    hearingStatus(pc, { me: local, them: null }).problem,
    "The speech server needs an API key: until there's one in Settings, this PC hears your voice."
  )
  openai.reset()
  assert.equal(hearingStatus(pc, { me: null, them: openai }).problem, undefined)
})

test("the ChatGPT plan's dictation is sent the clip alone, as Codex sends it, with the sign-in", async () => {
  const forms = []
  let signedIn = false
  const plan = new SpeechApi('chatgpt', '', () => ({ baseUrl: 'https://chatgpt.com/backend-api', model: '' }), {
    signedIn: () => signedIn,
    post: async (form) => {
      forms.push(form)
      return Response.json({ text: 'Can we try it before we buy?' })
    }
  })
  assert.equal(plan.missing(), 'a ChatGPT sign-in')
  signedIn = true
  // Half a second, quiet: padded to a second, and raised to Codex's level.
  const quiet = Float32Array.from({ length: 8000 }, (_, i) => 0.1 * Math.sin(i / 5))
  assert.equal(await plan.transcribe(quiet, { language: 'en', vocabulary: 'Nordlink, SAP' }), 'Can we try it before we buy?')
  const fields = [...forms[0].entries()]
  assert.deepEqual(
    fields.map(([name, value]) => [name, value.name, value.type, value.size]),
    [['file', 'audio.wav', 'audio/wav', 44 + 16000 * 2]],
    'no model, language or words to spell'
  )
  const wav = Buffer.from(await fields[0][1].arrayBuffer())
  let peak = 0
  for (let i = 44; i < wav.length; i += 2) peak = Math.max(peak, Math.abs(wav.readInt16LE(i)))
  assert.ok(Math.abs(peak / 32767 - 0.9) < 0.01, `its peak is at 0.9 (${(peak / 32767).toFixed(3)})`)
  assert.equal(plan.label(), "the ChatGPT plan's dictation")
})

test('turned down by ChatGPT (403), the plan gets no more lines until it is picked again', async () => {
  const plan = new SpeechApi('chatgpt', '', () => ({ baseUrl: 'https://chatgpt.com/backend-api', model: '' }), {
    signedIn: () => true,
    post: async () => new Response('<html>Just a moment...</html>', { status: 403, headers: { 'Content-Type': 'text/html' } })
  })
  await assert.rejects(plan.transcribe(second, { language: 'en', vocabulary: '' }), /chatgpt\.com turned the request down/)
  assert.equal(plan.canHear(), false)
  const pc = { state: 'ready', detail: 'Parakeet' }
  assert.equal(
    hearingStatus(pc, { me: null, them: plan }).problem,
    "ChatGPT's dictation turned Togle down (chatgpt.com turned the request down): until you sign in again or pick it again in Settings, this PC hears other people."
  )
  plan.reset()
  assert.equal(plan.canHear(), true)
})

test('"too many requests" rests an API for as long as it says, and this PC hears that side meanwhile', async () => {
  const api = new SpeechApi('server', 'server-7.bin', () => ({ baseUrl: 'http://localhost:8004/v1', model: '' }))
  let changes = 0
  api.onChange = () => changes++
  server(() => Response.json({ error: { message: 'Rate limit reached' } }, { status: 429, headers: { 'Retry-After': '1' } }))
  await assert.rejects(api.transcribe(second, { language: 'en', vocabulary: '' }), /too many requests just now/)
  assert.equal(api.canHear(), false)
  assert.ok(api.restingUntil() > Date.now())
  const status = hearingStatus({ state: 'ready', detail: 'Parakeet' }, { me: api, them: null })
  assert.match(status.problem, /^The speech server is turning requests away for now: this PC hears your voice until \d/)
  assert.equal(status.detail, 'Your voice: this PC (Parakeet). Other people: this PC (Parakeet)')
  await wait(1200)
  assert.equal(api.canHear(), true, 'it is asked again once the wait is over')
  assert.equal(changes, 2, 'and the window hears when that is')
})
