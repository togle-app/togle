// What Hermes kept of a session's conversation, for the Chat view: its `sessions export` made into entries (only the live
// conversation, in the order Hermes wrote it), and the backend's history over the stand-in for the `hermes` program: asked for
// again only after a while, and nothing for a session Hermes does not have.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const until = async (check, what, ms = 15_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
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

test('what else Hermes did: code it ran, files read, searches, the web, its checklist, its thinking and its other tools', () => {
  const details = new Map()
  const entries = T.hermesEntries(session(
    message(301, 'user', { content: 'Tidy the notes folder.' }),
    message(302, 'assistant', { content: '', reasoning: 'First see what is there.', tool_calls: [call('d1', 'execute_code', { code: 'import os\nprint(os.listdir("notes"))' }), call('d2', 'read_file', { path: 'notes/a.md' }), call('d3', 'read_file', { path: 'notes/b.md', limit: 40 })] }),
    message(303, 'tool', { tool_call_id: 'd1', content: JSON.stringify({ output: "['a.md', 'b.md']\n", exit_code: 0, duration_seconds: 1.25, status: 'ok' }) }),
    message(304, 'tool', { tool_call_id: 'd2', content: JSON.stringify({ content: 'alpha', total_lines: 1 }) }),
    message(305, 'tool', { tool_call_id: 'd3', content: JSON.stringify({ content: 'beta', total_lines: 1 }) }),
    message(306, 'assistant', { content: 'Two notes. I will make a list.', reasoning: null, tool_calls: JSON.stringify([call('d4', 'todo_list', { todos: [{ id: 'a', content: 'Merge the notes', status: 'in_progress' }] }), call('d5', 'search_files', { pattern: 'TODO', path: 'notes' }), call('d6', 'web_search', { query: 'markdown front matter', limit: 5 }), call('d7', 'web_extract', { urls: ['https://example.com/front-matter'] })]) }),
    message(307, 'tool', { tool_call_id: 'd4', content: JSON.stringify({ revision: 1, summary: {}, todos: [{ id: 'a', content: 'Merge the notes', status: 'in_progress' }, { id: 'b', content: 'Delete the old ones', status: 'pending' }, { id: 'c', content: 'Called off', status: 'cancelled' }] }) }),
    message(308, 'tool', { tool_call_id: 'd5', content: JSON.stringify({ total_count: 0 }), timestamp: 1800000309.5 }),
    message(309, 'assistant', { content: '', reasoning: 'Now merge them.', tool_calls: [call('d8', 'terminal', { command: 'type notes\\a.md notes\\b.md > notes\\all.md' }), call('d9', 'vision_analyze', { image_url: 'x', question: 'y' }), call('d10', 'todo_list', { merge: true, todos: [{ id: 'a', content: 'Merge the notes', status: 'completed' }] })] }),
    message(310, 'tool', { tool_call_id: 'd8', content: 'The system cannot find the file.' , timestamp: 1800000300 }),
    message(311, 'tool', { tool_call_id: 'd10', content: JSON.stringify({ todos: [{ id: 'a', content: 'Merge the notes', status: 'completed' }, { id: 'b', content: 'Delete the old ones', status: 'pending' }] }) }),
    message(312, 'assistant', { content: 'Merged into notes/all.md.', reasoning: '   ' })
  ), details)
  assert.deepEqual(entries.map((e) => [e.kind, e.step ?? null, e.text, e.status ?? null, e.took ?? null]), [
    ['you', null, 'Tidy the notes folder.', null, null],
    ['step', 'think', '', null, null],
    ['step', 'code', 'import os\nprint(os.listdir("notes"))', 'finished', 1250],
    ['step', 'read', 'notes/a.md', null, null],
    ['agent', null, 'Two notes. I will make a list.', null, null],
    ['step', 'plan', '0 of 2 done', null, null],
    ['step', 'search', 'TODO', null, 3500],
    ['step', 'web', 'markdown front matter', null, null],
    ['step', 'web', 'https://example.com/front-matter', null, null],
    ['step', 'think', '', null, null],
    ['command', null, 'type notes\\a.md notes\\b.md > notes\\all.md', 'finished', null],
    ['step', 'tool', 'vision_analyze', null, null],
    ['step', 'plan', '1 of 2 done', null, null],
    ['agent', null, 'Merged into notes/all.md.', null, null]
  ])
  assert.deepEqual(entries[3].paths, ['notes/a.md', 'notes/b.md'])
  assert.deepEqual(entries[5].plan, [{ text: 'Merge the notes', state: 'doing' }, { text: 'Delete the old ones', state: 'todo' }], 'the checklist as its result gives it whole, without what was called off')
  assert.deepEqual(entries[12].plan, [{ text: 'Merge the notes', state: 'done' }, { text: 'Delete the old ones', state: 'todo' }])
  assert.equal(entries[10].took, undefined, 'a result whose time is before its call tells no time')
  assert.deepEqual([...details].map(([key, words]) => [key, words]), [
    ['think:30200', 'First see what is there.'],
    ['d1', "['a.md', 'b.md']\n"],
    ['think:30900', 'Now merge them.'],
    ['d8', 'The system cannot find the file.']
  ], 'what each step holds: a thought, what code printed, and a result that is only words')
  assert.deepEqual(entries.filter((e) => e.more).map((e) => e.more), ['think:30200', 'd1', 'think:30900', 'd8'])
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length, 'each entry has an id of its own')
  assert.equal(T.hermesEntries(session(message(1, 'assistant', { content: 'Hi.', reasoning: 'A thought.' }))).length, 1, 'with nowhere to keep its words, a thought is not told')
})

