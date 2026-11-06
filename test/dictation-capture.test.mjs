import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { DictationCapture, microphoneProblem } from './.build/dictation-capture.mjs'
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
let ctx, tap, moduleReady, micReady, constraints
globalThis.document = { baseURI: 'file:///togle/index.html' }
globalThis.AudioContext = class {
  closed = 0; destination = {}; audioWorklet = { addModule: () => moduleReady }
  constructor() { ctx = this }
  createMediaStreamSource() { return { connect() {}, disconnect() {} } }
  async resume() {}
  async close() { this.closed++ }
}
globalThis.AudioWorkletNode = class { constructor() { tap = this }; port = { onmessage: null }; connect() {}; disconnect() {} }
function device() {
  const track = { label: 'Test headset', muted: false, stops: 0, onended: null, onmute: null, onunmute: null, stop() { this.stops++ } }
  return { track, getTracks: () => [track], getAudioTracks: () => [track] }
}
function reset(get) {
  moduleReady = Promise.resolve(); micReady = get
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: input => { constraints = input; return micReady() } } } })
}
test('dictation capture: late microphone permission after cancel releases the device', async () => {
  const delayed = deferred(), stream = device(); reset(() => delayed.promise)
  const capture = new DictationCapture(), opening = capture.start(() => {}, () => {})
  await tick(); capture.stop(false); delayed.resolve(stream); await opening
  assert.equal(stream.track.stops, 1); assert.equal(ctx.closed, 1)
})
test('dictation capture: cancel during worklet load never requests microphone permission', async () => {
  let requested = 0; reset(() => { requested++; return Promise.resolve(device()) })
  const delayed = deferred(); moduleReady = delayed.promise
  const capture = new DictationCapture(), opening = capture.start(() => {}, () => {})
  capture.stop(false); delayed.resolve(); await opening; assert.equal(requested, 0); assert.equal(ctx.closed, 1)
})
test('dictation capture: stop flushes a short reply once and closes all resources', async () => {
  const stream = device(), chunks = []; reset(async () => stream)
  const capture = new DictationCapture(); await capture.start(pcm => chunks.push(pcm), () => {})
  for (let n = 0; n < 8; n++) tap.port.onmessage({ data: new Float32Array(512).fill(0.08) })
  capture.stop(true); capture.stop(true)
  assert.equal(chunks.length, 1); assert.equal(chunks[0].length, 4096); assert.equal(stream.track.stops, 1); assert.equal(ctx.closed, 1)
})
test('dictation capture: microphone removal reports failure; cancel discards audio', async () => {
  const stream = device(), errors = [], chunks = []; reset(async () => stream)
  const capture = new DictationCapture(); await capture.start(pcm => chunks.push(pcm), error => errors.push(error))
  for (let n = 0; n < 8; n++) tap.port.onmessage({ data: new Float32Array(512).fill(0.08) })
  stream.track.onended(); capture.stop(false)
  assert.equal(errors.length, 1); assert.match(errors[0], /disconnected/); assert.equal(chunks.length, 0)
})

test('dictation feedback measures actual samples, stays bounded, and ends with the microphone', async () => {
  const stream = device(), levels = []; reset(async () => stream)
  const capture = new DictationCapture()
  await capture.start(() => {}, () => {}, level => levels.push(level))
  const receive = tap.port.onmessage
  for (const amplitude of [0, 0.002, 0.02, 0.2, 1]) receive({ data: Float32Array.from({ length: 512 }, (_, n) => Math.sin(n * 0.3) * amplitude) })
  assert.equal(levels[0], 0)
  assert.ok(levels[1] > 0 && levels[2] > levels[1] && levels[3] > levels[2])
  assert.ok(levels.every(level => level >= 0 && level <= 1))
  capture.stop(false)
  receive({ data: new Float32Array(512).fill(1) })
  assert.equal(levels.length, 5, 'A queued frame after cancel cannot animate the idle bar')
  assert.equal(stream.track.stops, 1)
})

test('dictation capture uses the selected microphone and reports source interruptions without reopening it', async () => {
  const stream = device(), states = []; reset(async () => stream)
  const capture = new DictationCapture()
  await capture.start(() => {}, () => {}, () => {}, { deviceId: 'usb-headset', microphone: state => states.push(state) })
  assert.deepEqual(constraints.audio.deviceId, { exact: 'usb-headset' })
  assert.deepEqual(states, [{ name: 'Test headset', muted: false }])
  stream.track.muted = true; stream.track.onmute()
  stream.track.muted = false; stream.track.onunmute()
  assert.deepEqual(states.map(state => state.muted), [false, true, false])
  const late = stream.track.onmute
  capture.stop(false); late()
  assert.equal(states.length, 3); assert.equal(stream.track.onmute, null); assert.equal(stream.track.onunmute, null)
  assert.match(microphoneProblem({ name: 'OverconstrainedError' }), /Choose another microphone/)
  assert.match(microphoneProblem({ name: 'NotAllowedError' }), /access is blocked/)
})

