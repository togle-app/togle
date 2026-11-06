import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Dictation, DictationSpeech, abortable, getSettings, cleanTranscript } from './.build/togle.mjs'
import { Segmenter } from './.build/capture.mjs'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function fixture(patch = {}) {
  const { ready = async () => {}, transcribe, polish = async text => text + '.', ...rest } = patch
  const states = [], inserted = [], heard = [], job = new Dictation({
    target: { capture: async () => ({ token: 'original', label: 'Fixture chat' }), insert: async (token, text) => { inserted.push({ token, text }); return { inserted: true } } },
    speech: () => ({ ready, transcribe: transcribe ?? (async pcm => { heard.push(pcm[0]); return `phrase ${pcm[0]}` }), polish }),
    changed: state => states.push(state), inCall: () => false, ...rest
  })
  return { job, states, inserted, heard }
}
const audio = number => new Float32Array(16000).fill(number)
test('releasing F9 preserves multilingual text through cleanup and focused-field insertion', async () => {
  const text = 'Bonjour André. 请检查 Jira。 Привет! مرحباً. Dobar dan.'
  const { job, inserted } = fixture({ transcribe: async () => text, polish: async value => value })
  await job.start(true); const id = job.status().id
  job.push(id, audio(1)); job.stop(); await job.finish(id)
  assert.deepEqual(inserted, [{ token: 'original', text }])
  assert.equal(job.status().phase, 'done'); job.dispose()
})
async function recorded(job) { await job.start(); const id = job.status().id; job.push(id, audio(1)); job.stop(); return id }

test('dictation: sentences stay ordered and insert once after the final microphone flush', async () => {
  const { job, inserted, heard } = fixture()
  await job.start(); const id = job.status().id
  job.push(id, audio(1)); job.push(id, audio(2)); job.stop(); job.push(id, audio(3))
  await Promise.all([job.finish(id), job.finish(id)])
  assert.deepEqual(heard, [1, 2, 3]); assert.deepEqual(inserted, [{ token: 'original', text: 'phrase 1 phrase 2 phrase 3.' }])
  assert.equal(job.status().phase, 'done')
  job.failed(id, 'Late device callback'); assert.equal(job.status().phase, 'done')
  job.dispose()
})

test('hold dictation targets the field focused at release, ignoring late key-down capture', async () => {
  const initial = deferred(), inserted = []; let captures = 0
  const { job } = fixture({ target: {
    capture: () => ++captures === 1 ? initial.promise : Promise.resolve({ token: 'release-field', label: 'Slack' }),
    insert: async (token, text) => { inserted.push({ token, text }); return { inserted: true } }
  } })
  const starting = job.start(true); await tick()
  assert.equal(job.status().hold, true)
  const id = job.status().id; job.push(id, audio(1)); job.stop()
  await job.finish(id)
  initial.resolve({ token: 'old-field', label: 'Old window' }); await starting
  assert.deepEqual(inserted, [{ token: 'release-field', text: 'phrase 1.' }])
  assert.equal(job.status().destination, 'Slack'); job.dispose()
})

test('releasing F9 immediately without speech does not insert or leave recording stuck', async () => {
  const { job, inserted } = fixture()
  const starting = job.start(true), id = job.status().id
  job.stop(); await job.finish(id); await starting
  assert.equal(job.status().phase, 'ready'); assert.deepEqual(inserted, []); job.dispose()
})
test('dictation: cancelling recognition cannot insert into a later job', async () => {
  const delayed = deferred(); let requests = 0
  const { job, inserted } = fixture({ transcribe: () => ++requests === 1 ? delayed.promise : Promise.resolve('new words') })
  const old = await recorded(job); const finished = job.finish(old)
  await tick(); job.cancel()
  const next = await recorded(job); const final = job.finish(next)
  delayed.resolve('cancelled private words'); await Promise.all([finished, final])
  assert.equal(inserted.length, 1); assert.equal(inserted[0].text, 'new words.'); job.dispose()
})
test('dictation: late setup after cancel never restarts capture or inserts words', async () => {
  const delayed = deferred(), { job, states } = fixture({ ready: () => delayed.promise })
  const starting = job.start(); await tick(); job.cancel()
  const afterCancel = states.length
  delayed.resolve(); await starting
  assert.equal(job.status().phase, 'idle'); assert.equal(states.length, afterCancel)
})