test('a file Hermes changed opens to how it changed: the diff of a patch, a file written whole; a change that failed opens to nothing', () => {
  const details = new Map()
  const entries = T.hermesEntries(session(
    message(401, 'user', { content: 'Fix the notes.' }),
    message(402, 'assistant', { content: '', tool_calls: [call('p1', 'patch', { path: 'notes/a.md', old_string: 'x', new_string: 'y' }), call('w1', 'write_file', { path: 'notes/new.md', content: 'line one\nline two\n' }), call('w2', 'write_file', { path: 'notes/locked.md', content: 'z' })] }),
    message(403, 'tool', { tool_call_id: 'p1', content: JSON.stringify({ success: true, diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-x\n+y\n', files_modified: ['notes/a.md'] }) }),
    message(404, 'tool', { tool_call_id: 'w1', content: JSON.stringify({ bytes_written: 18, files_modified: ['notes/new.md'], verified: true }) }),
    message(405, 'tool', { tool_call_id: 'w2', content: JSON.stringify({ error: 'The file changed since it was read.', stale_write_blocked: true }) }),
    message(406, 'assistant', { content: 'Done.' })
  ), details)
  const changes = entries.filter((entry) => entry.kind === 'files')
  assert.deepEqual(changes.map((entry) => [entry.paths[0], entry.more ?? null, entry.status ?? null]), [['notes/a.md', 'p1', null], ['notes/new.md', 'w1', null], ['notes/locked.md', null, 'failed']])
  assert.equal(details.get('p1#0'), '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-x\n+y\n')
  assert.equal(details.get('w1#0'), '+line one\n+line two')
  assert.equal(details.has('w2#0'), false)
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

test('a session Togle started is read by the id Hermes gave it, by its session and by the name it was started with', { timeout: 60_000 }, async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'togle-hermes-history-'))
  const keep = mkdtempSync(path.join(os.tmpdir(), 'togle-hermes-keep-'))
  made.push(home, keep)
  const open = () => new T.HermesBackend({ command: [process.execPath, fake], env: { ...process.env, FAKE_HERMES_HOME: home }, told: () => undefined, findMs: 80, cacheMs: 0, historyMs: 0, keep })
  const backend = open()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'say hi', title: 'A started session' })
    const name = task.id
    // Hermes gives the session its own id, which Togle finds and keeps beside the name.
    const real = await until(() => task.real, 'Togle to find the id Hermes gave the session')
    assert.notEqual(real, name)
    const file = path.join(home, 'sessions.json')
    const rows = JSON.parse(readFileSync(file, 'utf8'))
    rows.find((row) => row.id === real).messages = [message(1, 'user', { content: 'say hi' }), message(2, 'assistant', { content: 'hi' })]
    writeFileSync(file, JSON.stringify(rows))
    // By its session (what the hub asks for a task Togle runs): the id Hermes gave it.
    assert.equal(task.session(), real)
    assert.deepEqual((await backend.history(task.session(), false)).entries.map((e) => e.text), ['say hi', 'hi'])
    // By the name it was started with (what the list says of it after Togle starts again).
    assert.deepEqual((await backend.history(name, false)).entries.map((e) => e.text), ['say hi', 'hi'])
  } finally {
    await backend.close()
  }
  // A new Togle over the same kept folder knows the name too.
  const next = open()
  try {
    const listed = await until(async () => (await next.list()).find((row) => row.title === 'A started session' || row.id.startsWith('togle-')), 'the session to be listed')
    assert.deepEqual((await next.history(listed.id, false)).entries.map((e) => e.text), ['say hi', 'hi'])
  } finally {
    await next.close()
  }
})
