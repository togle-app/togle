// What Codex kept of a thread's conversation, for the Chat view: its turns made into entries, and the backend's history over the
// stand-in for Codex's shared server (the newest turns with every step, older ones asked for, a thread it does not have).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('codex-history')
const T = await import('./.build/togle.mjs')
const fake = path.join(import.meta.dirname, 'fake-codex.mjs')

const made = []
const daemons = []
after(() => {
  for (const file of daemons) {
    try {
      execFileSync(process.execPath, [fake, 'app-server', 'daemon', 'stop'], { env: { ...process.env, FAKE_DAEMON_FILE: file } })
    } catch {
      // Nothing to stop.
    }
  }
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // Left for the system's own cleaning.
    }
  }
})

const until = async (check, what, ms = 8000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const codex = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-codex-history-'))
  made.push(dir)
  const daemonFile = path.join(dir, 'daemon.json')
  daemons.push(daemonFile)
  return new T.CodexBackend({
    command: [process.execPath, fake],
    env: { ...process.env, FAKE_DAEMON_FILE: daemonFile },
    told: () => undefined,
    serverPid: async () => {
      try {
        return JSON.parse(readFileSync(daemonFile, 'utf8')).pid
      } catch {
        return null
      }
    },
    retryMs: 150
  })
}

test('Codex turns become a conversation: what was asked, what it said, commands with how they ended, files changed', () => {
  const turns = [
    {
      id: 't1',
      startedAt: 1793852271,
      items: [
        { id: 'a', type: 'userMessage', content: [{ type: 'text', text: 'Add a status column.', text_elements: [] }, { type: 'localImage', path: 'C:\\shot.png' }], startedAtMs: 1793852271500 },
        { id: 'b', type: 'reasoning', summary: [], content: [] },
        { id: 'c', type: 'commandExecution', command: `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'npm test'`, status: 'completed', exitCode: 0 },
        { id: 'd', type: 'commandExecution', command: 'rm -rf build', status: 'declined' },
        { id: 'e', type: 'commandExecution', command: 'npm run lint', status: 'failed', exitCode: 1 },
        { id: 'f', type: 'fileChange', status: 'completed', changes: [{ path: 'C:\\work\\api\\orders.ts', diff: '+x', kind: { type: 'update' } }, { path: 'C:\\work\\api\\orders.sql', diff: '+y', kind: { type: 'add' } }] },
        { id: 'g', type: 'fileChange', status: 'declined', changes: [{ path: 'C:\\work\\api\\secret.ts', diff: '+z', kind: { type: 'add' } }] },
        { id: 'h', type: 'webSearch', query: 'x', results: [] },
        { id: 'i', type: 'agentMessage', text: 'Added the column.', phase: 'final_answer' }
      ]
    },
    { id: 't2', startedAt: 1793852300, items: [{ id: 'j', type: 'commandExecution', command: 'sleep 9', status: 'inProgress' }] }
  ]
  const entries = T.codexEntries(turns)
  assert.deepEqual(entries.map((e) => [e.kind, e.text, e.status ?? null]), [
    ['you', 'Add a status column.\n[picture]', null],
    ['command', 'npm test', 'finished'],
    ['command', 'rm -rf build', 'declined'],
    ['command', 'npm run lint', 'failed'],
    ['files', 'Changed 2 files: C:\\work\\api\\orders.ts, C:\\work\\api\\orders.sql', null],
    ['step', 'x', null],
    ['agent', 'Added the column.', null],
    ['command', 'sleep 9', 'running']
  ])
  assert.deepEqual(entries[4].paths, ['C:\\work\\api\\orders.ts', 'C:\\work\\api\\orders.sql'])
  assert.equal(entries[5].step, 'web', 'a search of the web is a step; a thought with no words and no time is not told')
  assert.equal(entries[0].at, 1793852271500)
  assert.equal(entries[7].at, 1793852300000, 'an item with no time of its own takes its turn')
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length)
  assert.deepEqual(T.codexEntries(turns).map((e) => e.id), entries.map((e) => e.id), 'the same item is the same id each time it is read')
  assert.deepEqual(T.turnsOf({ data: [1, 2], nextCursor: 'x' }), { turns: [1, 2], next: 'x' })
  assert.deepEqual(T.turnsOf({ data: [], nextCursor: null }), { turns: [], next: null })
  assert.deepEqual(T.turnsOf(undefined), { turns: [], next: null })
})

