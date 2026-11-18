// Hermes's own screen as a task: how Togle starts it, tells what it does from its window title, closes and opens it again, and lists
// the sessions Hermes keeps. A stand-in for the `hermes` program (fake-hermes-screen.mjs) behaves as Hermes 0.22 does on this
// computer; what it does is described at its top.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('hermes-screen')
const T = await import('./.build/togle.mjs')

const fake = path.join(import.meta.dirname, 'fake-hermes-screen.mjs')
const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-hermes-'))
  made.push(dir)
  return dir
}
after(() => {
  // A screen's console can hold its folder for a while after the screen ended: a folder that stays is only left in the temporary folder.
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    } catch {
      // Left for the system's own cleaning.
    }
  }
})

const until = async (check, what, ms = 10_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const watch = (task) => {
  const events = []
  task.on((event) => events.push(event))
  return events
}
const strip = (text) => text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

/** Hermes as the tests have it: a backend over the stand-in, its sessions' folder (`home`), what its screens printed and were started with. */
function hermes(options = {}) {
  const home = options.home ?? scratch()
  const chunks = []
  const args = path.join(home, 'args.jsonl')
  const backend = new T.HermesBackend({
    command: [process.execPath, fake],
    env: { ...process.env, FAKE_HERMES_HOME: home, FAKE_HERMES_ARGS: args, ...(options.env ?? {}) },
    told: (chunk) => chunks.push(chunk),
    findMs: 80,
    cacheMs: 0,
    ...(options.backend ?? {})
  })
  const text = (task) => strip(chunks.filter((chunk) => chunk.key === `hermes:${task.id}`).map((chunk) => chunk.data).join('')).replace(/\s+/g, ' ')
  const started = () => (existsSync(args) ? readFileSync(args, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
  return Object.assign(backend, { home, chunks, text, started })
}
const sessions = (home) => JSON.parse(readFileSync(path.join(home, 'sessions.json'), 'utf8'))
const seed = (home, rows) => writeFileSync(path.join(home, 'sessions.json'), JSON.stringify(rows))

// ---- Reading what Hermes prints ----

test('the list Hermes prints is read by where its columns start, whatever its rows hold', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  const sample = [
    'Title                        Workspace          Last Active   ID',
    '──────────────────────────────────────────────────────────────────────────────────────────────────────────────',
    'try now                      togle              4h ago        local-3fe4873ce7d7cf6841b34d1c163d334d1ef9812d1b91f04199044225d3c773e4',
    'Check betterstack.com and    —                  6d ago        20261026_173644_da0707',
    'Fix  the  spaces             site               just now      local-abc',
    'gera-pane-watch · Aug 26 0   —                  2026-08-26    cron_a1cb678bcafa_20260826_090957',
    '  … more not shown (use --limit 8 to see more)'
  ].join('\n')
  const rows = T.parseSessionList(sample, now)
  assert.deepEqual(rows.map((row) => row.id), ['local-3fe4873ce7d7cf6841b34d1c163d334d1ef9812d1b91f04199044225d3c773e4', '20261026_173644_da0707', 'local-abc', 'cron_a1cb678bcafa_20260826_090957'])
  assert.deepEqual(rows.map((row) => row.title), ['try now', 'Check betterstack.com and', 'Fix  the  spaces', 'gera-pane-watch · Aug 26 0'])
  assert.deepEqual(rows.map((row) => row.workspace), ['togle', '', 'site', ''], 'a dash is no folder')
  assert.equal(rows[0].updatedAt, now - 4 * 3_600_000)
  assert.equal(rows[1].updatedAt, now - 6 * 86_400_000)
  assert.equal(rows[2].updatedAt, now)
  assert.equal(rows[3].updatedAt, Date.parse('2026-08-26'))
  assert.deepEqual(T.parseSessionList('No sessions found.'), [])
  assert.deepEqual(T.parseSessionList(''), [])
})

test('the list is read in each of the four tables Hermes prints, and an emoji in a title moves no column', () => {
  const now = Date.parse('2026-11-13T12:00:00Z')
  // Hermes pads a column by characters, not by UTF-16 units: so does this.
  const cell = (text, width) => text + ' '.repeat(Math.max(0, width - Array.from(text).length))
  const table = (columns, rows) => [columns.map(([name, width]) => cell(name, width)).join(' ').trimEnd(), '─'.repeat(100), ...rows.map((row) => columns.map(([, width], at) => cell(row[at], width)).join(' ').trimEnd())].join('\n')
  const summary = (text) => T.parseSessionList(text, now).map((row) => [row.id, row.title, row.workspace])

  // Some session has a title and some has a folder.
  const both = table([['Title', 28], ['Workspace', 18], ['Last Active', 13], ['ID', 0]], [['🚀 Launch plan', 'site', '3h ago', 'local-aaa'], ['Plain', '—', 'just now', 'local-bbb']])
  assert.deepEqual(summary(both), [['local-aaa', '🚀 Launch plan', 'site'], ['local-bbb', 'Plain', '']])
  assert.equal(T.parseSessionList(both, now)[0].updatedAt, now - 3 * 3_600_000, 'the time is not moved by the emoji either')

  // Some session has a title and none has a folder: a session that failed its first turn can be all there is.
  const noFolder = table([['Title', 32], ['Preview', 40], ['Last Active', 13], ['ID', 0]], [['togle-1a2b3c4d', 'Reply with only the word ok.', 'just now', 'local-ccc'], ['Fix the redirect', 'Fix the redirect in the router', '2d ago', 'local-ddd']])
  assert.deepEqual(summary(noFolder), [['local-ccc', 'togle-1a2b3c4d', ''], ['local-ddd', 'Fix the redirect', '']])
  assert.deepEqual(T.parseSessionList(noFolder, now).map((row) => row.preview), ['Reply with only the word ok.', 'Fix the redirect in the router'], 'with titles, the start of the first message is kept too')

  // No session has a title: the first column is the start of the first message.
  const noTitle = table([['Preview', 38], ['Workspace', 18], ['Last Active', 13], ['Src', 16], ['ID', 0]], [['Start of a message', 'site', '1h ago', 'cli', 'local-eee']])
  assert.deepEqual(summary(noTitle), [['local-eee', 'Start of a message', 'site']])
  assert.equal(T.parseSessionList(noTitle, now)[0].preview, undefined, 'with no titles, the first column is that start already')
  assert.equal(T.parseSessionList(noTitle, now)[0].updatedAt, now - 3_600_000)
  const bare = table([['Preview', 50], ['Last Active', 13], ['Src', 16], ['ID', 0]], [['What is the time', '5m ago', 'telegram', 'local-fff']])
  assert.deepEqual(summary(bare), [['local-fff', 'What is the time', '']])
  assert.equal(T.parseSessionList(bare, now)[0].updatedAt, now - 5 * 60_000)
})

test('a window title tells whether the screen works, waits for the person, or is idle', () => {
  assert.equal(T.markerOf('⏳ togle-1234 · claude-sonnet-5 · …\\work'), 'busy')
  assert.equal(T.markerOf('⚠ model · folder'), 'waiting')
  assert.equal(T.markerOf('✓ model · folder'), 'idle')
  assert.equal(T.markerOf('Hermes'), undefined, 'the titles before the first marker say nothing')
  assert.equal(T.markerOf('C:\\Users\\x\\hermes.exe'), undefined)
})

// ---- A task ----

test('a task starts as Hermes\u2019s own screen with its words in, works, ends, and the session is named as the person\u2019s words', { timeout: 30_000 }, async () => {
  const dir = scratch()
  const backend = hermes()
  try {
    const task = await backend.start({ folder: dir, prompt: 'say ok', title: 'Fix the redirect' })
    const events = watch(task)
    assert.match(task.id, /^togle-[0-9a-f]{8}$/, 'known by the name it was started with until Hermes gives its own id')
    assert.equal(task.runner, 'hermes')
    assert.equal(task.screen.open, true, 'its screen is open')
    assert.equal(task.state, 'working', 'a task started with words works from the start')
    await until(() => backend.started().length === 1, 'the screen to start')
    assert.deepEqual(backend.started()[0], ['chat', '--tui', '--query=say ok', '--in', dir, '-c', task.id, '--create-if-missing'], 'no flag of Togle\u2019s own: Hermes follows the person\u2019s settings')
    await until(() => backend.text(task).includes(`HERMES SCREEN ${task.id}`), 'the screen to print')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'completed', error: null })
    assert.equal(task.state, 'idle')
    // Hermes's list shows the session once it has a message: its id is taken, and it is named as the words.
    await until(() => task.screen.job.startsWith('local-'), 'the session to be found')
    assert.equal(sessions(backend.home)[0].title, 'Fix the redirect')
    assert.equal(task.screen.line, `hermes --resume ${task.screen.job}`)
    const listed = await backend.list()
    assert.equal(listed.filter((row) => row.id === task.id || row.id === task.screen.job).length, 1, 'a session a task runs is one row, not two')
    assert.equal(listed.find((row) => row.id === task.id).job, task.screen.job)
  } finally {
    await backend.close()
  }
})

