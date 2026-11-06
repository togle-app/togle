import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter, once } from 'node:events'
import { createHash } from 'node:crypto'
import WebSocket, { WebSocketServer } from 'ws'
import { ClaudeSpeech, ClaudeSpeechAccess, claudeSpeechPcm, claudeSpeechLanguage, claudeSpeechStore, claudeKeychainService, CLAUDE_SPEECH_URL } from './.build/togle.mjs'

const profile = { directory: 'account-folder', email: 'one@example.test', organization: 'team-one' }
const signal = () => new AbortController().signal
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

function accessFixture() {
  let now = 1000, current = { ...profile }, refreshes = 0, reads = 0
  const store = { accessToken: 'test-only-token', expiresAt: 100_000, voiceAllowed: true }
  const access = new ClaudeSpeechAccess({ speechProfile: async () => ({ ...current }) }, async () => { refreshes++; store.expiresAt = now + 120_000 }, async () => { reads++; return { ...store } }, () => now)
  return { access, store, account: value => { current = value }, time: value => { now = value }, counts: () => ({ refreshes, reads }) }
}

test('Claude speech access initializes through the official runtime, reuses policy and refreshes expiring tokens', async () => {
  const f = accessFixture(), p = await f.access.prepare(profile.email, signal())
  assert.deepEqual(p, profile); assert.equal(await f.access.token(p, signal()), 'test-only-token')
  assert.equal(f.counts().refreshes, 1)
  f.time(70_000); await f.access.token(p, signal()); assert.equal(f.counts().refreshes, 2)
  f.time(400_000); await f.access.token(p, signal()); assert.equal(f.counts().refreshes, 3)
})

test('Claude speech access refuses account and organization changes and an organization voice denial', async () => {
  const f = accessFixture(), p = await f.access.prepare(profile.email, signal())
  f.store.voiceAllowed = false; await assert.rejects(f.access.token(p, signal()), /disabled by your organization/)
  f.store.voiceAllowed = true; f.account({ ...profile, organization: 'different-team' })
  await assert.rejects(f.access.token(p, signal()), /workspace changed/)
  await assert.rejects(f.access.prepare('other@example.test', signal()), /account changed/)
})

test('Claude speech access shares refresh, checks cancellation, and cannot adopt an account switched during refresh', async () => {
  const pending = deferred(); let count = 0, current = profile
  const access = new ClaudeSpeechAccess({ speechProfile: async () => current }, async () => { count++; await pending.promise }, async () => ({ accessToken: 'test', expiresAt: Date.now() + 120_000, voiceAllowed: true }))
  const controller = new AbortController()
  const a = access.prepare(profile.email, controller.signal), b = access.prepare(profile.email, signal())
  await tick(); assert.equal(count, 1)
  controller.abort(new Error('Cancelled')); current = { ...profile, email: 'other@example.test' }; pending.resolve()
  await assert.rejects(a, /Cancelled/); await assert.rejects(b, /account.*changed/)
})

test('Claude speech storage validates access and policy without disclosing secrets or reading refresh tokens', () => {
  const oauth = { claudeAiOauth: { accessToken: 'test-only', expiresAt: 5000, refreshToken: 'must-not-be-returned' } }
  assert.deepEqual(claudeSpeechStore(oauth, { restrictions: {} }), { accessToken: 'test-only', expiresAt: 5000, voiceAllowed: true })
  assert.equal(claudeSpeechStore(oauth, { restrictions: { allow_voice_mode: { allowed: false } } }).voiceAllowed, false)
  assert.throws(() => claudeSpeechStore(oauth, null), /permissions/)
  assert.throws(() => claudeSpeechStore(oauth, { restrictions: { allow_voice_mode: { allowed: 'yes' } } }), /permissions/)
  assert.throws(() => claudeSpeechStore({ secret: 'must-not-leak' }, { restrictions: {} }), error => !error.message.includes('must-not-leak'))
  assert.equal(claudeKeychainService({}), 'Claude Code-credentials')
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: '/profiles/work' }), 'Claude Code-credentials-' + createHash('sha256').update('/profiles/work').digest('hex').slice(0, 8))
  assert.equal(claudeKeychainService({ CLAUDE_CONFIG_DIR: '/profiles/work', CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }), 'Claude Code-credentials')
})

