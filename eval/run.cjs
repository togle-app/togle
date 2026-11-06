// The quality evaluation: the test calls in cases.cjs through Togle's real answer pipeline, with the real models
// and a copy of your data. Writes every answer, its timing and its token use to eval/results/<label>.json;
// `node eval/show.cjs <label>` prints them next to what a good answer does.
//   npm run eval                        every case, using your ChatGPT plan
//   npm run eval -- --only G3,A2         some of them
//   npm run eval -- --label before       names the results file (default: latest)
//   npm run eval -- --fast deep          those lanes (quick, deep) use their model's Fast tier
const fs = require('node:fs')
const path = require('node:path')
const { options, run, signIn, sleep, useCopyOfTogleData } = require('./data.cjs')
// Progress lines appear as they happen, even when the output goes to a pipe.
process.stdout._handle?.setBlocking?.(true)

const opts = options()
const LABEL = typeof opts.label === 'string' ? opts.label : 'latest'
const ONLY = typeof opts.only === 'string' ? opts.only.split(',') : null
const FAST = typeof opts.fast === 'string' ? opts.fast.split(',') : []
useCopyOfTogleData()

run(async () => {
  const T = require('./.build/togle.cjs')
  const cases = require('./cases.cjs')
  await T.loadSettings()
  const provider = new T.ChatGPTProvider(await signIn(T.readSecret))
  const usages = []
  // Requests that answered: stopped and failed ones are reported too, with nothing counted.
  provider.onUsage = (u) => u.rounds && usages.push(u)
  const lanes = { ...T.getSettings().chatgpt.lanes }
  for (const lane of FAST) lanes[lane] = { ...lanes[lane], fast: true }
  await T.updateSettings({ chatgpt: { lanes } })
  // As Togle does at startup: the model list, which also opens the connection answers reuse.
  await provider.listModels()

  const store = new T.AgentStore(async () => {
    throw new Error('no studying during the evaluation')
  })
  await store.load()
  // Fresh from the templates, so your own training doesn't change the results.
  const general = await store.create('general')
  const acme = await cases.acmeAgent(store)
  const frames = { snapshot: async () => Promise.reject(new Error('no screen')), dataUrl: async () => '', reset: async () => {} }

  async function answer(c, agent) {
    const events = []
    const timings = []
    const now = () => performance.now()
    const access = {
      active: () => store.list().find((a) => a.id === agent.id),
      get: (id) => store.list().find((a) => a.id === id),
      knowledgeFor: (a, q, seen) => store.knowledgeFor(a, q, seen),
      search: (a, q, seen, first) => store.search(a, q, seen, first),
      facts: (a, question) => store.factsFor(a, question),
      code: () => undefined
    }
    const copilot = new T.Copilot((channel, payload) => events.push({ at: now(), channel, payload }), () => provider, frames, access, (timing) => timings.push(timing))
    const t0 = Date.now()
    if (c.brief) copilot.setBrief(c.brief)
    c.lines.forEach(([speaker, text], i) => {
      const at = t0 - (c.lines.length - i) * 8000
      copilot.add(speaker, text, at, at + 6000)
    })
    const before = usages.length
    const start = now()
    await copilot.assist(c.request ?? { kind: 'suggest', auto: true })
    // A deep answer, once started, finishes by itself.
    for (const deadline = start + 240_000; now() < deadline; await sleep(200)) {
      const assist = events.filter((e) => e.channel === 'assist').map((e) => e.payload)
      const started = assist.some((p) => p.type === 'deep' && p.state === 'start')
      const ended = assist.some((p) => p.part === 'deep' && (p.type === 'done' || p.type === 'error'))
      if (!started || ended) break
    }
    await sleep(300)
    const assist = events.filter((e) => e.channel === 'assist')
    const decision = assist.some((e) => e.payload.type === 'error') ? 'error' : assist.some((e) => e.payload.type === 'start') ? 'shown' : 'quiet'
    const text = (part) =>
      assist
        .filter((e) => e.payload.type === 'delta' && e.payload.part === part)
        .map((e) => e.payload.text)
        .join('')
    const first = (part) => assist.find((e) => e.payload.type === 'delta' && e.payload.part === part)
    const done = (part) => assist.find((e) => e.payload.part === part && (e.payload.type === 'done' || e.payload.type === 'error'))
    const ms = (e) => (e ? Math.round(e.at - start) : null)
    return {
      id: c.id,
      title: c.title,
      expect: c.expect,
      decision,
      expectedDecision: c.decision,
      decisionPassed: c.decision ? decision === c.decision : undefined,
      dismissed: timings.find((t) => t.dismissed)?.dismissed,
      question: assist.find((e) => e.payload.type === 'start')?.payload.question,
      match: assist.find((e) => e.payload.type === 'match')?.payload.answer ?? null,
      facts: assist.find((e) => e.payload.type === 'facts')?.payload.facts ?? null,
      main: text('main'),
      deep: text('deep') || null,
      deepDropped: assist.some((e) => e.payload.type === 'deep' && e.payload.state === 'drop'),
      errors: assist.filter((e) => e.payload.type === 'error').map((e) => `${e.payload.part}: ${e.payload.message}`),
      mainFirstMs: ms(first('main')),
      mainDoneMs: ms(done('main')),
      deepFirstMs: ms(first('deep')),
      deepDoneMs: ms(done('deep')),
      usage: usages.slice(before).map((u) => ({ ...u, firstTextMs: u.firstTextMs && Math.round(u.firstTextMs), ms: Math.round(u.ms) }))
    }
  }

  const results = []
  for (const [list, agent] of [
    [cases.general, general],
    [cases.selective, general],
    [cases.acme, acme]
  ]) {
    for (const c of list) {
      if (ONLY && !ONLY.includes(c.id)) continue
      try {
        results.push(await answer(c, agent))
      } catch (err) {
        results.push({ id: c.id, title: c.title, errors: [String(err.message)] })
      }
      const r = results.at(-1)
      const u = (r.usage ?? []).map((x) => `${x.lane} ${x.input}/${x.cached}c in ${x.output}/${x.reasoning}r out`).join('; ')
      console.log(`${r.id}: ${r.decision ?? 'error'}, first words ${r.mainFirstMs ?? '-'} ms, deep ${r.deepFirstMs ?? '-'} ms | ${u}${r.decisionPassed === false ? ` | DECISION MISMATCH: expected ${r.expectedDecision}` : ''}${r.errors?.length ? ` | ERROR ${r.errors.join(' / ')}` : ''}`)
    }
  }
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, 'results', `${LABEL}.json`), JSON.stringify(results, null, 2))
  console.log(`${results.length} cases -> eval/results/${LABEL}.json (node eval/show.cjs ${LABEL})`)
})
