// Device failures during a call must remain visible and recover without losing its working input.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const turn = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
let context

class Track extends EventTarget {
  stops = 0
  constructor(kind) { super(); this.kind = kind }
  stop() { this.stops++ }
}
class Stream {
  constructor(tracks) { this.tracks = tracks }
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio') }
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video') }
}
const stream = (display = false) => new Stream([new Track('audio'), ...(display ? [new Track('video')] : [])])
const node = () => ({ connect(next) { return next }, disconnect() {} })

globalThis.window = {}
globalThis.document = { baseURI: 'file:///togle/index.html' }
globalThis.MediaStream = Stream
globalThis.AudioContext = class {
  closed = 0
  destination = node()
  audioWorklet = { addModule: async () => {} }
  constructor() { context.engines.push(this) }
  resume() { return context.resume() }
  async close() { this.closed++ }
  createMediaStreamSource() { return node() }
  createGain() { return { ...node(), gain: {} } }
}
globalThis.AudioWorkletNode = class {
  port = { onmessage: null }
  constructor() {
    if (context.failTap) { context.failTap = false; throw new Error('Audio processor failed') }
  }
  connect(next) { return next }
  disconnect() {}
}
const { CallCapture } = await import('./.build/capture.mjs')

test('microphone and call audio pause independently and paused devices never reopen on device changes', async t => {
  const { capture, mic, call } = setup(t)
  await capture.start(() => {})
  await capture.setPaused('me', true)
  assert.equal(capture.state.me.state, 'paused')
  assert.equal(mic.getAudioTracks()[0].stops, 1)
  assert.equal(call.getAudioTracks()[0].stops, 0)
  await capture.setPaused('them', true)
  assert.equal(call.getAudioTracks()[0].stops, 1)
  const count = context.micCalls + context.callCalls
  await capture.retryMissing()
  assert.equal(context.micCalls + context.callCalls, count)
  context.mic = async () => stream()
  await capture.setPaused('me', false)
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(capture.state.them.state, 'paused')
})

test('resuming a call with both inputs paused never requests either device', async t => {
  const { capture } = setup(t)
  await capture.start(() => {}, ['me', 'them'])
  assert.equal(context.micCalls + context.callCalls, 0)
  assert.equal(capture.state.me.state, 'paused')
  assert.equal(capture.state.them.state, 'paused')
})

test('rapid pause, resume, pause, resume releases the stale stream and follows the last intent', async t => {
  const { capture, call } = setup(t)
  await capture.start(() => {})
  await capture.setPaused('me', true)
  const pending = deferred(), stale = stream(), latest = stream()
  context.mic = () => pending.promise
  const firstResume = capture.setPaused('me', false)
  await capture.setPaused('me', true)
  context.mic = async () => latest
  await capture.setPaused('me', false)
  pending.resolve(stale)
  await firstResume
  assert.equal(stale.getAudioTracks()[0].stops, 1)
  assert.equal(latest.getAudioTracks()[0].stops, 0)
  assert.equal(call.getAudioTracks()[0].stops, 0)
  assert.equal(capture.state.me.state, 'ready')
})

function setup(t) {
  const mic = stream()
  const call = stream(true)
  context = {
    engines: [], micCalls: 0, callCalls: 0, states: [],
    resume: async () => {}, mic: async () => mic, call: async () => call,
    devices: [
      { kind: 'audioinput', deviceId: 'default', groupId: 'microphone-1' },
      { kind: 'audiooutput', deviceId: 'default', groupId: 'speakers-1' }
    ]
  }
  const media = new EventTarget()
  media.getUserMedia = () => { context.micCalls++; return context.mic() }
  media.getDisplayMedia = () => { context.callCalls++; return context.call() }
  media.enumerateDevices = async () => context.devices
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: media, userAgent: 'Windows' } })
  const capture = new CallCapture()
  capture.onState = state => context.states.push(state)
  t.after(() => capture.stop())
  return { capture, mic, call, media }
}

