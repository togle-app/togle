import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, shown, wait, workDir } from './helpers.mjs'

workDir('selective')
const { AgentStore, Copilot, updateSettings } = await import('./.build/togle.mjs')
const store = new AgentStore(async () => '')
await store.load()
const agent = store.list()[0]
const frames = { snapshot: async () => assert.fail('no screen'), dataUrl: async () => 'data:', reset: async () => {} }

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function callWith(reply, access = {}) {
  const events = []
  const inputs = []
  const timings = []
  const provider = {
    id: 'fake', supportsTools: false, listModels: async () => [],
    stream: async (input, handlers) => {
      inputs.push(input)
      await reply(input, handlers)
    }
  }
  const copilot = new Copilot(
    (channel, payload) => events.push({ channel, payload }),
    () => provider, frames, { ...agentAccess(store, agent.id), ...access },
    (timing) => timings.push(timing)
  )
  return { copilot, events, inputs, timings }
}

function question(copilot, text = 'Does that still need a reply?', segmentId) {
  const at = Date.now() - 4000
  const end = at + 1000
  copilot.add('them', text, at, end, segmentId)
  return { at, end }
}

const starts = (events) => shown(events).filter((e) => e.type === 'start')
const text = (events) => shown(events).filter((e) => e.type === 'delta').map((e) => e.text).join('')

test('an automatic quiet verdict, split across chunks, produces no card, marker or error', async () => {
  const lateFacts = deferred()
  const call = callWith((_input, { onDelta }) => {
    for (const piece of ['**LE', 'VEL:** qu', 'iet\r\n', 'This explanation should never appear.']) onDelta(piece)
  }, { facts: () => lateFacts.promise })
  question(call.copilot)
  await call.copilot.assist({ kind: 'suggest', auto: true })
  lateFacts.resolve([{ text: 'A fact that arrived too late.', doc: 'Notes' }])
  await wait(0)
  assert.deepEqual(shown(call.events), [])
  assert.deepEqual(call.copilot.currentCall().answering, [])
  assert.equal(call.timings.length, 1)
  assert.equal(call.timings[0].dismissed, 'quiet')
  assert.ok(!call.timings[0].error, 'silence is a decision, not a failed answer')
  assert.equal(call.timings[0].shown, undefined)
  assert.match(call.inputs[0].user, /triggered automatically/)
  assert.doesNotMatch(call.inputs[0].user, /give one useful point I could raise/)
})

test('a final transcript cannot reveal an automatic card before its answer decision', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    began.resolve(handlers)
    await finish.promise
  })
  const at = Date.now() - 3000
  call.copilot.setListening(true)
  call.copilot.anticipate('How many seats are included?', at, 'pending-decision')
  const handlers = await began.promise
  call.copilot.add('them', 'How many seats are included?', at, Date.now() - 1000, 'pending-decision')
  assert.deepEqual(shown(call.events), [])
  handlers.onDelta('LEVEL: quick\nTen seats are included.')
  finish.resolve()
  await wait(0)
  assert.deepEqual(shown(call.events).map((e) => e.type), ['start', 'context', 'delta', 'done'])
  assert.equal(text(call.events), 'Ten seats are included.')
  call.copilot.setListening(false)
})

test('an automatic card already prepared at a pause stays hidden when I answered before the final transcript', async () => {
  const call = callWith((_input, { onDelta }) => onDelta('LEVEL: quick\nWe can do Tuesday.'))
  const at = Date.now() - 4000
  call.copilot.setListening(true)
  call.copilot.anticipate('Which day works for you?', at, 'answered-at-pause')
  await wait(0)
  call.copilot.add('me', 'Tuesday works for us.', at + 2000, at + 2500)
  call.copilot.add('them', 'Which day works for you?', at, at + 1000, 'answered-at-pause')
  await wait(0)
  assert.deepEqual(shown(call.events), [])
  assert.equal(call.timings[0].dismissed, 'answered')
  call.copilot.setListening(false)
})

test('a specific one-word reply cancels an automatic answer still being prepared', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    began.resolve(handlers)
    await finish.promise
  })
  const turn = question(call.copilot, 'Which day works for you?')
  const task = call.copilot.assist({ kind: 'suggest', auto: true })
  const handlers = await began.promise
  call.copilot.add('me', 'Tuesday.', turn.end + 500, turn.end + 1000)
  assert.ok(handlers.signal.aborted)
  handlers.onDelta('LEVEL: deep\nThis late answer must stay hidden.')
  finish.resolve()
  await task
  assert.deepEqual(shown(call.events), [])
  assert.equal(call.timings[0].dismissed, 'answered')
})

