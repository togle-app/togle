import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, workDir } from './helpers.mjs'

workDir('screen-monitor')
const { ScreenMonitor, AgentStore, Copilot } = await import('./.build/togle.mjs')
const source = { id: 'window:call', name: 'Call window', kind: 'window' }
const signal = () => new AbortController().signal
const image = value => Buffer.from('fictional-jpeg-' + value)
const frame = at => ({ mode: 'frame', from: at, to: at })
const range = (from, to) => ({ mode: 'range', from, to })
const live = () => ({ mode: 'live', from: 100_000, to: 100_000 })
function fixture(stream) {
  let now = 1000
  const inputs = []
  const provider = { id: 'scripted', supportsTools: true, listModels: async () => [], stream: async (input, opts) => { inputs.push(input); if (stream) await stream(input, opts); else opts.onDelta('The chart shows revenue increasing from 20 to 35.') } }
  const monitor = new ScreenMonitor(() => provider, () => now)
  const scope = monitor.start(source)
  now = 100_000
  return { monitor, inputs, scope, provider, time: value => { now = value } }
}

test('local screen sampling never starts a model request or uploads images', () => {
  const { monitor, scope, inputs } = fixture()
  for (let index = 0; index < 100; index++) monitor.add(scope.id, 99_000 + index * 10, image(index))
  assert.equal(inputs.length, 0)
  assert.equal(monitor.status().imagesSent, 0)
  assert.equal(monitor.status().ready, true)
  monitor.stop()
})

test('the screen tool sends the selected recorded moment with its timestamp and question', async () => {
  const { monitor, scope, inputs } = fixture()
  monitor.add(scope.id, 99_000, image('current'))
  const result = await monitor.look(scope.id, 'What does the revenue chart show?', frame(99_000), signal())
  assert.match(result, /20 to 35/)
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].lane, 'vision')
  assert.match(inputs[0].user, /Call window/)
  assert.match(inputs[0].user, /revenue chart/)
  assert.equal(inputs[0].images.length, 1)
  assert.match(inputs[0].images[0].label, /1970-01-01T00:01:39.000Z/)
  assert.match(inputs[0].system, /untrusted visual evidence/)
  assert.equal(monitor.status().reads, 1)
  monitor.stop()
})

test('recorded context uses at most six selected views from the requested interval', async () => {
  const { monitor, scope, inputs } = fixture()
  for (let index = 0; index < 300; index++) monitor.add(scope.id, -50_000 + index * 500, image(index))
  await monitor.look(scope.id, 'What changed in the diagram?', range(90_000, 99_500), signal())
  assert.equal(inputs[0].images.length, 6)
  const values = inputs[0].images.map(item => Buffer.from(item.url.split(',')[1], 'base64').toString())
  assert.ok(values.includes('fictional-jpeg-299'))
  assert.ok(!values.includes('fictional-jpeg-0'), 'old frames cannot accumulate beyond the rolling buffer')
  assert.equal(monitor.status().imagesSent, 6)
  monitor.stop()
})

test('identical recent frames and repeated looks reuse visual observations', async () => {
  const { monitor, scope, inputs } = fixture()
  monitor.add(scope.id, 98_000, image('slide'))
  monitor.add(scope.id, 99_000, image('slide'))
  await monitor.look(scope.id, 'Read the slide title', range(98_000, 99_000), signal())
  await monitor.look(scope.id, 'Read the slide title', range(98_000, 99_000), signal())
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0].images.length, 1)
  monitor.stop()
})

test('a look can request a fresh local capture before it sends the selected view', async () => {
  const { monitor, scope, inputs } = fixture()
  monitor.add(scope.id, 95_000, image('old'))
  monitor.on('refresh', id => { assert.equal(id, scope.id); monitor.add(id, 100_000, image('fresh')) })
  await monitor.look(scope.id, 'Read this error message', live(), signal())
  assert.equal(Buffer.from(inputs[0].images[0].url.split(',')[1], 'base64').toString(), 'fictional-jpeg-fresh')
  monitor.stop()
})

test('stale, future, out-of-order and oversized frames cannot become current visual context', async () => {
  const { monitor, scope, inputs } = fixture()
  assert.equal(monitor.add(scope.id, -30_000, image('stale')), false)
  assert.equal(monitor.add(scope.id, 200_000, image('future')), false)
  assert.equal(monitor.add(scope.id, 99_000, Buffer.alloc(4 * 1024 * 1024 + 1)), false)
  monitor.add(scope.id, 98_000, image('valid'))
  assert.equal(monitor.add(scope.id, 97_000, image('late')), false)
  const noImage = fixture()
  assert.match(await noImage.monitor.look(noImage.scope.id, 'Read this', frame(100_000), signal()), /No recorded/)
  assert.equal(noImage.inputs.length, 0)
  noImage.monitor.stop(); monitor.stop()
})

