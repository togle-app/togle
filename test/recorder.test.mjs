// Ending a call releases screen capture, including capture still opening and frames still being encoded.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const turn = () => new Promise((resolve) => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
let context
globalThis.window = {
  togle: {
    prepareRecording: async (source) => { context.prepared.push(source) },
    setRecording: async (active) => { context.states.push(active) },
    addRecordedFrame: async (...args) => { context.frames.push(args) },
    startScreenMonitor: async source => { context.monitors.push(source); return { id: 'scope-' + context.monitors.length, state: 'watching' } },
    stopScreenMonitor: async id => { context.stoppedMonitors.push(id) },
    addScreenMonitorFrame: async (...args) => { context.monitorFrames.push(args); return true }
  },
  setInterval: (tick) => {
    const id = ++context.timerId
    context.timers.set(id, tick)
    return id
  },
  clearInterval: (id) => { context.timers.delete(id) }
}
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getDisplayMedia: () => context.media() } }
})
globalThis.document = {
  createElement: (tag) => tag === 'video'
    ? { muted: false, srcObject: null, readyState: 4, videoWidth: 640, videoHeight: 360, play: () => context.play() }
    : {
        width: 0, height: 0,
        getContext: () => ({ drawImage: () => {}, getImageData: () => ({ data: new Uint8ClampedArray(320 * 180 * 4) }) }),
        toBlob: (callback) => context.encoding ? context.encoded.push(callback) : callback(new Blob(['image']))
      }
}
const { ScreenRecorder } = await import('./.build/recorder.mjs')

function screen() {
  const track = new EventTarget()
  track.stops = 0
  track.stop = () => { track.stops++ }
  return { track, stream: { getTracks: () => [track], getVideoTracks: () => [track] } }
}

function setup(t) {
  const { track, stream } = screen()
  context = {
    prepared: [], states: [], frames: [], timers: new Map(), timerId: 0,
    encoded: [], encoding: false, media: async () => stream, play: async () => {}, monitors: [], stoppedMonitors: [], monitorFrames: []
  }
  const recorder = new ScreenRecorder()
  t.after(() => recorder.stop())
  return { recorder, track, stream }
}

test('stopping screen capture releases its track and stops saving frames', async (t) => {
  const { recorder, track } = setup(t)
  await recorder.start('cursor')
  assert.equal(recorder.active, true)
  const tick = [...context.timers.values()][0]
  tick()
  await turn()
  assert.equal(context.frames.length, 1, 'the active recorder saves a frame')
  recorder.stop()
  assert.equal(track.stops, 1)
  assert.equal(recorder.active, false)
  assert.equal(context.timers.size, 0)
  assert.deepEqual(context.states, [true, false])
  tick()
  await turn()
  assert.equal(context.frames.length, 1, 'a timer callback already queued at Stop cannot save another frame')
})

test('stopping while screen access opens releases the stream when it arrives', async (t) => {
  const { recorder, track, stream } = setup(t)
  const media = deferred()
  context.media = () => media.promise
  const starting = recorder.start('cursor')
  await turn()
  recorder.stop()
  media.resolve(stream)
  await starting
  assert.equal(track.stops, 1)
  assert.equal(recorder.active, false)
  assert.deepEqual(context.states, [false], 'the cancelled start never marks capture active')
  assert.equal(context.timers.size, 0)
})

test('stopping while the captured video starts cannot start its timer later', async (t) => {
  const { recorder, track } = setup(t)
  const playing = deferred()
  context.play = () => playing.promise
  const starting = recorder.start('cursor')
  await turn()
  recorder.stop()
  playing.resolve()
  await starting
  assert.equal(track.stops, 1)
  assert.equal(recorder.active, false)
  assert.deepEqual(context.states, [false])
  assert.equal(context.timers.size, 0)
})

test('automatic monitoring buffers images locally and refreshes only its selected source', async (t) => {
  const { recorder, track } = setup(t)
  await recorder.start('window:call', true)
  const tick = [...context.timers.values()][0]
  tick()
  await turn()
  assert.equal(context.frames.length, 0, 'automatic sampling must not use the persisted recorder path')
  assert.equal(context.monitorFrames.length, 1)
  assert.equal(context.monitorFrames[0][0], 'scope-1')
  recorder.captureNow('wrong-source')
  await turn()
  assert.equal(context.monitorFrames.length, 1)
  recorder.captureNow('scope-1')
  await turn()
  assert.equal(context.monitorFrames.length, 2, 'an AI request obtains a fresh view without waiting for a change')
  recorder.stop()
  assert.equal(track.stops, 1)
  assert.deepEqual(context.stoppedMonitors, ['scope-1'])
})