test('live capture sends audio while speaking and drains its last partial frame exactly once on release', async () => {
  const stream = device(), chunks = []; reset(async () => stream)
  const capture = new DictationCapture(); await capture.start(pcm => chunks.push(Array.from(pcm)), () => {}, undefined, { streaming: true })
  for (let n = 1; n <= 4; n++) tap.port.onmessage({ data: new Float32Array(512).fill(n) })
  assert.equal(chunks.length, 1); assert.equal(chunks[0].length, 2048)
  assert.deepEqual(chunks[0].filter((_value, i) => i % 512 === 0), [1, 2, 3, 4])
  tap.port.onmessage({ data: new Float32Array(512).fill(5) })
  let request
  tap.port.postMessage = value => { request = value }
  const first = capture.finish(); assert.equal(capture.finish(), first)
  assert.deepEqual(request, { type: 'flush' }); assert.equal(stream.track.stops, 0, 'Keep the port open until the final audio arrives')
  tap.port.onmessage({ data: new Float32Array(37).fill(6) }); tap.port.onmessage({ data: { type: 'flushed' } })
  await first; capture.stop(true)
  assert.equal(chunks.length, 2); assert.equal(chunks[1].length, 549); assert.equal(chunks[1].at(-1), 6)
  assert.equal(stream.track.stops, 1); assert.equal(ctx.closed, 1)
})

test('cancel during audio drain discards the tail and releases a pending finish', async () => {
  const stream = device(), chunks = []; reset(async () => stream)
  const capture = new DictationCapture(); await capture.start(pcm => chunks.push(pcm), () => {}, undefined, { streaming: true })
  tap.port.onmessage({ data: new Float32Array(512).fill(.1) })
  tap.port.postMessage = () => {}
  const receive = tap.port.onmessage, finishing = capture.finish()
  capture.stop(false); await finishing
  receive({ data: new Float32Array(25).fill(.2) }); receive({ data: { type: 'flushed' } })
  assert.deepEqual(chunks, []); assert.equal(stream.track.stops, 1)
})

test('F9 release retains delayed final words from the Togle virtual microphone', async () => {
  const stream = device(), chunks = []; stream.track.label = 'Togle Microphone (VB-Audio Virtual Cable)'; reset(async () => stream)
  const capture = new DictationCapture(); await capture.start(pcm => chunks.push(Array.from(pcm)), () => {}, undefined, {streaming: true})
  let flushed = false
  tap.port.postMessage = () => { flushed = true; tap.port.onmessage({data: {type: 'flushed'}}) }
  const finished = capture.finish()
  assert.equal(flushed, false, 'Keep receiving the noise processor tail before flushing')
  await new Promise(resolve => setTimeout(resolve, 40))
  tap.port.onmessage({data: new Float32Array(512).fill(.08)})
  await finished
  assert.equal(chunks.length, 1); assert.equal(chunks[0].length, 512)
  assert.equal(stream.track.stops, 1)
})

test('cancelling during virtual microphone release prevents late flushing or insertion', async () => {
  const stream = device(), chunks = []; stream.track.label = 'Togle Microphone'; reset(async () => stream)
  const capture = new DictationCapture(); await capture.start(pcm => chunks.push(pcm), () => {}, undefined, {streaming: true})
  let flushes = 0; tap.port.postMessage = () => { flushes++ }
  const finished = capture.finish(); capture.stop(false); await finished
  await new Promise(resolve => setTimeout(resolve, 110))
  assert.equal(flushes, 0); assert.deepEqual(chunks, []); assert.equal(stream.track.stops, 1)
})

test('F9 release reads current isolation buffering and retains words arriving after the old 90 ms drain',async()=>{
  const stream=device(),chunks=[];stream.track.label='Togle Microphone';reset(async()=>stream)
  let delay=90,reads=0,flushed=false
  const capture=new DictationCapture()
  await capture.start(pcm=>chunks.push(Array.from(pcm)),()=>{},undefined,{streaming:true,virtualDelay:async label=>{assert.equal(label,'Togle Microphone');reads++;return delay}})
  delay=220
  tap.port.postMessage=()=>{flushed=true;tap.port.onmessage({data:{type:'flushed'}})}
  const finished=capture.finish();await new Promise(r=>setTimeout(r,135))
  assert.equal(flushed,false);tap.port.onmessage({data:new Float32Array(512).fill(.07)})
  await finished;assert.equal(reads,1);assert.equal(chunks.length,1);assert.equal(chunks[0].length,512);assert.equal(stream.track.stops,1)
})

test('cancelled F9 capture cannot flush or insert when a late latency query resolves',async()=>{
  const stream=device();stream.track.label='Togle Microphone';reset(async()=>stream)
  const lookup=deferred();let flushes=0
  const capture=new DictationCapture();await capture.start(()=>{},()=>{},undefined,{streaming:true,virtualDelay:()=>lookup.promise})
  tap.port.postMessage=()=>flushes++
  const finished=capture.finish();await tick();capture.stop(false);await finished;lookup.resolve(220);await tick()
  assert.equal(flushes,0);assert.equal(stream.track.stops,1)
})

test('worklet flush delivers the partial resampled tail before acknowledgement and stops further recording', () => {
  const sent = []; let Processor
  vm.runInNewContext(readFileSync(new URL('../src/renderer/public/pcm-tap.js', import.meta.url), 'utf8'), {
    sampleRate: 48000, Float32Array,
    AudioWorkletProcessor: class { port = { postMessage: value => sent.push(value) } },
    registerProcessor: (_name, value) => { Processor = value }
  })
  const processor = new Processor()
  for (let n = 0; n < 16; n++) assert.equal(processor.process([[new Float32Array(128).fill(.1)]]), true)
  assert.equal(sent.length, 1); assert.equal(sent[0].length, 512)
  processor.port.onmessage({ data: { type: 'flush' } })
  assert.ok(sent[1] instanceof Float32Array && sent[1].length > 0 && sent[1].length < 512)
  assert.equal(sent[2].type, 'flushed')
  processor.port.onmessage({ data: { type: 'flush' } })
  assert.equal(processor.process([[new Float32Array(128).fill(.1)]]), false); assert.equal(sent.length, 3)
})
