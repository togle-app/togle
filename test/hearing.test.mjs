// From the window's audio segments to captions, transcript lines and answers started at a pause.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('hearing')
const { hearing } = await import('./.build/togle.mjs')

const second = new Float32Array(16000)

test('pausing one input drops its late results, while the other side keeps transcribing', async () => {
  let finish
  const { handler, calls } = ears({ parakeet: [() => new Promise(resolve => { finish = () => resolve({ text: 'Private words from before pause.', confidence: .99 }) }), { text: 'The other side keeps working.', confidence: .99 }, { text: 'Fresh resumed words.', confidence: .99 }] })
  const pending = handler('me', second, 1000, 'before-pause', 'final')
  handler.pause('me', true)
  await handler('them', second, 2000, 'other-side', 'final')
  handler.pause('me', false)
  await handler('me', second, 3000, 'resumed', 'final')
  finish(); await pending
  assert.deepEqual(calls.filter(call => call[0] === 'add').map(call => call[2]), ['The other side keeps working.', 'Fresh resumed words.'])
})

test('agent terminology corrects captions, pause suggestions and final transcripts consistently', async () => {
  const { handler, calls } = ears({ normalize: text => text.replaceAll('so three', 'SOH 3'), parakeet: [
    { text: 'Is so three ready?', confidence: .99 }, { text: 'Is so three ready?', confidence: .99 }, { text: 'Is so three ready?', confidence: .99 }
  ] })
  await handler('them', second, 1000, 'word', 'partial')
  await handler('them', second, 1000, 'word', 'pause')
  await handler('them', second, 1000, 'word', 'final')
  assert.ok(calls.some(call => call[0] === 'caption' && call[1] === 'Is SOH 3 ready?'))
  assert.ok(calls.some(call => call[0] === 'anticipate' && call[1] === 'Is SOH 3 ready?'))
  assert.ok(calls.some(call => call[0] === 'add' && call[2] === 'Is SOH 3 ready?'))
})

test('pausing clears an already visible caption immediately and late results cannot restore it', async () => {
  const { handler, calls } = ears({ parakeet: [{ text: 'Words before pause', confidence: .99 }] })
  await handler('them', second, 1000, 'visible', 'partial')
  assert.ok(calls.some(call => call[0] === 'caption' && call[1] === 'Words before pause'))
  handler.pause('them', true)
  assert.ok(calls.some(call => call[0] === 'caption' && call[1] === ''))
  await handler('them', second, 1000, 'visible', 'final')
  assert.ok(!calls.some(call => call[0] === 'add'))
})

test('New call discards a slow previous transcript and does not make the new call wait for it', async () => {
  let finishOld
  const slow = () => new Promise((resolve) => { finishOld = () => resolve({ text: 'Acme private price is 800.', confidence: 0.99 }) })
  const { handler, calls } = ears({ parakeet: [slow, { text: 'Contoso interview question.', confidence: 0.99 }] })
  const previous = handler('them', second, 1000, 'old-call', 'final')
  handler.reset()
  await handler('them', second, 9000, 'new-call', 'final')
  assert.deepEqual(calls.filter(([kind]) => kind === 'add').map(([, , text]) => text), ['Contoso interview question.'])
  finishOld()
  await previous
  assert.deepEqual(calls.filter(([kind]) => kind === 'add').map(([, , text]) => text), ['Contoso interview question.'])
})

test('a pause from an old call cannot create a caption or suggestion in the new call', async () => {
  let finish
  const slow = () => new Promise((resolve) => { finish = () => resolve({ text: 'Old private question?', confidence: 0.99 }) })
  const { handler, calls } = ears({ parakeet: [slow] })
  const previous = handler('them', second, 1000, 'old-pause', 'pause')
  handler.reset()
  finish()
  await previous
  assert.ok(!calls.some(([kind]) => ['caption', 'anticipate', 'talked on', 'add', 'drop'].includes(kind)))
})

test('a partial finishing after its final transcript cannot replace it or cancel an answer', async () => {
  let finish
  const slow = () => new Promise((resolve) => { finish = () => resolve({ text: 'Obsolete incomplete words', confidence: 0.99 }) })
  const { handler, calls } = ears({ parakeet: [slow, { text: 'Correct final question?', confidence: 0.99 }] })
  const preview = handler('them', second, 1000, 'same-segment', 'partial')
  await handler('them', second, 1000, 'same-segment', 'final')
  finish()
  await preview
  assert.ok(calls.some(([kind, , text]) => kind === 'add' && text === 'Correct final question?'))
  assert.ok(!calls.some(([kind]) => kind === 'caption' || kind === 'talked on'))
})

