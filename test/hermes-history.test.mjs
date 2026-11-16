// What Hermes kept of a session's conversation, for the Web view: its `sessions export` made into entries (only the live
// conversation, in the order Hermes wrote it), and the backend's history over the stand-in for the `hermes` program: asked for
// again only after a while, and nothing for a session Hermes does not have.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('hermes-history')
const T = await import('./.build/togle.mjs')
const fake = path.join(import.meta.dirname, 'fake-hermes-screen.mjs')
const made = []
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

const message = (id, role, extra = {}) => ({ id, role, content: '', timestamp: 1800000000 + id, active: 1, compacted: 0, display_kind: null, ...extra })
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const session = (...messages) => ({ id: 'S1', messages })

test('an export becomes a conversation: what was asked, what Hermes said, commands with how they ended, files changed', () => {
  const entries = T.hermesEntries(session(
    message(101, 'user', { content: 'List the files and fix the typo.' }),
    message(102, 'assistant', { content: 'I will look first.', tool_calls: [call('c1', 'terminal', { command: 'dir', timeout: 30 }), call('c2', 'terminal', { command: 'npm test' }), call('c3', 'write_file', { path: 'C:\\work\\notes\\a.md', content: 'x' })] }),
    message(103, 'tool', { tool_call_id: 'c1', tool_name: 'terminal', content: JSON.stringify({ output: 'a.txt', exit_code: 0, error: null }) }),
    message(104, 'tool', { tool_call_id: 'c2', tool_name: 'terminal', content: JSON.stringify({ output: 'boom', exit_code: 1, error: null }) }),
    message(105, 'assistant', { content: [{ type: 'text', text: 'Fixed.' }, { type: 'image', url: 'x' }] }),
    // What is not the conversation: rows compacted away, Hermes's notes to itself, a summary, its own turn marker.
    message(90, 'user', { content: 'Old question, compacted away.', active: 0, compacted: 1 }),
    message(106, 'user', { content: 'Summary of what came before.', _compressed_summary: true }),
    message(107, 'user', { content: 'hidden note', display_kind: 'internal_notification' }),
    message(108, 'user', { content: '[System: the session was resumed]' }),
    message(109, 'assistant', { content: 'switched', display_kind: 'model_switch' })
  ))
  assert.deepEqual(entries.map((e) => [e.kind, e.text, e.status ?? null]), [
    ['you', 'List the files and fix the typo.', null],
    ['agent', 'I will look first.', null],
    ['command', 'dir', 'finished'],
    ['command', 'npm test', 'failed'],
    ['files', 'Changed 1 file: C:\\work\\notes\\a.md', null],
    ['agent', 'Fixed.', null]
  ])
  assert.deepEqual(entries[4].paths, ['C:\\work\\notes\\a.md'])
  assert.equal(entries[0].at, 1800000101000, 'the time is in seconds in the export')
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length)
})

test('rows are read in the order Hermes wrote them, not by their time, and a command nothing answered stays running', () => {
  const entries = T.hermesEntries(session(
    message(202, 'assistant', { content: 'Second.', timestamp: 1 }),
    message(201, 'user', { content: 'First.', timestamp: 5 }),
    message(203, 'assistant', { content: '', tool_calls: [call('c9', 'terminal', { command: 'sleep 99' })] })
  ))
  assert.deepEqual(entries.map((e) => e.text), ['First.', 'Second.', 'sleep 99'])
  assert.equal(entries[2].status, 'running')
  assert.deepEqual(T.hermesEntries(null), [])
  assert.deepEqual(T.hermesEntries({ messages: 'nonsense' }), [])
})

const hermes = (rows, backend = {}) => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'togle-hermes-history-'))
  made.push(home)
  const write = (next) => writeFileSync(path.join(home, 'sessions.json'), JSON.stringify(next))
  write(rows)
  return Object.assign(new T.HermesBackend({ command: [process.execPath, fake], env: { ...process.env, FAKE_HERMES_HOME: home }, told: () => undefined, cacheMs: 0, ...backend }), { write })
}
const row = (id, messages) => ({ id, title: 'A task', workspace: 'site', updatedAt: Date.now(), source: 'local', messages })

test('a session is read from `sessions export`, and asked for again only after a while', { timeout: 30_000 }, async () => {
  const backend = hermes([row('local-abc', [message(1, 'user', { content: 'First question.' }), message(2, 'assistant', { content: 'First answer.' })])], { historyMs: 60_000 })
  try {
    const first = await backend.history('local-abc', false)
    assert.deepEqual(first.entries.map((e) => e.text), ['First question.', 'First answer.'])
    assert.equal(first.more, false)
    // A new turn is written, and the next look is within the while: it is the same export.
    backend.write([row('local-abc', [message(1, 'user', { content: 'First question.' }), message(2, 'assistant', { content: 'First answer.' }), message(3, 'user', { content: 'Second question.' })])])
    assert.equal((await backend.history('local-abc', false)).entries.length, 2, 'not asked again so soon: a Python program starts each time')
  } finally {
    await backend.close()
  }
})

test('with no wait it is read again, many turns are cut to the last ones, and a session Hermes does not have gives nothing', { timeout: 60_000 }, async () => {
  const many = []
  for (let turn = 1; turn <= 14; turn++) many.push(message(turn * 2 - 1, 'user', { content: `Question ${turn}` }), message(turn * 2, 'assistant', { content: `Answer ${turn}` }))
  const backend = hermes([row('local-big', many)], { historyMs: 0 })
  try {
    const recent = await backend.history('local-big', false)
    assert.equal(recent.more, true)
    assert.equal(recent.entries[0].text, 'Question 3', 'twelve turns')
    assert.equal(recent.entries.length, 24)
    const all = await backend.history('local-big', true)
    assert.equal(all.more, false)
    assert.equal(all.entries.length, 28)
    backend.write([row('local-big', [message(1, 'user', { content: 'Only now.' })])])
    assert.deepEqual((await backend.history('local-big', false)).entries.map((e) => e.text), ['Only now.'], 'asked again once the while is over')
    assert.equal(await backend.history('local-nothing', false), null, 'Hermes says it has none, on stdout')
    assert.equal(await backend.history('not a session id; rm -rf', false), null, 'only what looks like a session id is passed on')
  } finally {
    await backend.close()
  }
})