test('words with quotes, line breaks and a path reach Hermes as one argument, as they were written', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const words = 'Fix "the redirect" in C:\\Users\\Someone\\my site\\app.ts\n\nA call is saved at "C:\\calls\\one two\\call.md". Use it as information.'
    const task = await backend.start({ folder: scratch(), prompt: words, title: 'Quotes' })
    await until(() => backend.started().length === 1, 'the screen to start')
    assert.equal(backend.started()[0][2], `--query=${words}`, 'one argument, whole')
    assert.equal(backend.started()[0].length, 8, 'and nothing was split into more')
    await task.screen.hide()
  } finally {
    await backend.close()
  }
})

test('a screen that waits on the person says so, and the task goes on once it is answered on the screen', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'ask' })
    await until(() => task.state === 'waiting', 'the task to wait')
    assert.equal(task.waitingFor, 'approval or an answer')
    assert.equal(task.pending.length, 0, 'Togle has no request of its own: it is answered on the screen')
    task.terminal.write('y\r')
    await until(() => task.state === 'idle', 'the task to go on and end')
    assert.equal(task.waitingFor, undefined)
    // The window title (which says it is idle) can reach Togle before the last words the screen printed.
    await until(() => /allowed/.test(backend.text(task)), 'what it printed once it was answered')
  } finally {
    await backend.close()
  }
})

