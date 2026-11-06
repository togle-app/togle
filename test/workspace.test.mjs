import assert from 'node:assert/strict'
import { test } from 'node:test'
import { agentAccess, workDir } from './helpers.mjs'

workDir('workspace')
const { AgentStore, Copilot, updateSettings, getSettings, callReadiness, workspaceEntries, CALL_NOTES_CHARS } = await import('./.build/togle.mjs')
const store = new AgentStore(async () => '')
await store.load()
const agent = store.list()[0]
updateSettings({ assist: { auto: false }, activeAgentId: agent.id })

test('a Claude subscription connects answers independently of speech recognition', () => {
  const settings = structuredClone(getSettings())
  settings.provider = 'claude'
  settings.claude.auth = 'subscription'
  const ready = callReadiness(settings, { chatgpt: false, claudeSubscription: true, claudeKey: false }, { state: 'missing' })
  assert.equal(ready.needsAI, false)
  assert.equal(ready.setup, 'speech')
  assert.equal(ready.answers, 'Claude subscription')
  assert.equal(ready.transcription, 'Set up transcription')
})

test('a saved API key cannot satisfy an unsigned subscription connection', () => {
  const settings = structuredClone(getSettings())
  settings.provider = 'claude'
  settings.claude.auth = 'subscription'
  assert.equal(callReadiness(settings, { chatgpt: true, claudeSubscription: false, claudeKey: true }, { state: 'ready' }).setup, 'ai')
  settings.claude.auth = 'api-key'
  assert.equal(callReadiness(settings, { chatgpt: false, claudeSubscription: false, claudeKey: true }, { state: 'ready' }).setup, undefined)
})

test('a signed-in ChatGPT account and local speech can start without an API key', () => {
  const settings = structuredClone(getSettings())
  settings.provider = 'chatgpt'
  settings.transcription.me = settings.transcription.them = 'local'
  const ready = callReadiness(settings, { chatgpt: true, claudeSubscription: false, claudeKey: false }, { state: 'ready' })
  assert.equal(ready.setup, undefined)
  assert.equal(ready.answers, 'ChatGPT plan')
  assert.equal(ready.transcription, 'Speech on this PC')
})

test('a speech failure opens its own setup step while a warm-up can finish during capture', () => {
  const settings = structuredClone(getSettings())
  settings.provider = 'chatgpt'
  const account = { chatgpt: true, claudeSubscription: false, claudeKey: false }
  assert.equal(callReadiness(settings, account, { state: 'error' }).setup, 'speech')
  assert.equal(callReadiness(settings, account, { state: 'starting' }).setup, undefined)
})

test('a call workspace includes only the selected call, including its resumed stretches', () => {
  const entries = [
    { id: 'setup', role: 'user', text: 'Reusable instructions' },
    { id: 'previous-client', role: 'call', call: 'yesterday' },
    { id: 'current', role: 'call', call: 'today' },
    { id: 'training', role: 'agent', text: 'Saved a reusable fact' },
    { id: 'resumed', role: 'call', call: 'today', resumed: true },
    { id: 'review', role: 'review' }
  ]
  assert.deepEqual(workspaceEntries(entries, 'call', 'today').map(e => e.id), ['current', 'resumed'])
  assert.deepEqual(workspaceEntries(entries, 'agent', 'today').map(e => e.id), ['setup', 'training', 'review'])
})

test('a new call never borrows the old call to fill an empty workspace', () => {
  const entries = [{ role: 'call', call: 'previous', cards: ['private-price'] }]
  assert.deepEqual(workspaceEntries(entries, 'call', 'new'), [])
  assert.equal(entries[0].cards[0], 'private-price', 'history is preserved independently')
})

function call(overrides = {}) {
  const inputs = []
  const provider = {
    id: 'scripted', supportsTools: false, listModels: async () => [],
    stream: async (input, { onDelta }) => { inputs.push(input); onDelta('LEVEL: quick\nI will check the details.') }
  }
  const copilot = new Copilot(() => {}, () => provider, { snapshot: async () => assert.fail('No screen capture'), reset: async () => {}, dataUrl: async () => '' }, { ...agentAccess(store, agent.id), ...overrides })
  return { copilot, inputs }
}

test('call notes reach the answer without training the reusable agent', async () => {
  const { copilot, inputs } = call()
  const memory = structuredClone(store.get(agent.id).memory)
  await copilot.setBrief('Acme renewal. Private budget: EUR 800. Our goal is to schedule a pilot.')
  await copilot.assist({ kind: 'ask', question: 'What is the goal of this call?' })
  assert.match(inputs[0].user, /schedule a pilot/)
  assert.deepEqual(store.get(agent.id).memory, memory)
})

test('New call drops the previous customer context before accepting the next call', async () => {
  const { copilot, inputs } = call()
  await copilot.setBrief('Acme-only private budget: EUR 800.')
  copilot.add('them', 'Can you honor our Acme price?', Date.now() - 2000, Date.now() - 1000)
  await copilot.assist({ kind: 'suggest' })
  await copilot.clear()
  await copilot.setBrief('Contoso interview. Help me explain my experience clearly.')
  await copilot.assist({ kind: 'ask', question: 'How should I introduce myself?' })
  assert.match(inputs[1].user, /Contoso interview/)
  assert.doesNotMatch(inputs[1].user, /Acme|EUR 800|honor our/)
  assert.equal(copilot.currentCall().transcript.length, 0)
})

test('long call notes retain important facts after the old 500-character cutoff', async () => {
  const { copilot, inputs } = call()
  const notes = 'Background about this meeting. '.repeat(35) + '\nCritical: SSO is Enterprise only; no discounts are approved.'
  assert.ok(notes.length > 500 && notes.length < CALL_NOTES_CHARS)
  await copilot.setBrief(notes)
  await copilot.assist({ kind: 'ask', question: 'Can we offer SSO on Growth?' })
  assert.match(inputs[0].user, /SSO is Enterprise only; no discounts are approved/)
  assert.equal(copilot.currentCall().brief, notes)
})

test('a slow recall for the previous draft agent cannot overwrite the newly chosen agent', async () => {
  let finishOld
  let selected = agent
  const second = { ...agent, id: 'other-agent', name: 'Support' }
  const history = owner => [{ id: owner.id + '-call', agentId: owner.id, at: 1000, endedAt: 2000, brief: 'Acme', with: ['Acme'], summary: 'A saved call.', about: [], asked: [] }]
  const { copilot } = call({ active: () => selected, pastCalls: { recall: async owner => owner.id === agent.id ? new Promise(resolve => { finishOld = () => resolve(history(owner)) }) : history(owner) } })
  const previous = copilot.setBrief('Acme renewal')
  selected = second
  await copilot.refreshAgent()
  finishOld()
  await previous
  assert.deepEqual(copilot.currentCall().recalled.map(call => call.agentId), [second.id])
})

test('a late recall for an old call brief cannot replace the current customer context', async () => {
  let finishOld
  const history = name => [{ id: name, agentId: agent.id, at: 1000, endedAt: 2000, brief: name, with: [name], summary: 'Saved notes.', about: [], asked: [] }]
  const { copilot } = call({ pastCalls: { recall: async (_owner, context) => context.brief === 'Acme' ? new Promise(resolve => { finishOld = () => resolve(history('Acme')) }) : history('Contoso') } })
  const previous = copilot.setBrief('Acme')
  await copilot.setBrief('Contoso')
  finishOld()
  await previous
  assert.deepEqual(copilot.currentCall().recalled.map(call => call.brief), ['Contoso'])
})