/** The hearing handler with recognizers and a copilot that record what they were asked (`api`: the speech API picked for a side). */
function ears({ parakeet = [], whisper = [], language = 'en', api, normalize } = {}) {
  const calls = []
  const handler = hearing({
    normalize,
    api,
    parakeet: () =>
      parakeet && {
        available: true,
        transcribe: async (_pcm, opts) => {
          calls.push(['parakeet', opts.partial])
          const next = parakeet.shift()
          return typeof next === 'function' ? next() : next
        }
      },
    whisper: {
      transcribe: async (_pcm, opts) => {
        calls.push(['whisper', opts.prompt])
        const next = whisper.shift()
        return typeof next === 'function' ? next() : { text: next ?? '' }
      }
    },
    language: () => language,
    vocabulary: async () => 'Nordlink, SAP',
    copilot: {
      anticipate: (...args) => calls.push(['anticipate', ...args]),
      dropAnticipated: (id) => calls.push(['drop', id]),
      talkedOn: (id, heard) => calls.push(['talked on', id, heard]),
      add: (...args) => calls.push(['add', ...args])
    },
    caption: ({ text }) => calls.push(['caption', text])
  })
  return { handler, calls }
}

test('a pause Parakeet is sure of starts the answer and shows its caption', async () => {
  const { handler, calls } = ears({ parakeet: [{ text: 'How much is it?', confidence: 0.95 }] })
  await handler('them', second, 1000, 'seg-1', 'pause')
  assert.deepEqual(calls, [
    ['parakeet', true],
    ['caption', 'How much is it?'],
    ['anticipate', 'How much is it?', 1000, 'seg-1', 2000]
  ])
})

test('a pause heard only after they went on talking starts nothing', async () => {
  let finish
  const slow = () => new Promise((resolve) => (finish = () => resolve({ text: 'How much is it?', confidence: 0.95 })))
  const { handler, calls } = ears({ parakeet: [slow, { text: 'How much is it for forty', confidence: 0.9 }] })
  const atPause = handler('them', second, 1000, 'seg-2', 'pause')
  await handler('them', second, 1000, 'seg-2', 'partial')
  finish()
  await atPause
  assert.ok(
    calls.some(([what, id, heard]) => what === 'talked on' && id === 'seg-2' && heard === 'How much is it for forty'),
    'talking again tells the copilot what was said by now, which drops an answer started at the pause for less'
  )
  assert.equal(calls.filter(([what]) => what === 'anticipate').length, 0)
})

test("unsure Parakeet hands the utterance to Whisper, with the agent's words", async () => {
  const { handler, calls } = ears({ parakeet: [{ text: 'does it work with sap', confidence: 0.5 }], whisper: ['Does it work with SAP?'] })
  await handler('them', second, 1000, 'seg-3', 'final')
  assert.deepEqual(calls, [
    ['parakeet', false],
    ['whisper', 'Nordlink, SAP'],
    ['add', 'them', 'Does it work with SAP?', 1000, 2000, 'seg-3']
  ])
})

test('an empty final drops an answer started at the pause and clears the caption', async () => {
  const { handler, calls } = ears()
  await handler('them', new Float32Array(0), 1000, 'seg-4', 'final')
  assert.deepEqual(calls, [
    ['drop', 'seg-4'],
    ['caption', '']
  ])
})

test('without Parakeet, or in another language, Whisper hears everything and pauses start nothing', async () => {
  for (const setup of [{ parakeet: null }, { language: 'hr' }]) {
    const { handler, calls } = ears({ ...setup, whisper: ['Koliko košta?'] })
    await handler('them', second, 1000, 'seg-5', 'pause')
    await handler('them', second, 1000, 'seg-5', 'final')
    assert.deepEqual(calls, [
      ['whisper', 'Nordlink, SAP'],
      ['add', 'them', 'Koliko košta?', 1000, 2000, 'seg-5']
    ])
  }
})

/** A second of "speech" with gaps between the words where the given noise is left. */
function speech(noise) {
  let seed = 1
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296 - 0.5) * 2
  return Float32Array.from({ length: 16000 }, (_, i) => (Math.floor(i / 512) % 3 === 2 ? 0 : 0.1 * Math.sin(i / 3)) + noise * random())
}