test('Stop is Ctrl+C on the screen, and what it ends is the turn', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'sleep' })
    const events = watch(task)
    await until(() => backend.text(task).includes('sleeping'), 'the turn to be at work on the screen')
    await task.stop()
    assert.equal(task.state, 'stopped')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'interrupted', error: null })
    await until(() => /interrupted/.test(backend.text(task)), 'what the screen printed as it was interrupted')
    assert.equal(await task.endCommands(), 0, 'Hermes ends the command with the turn: nothing is left for a second press')
  } finally {
    await backend.close()
  }
})

test('a reply from the cards view opens a closed screen out of sight and is typed in with Enter once the turn has ended', { timeout: 40_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'say ok' })
    const events = watch(task)
    await until(() => events.some((e) => e.type === 'turn-ended') && task.screen.job.startsWith('local-'), 'the first turn to end, and its session to be found')
    await task.screen.hide()
    assert.equal(task.terminal, undefined, 'its screen is closed')
    await task.send('say again')
    assert.equal(task.screen.open, true, 'the reply opened the screen')
    assert.equal(task.state, 'working', 'it works from the reply, before its screen says so')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the second turn to end')
    assert.equal(task.state, 'idle')
    assert.match(backend.text(task), /RESUMED/, 'it was the session opened again, not a new one')
    // On a screen that is already open it is typed in at once.
    await task.send('say a third time')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 3, 'the third turn to end')
  } finally {
    await backend.close()
  }
})

