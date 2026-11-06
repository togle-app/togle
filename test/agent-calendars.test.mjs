import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('agent-calendars')
const { AgentCalendars } = await import('./.build/togle.mjs')

test('calendar reads, events and reminders stay bound to the owning agent and its explicit account', async () => {
  let agents = [{ id: 'work-agent', name: 'Northwind', calendar: { enabled: true, accountId: 'work-account' } }, { id: 'personal-agent', name: 'Personal', calendar: { enabled: true, accountId: 'personal-account' } }]
  const calls = [], alerts = []
  const calendars = new AgentCalendars(() => agents, (accountId, agentId) => ({
    connections: async () => ({ account: accountId + '@example.test', apps: [{ name: 'calendar', label: 'Calendar', status: 'connected', readTools: 1 }] }),
    stream: async (input, options) => {
      calls.push({ accountId, agentId, input })
      options.onToolCall('claude_connection')
      options.onFinal(JSON.stringify([{ id: 'same-external-event-id', title: accountId + ' meeting', start: Date.now() + 120000, end: Date.now() + 3600000, attendees: 4 }]))
    }
  }), () => false, () => {}, event => alerts.push(event))
  try {
    await calendars.refresh('work-agent')
    assert.equal(calls.length, 1); assert.equal(calls[0].accountId, 'work-account')
    assert.equal(calendars.status('personal-agent').events.length, 0)
    await calendars.refresh('personal-agent')
    const all = calendars.status().events
    assert.equal(all.length, 2); assert.notEqual(all[0].id, all[1].id, 'matching external event IDs cannot conflate two owners')
    assert.deepEqual(new Set(all.map(event => event.agentId)), new Set(['work-agent', 'personal-agent']))
    assert.ok(alerts.some(event => event.agentId === 'work-agent' && event.agentName === 'Northwind'))
    assert.ok(calls.every(call => call.input.claudeConnections.account === call.accountId + '@example.test'))
    agents = agents.filter(agent => agent.id !== 'work-agent'); calendars.sync()
    assert.equal(calendars.status().events.length, 1)
    assert.equal(calendars.status().events[0].agentId, 'personal-agent')
    await assert.rejects(calendars.refresh('work-agent'), /unavailable/)
  } finally { calendars.stop() }
})

test('disabled agents never read a calendar and active calls pause refreshes', async () => {
  const agents = [{ id: 'one', name: 'Work', calendar: { enabled: false, accountId: 'work' } }]
  let inCall = false, reads = 0
  const calendars = new AgentCalendars(() => agents, () => ({ connections: async () => { reads++; return { account: 'work', apps: [] } }, stream: async () => {} }), () => inCall, () => {}, () => {})
  try {
    await calendars.refresh(); assert.equal(reads, 0); assert.equal(calendars.status().state, 'off')
    agents[0].calendar.enabled = true; inCall = true
    await calendars.refresh('one'); assert.equal(reads, 0)
    inCall = false; await calendars.refresh('one'); assert.equal(reads, 1)
  } finally { calendars.stop() }
})
