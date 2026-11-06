import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, workDir } from './helpers.mjs'

workDir('screen-time')
const { ScreenBuffer, ScreenMonitor, screenQuestionTime, screenReference, SCREEN_HISTORY_MS, Copilot, AgentStore } = await import('./.build/togle.mjs')
const photo = text => Buffer.from(text)
const request = (from, to = from) => ({ mode: from === to ? 'frame' : 'range', from, to })
const freshSignal = () => new AbortController().signal

test('a point lookup chooses the preceding captured frame, never a later screen', () => {
  const buffer = new ScreenBuffer()
  buffer.add(1000, photo('slide-A'), 1000)
  buffer.add(1500, photo('slide-B'), 1500)
  const selected = buffer.select(request(1375), 10_000)
  assert.equal(selected.frames[0].image.toString(), 'slide-A')
  assert.deepEqual(selected.evidence.capturedAt, [1000])
  assert.equal(selected.evidence.requested.from, 1375)
})

test('a delayed range lookup only selects the interval that was requested', () => {
  const buffer = new ScreenBuffer()
  for (let at = 1000; at <= 10_000; at += 500) buffer.add(at, photo(at <= 3000 ? 'spoken-slide' : 'later-screen'), at)
  const selected = buffer.select(request(1000, 3000), 30_000)
  assert.ok(selected.frames.every(frame => frame.image.toString() === 'spoken-slide'))
  assert.equal(selected.evidence.capturedAt[0], 1000)
  assert.equal(selected.evidence.capturedAt.at(-1), 3000)
})

test('identical pictures share image bytes while preserving each captured timestamp', () => {
  const buffer = new ScreenBuffer()
  for (let at = 1000; at <= 121_000; at += 500) buffer.add(at, photo('unchanged slide'), at)
  const selected = buffer.select(request(1000, 121_000), 121_000)
  assert.equal(selected.frames[0].image, selected.frames.at(-1).image)
  assert.equal(selected.evidence.capturedAt[0], 1000)
  assert.equal(selected.evidence.capturedAt.at(-1), 121_000)
  assert.ok(selected.evidence.capturedAt.length <= 6)
})

test('missing and expired historical moments return unavailable without substituting now', () => {
  const buffer = new ScreenBuffer()
  buffer.add(100_000, photo('current screen'), 100_000)
  const tooEarly = buffer.select(request(90_000), 100_000)
  assert.equal(tooEarly.frames.length, 0)
  assert.match(tooEarly.evidence.unavailable, /current screenshot cannot replace it/)
  const expired = buffer.select(request(100_000), 100_000 + SCREEN_HISTORY_MS + 1)
  assert.equal(expired.frames.length, 0)
  assert.match(expired.evidence.unavailable, /No recorded/)
})

test('sampling gaps are reported and a point inside a large gap is unavailable', () => {
  const buffer = new ScreenBuffer()
  buffer.add(1000, photo('before'), 1000)
  buffer.add(5000, photo('after'), 5000)
  const interval = buffer.select(request(1000, 5000), 5000)
  assert.deepEqual(interval.evidence.gaps, [{ from: 1000, to: 5000 }])
  assert.equal(buffer.select(request(4000), 5000).frames.length, 0)
})

test('memory pressure reports evicted times as missing instead of substituting a retained image', () => {
  const buffer = new ScreenBuffer()
  for (let index = 0; index < 24; index++) buffer.add(1000 + index * 500, Buffer.alloc(3 * 1024 * 1024, index), 1000 + index * 500)
  const lost = buffer.select(request(1000), 13_000)
  assert.equal(lost.frames.length, 0)
  assert.match(lost.evidence.unavailable, /outside the retained history/)
  const latest = buffer.select(request(12_500), 13_000)
  assert.equal(latest.frames[0].image[0], 23)
})

test('invalid or future intervals cannot select images', () => {
  const buffer = new ScreenBuffer()
  buffer.add(1000, photo('screen'), 1000)
  for (const interval of [{ mode: 'range', from: 2000, to: 1000 }, { mode: 'frame', from: NaN, to: NaN }, { mode: 'frame', from: 1000, to: 1500 }, { mode: 'range', from: 1000, to: 2000 }]) assert.equal(buffer.select(interval, 1000).frames.length, 0)
})