test('a reply Hermes did not take at the first Enter is pressed again, and one it never takes is told in words', { timeout: 40_000 }, async () => {
  const slow = hermes({ env: { FAKE_HERMES_FIRST_ENTER_IGNORED: '1' }, backend: { takeMs: 400 } })
  try {
    const task = await slow.start({ folder: scratch(), prompt: 'say ok' })
    const events = watch(task)
    await until(() => events.some((e) => e.type === 'turn-ended') && task.screen.job.startsWith('local-'), 'the first turn to end')
    await task.send('say again')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the second turn to end: the Enter was pressed again')
  } finally {
    await slow.close()
  }
  const deaf = hermes({ env: { FAKE_HERMES_DEAF: '1' }, backend: { takeMs: 150 } })
  try {
    const task = await deaf.start({ folder: scratch(), prompt: 'say ok' })
    const events = watch(task)
    await until(() => events.some((e) => e.type === 'turn-ended') && task.screen.job.startsWith('local-'), 'the first turn to end')
    await assert.rejects(() => task.send('say again'), /Hermes did not take the reply\. Its words are on its screen/)
    assert.equal(task.state, 'idle', 'it is not shown as working for a turn that did not begin')
    assert.equal(events.filter((e) => e.type === 'turn-ended').length, 1)
  } finally {
    await deaf.close()
  }
})

test('a reply is refused while the agent works or waits, and when it is a command of the agent’s own', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'sleep' })
    await until(() => backend.text(task).includes('sleeping'), 'the turn to be at work')
    await assert.rejects(() => task.send('hello'), /Reply when it has finished/)
    await task.stop()
    await until(() => task.state === 'stopped', 'the turn to end')
    await assert.rejects(() => task.send('/model'), /command is typed on the agent/)
    await assert.rejects(() => task.send('!ls'), /command is typed on the agent/)
    const asking = await backend.start({ folder: scratch(), prompt: 'ask' })
    await until(() => asking.state === 'waiting', 'the second task to wait')
    await assert.rejects(() => asking.send('y'), /Reply when it has finished/, 'a line typed then would answer its question')
  } finally {
    await backend.close()
  }
})

test('a turn that fails at once leaves the task idle, the screen says what Hermes said, and the session Hermes kept with no folder is found and named', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'fail' })
    await until(() => task.state === 'idle' && backend.text(task).includes('Your request was not processed'), 'the failure to show')
    // Hermes lists the session of a first turn that failed with no folder: it is found by its name all the same.
    await until(() => task.screen.job.startsWith('local-'), 'the session to be found')
    const kept = sessions(backend.home)
    assert.equal(kept.length, 1)
    assert.equal(kept[0].workspace, '', 'the stand-in lists it with no folder, as Hermes does')
    assert.equal(kept[0].title, 'fail', 'named as the words, so that no name of Togle’s own is left in Hermes’s list')
    const listed = await backend.list()
    assert.equal(listed.filter((row) => row.id === task.id || row.id === task.screen.job).length, 1, 'one row for the task, not a second one for Hermes’s own')
  } finally {
    await backend.close()
  }
})

test('a name Hermes already has is tried again with a number, so that no name of Togle’s own is left in its list', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const first = await backend.start({ folder: scratch(), prompt: 'say ok', title: 'Same words' })
    await until(() => first.screen.job.startsWith('local-'), 'the first session to be found')
    const second = await backend.start({ folder: scratch(), prompt: 'say ok', title: 'Same words' })
    await until(() => second.screen.job.startsWith('local-'), 'the second session to be found')
    assert.deepEqual(sessions(backend.home).map((row) => row.title).sort(), ['Same words', 'Same words #2'])
  } finally {
    await backend.close()
  }
})

