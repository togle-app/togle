// From the window's audio segments to captions and transcript lines.
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

test('agent terminology corrects captions, pauses and final transcripts consistently', async () => {
  const { handler, calls } = ears({ normalize: text => text.replaceAll('so three', 'SOH 3'), parakeet: [
    { text: 'Is so three ready?', confidence: .99 }, { text: 'Is so three ready?', confidence: .99 }, { text: 'Is so three ready?', confidence: .99 }
  ] })
  await handler('them', second, 1000, 'word', 'partial')
  await handler('them', second, 1000, 'word', 'pause')
  await handler('them', second, 1000, 'word', 'final')
  assert.ok(calls.some(call => call[0] === 'caption' && call[1] === 'Is SOH 3 ready?'))
  assert.equal(calls.filter(call => call[0] === 'caption' && call[1] === 'Is SOH 3 ready?').length, 2, 'the partial and the pause')
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

test('a pause from an old call cannot create a caption in the new call', async () => {
  let finish
  const slow = () => new Promise((resolve) => { finish = () => resolve({ text: 'Old private question?', confidence: 0.99 }) })
  const { handler, calls } = ears({ parakeet: [slow] })
  const previous = handler('them', second, 1000, 'old-pause', 'pause')
  handler.reset()
  finish()
  await previous
  assert.ok(!calls.some(([kind]) => ['caption', 'add'].includes(kind)))
})

test('a partial finishing after its final transcript cannot replace it', async () => {
  let finish
  const slow = () => new Promise((resolve) => { finish = () => resolve({ text: 'Obsolete incomplete words', confidence: 0.99 }) })
  const { handler, calls } = ears({ parakeet: [slow, { text: 'Correct final question?', confidence: 0.99 }] })
  const preview = handler('them', second, 1000, 'same-segment', 'partial')
  await handler('them', second, 1000, 'same-segment', 'final')
  finish()
  await preview
  assert.ok(calls.some(([kind, , text]) => kind === 'add' && text === 'Correct final question?'))
  assert.ok(!calls.some(([kind]) => kind === 'caption'))
})

/** The hearing handler with this PC's two recognizers and a call that record what they were asked. */
function ears({ parakeet = [], whisper = [], language = 'en', normalize, whisperReady, whisperChecks } = {}) {
  const calls = []
  const handler = hearing({
    normalize,
    whisperReady,
    whisperChecks,
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
    call: { add: (...args) => calls.push(['add', ...args]) },
    caption: ({ text }) => calls.push(['caption', text])
  })
  return { handler, calls }
}

test('a pause Parakeet is sure of shows its caption at once', async () => {
  const { handler, calls } = ears({ parakeet: [{ text: 'How much is it?', confidence: 0.95 }] })
  await handler('them', second, 1000, 'seg-1', 'pause')
  assert.deepEqual(calls, [
    ['parakeet', true],
    ['caption', 'How much is it?']
  ])
})

test('a pause heard only after they went on talking does not bring back fewer words', async () => {
  let finish
  const slow = () => new Promise((resolve) => (finish = () => resolve({ text: 'How much is it?', confidence: 0.95 })))
  const { handler, calls } = ears({ parakeet: [slow, { text: 'How much is it for forty', confidence: 0.9 }] })
  const atPause = handler('them', second, 1000, 'seg-2', 'pause')
  await handler('them', second, 1000, 'seg-2', 'partial')
  finish()
  await atPause
  assert.deepEqual(calls.filter(([what]) => what === 'caption').map(([, text]) => text), ['How much is it for forty'])
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

test('an empty final clears the caption', async () => {
  const { handler, calls } = ears()
  await handler('them', new Float32Array(0), 1000, 'seg-4', 'final')
  assert.deepEqual(calls, [['caption', '']])
})

test("without Parakeet, or in a language Parakeet doesn't hear, Whisper hears every finished line and a pause shows nothing early", async () => {
  for (const setup of [{ parakeet: null }, { language: 'sr' }]) {
    const { handler, calls } = ears({ ...setup, whisper: ['Koliko košta?'] })
    await handler('them', second, 1000, 'seg-5', 'pause')
    await handler('them', second, 1000, 'seg-5', 'final')
    assert.deepEqual(calls, [
      ['whisper', 'Nordlink, SAP'],
      ['add', 'them', 'Koliko košta?', 1000, 2000, 'seg-5']
    ])
  }
})

test("Parakeet hears its other languages too: a Croatian call's pause and final line stay with it", async () => {
  const { handler, calls } = ears({ language: 'hr', parakeet: [{ text: 'Koliko košta?', confidence: 0.95 }, { text: 'Koliko košta?', confidence: 0.95 }] })
  await handler('them', second, 1000, 'hr-1', 'pause')
  await handler('them', second, 1000, 'hr-1', 'final')
  assert.ok(!calls.some(([what]) => what === 'whisper'), 'no Whisper for a language Parakeet hears, accented letters and all')
  assert.ok(calls.some(([what, text]) => what === 'caption' && text === 'Koliko košta?'))
  assert.ok(calls.some(([what, , text]) => what === 'add' && text === 'Koliko košta?'))
})

test('a Croatian line Parakeet heard in Cyrillic, or an English one with accented letters, goes to Whisper', async () => {
  for (const [language, heard, said] of [['hr', 'Сколько стоит?', 'Koliko košta?'], ['en', 'Où est la gare?', 'Where is the station?']]) {
    const { handler, calls } = ears({ language, parakeet: [{ text: heard, confidence: 0.95 }], whisper: [said] })
    await handler('them', second, 1000, 'switched', 'final')
    assert.deepEqual(calls.filter(([what]) => what === 'whisper' || what === 'add').map(([what, , text]) => (what === 'add' ? text : what)), ['whisper', said])
  }
})

test("without Whisper (a CPU's, for Parakeet's languages), Parakeet's text is kept, noisy line or unsure", async () => {
  const unsure = ears({ language: 'de', whisperReady: () => false, parakeet: [{ text: 'Wie viel kostet das', confidence: 0.5 }] })
  await unsure.handler('them', second, 1000, 'de-1', 'final')
  assert.deepEqual(unsure.calls, [['parakeet', false], ['add', 'them', 'Wie viel kostet das', 1000, 2000, 'de-1']])
  const noisy = ears({ language: 'de', whisperReady: () => false, parakeet: [{ text: 'Wie viel kostet das?', confidence: 0.9 }, { text: 'Wie viel kostet das?', confidence: 0.9 }] })
  await noisy.handler('them', speech(0.02), 1000, 'de-2', 'pause')
  await noisy.handler('them', speech(0.02), 1000, 'de-2', 'final')
  assert.ok(!noisy.calls.some(([what]) => what === 'whisper'))
  assert.ok(noisy.calls.some(([what, text]) => what === 'caption' && text === 'Wie viel kostet das?'))
  assert.ok(noisy.calls.some(([what, , text]) => what === 'add' && text === 'Wie viel kostet das?'))
})

test("on a CPU, Whisper small doesn't re-check Parakeet's languages, but takes what Parakeet is unsure of when the language is detected", async () => {
  const croatian = ears({ language: 'hr', whisperChecks: () => false, parakeet: [{ text: 'koliko kosta', confidence: 0.5 }], whisper: ['Koliko košta?'] })
  await croatian.handler('them', speech(0.02), 1000, 'cpu-1', 'final')
  assert.ok(!croatian.calls.some(([what]) => what === 'whisper'), 'neither the noisy line nor the unsure words go to Whisper small')
  assert.deepEqual(croatian.calls.at(-1), ['add', 'them', 'koliko kosta', 1000, 2000, 'cpu-1'])
  const detected = ears({ language: 'auto', whisperChecks: () => false, parakeet: [{ text: 'konnichiwa', confidence: 0.3 }], whisper: ['こんにちは'] })
  await detected.handler('them', second, 1000, 'cpu-2', 'final')
  assert.deepEqual(detected.calls.at(-1), ['add', 'them', 'こんにちは', 1000, 2000, 'cpu-2'])
})

test("without Whisper, a language Parakeet doesn't list is still tried by Parakeet rather than lost", async () => {
  const { handler, calls } = ears({ language: 'sr', whisperReady: () => false, parakeet: [{ text: 'Koliko košta?', confidence: 0.9 }] })
  await handler('them', second, 1000, 'sr-1', 'final')
  assert.deepEqual(calls.at(-1), ['add', 'them', 'Koliko košta?', 1000, 2000, 'sr-1'])
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
    calls.filter(([what]) => what === 'parakeet' || what === 'whisper' || what === 'add'),
    [
      ['parakeet', true],
      ['whisper', 'Nordlink, SAP'],
      ['whisper', 'Nordlink, SAP'],
      ['add', 'them', 'Does it work with SAP?', 1000, 2000, 'seg-6']
    ]
  )
  assert.ok(calls.some(([what, text]) => what === 'caption' && text === 'Does it work with SAP?'), "the pause's caption is Whisper's")
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
    call: { add: () => {} },
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

test('every side of a call is heard on this PC: nothing that was once given to hear a side in its place is ever asked', async () => {
  // An earlier Togle could send a side's finished lines to a speech API. This PC hears every call now, so the sound of a call
  // never leaves it: what hears each line is one of its own two recognizers, whatever else is handed in.
  const asked = []
  const heard = []
  const outside = { id: 'openai', transcribe: async (_pcm, opts) => (asked.push(opts), 'Heard somewhere else.') }
  const handler = hearing({
    parakeet: () => ({ available: true, transcribe: async () => ({ text: 'Does it work with SAP?', confidence: 0.95 }) }),
    whisper: { transcribe: async () => ({ text: '' }) },
    api: () => outside,
    language: () => 'en',
    vocabulary: async () => '',
    call: { add: (speaker, text) => heard.push([speaker, text]) },
    caption: () => {},
    heard: (timing) => heard.push(timing.by)
  })
  await handler('them', speech(0.0005), 1000, 'seg-14', 'final')
  await handler('me', speech(0.0005), 2000, 'seg-15', 'final')
  assert.deepEqual(asked, [], 'nothing outside this PC was asked')
  assert.deepEqual(heard, ['parakeet', ['them', 'Does it work with SAP?'], 'parakeet', ['me', 'Does it work with SAP?']])
})

test('speech requests run together, but finished lines from one side reach the call in order', async () => {
  const finish = []
  // Their two lines are slow to hear, the second done first; mine, asked for last, is quick.
  const slow = () => new Promise((resolve) => finish.push((text) => resolve({ text, confidence: 0.95 })))
  const { handler, calls } = ears({ parakeet: [slow, slow, { text: 'Let me check.', confidence: 0.95 }] })
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
  // Whisper hears all three (Parakeet is not there): the first is slow, the second fails, the third is done at once.
  const slow = () => new Promise((resolve, reject) => finish.push({ resolve: (text) => resolve({ text }), reject }))
  const { handler, calls } = ears({ parakeet: null, whisper: [slow, slow, slow] })
  const first = handler('them', second, 1000, 'failed-1', 'final')
  const failed = handler('them', second, 3000, 'failed-2', 'final')
  const last = handler('them', second, 5000, 'failed-3', 'final')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(finish.length, 3, 'all three are being heard')
  finish[1].reject(new Error('Whisper stopped'))
  finish[2].resolve('And what does it cost?')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(!calls.some(([what]) => what === 'add'), 'the failure still waits for the earlier request')
  finish[0].resolve('How often would lessons be?')
  await Promise.all([first, failed, last])
  assert.deepEqual(calls.filter(([what]) => what === 'add').map(([, , text]) => text), ['How often would lessons be?', 'And what does it cost?'])
})

test('a later pause captions at once, while an earlier line is still being heard', async () => {
  let finish
  // The finished line is slow to hear; the pause after it is heard at once.
  const slow = () => new Promise((resolve) => (finish = (text) => resolve({ text, confidence: 0.95 })))
  const { handler, calls } = ears({ parakeet: [slow, { text: 'And what does it cost?', confidence: 0.95 }] })
  const first = handler('them', second, 1000, 'before-pause', 'final')
  const pause = handler('them', second, 3000, 'after-pause', 'pause')
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(calls.some(([what, text]) => what === 'caption' && text === 'And what does it cost?'))
  assert.ok(!calls.some(([what]) => what === 'add'))
  finish('How often would lessons be?')
  await Promise.all([first, pause])
  assert.deepEqual(calls.filter(([what]) => what === 'add').map(([, , text]) => text), ['How often would lessons be?'])
})