test('speech references retain their original audio interval when recognition arrives late', () => {
  const entry = { id: 'cue', speaker: 'them', text: 'As you can see on my screen, the left bar is larger.', at: 1000, end: 4500 }
  assert.deepEqual(screenReference(entry), { id: 'cue', speaker: 'them', text: entry.text, from: 1000, to: 4500 })
  const anchor = screenQuestionTime([entry, { id: 'q', speaker: 'them', text: 'What do you think?', at: 5000, end: 6000 }], 20_000)
  assert.equal(anchor.from, 1000)
  assert.equal(anchor.to, 4500)
  assert.equal(anchor.references[0].id, 'cue')
  assert.equal(screenReference({ ...entry, text: 'Can you see my screen?' }), undefined)
})

test('a historical screen request never asks the renderer for a new screenshot', async () => {
  let now = 1000
  const inputs = []
  const monitor = new ScreenMonitor(() => ({ stream: async (input, opts) => { inputs.push(input); opts.onDelta('The old slide is A.') } }), () => now)
  const scope = monitor.start({ id: 'window:call', name: 'Call', kind: 'window' })
  monitor.add(scope.id, now, photo('old-slide'))
  now = 9000; monitor.add(scope.id, now, photo('new-slide'))
  let refreshes = 0
  monitor.on('refresh', () => { refreshes++ })
  await monitor.look(scope.id, 'What was shown when they spoke?', request(1000), freshSignal())
  assert.equal(refreshes, 0)
  assert.equal(Buffer.from(inputs[0].images[0].url.split(',')[1], 'base64').toString(), 'old-slide')
  assert.equal(monitor.status().lastLook.requested.from, 1000)
  assert.deepEqual(monitor.status().lastLook.capturedAt, [1000])
  monitor.stop()
})

test('an old spoken reference remains addressable after its images expire', () => {
  const entries = [{ id: 'old-cue', speaker: 'them', text: 'As you can see on my screen, this is the old chart.', at: 1000, end: 1500 }, { id: 'new-question', speaker: 'them', text: 'What about the current plan?', at: 499_000, end: 499_100 }]
  const timing = screenQuestionTime(entries, 500_000)
  assert.equal(timing.references[0].from, 1000)
  assert.equal(timing.references[0].to, 1500)
  assert.equal(timing.from, 499_000, 'an unrelated old reference must not move the new question')
})

test('cached visual observations cannot return timestamps from another request', async () => {
  let now = 1000
  const monitor = new ScreenMonitor(() => ({ stream: async (_input, opts) => opts.onDelta('The slide is unchanged.') }), () => now)
  const scope = monitor.start({ id: 'window:call', name: 'Call', kind: 'window' })
  monitor.add(scope.id, 1000, photo('same'))
  now = 2000; monitor.add(scope.id, 2000, photo('same'))
  const first = await monitor.look(scope.id, 'Read the slide', request(1000), freshSignal())
  const second = await monitor.look(scope.id, 'Read the slide', request(2000), freshSignal())
  assert.match(first, /00:00:01.000Z/)
  assert.match(second, /00:00:02.000Z/)
  assert.deepEqual(monitor.status().lastLook.capturedAt, [2000])
  monitor.stop()
})