test('on a noisy line, Whisper hears the pause and the final transcript; captions stay with Parakeet', async () => {
  const { handler, calls } = ears({
    parakeet: [{ text: 'Does it work', confidence: 0.9 }],
    whisper: ['Does it work with SAP?', 'Does it work with SAP?']
  })
  const noisy = speech(0.02)
  await handler('them', noisy, 1000, 'seg-6', 'partial')
  await handler('them', noisy, 1000, 'seg-6', 'pause')
  await handler('them', noisy, 1000, 'seg-6', 'final')
  assert.deepEqual(
    calls.filter(([what]) => what === 'parakeet' || what === 'whisper' || what === 'anticipate' || what === 'add'),
    [
      ['parakeet', true],
      ['whisper', 'Nordlink, SAP'],
      ['anticipate', 'Does it work with SAP?', 1000, 'seg-6', 2000],
      ['whisper', 'Nordlink, SAP'],
      ['add', 'them', 'Does it work with SAP?', 1000, 2000, 'seg-6']
    ]
  )
  // A quiet line stays with Parakeet.
  const quiet = ears({ parakeet: [{ text: 'Does it work with SAP?', confidence: 0.95 }] })
  await quiet.handler('them', speech(0.0005), 1000, 'seg-7', 'final')
  assert.deepEqual(quiet.calls.at(-1), ['add', 'them', 'Does it work with SAP?', 1000, 2000, 'seg-7'])
  assert.ok(!quiet.calls.some(([what]) => what === 'whisper'))
})

test('each finished utterance reports who heard it and whether the line was noisy', async () => {
  const heard = []
  const handler = hearing({
    parakeet: () => ({ available: true, transcribe: async () => ({ text: 'How much is it?', confidence: 0.95 }) }),
    whisper: { transcribe: async () => ({ text: 'Does it work with SAP?' }) },
    language: () => 'en',
    vocabulary: async () => '',
    copilot: { anticipate: () => {}, dropAnticipated: () => {}, talkedOn: () => {}, add: () => {} },
    caption: () => {},
    heard: (timing) => heard.push(timing)
  })
  await handler('them', speech(0.0005), 1000, 'seg-8', 'final')
  await handler('them', speech(0.02), 1000, 'seg-9', 'final')
  await handler('them', speech(0.0005), 1000, 'seg-10', 'partial')
  assert.deepEqual(
    heard.map(({ by, noisy, seconds }) => ({ by, noisy, seconds })),
    [
      { by: 'parakeet', noisy: false, seconds: 1 },
      { by: 'whisper', noisy: true, seconds: 1 }
    ]
  )
})

test("the API picked for the other side writes their lines; captions, pauses and my side stay on this PC", async () => {
  const asked = []
  const openai = { id: 'openai', transcribe: async (_pcm, opts) => (asked.push(opts), 'How much is it per seat?') }
  const { handler, calls } = ears({
    parakeet: [
      { text: 'How much is it', confidence: 0.9 },
      { text: 'How much is it per seat?', confidence: 0.95 },
      { text: 'Forty seats.', confidence: 0.95 }
    ],
    api: (speaker) => (speaker === 'them' ? openai : null)
  })
  await handler('them', second, 1000, 'seg-11', 'partial')
  await handler('them', second, 1000, 'seg-11', 'pause')
  await handler('them', second, 1000, 'seg-11', 'final')
  await handler('me', second, 3000, 'seg-12', 'final')
  assert.deepEqual(asked, [{ language: 'en', vocabulary: 'Nordlink, SAP' }], "only their finished line goes to it, with the call's language and the agent's words")
  assert.deepEqual(
    calls.filter(([what]) => what !== 'talked on'),
    [
      ['parakeet', true],
      ['caption', 'How much is it'],
      ['parakeet', true],
      ['caption', 'How much is it per seat?'],
      ['anticipate', 'How much is it per seat?', 1000, 'seg-11', 2000],
      ['add', 'them', 'How much is it per seat?', 1000, 2000, 'seg-11'],
      ['parakeet', false],
      ['add', 'me', 'Forty seats.', 3000, 4000, 'seg-12']
    ]
  )
})

test("a line the API couldn't hear is heard on this PC, so it isn't lost", async () => {
  const warn = console.warn
  console.warn = () => {}
  try {
    const server = {
      id: 'server',
      transcribe: async () => {
        throw new Error('nothing answers at localhost:8000')
      }
    }
    const { handler, calls } = ears({ parakeet: [{ text: 'Does it work with SAP?', confidence: 0.95 }], api: () => server })
    await handler('them', second, 1000, 'seg-13', 'final')
    assert.deepEqual(calls, [
      ['parakeet', false],
      ['add', 'them', 'Does it work with SAP?', 1000, 2000, 'seg-13']
    ])
  } finally {
    console.warn = warn
  }
})