test('a complete call opens both inputs and releases every track at End call', async (t) => {
  const { capture, mic, call } = setup(t)
  assert.deepEqual(await capture.start(() => {}), [])
  assert.deepEqual(Object.keys(capture.levels), ['me', 'them'])
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(capture.state.them.state, 'ready')
  assert.equal(call.getVideoTracks()[0].stops, 1, 'loopback capture must release its video track')
  capture.stop()
  assert.equal(mic.getAudioTracks()[0].stops, 1)
  assert.equal(call.getAudioTracks()[0].stops, 1)
  assert.equal(context.engines[0].closed, 1)
  assert.deepEqual(capture.levels, {})
  assert.equal(capture.state.me.state, 'off')
})

test('a denied microphone leaves call audio working and reconnect retries only the microphone', async (t) => {
  const { capture, call } = setup(t)
  context.mic = async () => { throw new Error('Microphone permission denied') }
  assert.match((await capture.start(() => {}))[0], /Microphone unavailable/)
  assert.equal(capture.state.me.state, 'unavailable')
  assert.match(capture.state.me.detail, /permission denied/)
  assert.equal(capture.state.them.state, 'ready')
  const replacement = stream()
  context.mic = async () => replacement
  await capture.retryMissing()
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(capture.state.me.detail, undefined)
  assert.equal(context.callCalls, 1)
  assert.equal(context.engines.length, 1)
  assert.equal(call.getAudioTracks()[0].stops, 0, 'the working side keeps listening')
})

test('missing system audio reconnects without restarting the microphone or the call', async (t) => {
  const { capture, mic } = setup(t)
  context.call = async () => { throw new Error('System audio not available') }
  await capture.start(() => {})
  assert.equal(capture.state.them.state, 'unavailable')
  context.call = async () => stream(true)
  await capture.retryMissing()
  assert.equal(capture.state.them.state, 'ready')
  assert.equal(context.micCalls, 1)
  assert.equal(mic.getAudioTracks()[0].stops, 0)
})

test('macOS microphone denial explains the system permission and preserves call audio', async (t) => {
  const { capture } = setup(t)
  window.togle = { platform: 'darwin' }
  t.after(() => { delete window.togle })
  context.mic = async () => { throw new DOMException('Permission denied', 'NotAllowedError') }
  const warnings = await capture.start(() => {})
  assert.match(warnings[0], /System Settings → Privacy & Security → Microphone/)
  assert.equal(capture.state.them.state, 'ready')
  context.mic = async () => stream()
  await capture.retryMissing()
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(context.callCalls, 1)
})

test('macOS missing loopback audio explains screen/audio access and releases the unused video', async (t) => {
  const { capture, mic } = setup(t)
  window.togle = { platform: 'darwin' }
  t.after(() => { delete window.togle })
  const video = new Track('video')
  context.call = async () => new Stream([video])
  assert.match((await capture.start(() => {}))[0], /Screen & System Audio Recording/)
  assert.equal(video.stops, 1)
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(mic.getAudioTracks()[0].stops, 0)
  context.call = async () => stream(true)
  await capture.retryMissing()
  assert.equal(capture.state.them.state, 'ready')
  assert.equal(context.micCalls, 1)
})

test('when neither input can open, startup fails and closes the audio engine', async (t) => {
  const { capture } = setup(t)
  context.mic = context.call = async () => { throw new Error('Access denied') }
  await assert.rejects(capture.start(() => {}), /Microphone unavailable.*System audio unavailable/)
  assert.equal(context.engines[0].closed, 1)
  assert.deepEqual(capture.levels, {})
  assert.equal(capture.state.them.state, 'off')
})

test('an audio engine that fails to resume is closed before any device is opened', async (t) => {
  const { capture } = setup(t)
  context.resume = async () => { throw new Error('Audio engine unavailable') }
  await assert.rejects(capture.start(() => {}), /Audio engine unavailable/)
  assert.equal(context.engines[0].closed, 1)
  assert.equal(context.micCalls + context.callCalls, 0)
  assert.equal(capture.state.me.state, 'off')
})

test('a stream is released if attaching its audio processor fails', async (t) => {
  const { capture, mic } = setup(t)
  context.failTap = true
  await capture.start(() => {})
  assert.equal(mic.getAudioTracks()[0].stops, 1)
  assert.equal(capture.state.me.state, 'unavailable')
  assert.equal(capture.state.them.state, 'ready')
})