function fixture(autoOpen = true) {
  const socket = new EventEmitter(); socket.sent = []; socket.stopped = 0
  socket.send = (data, callback) => { socket.sent.push(data); callback?.() }
  socket.terminate = () => { socket.stopped++ }
  let headers, destination, tokens = 0
  const speech = new ClaudeSpeech({ prepare: async () => profile, token: async p => { assert.deepEqual(p, profile); tokens++; return 'test-only-token' } }, (url, options) => { destination = url; headers = options; if (autoOpen) queueMicrotask(() => socket.emit('open')); return socket })
  const emit = frame => socket.emit('message', Buffer.from(JSON.stringify(frame)), false)
  return { speech, socket, emit, options: () => headers, url: () => destination, tokens: () => tokens }
}

test('Claude speech PCM clamps samples; unsupported languages and oversized audio never connect', async () => {
  const bytes = claudeSpeechPcm(new Float32Array([-2, -1, 0, 1, 2]))
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => bytes.readInt16LE(i * 2)), [-32768, -32768, 0, 32767, 32767])
  assert.equal(claudeSpeechLanguage('de-DE'), 'de'); assert.throws(() => claudeSpeechLanguage('auto'), /Choose a language/)
  assert.throws(() => claudeSpeechLanguage('unsupported'), /language/)
  const f = fixture(), transcribe = await f.speech.prepare('en', profile.email, signal())
  assert.equal(await transcribe(new Float32Array(), signal()), '')
  await assert.rejects(transcribe(new Float32Array([NaN]), signal()), /invalid audio/)
  await assert.rejects(transcribe(new Float32Array(30 * 16000 + 1), signal()), /invalid audio/)
  assert.equal(f.tokens(), 0)
})

test('Claude speech replaces interim text, retains repeated utterances and waits for the complete stream', async () => {
  const f = fixture(), transcribe = await f.speech.prepare('en', profile.email, signal())
  let done = false; const result = transcribe(new Float32Array(16000), signal()).then(value => { done = true; return value })
  await tick()
  assert.equal(f.url().origin + f.url().pathname, CLAUDE_SPEECH_URL)
  assert.equal(f.url().searchParams.get('sample_rate'), '16000')
  assert.equal(f.options().followRedirects, false); assert.equal(f.options().headers.Authorization, 'Bearer test-only-token')
  assert.equal(JSON.parse(f.socket.sent[0]).type, 'KeepAlive'); assert.equal(JSON.parse(f.socket.sent.at(-1)).type, 'CloseStream')
  assert.equal(Buffer.concat(f.socket.sent.filter(Buffer.isBuffer)).length, 32000)
  f.emit({ type: 'TranscriptInterim', data: 'send' }); f.emit({ type: 'TranscriptText', data: 'Send the update.' }); f.emit({ type: 'TranscriptEndpoint' })
  await tick(); assert.equal(done, false, 'One endpoint is not the end of a multi-sentence recording')
  f.emit({ type: 'TranscriptText', data: 'Send the update.' }); f.emit({ type: 'TranscriptEndpoint' }); f.socket.emit('close', 1000)
  assert.equal(await result, 'Send the update. Send the update.'); assert.equal(f.socket.stopped, 1)
})

test('Claude speech rejects partial results on protocol, server and connection failures, including after CloseStream', async () => {
  for (const fail of [f => f.emit({ type: 'TranscriptError', description: 'private-server-detail' }), f => f.socket.emit('close', 1006), f => f.socket.emit('error', new Error('secret-token')), f => f.socket.emit('message', Buffer.from('{private-data'), false), f => f.emit({ type: 'TranscriptText', data: {} })]) {
    const f = fixture(), transcribe = await f.speech.prepare('en', profile.email, signal())
    const result = transcribe(new Float32Array(1600), signal()); await tick()
    f.emit({ type: 'TranscriptText', data: 'Incomplete words' }); fail(f)
    await assert.rejects(result, error => !/private|secret/.test(error.message)); assert.equal(f.socket.stopped, 1)
  }
})

test('Claude speech cancellation before and after connection never returns late text', async () => {
  const f = fixture(), transcribe = await f.speech.prepare('en', profile.email, signal()), controller = new AbortController()
  const result = transcribe(new Float32Array(1600), controller.signal); await tick(); controller.abort(new Error('Cancelled'))
  f.emit({ type: 'TranscriptText', data: 'Too late' }); f.socket.emit('close', 1000)
  await assert.rejects(result, /Cancelled/); assert.equal(f.socket.stopped, 1)
  await assert.rejects(transcribe(new Float32Array(1600), controller.signal), /Cancelled/); assert.equal(f.tokens(), 1)
})

