import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('screen-verification')
const { ScreenMonitor, ScreenBuffer, screenQuestionTime, screenReference } = await import('./.build/togle.mjs')
const signal = () => new AbortController().signal
const turn = () => new Promise(resolve => setImmediate(resolve))
const frame = at => ({ mode: 'frame', from: at, to: at })
const source = { id: 'window:verification', name: 'Verification chart', kind: 'window' }

test('simultaneous independent screen reads cannot leave the UI stuck reading', async () => {
  const finish = []
  const monitor = new ScreenMonitor(() => ({ stream: async (_input, opts) => { await new Promise(resolve => finish.push(resolve)); opts.onDelta('Read the selected chart.') } }), () => 1000)
  const scope = monitor.start(source)
  monitor.add(scope.id, 1000, Buffer.from('chart'))
  const first = monitor.look(scope.id, 'Read first label', frame(1000), signal())
  const second = monitor.look(scope.id, 'Read second label', frame(1000), signal())
  await turn()
  for (const done of finish) done()
  await Promise.all([first, second])
  assert.equal(monitor.status().state, 'watching')
  assert.equal(monitor.status().reads, 2)
  monitor.stop()
})

test('cancelling one consumer cannot cancel another consumer of the same screen lookup', async () => {
  let finish
  let requests = 0
  const monitor = new ScreenMonitor(() => ({ stream: async (_input, opts) => {
    requests++
    await new Promise((resolve, reject) => { finish = resolve; opts.signal.addEventListener('abort', () => reject(new Error('Shared read aborted')), { once: true }) })
    opts.onDelta('Beta = 35')
  } }), () => 1000)
  const scope = monitor.start(source)
  monitor.add(scope.id, 1000, Buffer.from('chart'))
  const cancelled = new AbortController()
  const first = monitor.look(scope.id, 'Read chart', frame(1000), cancelled.signal).then(value => ({ value }), error => ({ error }))
  const second = monitor.look(scope.id, 'Read chart', frame(1000), signal()).then(value => ({ value }), error => ({ error }))
  await turn()
  cancelled.abort(new Error('Only the quick answer was cancelled'))
  finish()
  const [a, b] = await Promise.all([first, second])
  assert.ok(a.error)
  assert.equal(b.error, undefined)
  assert.match(b.value, /Beta = 35/)
  assert.equal(requests, 1)
  monitor.stop()
})

test('expired samples disappear from advertised availability without another capture', () => {
  const buffer = new ScreenBuffer()
  buffer.add(1000, Buffer.from('old'), 1000)
  buffer.select(frame(1000), 122_000)
  assert.deepEqual(buffer.bounds(), { from: undefined, to: undefined })
})

test('an explicit new spoken question overrides an unrelated older screen reference', () => {
  const entries = [
    { id: 'old-slide', speaker: 'them', text: 'As you can see on my screen, this is the first slide.', at: 1000, end: 2000 },
    { id: 'new-chart', speaker: 'them', text: 'What does this different chart show?', at: 30_000, end: 32_000 }
  ]
  const timing = screenQuestionTime(entries, 35_000, 'What does this different chart show?')
  assert.equal(timing.from, 30_000)
  assert.equal(timing.to, 32_000)
  assert.equal(timing.references[0].id, 'old-slide', 'the old reference remains addressable explicitly')
})

test('ordinary Croatian speech cannot create a false screen-time anchor', () => {
  const entry = text => ({ id: 'speech', speaker: 'them', text, at: 1000, end: 2000 })
  assert.equal(screenReference(entry('Na mom poslu imamo tri tima.')), undefined)
  assert.equal(screenReference(entry('Kao što možete dogovoriti za sutra.')), undefined)
  assert.ok(screenReference(entry('Kao što možete vidjeti na mom ekranu, ovo je novi graf.')))
})

test('an extracted question retains the time of the longer utterance containing it', () => {
  const timing = screenQuestionTime([
    { id: 'old', speaker: 'them', text: 'As you can see on my screen, here is the earlier slide.', at: 1000, end: 2000 },
    { id: 'new', speaker: 'them', text: "Okay, let us switch to revenue. What does this different chart show?", at: 30_000, end: 34_000 }
  ], 40_000, 'What does this different chart show?')
  assert.deepEqual([timing.from, timing.to], [30_000, 34_000])
  assert.deepEqual(timing.speech.map(entry => entry.id), ['old', 'new'])
})