test('a brief acknowledgement keeps a pending automatic suggestion available', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    began.resolve(handlers)
    await finish.promise
  })
  const turn = question(call.copilot, 'What does onboarding involve?')
  const task = call.copilot.assist({ kind: 'suggest', auto: true })
  const handlers = await began.promise
  call.copilot.add('me', 'Yeah, got it.', turn.end + 500, turn.end + 1000)
  assert.ok(!handlers.signal.aborted)
  handlers.onDelta('LEVEL: quick\nWe start with a short setup session.')
  finish.resolve()
  await task
  assert.equal(starts(call.events).length, 1)
  assert.equal(text(call.events), 'We start with a short setup session.')
  assert.equal(call.timings[0].dismissed, undefined)
})

test('answering before the automatic timer fires avoids a model request entirely', async () => {
  const call = callWith(() => assert.fail('no answer needed'))
  call.copilot.setListening(true)
  try {
    const turn = question(call.copilot, 'Which day works for you?')
    call.copilot.add('me', 'Tuesday works for us.', turn.end + 500, turn.end + 1000)
    await wait(450)
    assert.deepEqual(call.inputs, [])
    assert.deepEqual(shown(call.events), [])
  } finally {
    call.copilot.setListening(false)
  }
})

test('a newer question replaces a hidden answer and late text cannot revive it', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    if (call.inputs.length === 1) {
      began.resolve(handlers)
      await finish.promise
    } else handlers.onDelta('LEVEL: quick\nThe new question gets this answer.')
  })
  const turn = question(call.copilot, 'How long does onboarding take?')
  const first = call.copilot.assist({ kind: 'suggest', auto: true })
  const old = await began.promise
  call.copilot.add('them', 'Can we discuss pricing instead?', turn.end + 1000, turn.end + 2000)
  assert.ok(old.signal.aborted)
  await call.copilot.assist({ kind: 'suggest', auto: true })
  old.onDelta('LEVEL: quick\nAn outdated answer.')
  finish.resolve()
  await first
  assert.deepEqual(starts(call.events).map((e) => e.question), ['Can we discuss pricing instead?'])
  assert.equal(text(call.events), 'The new question gets this answer.')
  assert.ok(call.timings.some((t) => t.dismissed === 'superseded'))
  assert.equal(call.timings.find((t) => !t.dismissed).nthInCall, 0, 'discarded work is not the first shown answer')
})

test('the answer I have started reading keeps streaming when I begin speaking', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    handlers.onDelta('LEVEL: quick\nWe start with setup, ')
    began.resolve(handlers)
    await finish.promise
    handlers.onDelta('then import your contacts.')
  })
  const turn = question(call.copilot, 'What does onboarding involve?')
  const task = call.copilot.assist({ kind: 'suggest', auto: true })
  const handlers = await began.promise
  call.copilot.add('me', 'We start with setup.', turn.end + 500, turn.end + 1000)
  assert.ok(!handlers.signal.aborted, 'reading a visible suggestion is not a reason to remove it')
  finish.resolve()
  await task
  assert.equal(text(call.events), 'We start with setup, then import your contacts.')
  assert.equal(call.timings[0].dismissed, undefined)
})

test('a quiet verdict stops a speculative deep answer even if it already wrote hidden text', async () => {
  const quickBegan = deferred()
  const deepBegan = deferred()
  const finishQuick = deferred()
  const finishDeep = deferred()
  const call = callWith(async (input, handlers) => {
    if (input.lane === 'quick') {
      handlers.onAccepted?.()
      quickBegan.resolve(handlers)
      await finishQuick.promise
    } else {
      handlers.onDelta('A speculative deep answer that is not needed.')
      deepBegan.resolve(handlers)
      await finishDeep.promise
    }
  })
  question(call.copilot, 'How would you design a queue service?')
  const task = call.copilot.assist({ kind: 'suggest', auto: true })
  const quick = await quickBegan.promise
  const deep = await deepBegan.promise
  assert.deepEqual(shown(call.events), [])
  quick.onDelta('LEVEL: quiet\n')
  assert.ok(quick.signal.aborted)
  assert.ok(deep.signal.aborted)
  deep.onDelta('More text after cancellation.')
  finishQuick.resolve()
  finishDeep.resolve()
  await task
  await wait(0)
  assert.deepEqual(shown(call.events), [])
  assert.equal(call.timings.length, 1)
  assert.equal(call.timings[0].dismissed, 'quiet')
})

test('ending a call stops a pending automatic suggestion without a late card', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    began.resolve(handlers)
    await finish.promise
  })
  question(call.copilot)
  call.copilot.setListening(true)
  const task = call.copilot.assist({ kind: 'suggest', auto: true })
  const handlers = await began.promise
  call.copilot.setListening(false)
  assert.ok(handlers.signal.aborted)
  handlers.onDelta('LEVEL: quick\nToo late.')
  finish.resolve()
  await task
  assert.deepEqual(shown(call.events), [])
  assert.equal(call.timings[0].dismissed, 'stopped')
})

test('a provider failure before its verdict remains visible and actionable', async () => {
  const call = callWith(() => { throw new Error('The connection failed. Try again.') })
  question(call.copilot)
  await call.copilot.assist({ kind: 'suggest', auto: true })
  assert.equal(starts(call.events).length, 1)
  assert.match(shown(call.events).find((e) => e.type === 'error').message, /connection failed/)
  assert.equal(call.timings[0].dismissed, undefined)
  assert.equal(call.timings[0].error, true)
})