test('a task Togle started is listed under the name it was started with after Togle starts again, and that name opens its session', { timeout: 30_000 }, async () => {
  const home = scratch()
  const keep = scratch()
  const first = hermes({ home, backend: { keep } })
  let name
  let session
  try {
    const task = await first.start({ folder: scratch(), prompt: 'say ok', title: 'Fix the redirect' })
    name = task.id
    await until(() => task.screen.job.startsWith('local-'), 'the session to be found')
    session = task.screen.job
  } finally {
    await first.close()
  }
  // A new Togle: a new backend over the same sessions and the same folder of its own.
  const second = hermes({ home, backend: { keep } })
  try {
    const listed = await second.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, name, 'the key a to-do line holds is the one the task had when it was started')
    assert.equal(listed[0].title, 'Fix the redirect')
    const task = await second.resume(name)
    assert.equal(task.id, name)
    assert.equal(task.screen.job, session, 'the name opens the session Hermes gave it')
    await until(() => second.started().length === 2, 'the second screen to start')
    assert.deepEqual(second.started().at(-1), ['--tui', '--resume', session])
  } finally {
    await second.close()
  }
  // Without a folder of its own to keep names in, the session is listed under the id Hermes gave it.
  const third = hermes({ home })
  try {
    assert.equal((await third.list())[0].id, session)
  } finally {
    await third.close()
  }
})

// ---- The screen ----

test('the screen can be closed and opened again: the session goes on, and is opened by the id Hermes gave it', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'say ok' })
    await until(() => task.screen.job.startsWith('local-'), 'the session to be found')
    const first = task.screen.screenId
    await task.screen.hide()
    assert.equal(task.screen.open, false)
    assert.equal(task.terminal, undefined)
    assert.equal(task.state, 'idle', 'what the session does after that is not told')
    assert.ok((await backend.list()).some((row) => row.id === task.id), 'the task is still listed')
    await task.screen.show()
    assert.equal(task.screen.open, true)
    assert.notEqual(task.screen.screenId, first)
    await until(() => backend.started().length === 2, 'the second screen to start')
    assert.deepEqual(backend.started().at(-1), ['--tui', '--resume', task.screen.job], 'a later screen resumes the session')
    await until(() => backend.text(task).includes(`RESUMED ${task.screen.job}`), 'the screen to resume')
    task.terminal.write('/exit\r')
    await until(() => task.screen.open === false, 'the screen to end when its program does')
    assert.equal(task.screen.closed, undefined, 'a screen the person left says nothing of itself')
  } finally {
    await backend.close()
  }
})

