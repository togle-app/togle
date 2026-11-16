// What Codex kept of a thread's conversation, for the Web view: its turns made into entries, and the backend's history over the
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
    ['agent', 'Added the column.', null],
    ['command', 'sleep 9', 'running']
  ])
  assert.deepEqual(entries[4].paths, ['C:\\work\\api\\orders.ts', 'C:\\work\\api\\orders.sql'])
  assert.equal(entries[0].at, 1793852271500)
  assert.equal(entries[6].at, 1793852300000, 'an item with no time of its own takes its turn')
  assert.equal(new Set(entries.map((e) => e.id)).size, entries.length)
  assert.deepEqual(T.codexEntries(turns).map((e) => e.id), entries.map((e) => e.id), 'the same item is the same id each time it is read')
  assert.deepEqual(T.turnsOf({ data: [1, 2], nextCursor: 'x' }), { turns: [1, 2], next: 'x' })
  assert.deepEqual(T.turnsOf({ data: [], nextCursor: null }), { turns: [], next: null })
  assert.deepEqual(T.turnsOf(undefined), { turns: [], next: null })
})

test('a thread Togle runs gives back its conversation: the newest turns with their steps, older ones asked for', { timeout: 60_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'say one', asks: true })
    await until(() => task.state === 'idle', 'the first turn to end')
    for (const word of ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']) {
      await task.send(`say ${word}`)
      await until(() => task.state === 'idle', `the turn "${word}" to end`)
    }
    const recent = await backend.history(task.id, false)
    assert.ok(recent)
    assert.equal(recent.more, true, 'twelve turns, ten shown')
    assert.deepEqual(recent.entries.filter((e) => e.kind === 'you').map((e) => e.text), ['say three', 'say four', 'say five', 'say six', 'say seven', 'say eight', 'say nine', 'say ten', 'say eleven', 'say twelve'])
    assert.deepEqual(recent.entries.slice(-2).map((e) => [e.kind, e.text]), [['you', 'say twelve'], ['agent', 'ok']])
    const all = await backend.history(task.id, true)
    assert.equal(all.more, false)
    assert.equal(all.entries.filter((e) => e.kind === 'you').length, 12)
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