test('a large buffer stays within the upload budget while retaining the newest view', async () => {
  const { monitor, scope, inputs } = fixture()
  for (let index = 0; index < 20; index++) monitor.add(scope.id, 80_000 + index * 1000, Buffer.alloc(3 * 1024 * 1024, index))
  await monitor.look(scope.id, 'Compare these views', range(80_000, 99_000), signal())
  const sent = inputs[0].images.map(item => Buffer.from(item.url.split(',')[1], 'base64'))
  assert.ok(sent.reduce((sum, item) => sum + item.length, 0) <= 6 * 1024 * 1024)
  assert.equal(sent.at(-1)[0], 19)
  monitor.stop()
})

test('pausing cancels an in-flight screen read and discards buffered context', async () => {
  let accepted
  const started = new Promise(resolve => { accepted = resolve })
  const { monitor, scope } = fixture(async (_input, opts) => {
    accepted()
    await new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new Error('Aborted screen read')), { once: true }))
  })
  monitor.add(scope.id, 99_000, image('slide'))
  const reading = monitor.look(scope.id, 'Read this slide', frame(99_000), signal())
  await started
  monitor.stop(scope.id)
  await assert.rejects(reading, { name: 'AbortError' })
  assert.equal(monitor.status().state, 'paused')
  assert.equal(monitor.status().ready, false)
  assert.equal(monitor.add(scope.id, 100_000, image('late')), false)
  assert.match(await monitor.look(scope.id, 'Read again', frame(99_000), signal()), /paused/)
})

test('source changes and a new call reject old frames and old stop commands', async () => {
  const { monitor, scope, inputs } = fixture()
  monitor.add(scope.id, 99_000, image('old-source'))
  const next = monitor.start({ id: 'screen:2', name: 'Second screen', kind: 'screen' })
  monitor.stop(scope.id)
  assert.equal(monitor.status().state, 'watching')
  assert.equal(monitor.add(scope.id, 100_000, image('late-old-source')), false)
  assert.match(await monitor.look(scope.id, 'Read old screen', frame(99_000), signal()), /changed/)
  monitor.add(next.id, 100_000, image('second-screen'))
  await monitor.look(next.id, 'Read selected screen', frame(100_000), signal())
  assert.match(inputs[0].user, /Second screen/)
  monitor.stop(undefined, true)
  assert.equal(monitor.status().source, undefined)
  assert.equal(monitor.status().state, 'off')
  assert.equal(monitor.add(next.id, 100_000, image('after-call')), false)
})

const store = new AgentStore(async () => '')
await store.load()
test('the answering model decides when to look; ordinary call questions send no screen images', async () => {
  const { monitor, scope, provider, inputs } = fixture()
  monitor.add(scope.id, 99_000, image('revenue-slide'))
  let looks = false
  provider.stream = async (input, opts) => {
    inputs.push(input)
    if (input.lane === 'vision') { opts.onDelta('Revenue grew from 20 to 35.'); return }
    const tool = input.tools.find(tool => tool.name === 'look_at_screen')
    assert.ok(tool)
    assert.match(input.user, /Decide from the conversation whether a look is needed/)
    if (input.user.includes('Explain the chart')) {
      looks = true
      const result = await tool.run({ question: 'What does the chart show?', view: 'frame', from_ms: 99_000, to_ms: 99_000 })
      assert.match(result, /20 to 35/)
    }
    opts.onDelta('LEVEL: quick\nRevenue grew from 20 to 35.')
  }
  const agent = store.list()[0]
  const copilot = new Copilot(() => {}, () => provider, { monitor, snapshot: async () => assert.fail('must only use the selected monitor'), dataUrl: async () => '', reset: async () => {} }, agentAccess(store, agent.id))
  await copilot.assist({ kind: 'ask', question: 'Can you repeat the deadline?' })
  assert.equal(looks, false)
  assert.equal(inputs.filter(input => input.lane === 'vision').length, 0)
  await copilot.assist({ kind: 'ask', question: 'Explain the chart' })
  assert.equal(looks, true)
  assert.equal(inputs.filter(input => input.lane === 'vision').length, 1)
  assert.equal(copilot.callState().frames.length, 0, 'automatic buffering must not create a background screenshot archive')
  monitor.stop()
})

test('audio-only calls have no screen tool and cannot capture a display implicitly', async () => {
  const { monitor, provider } = fixture()
  monitor.stop(undefined, true)
  provider.stream = async (input, opts) => { assert.ok(!input.tools.some(tool => tool.name === 'look_at_screen')); opts.onDelta('LEVEL: quick\nAsk them to describe the chart.') }
  const agent = store.list()[0]
  const copilot = new Copilot(() => {}, () => provider, { monitor, snapshot: async () => assert.fail('no screen was selected'), dataUrl: async () => '', reset: async () => {} }, agentAccess(store, agent.id))
  await copilot.assist({ kind: 'ask', question: 'Explain this chart' })
})