test('a session another window holds is refused in Hermes\u2019s words, and the screen says why it closed', { timeout: 30_000 }, async () => {
  const home = scratch()
  seed(home, [{ id: 'local-held', title: 'Held', workspace: 'site', source: 'local', updatedAt: Date.now() }])
  const backend = hermes({ home, env: { FAKE_HERMES_HELD: '1' } })
  try {
    const task = await backend.resume('local-held', { folder: scratch() })
    await until(() => task.screen.closed, 'the reason the screen closed')
    assert.match(task.screen.closed, /open in another Hermes window/)
    assert.equal(task.screen.open, false)
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

test('opening a session that is listed resumes it by its id, and one Togle runs already is shown, not opened twice', { timeout: 30_000 }, async () => {
  const home = scratch()
  seed(home, [{ id: 'local-old', title: 'An older session', workspace: 'site', source: 'local', updatedAt: Date.now() - 3 * 3_600_000 }])
  const backend = hermes({ home })
  try {
    const task = await backend.resume('local-old')
    assert.equal(task.id, 'local-old')
    assert.equal(task.title, 'An older session')
    assert.equal(task.screen.job, 'local-old')
    await until(() => backend.text(task).includes('RESUMED local-old'), 'the screen to resume')
    assert.deepEqual(backend.started()[0], ['--tui', '--resume', 'local-old'], 'no folder is given: Hermes goes back to the one the session had')
    await task.screen.hide()
    assert.equal(await backend.resume('local-old'), task, 'the same task, its screen opened again')
    assert.equal(task.screen.open, true)
    await until(() => backend.started().length === 2, 'the second screen to start')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(backend.started().length, 2, 'one screen for each time it was opened, no more')
  } finally {
    await backend.close()
  }
})

test('two quick opens of one session make one task and one screen', { timeout: 30_000 }, async () => {
  const home = scratch()
  seed(home, [{ id: 'local-once', title: 'Once', workspace: 'site', source: 'local', updatedAt: Date.now() - 3_600_000 }])
  const backend = hermes({ home })
  try {
    const [first, second] = await Promise.all([backend.resume('local-once'), backend.resume('local-once')])
    assert.equal(first, second, 'the same task')
    await until(() => backend.started().length >= 1, 'the screen to start')
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(backend.started().length, 1, 'one screen')
  } finally {
    await backend.close()
  }
})

// ---- What Hermes lists ----

test('the list is Hermes\u2019s own, from terminals and screens and not from its other platforms, newest first', { timeout: 30_000 }, async () => {
  const home = scratch()
  const now = Date.now()
  seed(home, [
    { id: 'local-a', title: 'From a screen', workspace: 'site', source: 'local', updatedAt: now - 3_600_000 },
    { id: '20261026_173644_da0707', title: 'From the classic terminal', workspace: '', source: 'cli', updatedAt: now - 5 * 86_400_000 },
    { id: 'cron_1', title: 'A scheduled job', workspace: '', source: 'cron', updatedAt: now - 60_000 }
  ])
  const backend = hermes({ home })
  try {
    const rows = await backend.list()
    assert.deepEqual(rows.map((row) => row.id), ['local-a', '20261026_173644_da0707'], 'the scheduled job is not a task of the person\u2019s')
    assert.deepEqual(rows.map((row) => row.title), ['From a screen', 'From the classic terminal'])
    assert.ok(rows.every((row) => row.runner === 'hermes' && row.state === 'idle' && !row.job))
    assert.ok(Math.abs(rows[0].updatedAt - (now - 3_600_000)) < 120_000)
  } finally {
    await backend.close()
  }
})

test('a program that cannot list says nothing, and one that is not there cannot be started', { timeout: 30_000 }, async () => {
  const missing = new T.HermesBackend({ command: [path.join(os.tmpdir(), 'no-such-hermes-program')], told: () => undefined })
  assert.deepEqual(await missing.list(), [])
  await assert.rejects(missing.start({ folder: os.tmpdir(), prompt: 'say ok' }))
  const found = await new T.HermesBackend({ command: [process.execPath, fake], told: () => undefined }).detect()
  assert.deepEqual({ installed: found.installed, version: found.version }, { installed: true, version: 'Hermes Agent v0.0.0-fake' })
})

test('what could be read as a flag is not handed to Hermes, and words too long for a command line are refused', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    await assert.rejects(backend.resume('--yolo'), /not a session Hermes knows/)
    await assert.rejects(backend.resume('x y'), /not a session Hermes knows/)
    await assert.rejects(backend.start({ folder: scratch(), prompt: 'x'.repeat(20_001) }), /too long/)
    assert.deepEqual(backend.started(), [], 'nothing was started')
  } finally {
    await backend.close()
  }
})

test('closing Hermes closes its screens and leaves the sessions where they are', { timeout: 30_000 }, async () => {
  const backend = hermes()
  const task = await backend.start({ folder: scratch(), prompt: 'say ok' })
  await until(() => task.screen.job.startsWith('local-'), 'the session to be found')
  const events = watch(task)
  await backend.close()
  assert.equal(task.screen.open, false)
  assert.ok(events.some((e) => e.type === 'ended' && e.reason === 'closed'))
  assert.equal(sessions(backend.home).length, 1, 'the session is Hermes\u2019s, and stays')
  await assert.rejects(backend.start({ folder: scratch(), prompt: 'say ok' }), /closed/)
})