const store = new AgentStore(async () => '')
await store.load()
test('recognition and model delays cannot move a spoken visual reference to the later screen', async () => {
  const realNow = Date.now
  const base = realNow()
  let now = base
  Date.now = () => now
  const inputs = []
  let monitor, copilot
  try {
    const provider = { id: 'scripted', supportsTools: true, stream: async (input, opts) => {
      inputs.push(input)
      if (input.lane === 'vision') {
        assert.ok(input.images.every(item => Buffer.from(item.url.split(',')[1], 'base64').toString() === 'slide-at-spoken-time'))
        opts.onDelta('The spoken slide shows Beta = 35.'); return
      }
      // The model spends another ten seconds deciding; a new screen arrives meanwhile.
      now = base + 20_000
      monitor.add(scope.id, now, photo('new-screen-while-AI-thinks'))
      const tool = input.tools.find(tool => tool.name === 'look_at_screen')
      const [, from, to] = input.user.match(/Suggested speech-time interval: from_ms=(\d+), to_ms=(\d+)/)
      assert.equal(Number(from), base + 1000)
      assert.equal(Number(to), base + 3000)
      assert.match(await tool.run({ question: 'Read the later screen', view: 'frame', from_ms: now, to_ms: now }), /after the question was received/)
      assert.equal(inputs.filter(input => input.lane === 'vision').length, 0)
      assert.match(await tool.run({ question: 'Read the chart from their spoken reference.', view: 'range', from_ms: Number(from), to_ms: Number(to) }), /Beta = 35/)
      opts.onDelta('LEVEL: quick\nBeta was 35 at the time they spoke.')
    } }
    monitor = new ScreenMonitor(() => provider, () => now)
    const scope = monitor.start({ id: 'window:call', name: 'Call', kind: 'window' })
    for (let at = base; at <= base + 3000; at += 500) { now = at; monitor.add(scope.id, at, photo('slide-at-spoken-time')) }
    now = base + 10_000
    monitor.add(scope.id, now, photo('screen-after-speech'))
    const agent = store.list()[0]
    copilot = new Copilot(() => {}, () => provider, { monitor, snapshot: async () => assert.fail('must not capture now'), dataUrl: async () => '', reset: async () => {} }, agentAccess(store, agent.id))
    // Recognition arrives seven seconds after the original utterance ended.
    copilot.add('them', 'As you can see on my screen, the chart is different.', base + 1000, base + 3000)
    assert.equal(monitor.status().lastReference.from, base + 1000)
    await copilot.assist({ kind: 'ask', question: 'What did that chart show?' })
    assert.equal(inputs.filter(input => input.lane === 'vision').length, 1)
    assert.equal(monitor.status().lastLook.requested.to, base + 3000)
  } finally { Date.now = realNow; copilot?.cancel(); monitor?.stop() }
})

test('screen and audio timestamps remain aligned after the system clock moves backwards', async () => {
  const realNow = Date.now
  const base = realNow()
  let now = base
  Date.now = () => now
  try {
    const agent = store.list()[0]
    const copilot = new Copilot(() => {}, () => ({ supportsTools: false }), { snapshot: async () => {}, dataUrl: async () => '', reset: async () => {} }, agentAccess(store, agent.id))
    copilot.screenTimestamp(now)
    now -= 3600_000
    const capturedAt = copilot.screenTimestamp(now)
    copilot.add('them', 'The screen shows the next slide.', now, now)
    assert.equal(copilot.callState().transcript[0].at, capturedAt)
    assert.equal(copilot.timelineNow(), capturedAt)
  } finally { Date.now = realNow }
})

test('mentioning a current plan does not authorize replacing recorded context with a live capture', async () => {
  const now = Date.now()
  let visions = 0
  const provider = { id: 'scripted', supportsTools: true, stream: async (input, opts) => {
    if (input.lane === 'vision') { visions++; opts.onDelta('A current screenshot.'); return }
    const tool = input.tools.find(tool => tool.name === 'look_at_screen')
    const result = await tool.run({ question: 'Read screen', view: 'live', from_ms: now, to_ms: now })
    assert.match(result, /recorded speech/)
    opts.onDelta('LEVEL: quick\nUse the earlier interval.')
  } }
  const monitor = new ScreenMonitor(() => provider)
  const scope = monitor.start({ id: 'window:call', name: 'Call', kind: 'window' })
  monitor.add(scope.id, now, photo('screen'))
  const agent = store.list()[0]
  const copilot = new Copilot(() => {}, () => provider, { monitor, snapshot: async () => assert.fail('no current screenshot requested'), dataUrl: async () => '', reset: async () => {} }, agentAccess(store, agent.id))
  await copilot.assist({ kind: 'ask', question: 'How does our current plan compare with the earlier diagram?' })
  assert.equal(visions, 0)
  monitor.stop()
})