test('a delayed pre-request sample cannot satisfy a live refresh', async t => {
  let now = 1000
  const sent = []
  const monitor = new ScreenMonitor(() => ({ stream: async (input, opts) => { sent.push(input); opts.onDelta('fresh') } }), () => now)
  t.after(() => monitor.stop())
  const scope = monitor.start(source)
  monitor.add(scope.id, now, Buffer.from('old'))
  now = 1500
  monitor.on('refresh', () => {
    monitor.add(scope.id, 1250, Buffer.from('late old sample'))
    setImmediate(() => { now = 1600; monitor.add(scope.id, now, Buffer.from('fresh sample')) })
  })
  await monitor.look(scope.id, 'What is visible right now?', { mode: 'live', from: 0, to: 0 }, signal())
  assert.deepEqual(monitor.status().lastLook.capturedAt, [1600])
  assert.equal(Buffer.from(sent[0].images[0].url.split(',')[1], 'base64').toString(), 'fresh sample')
})

test('cancelling every consumer aborts the provider and permits an independent retry', async t => {
  const reads = []
  const monitor = new ScreenMonitor(() => ({ stream: async (_input, opts) => {
    await new Promise((resolve, reject) => {
      reads.push({ signal: opts.signal, finish: resolve })
      opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true })
    })
    opts.onDelta('retry completed')
  } }), () => 1000)
  t.after(() => monitor.stop())
  const scope = monitor.start(source)
  monitor.add(scope.id, 1000, Buffer.from('chart'))
  const first = new AbortController(), second = new AbortController()
  const a = monitor.look(scope.id, 'Read chart', frame(1000), first.signal).catch(error => error)
  const b = monitor.look(scope.id, 'Read chart', frame(1000), second.signal).catch(error => error)
  await turn()
  first.abort(); second.abort()
  await Promise.all([a, b])
  assert.equal(reads[0].signal.aborted, true)
  assert.equal(monitor.status().state, 'watching')
  const retry = monitor.look(scope.id, 'Read chart', frame(1000), signal())
  await turn()
  assert.equal(reads.length, 2)
  reads[1].finish()
  assert.match(await retry, /retry completed/)
  assert.equal(monitor.status().reads, 1)
})

test('a provider ignoring cancellation cannot contaminate a replacement source', async t => {
  let finish
  const monitor = new ScreenMonitor(() => ({ stream: async (_input, opts) => {
    await new Promise(resolve => { finish = resolve })
    opts.onDelta('late old chart')
  } }), () => 1000)
  t.after(() => monitor.stop())
  const old = monitor.start(source)
  monitor.add(old.id, 1000, Buffer.from('old'))
  const pending = monitor.look(old.id, 'Read chart', frame(1000), signal()).catch(error => error)
  await turn()
  const current = monitor.start({ ...source, id: 'window:new', name: 'Replacement chart' })
  monitor.add(current.id, 1000, Buffer.from('new'))
  finish()
  await pending; await turn()
  assert.equal(monitor.status().id, current.id)
  assert.equal(monitor.status().reads, 0)
  assert.equal(monitor.status().imagesSent, 0)
  assert.equal(monitor.status().lastLook, undefined)
  assert.equal(monitor.status().state, 'watching')
})

test('500 generated screen timelines never upload a later frame or exceed the request budget', () => {
  let seed = 0x6a09e667
  const random = max => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max }
  for (let trial = 0; trial < 500; trial++) {
    const buffer = new ScreenBuffer()
    const now = 200_000
    const samples = []
    for (let at = 81_000; at <= now; at += 500) {
      if (random(9) === 0) continue
      buffer.add(at, Buffer.from('view-' + random(25)), now)
      samples.push(at)
    }
    const from = 80_000 + random(121_000)
    const to = from + random(12_000)
    const requested = random(2) ? { mode: 'range', from, to } : frame(from)
    const selected = buffer.select(requested, now)
    if (selected.evidence.unavailable) { assert.equal(selected.frames.length, 0); continue }
    assert.ok(selected.frames.length > 0 && selected.frames.length <= 6)
    assert.ok(selected.frames.every(sample => samples.includes(sample.at) && sample.at <= requested.to && sample.at <= now))
    assert.ok(selected.frames[0].at <= requested.from && requested.from - selected.frames[0].at <= 1000)
    assert.deepEqual(selected.evidence.capturedAt, selected.frames.map(sample => sample.at))
    assert.ok([...new Map(selected.frames.map(sample => [sample.hash, sample.image])).values()].reduce((bytes, image) => bytes + image.length, 0) <= 6 * 1024 * 1024)
  }
})
