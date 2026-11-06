import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
process.env.TOGLE_TEST_USER_DATA = path.join(import.meta.dirname, '.work', 'saved-call-context-' + process.pid)
mkdirSync(process.env.TOGLE_TEST_USER_DATA, { recursive: true })
const { SavedCallReader, savedCallContext, sessionSummary, emptyLessons, train, trainHistory, AgentStore } = await import('./.build/togle.mjs')
const start = Date.UTC(2026, 10, 2, 10)
const record = (id = 'team-sync', owner = 'work') => ({ version: 1, id, agentId: owner, agentName: 'Team', title: 'Team sync', startedAt: start, endedAt: start + 3600000, updatedAt: start, status: 'ended', frameSession: '', brief: '', group: true,
  transcript: [{ id: 'line-one', speaker: 'them', at: start + 240000, end: start + 243000, voiceName: 'Denis', voiceNamedBy: 'suggested', text: 'I can investigate the deployment issue. We have not agreed a deadline.' }],
  summary: '', notes: '', suggestions: [], callAnswers: [], learning: { state: 'not-reviewed', pending: emptyLessons(), changes: [] } })
const source = records => ({ list: async () => records.map(sessionSummary), get: async id => records.find(record => record.id === id) ?? null })

test('unreviewed calls expose timestamped original evidence and uncertainty, without inventing a summary', async () => {
  const text = await savedCallContext(record()), context = JSON.parse(text)
  assert.equal(context.summary, ''); assert.equal(context.evidence[0].time, '4:00'); assert.equal(context.evidence[0].tentativeName, true)
  assert.match(context.evidence[0].text, /not agreed a deadline/)
  assert.equal(context.coverage, 'Complete retained transcript.'); assert.match(context.instructions, /untrusted evidence/)
})

test('saved call reads cannot cross agent boundaries, accept paths or return deleted calls', async () => {
  const reader = new SavedCallReader(source([record('private-call', 'personal')]))
  await assert.rejects(reader.read('work', 'private-call'), /unavailable for this agent/)
  await assert.rejects(reader.read('personal', '../private-call'), /unavailable/)
  await assert.rejects(reader.read('personal', 'deleted-call'), /unavailable/)
  assert.deepEqual(JSON.parse(await reader.search('work', 'deployment')).results, [])
})

test('long meeting pages stay bounded and cover every retained line without gaps or repeats', async () => {
  const call = record()
  call.transcript = Array.from({ length: 900 }, (_, i) => ({ ...call.transcript[0], id: 'line-' + i, text: `Decision ${i}: ${'evidence '.repeat(30)}`, at: start + i * 4000 }))
  const seen = []; let next = 0
  do {
    const text = await savedCallContext(call, '', next), page = JSON.parse(text)
    assert.ok(text.length < 24000); assert.ok(page.evidence.length)
    seen.push(...page.evidence.map(line => line.line)); next = page.nextLine
  } while (next !== undefined)
  assert.deepEqual(seen, Array.from({ length: 900 }, (_, i) => i + 1))
})

test('search finds transcript-only commitments and supports older-call pagination without other agents', async () => {
  const calls = Array.from({ length: 65 }, (_, i) => ({ ...record('call-' + i), startedAt: start - i * 3600000, transcript: [{ ...record().transcript[0], text: i === 64 ? 'The GraphQL migration belongs to Luka.' : 'Routine status update.' }] }))
  calls.push({ ...record('personal', 'personal'), transcript: [{ ...record().transcript[0], text: 'Private GraphQL discussion.' }] })
  const reader = new SavedCallReader(source(calls)), first = JSON.parse(await reader.search('work', 'GraphQL'))
  assert.deepEqual(first.results, []); assert.equal(first.nextOffset, 60)
  const second = JSON.parse(await reader.search('work', 'GraphQL', first.nextOffset))
  assert.equal(second.results.length, 1); assert.equal(second.results[0].id, 'call-64'); assert.match(second.results[0].excerpts[0].text, /Luka/)
  assert.equal(second.nextOffset, undefined)
})

test('search excerpts keep neighboring context and cancellation stops archive reads', async () => {
  const call = record(); call.transcript = ['No deadline yet.', 'I will check GraphQL.', 'That is only a proposal.'].map((text, index) => ({ ...call.transcript[0], id: String(index), text }))
  const excerpt = JSON.parse(await savedCallContext(call, 'GraphQL'))
  assert.equal(excerpt.evidence.length, 3); assert.match(excerpt.coverage, /excerpts/)
  const controller = new AbortController(); controller.abort()
  await assert.rejects(new SavedCallReader(source([call])).search('work', 'GraphQL', 0, controller.signal), /abort/i)
})

test('selected-call questions use only archive read tools and keep the exact call reference in follow-ups', async () => {
  const store = new AgentStore(async () => ''); await store.load(); const agent = store.list()[0]
  const selected = { id: 'last-week', title: 'Team sync' }, calls = []
  const provider = { supportsTools: true, stream: async input => {
    assert.match(input.system, /last-week/); assert.equal(input.claudeConnections, undefined)
    assert.deepEqual(input.tools.map(tool => tool.name), ['search_past_calls', 'read_saved_call'])
    await input.tools.find(tool => tool.name === 'read_saved_call').run({ id: 'last-week', query: 'deployment' })
  } }
  await train(store, provider, agent.id, [], 'What did we decide?', new AbortController().signal, { selectedCall: selected, savedCall: async (...args) => { calls.push(args); return 'evidence' }, onDelta: () => {}, onChange: () => { throw Error('Must not modify the agent') } })
  assert.deepEqual(calls, [['last-week', 'deployment', 0]])
  const history = trainHistory([{ role: 'user', text: 'What did we decide?', call: selected }, { role: 'agent', text: 'The decision.', changes: [] }])
  assert.match(history[0].text, /last-week/); assert.match(history[0].text, /What did we decide/)
})