test('ending capture while microphone access is pending releases the late stream', async (t) => {
  const { capture, mic } = setup(t)
  const permission = deferred()
  context.mic = () => permission.promise
  const starting = capture.start(() => {})
  await turn()
  capture.stop()
  permission.resolve(mic)
  await assert.rejects(starting, /cancelled/)
  assert.equal(mic.getAudioTracks()[0].stops, 1)
  assert.equal(context.callCalls, 0)
  assert.equal(context.engines[0].closed, 1)
})

test('ending capture while the audio engine is opening closes it when it becomes ready', async (t) => {
  const { capture } = setup(t)
  const resuming = deferred()
  context.resume = () => resuming.promise
  const starting = capture.start(() => {})
  await turn()
  capture.stop()
  resuming.resolve()
  await assert.rejects(starting, /cancelled/)
  assert.equal(context.engines[0].closed, 1)
  assert.equal(context.micCalls + context.callCalls, 0)
  assert.equal(capture.state.them.state, 'off')
})

test('a screen share without an audio track stays unavailable and releases its video', async (t) => {
  const { capture } = setup(t)
  const video = new Track('video')
  context.call = async () => new Stream([video])
  await capture.start(() => {})
  assert.equal(video.stops, 1)
  assert.equal(capture.state.them.state, 'unavailable')
  assert.match(capture.state.them.detail, /no loopback audio track/)
  assert.equal(capture.state.me.state, 'ready')
})

test('unplugged headphones reconnect automatically and ignore duplicate ended events', async (t) => {
  const { capture, mic, call } = setup(t)
  await capture.start(() => {})
  const replacement = deferred()
  context.mic = () => replacement.promise
  mic.getAudioTracks()[0].dispatchEvent(new Event('ended'))
  mic.getAudioTracks()[0].dispatchEvent(new Event('ended'))
  assert.equal(capture.state.me.state, 'connecting')
  assert.equal(context.micCalls, 2)
  replacement.resolve(stream())
  await turn()
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(call.getAudioTracks()[0].stops, 0)
  assert.ok(context.states.some(state => state.me.state === 'connecting' && state.them.state === 'ready'))
})

test('a replacement arriving after End call cannot attach to the next call', async (t) => {
  const { capture, mic } = setup(t)
  await capture.start(() => {})
  const replacement = deferred()
  context.mic = () => replacement.promise
  mic.getAudioTracks()[0].dispatchEvent(new Event('ended'))
  capture.stop()
  context.mic = async () => stream()
  context.call = async () => stream(true)
  await capture.start(() => {})
  const late = stream()
  replacement.resolve(late)
  await turn()
  assert.equal(late.getAudioTracks()[0].stops, 1)
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(capture.state.them.state, 'ready')
  assert.equal(context.micCalls, 3)
})

test('plugging in a new default microphone retries an input that was unavailable at startup', async (t) => {
  const { capture, media } = setup(t)
  context.mic = async () => { throw new Error('No microphone') }
  await capture.start(() => {})
  context.mic = async () => stream()
  context.devices = context.devices.map(device => device.kind === 'audioinput' ? { ...device, groupId: 'new-headset' } : device)
  media.dispatchEvent(new Event('devicechange'))
  await turn()
  assert.equal(capture.state.me.state, 'ready')
  assert.equal(context.callCalls, 1)
})

test('reconnect exhaustion stays visible and a later manual retry can recover', async (t) => {
  const { capture } = setup(t)
  context.call = async () => { throw new Error('Headphones disconnected') }
  await capture.start(() => {})
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const retrying = capture.retryMissing()
  for (let attempt = 0; attempt < 5; attempt++) {
    await turn()
    t.mock.timers.tick(2000)
  }
  await retrying
  assert.equal(capture.state.them.state, 'unavailable')
  assert.match(capture.state.them.detail, /Headphones disconnected/)
  context.call = async () => stream(true)
  await capture.retryMissing()
  assert.equal(capture.state.them.state, 'ready')
})