test('dictation: captures early words during slow setup; finish still works before setup completes', async () => {
  const ready = deferred(), polish = deferred()
  const { job, inserted, heard } = fixture({ ready: () => ready.promise, polish: () => polish.promise })
  const opening = job.toggle()
  assert.equal(job.status().phase, 'recording'); assert.equal(job.status().preparing, true)
  const id = job.status().id; job.push(id, audio(1)); job.push(id, audio(2)); await job.toggle()
  assert.equal(job.status().phase, 'finishing')
  await job.toggle(); assert.equal(job.status().phase, 'finishing')
  const finished = job.finish(id); await tick()
  assert.deepEqual(heard, [], 'Audio is buffered until the frozen provider is ready')
  ready.resolve(); await opening; await tick()
  assert.deepEqual(heard, [1, 2], 'The first words survive and stay in order')
  await job.toggle(); assert.equal(job.status().phase, 'polishing')
  polish.resolve('Keep these words.'); await finished
  assert.equal(inserted.length, 1); assert.equal(inserted[0].text, 'Keep these words.')
  job.dispose()
})

test('dictation: a slow text box does not block recognition; insertion still waits for its captured target', async () => {
  const target = deferred(), inserted = []
  const { job, heard } = fixture({ target: { capture: () => target.promise, insert: async (token, text) => { inserted.push({ token, text }); return { inserted: true } } } })
  const opening = job.start(), id = job.status().id
  job.push(id, audio(1)); await tick()
  assert.deepEqual(heard, [1], 'Recognition runs while the destination is still being detected')
  job.stop(); const finished = job.finish(id); await tick()
  assert.deepEqual(inserted, []); assert.match(job.status().message, /Finding your text box/)
  target.resolve({ token: 'slow-original-field', label: 'Editor' }); await opening; await finished
  assert.deepEqual(inserted, [{ token: 'slow-original-field', text: 'phrase 1.' }]); job.dispose()
})
test('dictation: changed focus recovers text without another insertion attempt', async () => {
  let attempts = 0
  const { job } = fixture({ target: { capture: async () => ({ token: 'one', label: 'Chat' }), insert: async () => { attempts++; return { inserted: false, message: 'Cursor moved' } } } })
  const id = await recorded(job); await job.finish(id); await job.finish(id)
  assert.equal(attempts, 1); assert.equal(job.status().phase, 'ready'); assert.equal(job.status().lastText, 'phrase 1.'); job.dispose()
})
test('dictation: unsupported text fields retain text for Copy', async () => {
  const { job, inserted } = fixture({ target: { capture: async () => ({ label: 'Custom editor', reason: 'Copy into this editor.' }), insert: async () => { throw Error('Must not insert') } } })
  await job.finish(await recorded(job))
  assert.equal(inserted.length, 0); assert.equal(job.status().phase, 'ready'); assert.equal(job.status().text, 'phrase 1.'); job.dispose()
})
test('dictation: cleanup failure still inserts the recognized words', async () => {
  const { job, inserted } = fixture({ polish: async () => { throw Error('Plan limit') } })
  await job.finish(await recorded(job)); assert.equal(inserted[0].text, 'phrase 1'); assert.match(job.status().message, /original words/i); job.dispose()
})
test('dictation: cancel during cleanup never delivers a late response', async () => {
  const delayed = deferred(), { job, inserted } = fixture({ polish: () => delayed.promise })
  const finished = job.finish(await recorded(job)); await tick(); assert.equal(job.status().phase, 'polishing')
  job.cancel(); delayed.resolve('late text'); await finished; assert.equal(inserted.length, 0)
})

test('dictation: Use original aborts cleanup and inserts once even when the provider ignores abort', async () => {
  const late = deferred(); let signal
  const { job, inserted } = fixture({ polish: (_text, cancellation) => { signal = cancellation; return late.promise } })
  const id = await recorded(job), finished = job.finish(id); await tick()
  job.useOriginal('old'); assert.equal(signal.aborted, false)
  job.useOriginal(id); job.useOriginal(id); await finished
  assert.equal(signal.aborted, true)
  assert.deepEqual(inserted, [{ token: 'original', text: 'phrase 1' }])
  late.resolve('A late rewrite must not overwrite the original.'); await tick()
  assert.equal(inserted.length, 1); assert.equal(job.status().text, 'phrase 1')
  job.dispose()
})

test('dictation: cancelling immediately after Use original cannot insert', async () => {
  const { job, inserted } = fixture({ polish: () => new Promise(() => {}) })
  const id = await recorded(job), finished = job.finish(id); await tick()
  job.useOriginal(id); job.cancel(); await finished
  assert.deepEqual(inserted, [])
})