test('Claude speech explains authentication, policy and rate-limit rejections without falling back', async () => {
  for (const [statusCode, match] of [[401, /Sign in again/], [403, /not available/], [429, /limit/], [500, /connect/]]) {
    const f = fixture(), transcribe = await f.speech.prepare('en', profile.email, signal())
    const result = transcribe(new Float32Array(1600), signal()); await tick()
    f.socket.emit('unexpected-response', { destroy() {} }, { statusCode, resume() {} })
    await assert.rejects(result, match)
  }
})

test('Claude speech sends real WebSocket PCM frames and waits for later sentences before resolving', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening')
  t.after(() => { for (const client of server.clients) client.terminate(); server.close() })
  let bytes = 0
  server.on('connection', (client, request) => {
    assert.equal(request.headers.authorization, 'Bearer fixture')
    client.on('message', (data, binary) => {
      if (binary) { bytes += data.length; return }
      if (JSON.parse(data.toString()).type !== 'CloseStream') return
      client.send(JSON.stringify({ type: 'TranscriptText', data: 'First sentence.' })); client.send(JSON.stringify({ type: 'TranscriptEndpoint' }))
      setTimeout(() => { client.send(JSON.stringify({ type: 'TranscriptText', data: 'And the second.' })); client.send(JSON.stringify({ type: 'TranscriptEndpoint' })); client.close(1000) }, 25)
    })
  })
  const speech = new ClaudeSpeech({ prepare: async () => profile, token: async () => 'fixture' }, (_, options) => new WebSocket(`ws://127.0.0.1:${server.address().port}`, options))
  const transcribe = await speech.prepare('en', profile.email, signal())
  assert.equal(await transcribe(new Float32Array(4800), signal()), 'First sentence. And the second.'); assert.equal(bytes, 9600)
})

test('live Claude speech sends audio before release, preserves startup order and closes exactly once', async () => {
  const f = fixture(false), live = await f.speech.open('en', profile.email, signal())
  const first = new Float32Array(2048).fill(.1), second = new Float32Array(512).fill(.2)
  live.push(first); assert.deepEqual(f.socket.sent, [], 'Buffer while the handshake is pending')
  f.socket.emit('open'); live.push(second)
  assert.deepEqual(Buffer.concat(f.socket.sent.filter(Buffer.isBuffer)), Buffer.concat([claudeSpeechPcm(first), claudeSpeechPcm(second)]))
  assert.equal(f.socket.sent.some(data => typeof data === 'string' && JSON.parse(data).type === 'CloseStream'), false)
  f.emit({ type: 'TranscriptInterim', data: 'First' }); f.emit({ type: 'TranscriptText', data: 'First sentence.' }); f.emit({ type: 'TranscriptEndpoint' })
  const final = live.finish(); assert.equal(live.finish(), final)
  assert.equal(f.socket.sent.filter(data => typeof data === 'string' && JSON.parse(data).type === 'CloseStream').length, 1)
  assert.throws(() => live.push(second), /already finished/)
  f.emit({ type: 'TranscriptText', data: 'Final word.' }); f.socket.emit('close', 1000)
  assert.equal(await final, 'First sentence. Final word.'); live.cancel(); assert.equal(f.socket.stopped, 1)
})

test('live Claude speech handles quick release before connection and silence without inventing text', async () => {
  const f = fixture(false), live = await f.speech.open('en', profile.email, signal())
  live.push(new Float32Array(128)); const final = live.finish()
  f.socket.emit('open')
  assert.equal(Buffer.concat(f.socket.sent.filter(Buffer.isBuffer)).length, 256)
  assert.equal(JSON.parse(f.socket.sent.at(-1)).type, 'CloseStream')
  f.socket.emit('close', 1000); assert.equal(await final, '')
})

test('live Claude speech rejects partial text on early close and cancellation before F9 release', async () => {
  for (const how of ['early-close', 'cancel', 'backpressure']) {
    const f = fixture(), live = await f.speech.open('en', profile.email, signal())
    live.push(new Float32Array(512)); f.emit({ type: 'TranscriptText', data: 'Incomplete message' })
    if (how === 'early-close') f.socket.emit('close', 1000)
    else if (how === 'cancel') live.cancel()
    else { f.socket.bufferedAmount = 1024 * 1024; assert.throws(() => live.push(new Float32Array(512)), /keep up/) }
    await tick() // The internal failure must be handled even before finish is called.
    assert.throws(() => live.push(new Float32Array(512)), /finished|cancelled|keep up/)
    await assert.rejects(live.finish(), /finished|cancelled|keep up/)
    assert.equal(f.socket.stopped, 1)
  }
})