test('a line the API heard is reported as heard by it', async () => {
  const heard = []
  const handler = hearing({
    parakeet: () => ({ available: true, transcribe: async () => ({ text: 'Mhm.', confidence: 0.95 }) }),
    whisper: { transcribe: async () => ({ text: '' }) },
    api: (speaker) => (speaker === 'them' ? { id: 'server', transcribe: async () => 'Does it work with SAP?' } : null),
    language: () => 'en',
    vocabulary: async () => '',
    copilot: { anticipate: () => {}, dropAnticipated: () => {}, talkedOn: () => {}, add: () => {} },
    caption: () => {},
    heard: (timing) => heard.push(timing)
  })
  await handler('them', speech(0.0005), 1000, 'seg-14', 'final')
  await handler('me', speech(0.0005), 2000, 'seg-15', 'final')
  assert.deepEqual(
    heard.map(({ by }) => by),
    ['server', 'parakeet']
  )
})

test('speech requests run together, but finished lines from one side reach the call in order', async () => {
  const finish = []
  const server = { id: 'server', transcribe: () => new Promise((resolve) => finish.push(resolve)) }
  const { handler, calls } = ears({
    api: (speaker) => (speaker === 'them' ? server : null),
    parakeet: [{ text: 'Let me check.', confidence: 0.95 }]
  })
  const first = handler('them', second, 1000, 'ordered-1', 'final')
  const next = handler('them', second, 3000, 'ordered-2', 'final')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finish.length, 2, 'both clips are already being transcribed')
  finish[1]('And what does it cost?')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(!calls.some(([what]) => what === 'add'), 'a later result waits for the first line')
  await handler('me', second, 4000, 'ordered-me', 'final')
  assert.deepEqual(calls.at(-1), ['add', 'me', 'Let me check.', 4000, 5000, 'ordered-me'], 'the other side still comes through')
  finish[0]('How often would lessons be?')
  await Promise.all([first, next])
  assert.deepEqual(calls.filter(([what, speaker]) => what === 'add' && speaker === 'them').map(([, , text]) => text), [
    'How often would lessons be?',
    'And what does it cost?'
  ])
})

test('a failed transcription does not let a later line overtake an earlier request', async (t) => {
  t.mock.method(console, 'warn', () => {})
  t.mock.method(console, 'error', () => {})
  const finish = []
  const { handler, calls } = ears({
    parakeet: null,
    whisper: [() => Promise.reject(new Error('Whisper stopped'))],
    api: () => ({ id: 'server', transcribe: () => new Promise((resolve, reject) => finish.push({ resolve, reject })) })
  })
  const first = handler('them', second, 1000, 'failed-1', 'final')
  const failed = handler('them', second, 3000, 'failed-2', 'final')
  const last = handler('them', second, 5000, 'failed-3', 'final')
  await new Promise((resolve) => setImmediate(resolve))
  finish[1].reject(new Error('The speech server is down'))
  finish[2].resolve('And what does it cost?')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(!calls.some(([what]) => what === 'add'), 'the failure still waits for the earlier request')
  finish[0].resolve('How often would lessons be?')
  await Promise.all([first, failed, last])
  assert.deepEqual(calls.filter(([what]) => what === 'add').map(([, , text]) => text), ['How often would lessons be?', 'And what does it cost?'])
})

test('a later pause captions at once, but cannot answer before an earlier final line', async () => {
  let finish
  const { handler, calls } = ears({
    api: () => ({ id: 'server', transcribe: () => new Promise((resolve) => (finish = resolve)) }),
    parakeet: [{ text: 'And what does it cost?', confidence: 0.95 }]
  })
  const first = handler('them', second, 1000, 'before-pause', 'final')
  const pause = handler('them', second, 3000, 'after-pause', 'pause')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.some(([what, text]) => what === 'caption' && text === 'And what does it cost?'))
  assert.ok(!calls.some(([what]) => what === 'anticipate'), 'the earlier line is still needed by the answer')
  finish('How often would lessons be?')
  await Promise.all([first, pause])
  const add = calls.findIndex(([what]) => what === 'add')
  const anticipate = calls.findIndex(([what]) => what === 'anticipate')
  assert.ok(add >= 0 && anticipate > add, 'the answer starts with the earlier line in its context')
})