test('dictation: setup failure releases capture and never transcribes buffered speech', async () => {
  const ready = deferred(), { job, states, inserted, heard } = fixture({ ready: () => ready.promise })
  const opening = job.start(), id = job.status().id
  job.push(id, audio(1)); ready.reject(new Error('Local speech unavailable')); await opening; await tick()
  assert.equal(job.status().phase, 'error'); assert.equal(job.status().preparing, false)
  assert.match(states.at(-1).message, /Local speech/); assert.deepEqual(heard, []); assert.deepEqual(inserted, [])
  job.dispose()
})

test('dictation: microphone choice is frozen at start and changes only on the next recording', async () => {
  let microphone = 'headset'
  const { job } = fixture({ microphone: () => microphone })
  await job.start(); microphone = 'usb'
  assert.equal(job.status().microphoneId, 'headset'); job.cancel(); await job.start()
  assert.equal(job.status().microphoneId, 'usb'); job.dispose()
})

test('dictation: copy acknowledgement dismisses only the text actually copied', async () => {
  const { job } = fixture({ target: { capture: async () => ({ label: 'Editor' }), insert: async () => { throw Error('No target') } } })
  await job.finish(await recorded(job))
  const previous = job.status(); job.copied(previous.id, 'Different text')
  assert.equal(job.status().phase, 'ready')
  job.copied(previous.id, previous.text); assert.equal(job.status().phase, 'done'); assert.equal(job.status().outcome, 'copied')
  await job.start(); job.copied(previous.id, previous.text)
  assert.equal(job.status().phase, 'recording', 'A slow clipboard reply must not dismiss a later dictation')
  job.dispose()
})

test('dictation: a tray clipboard failure recovers the text without interrupting another recording', async () => {
  const { job } = fixture()
  await job.finish(await recorded(job))
  const done = job.status(); job.copyFailed(done.id, done.text)
  assert.equal(job.status().phase, 'ready'); assert.equal(job.status().text, done.text)
  assert.match(job.status().message, /Could not copy/)
  await job.start(); job.copyFailed(done.id, done.text)
  assert.equal(job.status().phase, 'recording'); job.dispose()
})
test('dictation: retrying a tray copy after cancellation dismisses recovered text', async () => {
  const { job } = fixture()
  await job.finish(await recorded(job)); job.cancel()
  const idle = job.status()
  assert.equal(idle.id, undefined)
  job.copyFailed(idle.id, idle.lastText)
  assert.equal(job.status().phase, 'ready'); assert.equal(job.status().text, idle.lastText)
  job.copied(idle.id, idle.lastText)
  assert.equal(job.status().phase, 'done'); assert.equal(job.status().outcome, 'copied')
  job.dispose()
})
test('dictation: insertion is a single commit, and shutdown ignores its late receipt', async () => {
  const delayed = deferred()
  const { job } = fixture({ target: { capture: async () => ({ token: 'one', label: 'Chat' }), insert: () => delayed.promise } })
  const finished = job.finish(await recorded(job)); await tick(); assert.equal(job.status().phase, 'inserting')
  await job.toggle(); assert.equal(job.status().phase, 'inserting')
  job.dispose(); delayed.resolve({ inserted: true }); await finished; assert.equal(job.status().phase, 'idle')
})
test('dictation: failed recognition preserves earlier words without automatically inserting a partial message', async () => {
  let n = 0
  const { job, inserted } = fixture({ transcribe: async () => { if (++n === 2) throw Error('Offline'); return 'Keep these words' } })
  await job.start(); const id = job.status().id; job.push(id, audio(1)); job.push(id, audio(2)); job.stop(); await job.finish(id)
  assert.equal(inserted.length, 0); assert.equal(job.status().phase, 'error'); assert.equal(job.status().text, 'Keep these words'); job.dispose()
})
test('dictation: no speech and malformed or stale chunks never send text', async () => {
  const { job, heard, inserted } = fixture()
  await job.start(); const id = job.status().id
  job.push('old', audio(1)); job.push(id, [1]); job.push(id, new Float32Array([NaN])); job.push(id, new Float32Array(31 * 16000))
  job.stop(); await job.finish(id)
  assert.deepEqual(heard, []); assert.deepEqual(inserted, []); assert.match(job.status().message, /No speech/); job.dispose()
})
test('dictation: bounded queue stops runaway capture', async () => {
  const delayed = deferred(), { job } = fixture({ transcribe: () => delayed.promise })
  await job.start(); const id = job.status().id
  for (let n = 0; n < 10; n++) job.push(id, audio(n))
  assert.equal(job.status().phase, 'error'); delayed.resolve('late'); job.dispose()
})