test('denied screen access tears down monitoring while audio can continue independently', async (t) => {
  const { recorder } = setup(t)
  context.media = async () => { throw new Error('Screen permission denied') }
  await assert.rejects(recorder.start('window:call', true), /denied/)
  assert.deepEqual(context.stoppedMonitors, ['scope-1'])
  assert.equal(recorder.active, false)
  assert.equal(context.timers.size, 0)
})

test('a monitor cancelled while capture opens cannot replace a newer selected source', async (t) => {
  const { recorder, track, stream } = setup(t)
  const media = deferred()
  context.media = () => media.promise
  const old = recorder.start('window:old', true)
  await turn()
  recorder.stop()
  const next = screen()
  context.media = async () => next.stream
  await recorder.start('window:new', true)
  media.resolve(stream)
  await old
  assert.equal(track.stops, 1)
  assert.equal(next.track.stops, 0)
  assert.equal(recorder.active, true)
  recorder.captureNow('scope-1')
  await turn()
  assert.equal(context.monitorFrames.length, 0)
  recorder.captureNow('scope-2')
  await turn()
  assert.equal(context.monitorFrames[0][0], 'scope-2')
})

test('a monitor sample keeps capture time when image encoding finishes later', async (t) => {
  const { recorder } = setup(t)
  await recorder.start('window:call', true)
  context.encoding = true
  const sampledAt = Date.now()
  recorder.captureNow('scope-1')
  await new Promise(resolve => setTimeout(resolve, 20))
  const encodedAt = Date.now()
  for (const callback of context.encoded.splice(0)) callback(new Blob(['sample']))
  await turn()
  for (const callback of context.encoded.splice(0)) callback(new Blob(['thumbnail']))
  await turn()
  assert.ok(context.monitorFrames[0][1] >= sampledAt)
  assert.ok(context.monitorFrames[0][1] < encodedAt, 'the timestamp belongs to the sampled pixels, not the later encode completion')
})

test('a live refresh requested during encoding takes another picture immediately afterward', async (t) => {
  const { recorder } = setup(t)
  await recorder.start('window:call', true)
  context.encoding = true
  recorder.captureNow('scope-1')
  recorder.captureNow('scope-1')
  assert.equal(context.encoded.length, 1, 'encoding stays serial')
  await new Promise(resolve => setTimeout(resolve, 10))
  const refreshedAt = Date.now()
  context.encoded.shift()(new Blob(['first picture']))
  await turn()
  assert.equal(context.encoded.length, 1, 'the changed view gets a local thumbnail')
  context.encoded.shift()(new Blob(['thumbnail']))
  await turn()
  assert.equal(context.encoded.length, 1, 'a fresh capture follows without waiting for the sampling timer')
  context.encoded.shift()(new Blob(['fresh picture']))
  await turn()
  assert.equal(context.monitorFrames.length, 2)
  assert.ok(context.monitorFrames[1][1] >= refreshedAt)
  assert.equal(Buffer.from(context.monitorFrames[1][2]).toString(), 'fresh picture')
  assert.ok(context.monitorFrames[0][3]?.thumb, 'the initial changed view is retained locally')
  assert.equal(context.monitorFrames[1][3], undefined, 'an unchanged live refresh does not add another snapshot')
})

test('a frame being encoded when capture stops never reaches a later call', async (t) => {
  const { recorder } = setup(t)
  await recorder.start('cursor')
  context.encoding = true
  const tick = [...context.timers.values()][0]
  tick()
  assert.equal(context.encoded.length, 2, 'the frame and its thumbnail are being encoded')
  recorder.stop()
  const next = screen()
  context.media = async () => next.stream
  await recorder.start('cursor')
  for (const callback of context.encoded.splice(0)) callback(new Blob(['old image']))
  await turn()
  assert.equal(context.frames.length, 0, 'the previous capture cannot add a frame after Stop or into its replacement')
  assert.equal(recorder.active, true)
})
