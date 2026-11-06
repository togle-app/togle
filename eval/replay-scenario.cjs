const { checkScenario } = require('./scenario-checks.cjs')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A complete call moment through the real store, retrieval, automatic scheduling and answer pipeline. */
async function replayScenario(T, scenario, createProvider, { timeoutMs = 30000 } = {}) {
  const store = new T.AgentStore(async () => { throw new Error('No background studying in scenario tests') })
  await store.load()
  const agent = await store.create('general')
  for (const [name, text] of scenario.knowledge ?? []) await store.addText(agent.id, name, text)
  const events = []
  const inputs = []
  const timings = []
  const behavior = []
  let requests = 0
  let running = 0
  let timedOut = false
  const provider = createProvider(scenario)
  const wrapped = {
    id: provider.id, supportsTools: provider.supportsTools, listModels: () => provider.listModels(),
    stream: async (input, handlers) => {
      requests++
      inputs.push(input)
      if (scenario.recovery && requests === 1) {
        const error = new Error('429: The AI service is at its limit. Try again in a moment.')
        error.status = 429
        throw error
      }
      running++
      try { await provider.stream(input, handlers) }
      finally { running-- }
    }
  }
  const access = {
    active: () => store.list().find(a => a.id === agent.id), get: id => store.list().find(a => a.id === id),
    knowledgeFor: (a, query, seen) => store.knowledgeFor(a, query, seen),
    search: (a, query, seen, first) => store.search(a, query, seen, first),
    facts: (a, query) => store.factsFor(a, query), code: () => undefined
  }
  const frames = { snapshot: async () => { throw new Error('No screen in transcript scenarios') }, dataUrl: async () => '', reset: async () => {} }
  const copilot = new T.Copilot((channel, payload) => { if (channel === 'assist') events.push(payload) }, () => wrapped, frames, access, t => timings.push(t))
  const started = Date.now()
  const deadline = started + timeoutMs
  const timer = setTimeout(() => { timedOut = true; copilot.setListening(false); copilot.cancel() }, timeoutMs)
  const add = (line, i) => {
    const at = started - (scenario.lines.length - i) * 3000
    copilot.add(line[0], line[1], at, at + 1500)
  }
  const settled = async () => {
    for (;;) {
      if (timedOut || Date.now() >= deadline) { timedOut = true; return }
      const terminal = timings.length || events.some(e => e.part === 'main' && (e.type === 'done' || e.type === 'error'))
      if (terminal && !running && !copilot.currentCall().answering.length) return
      await sleep(20)
    }
  }
  try {
    if (scenario.brief) await copilot.setBrief(scenario.brief)
    copilot.setGroup(!!scenario.group)
    if (scenario.request) {
      scenario.lines.forEach(add)
      await copilot.assist(scenario.request)
      await settled()
    } else if (scenario.recovery) {
      copilot.setListening(true)
      add(scenario.lines[0], 0)
      await settled()
      const before = requests
      add(scenario.lines[1], 1)
      await sleep(450)
      behavior.push({ label: 'automatic requests pause at the limit', pass: before === 1 && requests === 1 })
      await copilot.assist({ kind: 'suggest' })
      await settled()
      behavior.push({ label: 'manual retry recovers', pass: requests === 2 })
    } else {
      copilot.setListening(true)
      scenario.lines.forEach(add)
      if (scenario.noRequest) await sleep(1500)
      else await settled()
    }
  } finally {
    clearTimeout(timer)
    copilot.setListening(false)
    copilot.cancel()
  }
  const cards = events.filter(e => e.type === 'start')
  const latest = cards.at(-1)?.id
  const text = events.filter(e => e.id === latest && e.type === 'delta').map(e => e.text).join('')
  const match = events.find(e => e.id === latest && e.type === 'match')?.answer ?? ''
  const errors = events.filter(e => e.type === 'error').map(e => e.message)
  const failedLatest = events.some(e => e.id === latest && e.type === 'error')
  const result = {
    id: scenario.id, title: scenario.title,
    decision: failedLatest ? 'error' : cards.length ? 'shown' : 'quiet',
    text: text || match, cards: cards.length, errors, requests, timedOut, ms: Date.now() - started,
    prompt: inputs.map(input => input.system + '\n' + input.user).join('\n'),
    behavior, timings
  }
  return { ...result, ...checkScenario(scenario, result) }
}

function scriptedProvider(scenario) {
  return {
    id: 'scripted', supportsTools: false, listModels: async () => [],
    stream: async (_input, { signal, onDelta }) => {
      signal.throwIfAborted()
      onDelta(scenario.offline)
    }
  }
}

module.exports = { replayScenario, scriptedProvider }
