import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotWith, workDir } from './helpers.mjs'
workDir('claude-connections')
const { AgentStore, Copilot, train, connectionSelection, waitForConnections } = await import('./.build/togle.mjs')

test('connection grants persist per agent, normalize accounts, reject wildcard servers, and can be removed', async () => {
  const store = new AgentStore()
  await store.load()
  const first = await store.create('team-meeting')
  const second = await store.create('general')
  const selection = { account: ' Work@Example.Test ', servers: ['claude.ai Slack', 'claude.ai Slack', '*', 'claude.ai *', 'claude.ai Bad\nserver'] }
  assert.deepEqual(connectionSelection(selection), { account: 'work@example.test', servers: ['claude.ai Slack'] })
  await store.update(first.id, { claudeConnections: selection })
  assert.equal(store.get(second.id).claudeConnections, undefined)
  const reloaded = new AgentStore()
  await reloaded.load()
  assert.deepEqual(reloaded.get(first.id).claudeConnections, { account: 'work@example.test', servers: ['claude.ai Slack'] })
  await reloaded.update(first.id, { claudeConnections: undefined })
  assert.equal(reloaded.get(first.id).claudeConnections, undefined)
  for (const input of [null, {}, { account: {}, servers: [] }, { account: 'work@example.test', servers: '*' }]) assert.equal(connectionSelection(input), undefined)
})

test('stopping while a connector is pending aborts immediately instead of starting an answer', async () => {
  const controller = new AbortController()
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const waiting = waitForConnections({ mcpServerStatus: async () => { ready(); return [] } }, controller.signal, ['claude.ai Slack'])
  await started
  controller.abort(new Error('Call ended'))
  await assert.rejects(waiting, /Call ended/)
})

test('agent chat and live call answers both receive only their own saved connections', async () => {
  const store = new AgentStore(async () => 'digest')
  await store.load()
  const connected = await store.create('meeting')
  const other = await store.create('general')
  const selection = { account: 'work@example.test', servers: ['claude.ai Slack'] }
  await store.update(connected.id, { claudeConnections: selection })
  const chat = []
  const provider = { id: 'fake', supportsTools: true, listModels: async () => [], stream: async input => { chat.push(input) } }
  for (const id of [connected.id, other.id]) await train(store, provider, id, [], 'Check the current project blockers.', new AbortController().signal, { onDelta() {}, onChange() {} })
  assert.deepEqual(chat[0].claudeConnections, selection)
  assert.equal(chat[1].claudeConnections, undefined)
  for (const id of [connected.id, other.id]) {
    const { copilot, inputs } = copilotWith(Copilot, store, id, ['LEVEL: quick\nI will check the current blockers.'])
    await copilot.assist({ kind: 'ask', question: 'What are the current project blockers?' })
    assert.deepEqual(inputs[0].claudeConnections, id === connected.id ? selection : undefined)
    copilot.cancel()
  }
})