test('an empty F9 attempt returns to idle without hiding the persistent indicator or affecting call audio', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { job, inserted } = fixture({ inCall: () => true })
  await job.start(true)
  const id = job.status().id
  job.stop(); await job.finish(id)
  assert.equal(job.status().phase, 'ready')
  t.mock.timers.tick(2500)
  assert.equal(job.status().phase, 'idle')
  assert.deepEqual(inserted, [])
  job.dispose()
})

test('the empty-attempt timer cannot cancel a later F9 recording', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { job } = fixture()
  await job.start(true)
  job.stop(); await job.finish(job.status().id)
  await job.start(true)
  t.mock.timers.tick(2600)
  assert.equal(job.status().phase, 'recording')
  job.dispose()
})
test('dictation: timestamp overlap protects a late call segment spanning the dictation interval', async () => {
  let now = 1000; const { job } = fixture({ now: () => now, inCall: () => true })
  await job.start(); assert.equal(job.status().inCall, true); now = 2000; job.stop()
  assert.equal(job.overlaps(900, 2500), true); assert.equal(job.overlaps(10, 999), false); assert.equal(job.overlaps(2001, 3000), false); job.dispose()
})
test('dictation: short replies survive the speech cleaner and explicit capture', () => {
  assert.equal(cleanTranscript('Okay.', 0.7, 'en'), '')
  assert.equal(cleanTranscript('Okay.', 0.7, 'en', true), 'Okay.')
  assert.equal(cleanTranscript('Thank you.', 1, 'en', true), 'Thank you.')
  const parts = [], segmenter = new Segmenter(pcm => parts.push(pcm), false, 160)
  for (let n = 0; n < 8; n++) segmenter.push(new Float32Array(512).fill(0.06))
  segmenter.flush(); assert.equal(parts.length, 1); assert.equal(parts[0].length, 4096)
})

test('live dictation buffers early audio, streams during recording, drains the tail and inserts exactly once', async () => {
  const ready = deferred(), recognition = deferred(), received = []
  let finalized = 0, disposed = 0
  const { job, inserted, states } = fixture({ speech: () => ({
    streaming: true, polishes: false, ready: () => ready.promise,
    transcribe: () => assert.fail('Never batch live PCM'), polish: async text => text,
    push: pcm => received.push(...pcm), finish: () => { finalized++; return recognition.promise }, dispose: () => { disposed++ }
  }) })
  const opening = job.start(true), id = job.status().id
  job.push(id, new Float32Array([1, 2])); await tick(); assert.deepEqual(received, [])
  ready.resolve(); await opening
  job.push(id, new Float32Array([3, 4])); await tick()
  assert.deepEqual(received, [1, 2, 3, 4], 'Audio travels while F9 is still held')
  job.stop(); job.push(id, new Float32Array([5]))
  const finishing = job.finish(id); await job.finish(id); await tick()
  assert.deepEqual(received, [1, 2, 3, 4, 5]); assert.equal(finalized, 1)
  assert.equal(job.status().phase, 'finishing'); assert.deepEqual(inserted, [])
  recognition.resolve('Keep every word.'); await finishing
  assert.deepEqual(inserted, [{ token: 'original', text: 'Keep every word.' }])
  assert.equal(disposed, 1); assert.ok(!states.some(state => state.phase === 'polishing'))
  job.dispose()
})

test('live dictation cancellation cannot insert a late stream final into a subsequent field', async () => {
  const final = deferred(); let disposed = 0
  const { job, inserted } = fixture({ speech: () => ({ streaming: true, ready: async () => {}, push: () => {}, transcribe: () => assert.fail(),
    finish: () => final.promise, polish: async text => text, dispose: () => { disposed++ } }) })
  await job.start(); const id = job.status().id; job.push(id, audio(1)); job.stop()
  const finishing = job.finish(id); await tick(); job.cancel()
  final.resolve('Do not enter these words'); await finishing
  assert.deepEqual(inserted, []); assert.equal(disposed, 1); assert.equal(job.status().phase, 'idle')
})