test('what else Codex did: its thinking, the web, a connector\'s tools, pictures it looked at; how long things took; what a step holds', () => {
  const turns = [{
    id: 't1',
    startedAt: 1793852271,
    items: [
      { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Why does the build fail?' }], startedAtMs: 1793852271000 },
      { id: 'r1', type: 'reasoning', summary: [], content: [], startedAtMs: 1793852271000, completedAtMs: 1793852271400 },
      { id: 'c1', type: 'commandExecution', command: 'npm run build', status: 'completed', exitCode: 1, durationMs: 8123.4, aggregatedOutput: 'error TS2345\n', startedAtMs: 1793852272000 },
      { id: 'c2', type: 'commandExecution', command: 'true', status: 'completed', exitCode: 0, durationMs: 12, aggregatedOutput: null },
      { id: 'r2', type: 'reasoning', summary: [], content: [], startedAtMs: 1793852281000, completedAtMs: 1793852284000 },
      { id: 'r3', type: 'reasoning', summary: ['The type of the plan is wrong.'], content: [{ type: 'text', text: 'It wants a number.' }], startedAtMs: 1793852284000, completedAtMs: 1793852286500 },
      { id: 'r4', type: 'reasoning', summary: ['Then the test.'], content: [], startedAtMs: 1793852286500, completedAtMs: 1793852287500 },
      { id: 'w1', type: 'webSearch', query: 'TS2345 number string', action: { type: 'search', query: 'TS2345 number string', queries: [] }, results: [], startedAtMs: 1793852288000, completedAtMs: 1793852289500 },
      { id: 'w2', type: 'webSearch', query: '', action: { type: 'open_page', url: 'https://example.com/ts2345' }, results: [] },
      { id: 'm1', type: 'mcpToolCall', server: 'github', tool: 'get_job_logs', status: 'completed', error: null, durationMs: 640, arguments: {}, result: {} },
      { id: 'm2', type: 'mcpToolCall', server: 'github', tool: 'get_run', status: 'failed', error: { message: 'no' }, durationMs: 90 },
      { id: 'i1', type: 'imageView', path: 'C:\\work\\shot-1.png' },
      { id: 'i2', type: 'imageView', path: 'C:\\work\\shot-2.png' },
      { id: 's1', type: 'sleep', durationMs: 5000 },
      { id: 'x1', type: 'contextCompaction' },
      { id: 'a', type: 'agentMessage', text: 'The plan needs a number.', phase: 'final_answer' }
    ]
  }]
  const details = new Map()
  const entries = T.codexEntries(turns, details)
  assert.deepEqual(entries.map((e) => [e.kind, e.step ?? null, e.text, e.status ?? null, e.took ?? null, e.more ?? null]), [
    ['you', null, 'Why does the build fail?', null, null, null],
    ['command', null, 'npm run build', 'finished', 8123, 'c1'],
    ['command', null, 'true', 'finished', 12, null],
    ['step', 'think', '', null, 5500, 'r3'],
    ['step', 'think', '', null, 1000, 'r4'],
    ['step', 'web', 'TS2345 number string', null, 1500, null],
    ['step', 'web', 'https://example.com/ts2345', null, null, null],
    ['step', 'tool', 'github: get_job_logs', null, 640, null],
    ['step', 'tool', 'github: get_run', 'failed', 90, null],
    ['step', 'read', 'C:\\work\\shot-1.png', null, null, null],
    ['agent', null, 'The plan needs a number.', null, null, null]
  ])
  assert.deepEqual(entries[9].paths, ['C:\\work\\shot-1.png', 'C:\\work\\shot-2.png'])
  assert.deepEqual([...details], [['c1', 'error TS2345\n'], ['r3', 'The type of the plan is wrong.\n\nIt wants a number.'], ['r4', 'Then the test.']], 'what a command printed and the words of a thought, by the key of the step')
  assert.equal(JSON.stringify(entries).includes('TS2345\\n'), false, 'none of it is in the entries')
  assert.deepEqual(T.codexEntries(turns).map((e) => e.more ?? null).filter(Boolean), [], 'with nowhere to keep it, no step says it can be opened')
  assert.deepEqual(T.codexEntries(turns, new Map()).map((e) => e.id), entries.map((e) => e.id), 'the same ids each time, thoughts in a row keeping the first')
})

test('each file Codex changed is kept with how it changed, by its place among the files with a path; a file it made is all added', () => {
  const details = new Map()
  const entries = T.codexEntries([{ id: 't1', items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Tidy.' }] },
    { id: 'fc', type: 'fileChange', status: 'completed', changes: [
      { path: 'C:\\work\\a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-old\n+new\n' },
      { path: '', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
      { path: 'C:\\work\\b.ts', kind: { type: 'add' }, diff: 'first\nsecond\n' },
      { path: 'C:\\work\\c.ts', kind: { type: 'delete' }, diff: 'gone\n' }
    ] },
    { id: 'a', type: 'agentMessage', text: 'Tidied.' }
  ] }], details)
  const change = entries.find((entry) => entry.kind === 'files')
  assert.deepEqual(change.paths, ['C:\\work\\a.ts', 'C:\\work\\b.ts', 'C:\\work\\c.ts'], 'a change with no path is not a file of it')
  assert.equal(change.more, 'fc')
  assert.deepEqual([...details], [['fc#0', '@@ -1 +1 @@\n-old\n+new\n'], ['fc#1', '+first\n+second'], ['fc#2', '-gone']], 'each by its place among the files shown')
})

test('a thread Togle runs gives back its conversation: the newest turns with their steps, older ones asked for', { timeout: 60_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'say one', asks: true })
    await until(() => task.state === 'idle', 'the first turn to end')
    for (const word of ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen']) {
      await task.send(`say ${word}`)
      await until(() => task.state === 'idle', `the turn "${word}" to end`)
    }
    const recent = await backend.history(task.id, false)
    assert.ok(recent)
    assert.equal(recent.more, true, 'fourteen turns, twelve shown')
    assert.deepEqual(recent.entries.filter((e) => e.kind === 'you').map((e) => e.text), ['say three', 'say four', 'say five', 'say six', 'say seven', 'say eight', 'say nine', 'say ten', 'say eleven', 'say twelve', 'say thirteen', 'say fourteen'])
    assert.deepEqual(recent.entries.slice(-2).map((e) => [e.kind, e.text]), [['you', 'say fourteen'], ['agent', 'ok']])
    const all = await backend.history(task.id, true)
    assert.equal(all.more, false)
    assert.equal(all.entries.filter((e) => e.kind === 'you').length, 14)
    assert.deepEqual(all.entries.slice(0, 2).map((e) => [e.kind, e.text]), [['you', 'say one'], ['agent', 'ok']])
  } finally {
    await backend.close()
  }
})

test('a command shows as a step in the conversation, and a thread the server does not have gives nothing', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'run note', asks: true })
    const request = await until(() => task.pending[0], 'the command to wait')
    task.answer(request.id, 'allow-once')
    await until(() => task.state === 'idle', 'the turn to end')
    const history = await backend.history(task.id, false)
    assert.deepEqual(history.entries.map((e) => [e.kind, e.text, e.status ?? null]), [
      ['you', 'run note', null],
      ['command', 'Set-Content -Path note.txt -Value x', 'finished'],
      ['agent', 'ran it', null]
    ])
    assert.equal(await backend.history('no-such-thread', false), null)
  } finally {
    await backend.close()
  }
})