test('manual Suggest still provides a useful point after the question has been answered', async () => {
  const call = callWith((_input, { onDelta }) => onDelta('LEVEL: quick\nAsk about their rollout plan.'))
  const turn = question(call.copilot)
  call.copilot.add('me', 'We have already covered that.', turn.end + 500, turn.end + 1000)
  await call.copilot.assist({ kind: 'suggest' })
  assert.equal(text(call.events), 'Ask about their rollout plan.')
  assert.match(call.inputs[0].user, /give one useful point I could raise/)
  assert.doesNotMatch(call.inputs[0].user, /LEVEL: quiet/)
})

test('an unexpected quiet verdict on a manual request is an error, never a silent disappearance', async () => {
  const call = callWith((_input, { onDelta }) => onDelta('LEVEL: quiet'))
  question(call.copilot)
  await call.copilot.assist({ kind: 'ask', question: 'What should I ask next?' })
  assert.equal(starts(call.events).length, 1)
  assert.match(shown(call.events).find((e) => e.type === 'error').message, /No answer/)
  assert.equal(text(call.events), '')
})

test('a listening cue before the automatic timer fires keeps the original question on the card', async () => {
  const call = callWith((_input, { onDelta }) => onDelta('LEVEL: quick\nWe begin with setup.'))
  call.copilot.setListening(true)
  try {
    const turn = question(call.copilot, 'What does onboarding involve?')
    call.copilot.add('me', 'I see.', turn.end + 500, turn.end + 1000)
    await wait(450)
    assert.deepEqual(starts(call.events).map((e) => e.question), ['What does onboarding involve?'])
    assert.match(call.inputs[0].user, /What they just said, which is what to answer: "What does onboarding involve\?"/)
  } finally {
    call.copilot.setListening(false)
  }
})

test('an exact approved answer is still immediate and needs no model decision', async () => {
  const own = await store.create('general')
  await store.addAnswer(own.id, 'Do you integrate with SAP?', 'Yes, through Nordlink.', 'manual')
  const call = callWith(() => assert.fail('the approved answer is enough'), agentAccess(store, own.id))
  question(call.copilot, 'Do you integrate with SAP?')
  await call.copilot.assist({ kind: 'suggest', auto: true })
  assert.deepEqual(shown(call.events).map((e) => e.type), ['start', 'match', 'done'])
  assert.equal(shown(call.events)[1].answer, 'Yes, through Nordlink.')
})

test('switching automatic suggestions off keeps an in-flight decision off screen', async () => {
  const began = deferred()
  const finish = deferred()
  const call = callWith(async (_input, handlers) => {
    began.resolve(handlers)
    await finish.promise
  })
  question(call.copilot)
  const task = call.copilot.assist({ kind: 'suggest', auto: true })
  const handlers = await began.promise
  try {
    await updateSettings({ assist: { auto: false } })
    handlers.onDelta('LEVEL: quick\nThis should not appear after switching it off.')
    finish.resolve()
    await task
    assert.ok(handlers.signal.aborted)
    assert.deepEqual(shown(call.events), [])
  } finally {
    finish.resolve()
    await task
    await updateSettings({ assist: { auto: true } })
  }
})

test('a quiet verdict for an unfinished question does not swallow its changed final transcript', async () => {
  const call = callWith((_input, { onDelta }) => onDelta(call.inputs.length === 1 ? 'LEVEL: quiet' : 'LEVEL: quick\nThe follow-up still needs this answer.'))
  const at = Date.now() - 3000
  call.copilot.setListening(true)
  try {
    call.copilot.anticipate('Who does not want fewer outages?', at, 'changed-after-quiet')
    await wait(0)
    call.copilot.add('them', 'Who does not want fewer outages? What should we measure first?', at, Date.now() - 1000, 'changed-after-quiet')
    await wait(450)
    assert.equal(starts(call.events).length, 1)
    assert.equal(text(call.events), 'The follow-up still needs this answer.')
    assert.equal(call.inputs.filter((i) => i.lane === 'quick').length, 2)
  } finally {
    call.copilot.setListening(false)
  }
})

test('discarded assistance does not count training as used; a shown answer does', async () => {
  const uses = []
  const access = { noteUse: (_agent, use) => uses.push(use) }
  const quiet = callWith((_input, { onDelta }) => onDelta('LEVEL: quiet'), access)
  question(quiet.copilot, 'Could you explain onboarding?')
  await quiet.copilot.assist({ kind: 'suggest', auto: true })
  assert.deepEqual(uses, [])
  const useful = callWith((_input, { onDelta }) => onDelta('LEVEL: quick\nWe start with setup.'), access)
  question(useful.copilot, 'Could you explain onboarding?')
  await useful.copilot.assist({ kind: 'suggest', auto: true })
  assert.equal(uses.length, 1)
})