test('cleanup overlaps a slow release target instead of adding its latency to model latency', async () => {
  const target = deferred(), cleanup = deferred(); let cleaned = false
  const { job, inserted } = fixture({ target: { capture: () => target.promise, insert: async (token, text) => { inserted.push({ token, text }); return { inserted: true } } },
    polish: () => { cleaned = true; return cleanup.promise } })
  const opening = job.start(true), id = job.status().id; job.push(id, audio(1)); job.stop()
  const finishing = job.finish(id); await tick()
  assert.equal(cleaned, true, 'Cleanup begins before the target is ready')
  assert.equal(job.status().phase, 'polishing'); assert.deepEqual(inserted, [])
  target.resolve({ token: 'release', label: 'Editor' }); await opening
  assert.deepEqual(inserted, [])
  cleanup.resolve('Final text.'); await finishing
  assert.deepEqual(inserted, [{ token: 'release', text: 'Final text.' }]); job.dispose()
})

test('stream failure and silence both release prepared resources without inserting text', async () => {
  for (const outcome of ['silence', 'error']) {
    let disposed = 0
    const { job, inserted } = fixture({ speech: () => ({ streaming: true, ready: async () => {}, push: () => {}, transcribe: () => assert.fail(), polish: () => assert.fail(),
      finish: async () => { if (outcome === 'error') throw Error('Connection closed'); return '' }, dispose: () => { disposed++ } }) })
    await job.start(); const id = job.status().id; job.stop(); await job.finish(id)
    assert.equal(job.status().phase, outcome === 'silence' ? 'ready' : 'error')
    assert.deepEqual(inserted, []); assert.equal(disposed, 1); job.dispose()
  }
})

test('subscription cleanup warms before speech setup, sends only final text and closes its runtime', async () => {
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.claude.auth = 'subscription'; settings.dictation.polish = true
  const connection = deferred(), sent = [], samples = []
  let warmed = 0, closed = 0, cancelled = 0
  const controller = new AbortController()
  const speech = new DictationSpeech({ settings: () => settings, claudeAccount: async () => ({ signedIn: true, email: 'work@test.example' }),
    claude: { prepareText: async (input, options) => {
      warmed++; assert.equal(JSON.parse(input.user).dictated_text, '')
      return { send: async user => { sent.push(JSON.parse(user).dictated_text); options.onFinal('Final sentence.') }, close: () => { closed++ } }
    }, stream: () => assert.fail('Reuse the prepared process') },
    claudeStream: () => connection.promise
  })
  const opening = speech.ready(controller.signal); await tick()
  assert.equal(warmed, 1); assert.deepEqual(sent, [])
  connection.resolve({ push: pcm => samples.push(...pcm), finish: async () => 'final sentence', cancel: () => { cancelled++ } }); await opening
  speech.push(new Float32Array([.5])); assert.deepEqual(samples, [.5])
  const raw = await speech.finish(controller.signal); assert.equal(await speech.polish(raw, controller.signal), 'Final sentence.')
  assert.deepEqual(sent, ['final sentence']); assert.equal(closed, 1)
  speech.dispose(); assert.equal(cancelled, 1)
})

test('cancelled speech setup closes a late live connection and prepared runtime without sending text', async () => {
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.claude.auth = 'subscription'; settings.dictation.polish = true
  const connection = deferred(), prepared = deferred(), controller = new AbortController()
  let cancelled = 0, closed = 0
  const speech = new DictationSpeech({ settings: () => settings, claudeAccount: async () => ({ signedIn: true, email: 'work@test.example' }),
    claude: { prepareText: () => prepared.promise }, claudeStream: () => connection.promise })
  const opening = speech.ready(controller.signal); await tick()
  controller.abort(new Error('Cancelled')); speech.dispose()
  await assert.rejects(opening, /Cancelled/)
  connection.resolve({ cancel: () => { cancelled++ } })
  prepared.resolve({ send: () => assert.fail('Cancelled before the final transcript'), close: () => { closed++ } })
  await tick(); assert.equal(cancelled, 1); assert.equal(closed, 1)
})

function speechFixture() {
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.claude.auth = 'subscription'
  let account = { signedIn: true, email: 'one@example.test' }, localReady = true
  const requests = [], remote = [], local = [], claudeAudio = []
  const provider = id => ({ id, stream: async (input, options) => { requests.push({ id, input, options }); options.onDelta('Clean words.'); options.onFinal?.('Clean words.') } })
  const speech = new DictationSpeech({ settings: () => settings, chatgpt: provider('chatgpt'), claude: provider('claude'),
    chatgptAccount: () => account, claudeAccount: async () => account, localReady: () => localReady,
    local: async pcm => { local.push(pcm); return 'raw words' }, remote: async pcm => { remote.push(pcm); return 'plan words' },
    claudeSpeech: async (language, email) => async pcm => {
      if (!account.signedIn || account.email !== email) throw Error('The Claude account changed')
      claudeAudio.push({ pcm, language }); return 'Claude speech words'
    }
  })
  return { speech, settings, requests, remote, local, claudeAudio, account: value => { account = value }, ready: value => { localReady = value } }
}
test('dictation: Claude transcribes through the signed-in account without local models or another provider', async () => {
  const f = speechFixture(), signal = new AbortController().signal; f.ready(false); await f.speech.ready()
  f.settings.provider = 'chatgpt'
  assert.equal(await f.speech.transcribe(audio(1), signal), 'Claude speech words')
  assert.equal(await f.speech.polish('uh raw words', signal), 'Clean words.')
  assert.equal(f.claudeAudio.length, 1); assert.equal(f.local.length, 0); assert.equal(f.remote.length, 0); assert.equal(f.requests[0].id, 'claude')
  assert.equal(f.requests[0].input.model, 'haiku', 'Simple cleanup uses the fast subscription model independently of call answers')
  assert.deepEqual(f.requests[0].input.tools, []); assert.equal(f.requests[0].input.history, undefined); assert.equal(f.requests[0].input.claudeConnections, undefined)
  f.account({ signedIn: true, email: 'other@example.test' })
  await assert.rejects(f.speech.transcribe(audio(1), signal), /account changed/)
})
test('dictation: an old local preference migrates to subscription speech, and cleanup uses the same account', async () => {
  const f = speechFixture(), signal = new AbortController().signal
  f.settings.dictation.speech = 'local'; await f.speech.ready()
  assert.equal(await f.speech.transcribe(audio(1), signal), 'Claude speech words'); assert.equal(f.local.length, 0)
  f.settings.provider = 'chatgpt'; f.settings.dictation.speech = 'claude'; f.ready(false); await f.speech.ready()
  assert.equal(await f.speech.transcribe(audio(1), signal), 'Claude speech words'); await f.speech.polish('hello', signal)
  assert.equal(f.requests[0].id, 'claude')
})
test('dictation: Claude speech still requires a sign-in when cleanup is off and never falls back silently', async () => {
  const f = speechFixture(); f.settings.dictation.polish = false; f.account({ signedIn: false })
  await assert.rejects(f.speech.ready(), /Sign in with Claude/)
  assert.equal(f.local.length, 0); assert.equal(f.remote.length, 0)
  await assert.rejects(f.speech.transcribe(audio(1), new AbortController().signal), /Start dictation again/)
})
test('dictation: ChatGPT uses the existing plan, and a settings change cannot reroute active recording', async () => {
  const f = speechFixture(), signal = new AbortController().signal; f.settings.provider = 'chatgpt'; await f.speech.ready(); f.settings.provider = 'claude'
  assert.equal(await f.speech.transcribe(audio(1), signal), 'plan words'); await f.speech.polish('hello', signal)
  assert.equal(f.requests[0].id, 'chatgpt'); assert.equal(f.local.length, 0)
  f.account({ signedIn: true, email: 'other@example.test' })
  await assert.rejects(f.speech.transcribe(audio(1), signal), /account changed/); await assert.rejects(f.speech.polish('secret', signal), /account changed/)
})
test('dictation: API key mode requires choosing a subscription and never falls back to a local model', async () => {
  const f = speechFixture(); f.settings.claude.auth = 'api-key'
  await assert.rejects(f.speech.ready(), /subscription account/)
  assert.equal(f.requests.length, 0); assert.equal(f.local.length, 0)
  f.settings.dictation.speech = 'claude'; await f.speech.ready()
  assert.equal(await f.speech.transcribe(audio(1), new AbortController().signal), 'Claude speech words')
})
test('dictation: cleanup can be disabled; abort releases a hung backend promptly', async () => {
  const f = speechFixture(); f.settings.dictation.polish = false; await f.speech.ready()
  assert.equal(await f.speech.polish('Okay.', new AbortController().signal), 'Okay.'); assert.equal(f.requests.length, 0)
  const controller = new AbortController(), never = new Promise(() => {}), task = abortable(never, controller.signal)
  controller.abort(new Error('Cancelled')); await assert.rejects(task, /Cancelled/)
})
