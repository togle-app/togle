import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('runners')
const T = await import('./.build/togle.mjs')
const fake = path.join(import.meta.dirname, 'fake-codex.mjs')

// The folders the tests work in, taken away when they are done.
const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-runners-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (check, what, ms = 8000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const watch = (task) => {
  const events = []
  task.on((event) => events.push(event))
  return events
}
const codex = (env = {}) => new T.CodexBackend({ command: [process.execPath, fake], env: { ...process.env, ...env } })

// ---- reading a shell command ----

test('a command wrapped by PowerShell, bash or cmd is read as the script it runs', () => {
  assert.equal(T.unwrapShell(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Set-Content -Path a.txt -Value x'`), 'Set-Content -Path a.txt -Value x')
  assert.equal(T.unwrapShell(`powershell.exe -NoProfile -Command "Get-ChildItem -Force"`), 'Get-ChildItem -Force')
  assert.equal(T.unwrapShell(`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -Command 'Write-Output ''hi'''`), `Write-Output 'hi'`)
  assert.equal(T.unwrapShell(`/bin/bash -lc "npm test && echo done"`), 'npm test && echo done')
  assert.equal(T.unwrapShell(`bash -c 'git status'`), 'git status')
  assert.equal(T.unwrapShell(`cmd.exe /c dir /b`), 'dir /b')
  assert.equal(T.unwrapShell('  git status  '), 'git status', 'a command that is not wrapped is only trimmed')
  assert.equal(T.unwrapShell(''), '')
})

// ---- finding what an agent started ----

const table = [
  { pid: 1, ppid: 0, command: 'system' },
  { pid: 10, ppid: 1, command: 'codex app-server' },
  { pid: 11, ppid: 10, command: 'powershell -Command Start-Sleep -Seconds 45; Set-Content a.txt' },
  { pid: 12, ppid: 11, command: 'conhost Start-Sleep -Seconds 45; Set-Content a.txt' },
  { pid: 13, ppid: 10, command: 'codex-command-runner' },
  { pid: 20, ppid: 1, command: 'powershell -Command Start-Sleep -Seconds 45; Set-Content a.txt' }
]
test('what an agent started is found below it, and a command by the words it was started with', () => {
  assert.deepEqual(T.descendantsOf(table, 10).map((p) => p.pid).sort((a, b) => a - b), [11, 12, 13])
  assert.deepEqual(T.matching(table, 10, 'Start-Sleep -Seconds 45').map((p) => p.pid), [11], 'only the outermost; what it started goes down with it')
  assert.deepEqual(T.matching(table, 10, 'no such command'), [])
  assert.deepEqual(T.matching(table, 10, '  '), [], 'an empty search finds nothing, so it can never end everything')
  assert.deepEqual(T.matching(table, 999, 'Start-Sleep'), [], 'a program that is not running has nothing below it')
})

test('the real process list holds this test and its parent, and a program and what it started can be ended', { timeout: 60_000 }, async () => {
  const all = await T.listProcesses()
  const me = all.find((p) => p.pid === process.pid)
  assert.ok(me, 'this process is listed')
  assert.ok(me.ppid > 0)
  const marker = `togle-test-${Date.now()}`
  const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) /* ${marker} */`], { stdio: 'ignore', windowsHide: true })
  try {
    await until(async () => T.matching(await T.listProcesses(), process.pid, marker).length === 1, 'the child to be found by its command line')
    assert.equal(await T.endCommandsMatching(process.pid, marker), 1)
    await until(() => !alive(child.pid), 'the child to end')
    assert.equal(await T.endCommandsMatching(process.pid, marker), 0, 'nothing is left to end')
  } finally {
    child.kill()
  }
})

// ---- Codex ----

test('Codex starts a task with its own approval policy, names it, and answers a plain turn', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    assert.deepEqual(await backend.detect().then((d) => d.installed), true)
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'say ok', title: 'Port the settings screen', asks: true })
    const events = watch(task)
    assert.equal(task.runner, 'codex')
    assert.ok(task.id)
    assert.equal(task.title, 'Port the settings screen')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ok'])
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

test('a turn that ends before the answer to starting it is read leaves the task done, not working', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'quick', asks: true })
    const events = watch(task)
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(task.state, 'idle')
    await task.send('say ok')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the next turn to end')
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

test('a command waits as a request, shows its script, and runs once allowed', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'run note', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.kind, 'command')
    assert.equal(request.command, 'Set-Content -Path note.txt -Value x', 'read as the script, not the PowerShell wrapping')
    assert.match(request.raw, /powershell\.exe" -Command '/)
    assert.equal(request.offersAlways, true)
    assert.equal(task.state, 'waiting')
    task.answer(request.id, 'allow-once')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.status), ['started', 'finished'])
    assert.deepEqual(events.find((e) => e.type === 'request-ended'), { type: 'request-ended', id: request.id, outcome: 'allowed' })
    assert.equal(task.pending.length, 0)
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

test('always, for Codex, keeps the rule it proposed: the button says what commands it covers', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'run note', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.always, 'Always allow commands that start with Set-Content')
    task.answer(request.id, 'allow-always')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['kept the rule Set-Content'], 'Codex got the rule it proposed, as it proposed it')
    assert.deepEqual(events.find((e) => e.type === 'request-ended'), { type: 'request-ended', id: request.id, outcome: 'always' })
  } finally {
    await backend.close()
  }
})

test('a refused command is declined and the agent goes on', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'run other', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    task.answer(request.id, 'refuse')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.status), ['started', 'declined'])
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['it was refused'])
  } finally {
    await backend.close()
  }
})

test('an answer is taken once, and a question is not answered with Allow', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'ask', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the question to wait')
    assert.equal(request.kind, 'question')
    assert.deepEqual(request.questions, [{ id: 'which', text: 'Which pricing table?', options: ['Two plans'], free: true, secret: false }])
    task.answer(request.id, 'allow-once')
    assert.equal(task.pending.length, 1, 'Allow does not answer a question')
    task.reply(request.id, 'the one with three plans')
    task.reply(request.id, 'again')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['you said the one with three plans'])
    assert.equal(events.filter((e) => e.type === 'request-ended').length, 1, 'the second answer does nothing')
  } finally {
    await backend.close()
  }
})

test('an edit waits with the files it changes', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'edit page', asks: true })
    const request = await until(() => task.pending[0], 'the edit to wait')
    assert.equal(request.kind, 'edit')
    assert.equal(request.files.length, 1)
    assert.match(request.files[0], /page\.txt$/)
    assert.equal(request.offersAlways, false)
    task.answer(request.id, 'refuse')
    await until(() => task.pending.length === 0, 'the edit to be answered')
  } finally {
    await backend.close()
  }
})

test('Stop ends the turn and refuses what waits, and the command already running needs a second press', { timeout: 60_000 }, async () => {
  const dir = scratch()
  const pidFile = path.join(dir, 'pid')
  const backend = codex({ FAKE_PID_FILE: pidFile })
  try {
    const task = await backend.start({ folder: dir, prompt: 'sleep', asks: true })
    const events = watch(task)
    const childPid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the long command to start'))
    await until(() => task.state === 'working', 'the task to work')
    assert.ok(alive(childPid))
    await task.stop()
    assert.equal(task.state, 'stopped')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'interrupted', error: null })
    assert.ok(alive(childPid), 'the first press leaves the running command alone, as Codex does')
    assert.equal(await task.endCommands(), 1, 'the second press finds the command by what it was started with')
    await until(() => !alive(childPid), 'the command to end')
    assert.equal(task.state, 'stopped', 'a stopped task stays stopped when its status settles')
    assert.equal(await task.endCommands(), 0)
  } finally {
    await backend.close()
  }
})

test('Stop with a request open refuses it, so the agent cannot be answered afterwards', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'run late', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    await task.stop()
    assert.equal(task.pending.length, 0)
    assert.deepEqual(events.find((e) => e.type === 'request-ended'), { type: 'request-ended', id: request.id, outcome: 'cancelled' })
    task.answer(request.id, 'allow-once')
    assert.ok(!events.some((e) => e.type === 'command' && e.status === 'finished'), 'a late Allow runs nothing')
  } finally {
    await backend.close()
  }
})

test('a task that was started earlier is listed and picked up again, and a reply continues it', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const listed = await backend.list()
    const old = listed.find((t) => t.id === 'old1')
    assert.deepEqual({ ...old, updatedAt: undefined }, { id: 'old1', runner: 'codex', title: 'Fix the login redirect', folder: 'C:\\work\\site', state: 'idle', updatedAt: undefined })
    assert.equal(old.updatedAt, 1793852778 * 1000)
    const task = await backend.resume('old1', { asks: true })
    assert.equal(task.id, 'old1')
    assert.equal(task.title, 'Fix the login redirect')
    const events = watch(task)
    await task.send('say ok')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.equal((await backend.list()).find((t) => t.id === 'old1').state, 'idle')
    await task.close()
    assert.ok(events.some((e) => e.type === 'ended' && e.reason === 'closed'))
  } finally {
    await backend.close()
  }
})

test('when the agent program ends, its tasks fail and what they waited for is cancelled', { timeout: 30_000 }, async () => {
  const backend = codex()
  const task = await backend.start({ folder: os.tmpdir(), prompt: 'run gone', asks: true })
  const events = watch(task)
  await until(() => task.pending[0], 'the command to wait')
  await backend.close()
  await until(() => task.state === 'failed', 'the task to fail', 10_000)
  assert.equal(task.pending.length, 0)
  assert.ok(events.some((e) => e.type === 'ended' && e.reason === 'crashed'))
})

// ---- Hermes ----

const fakeHermes = path.join(import.meta.dirname, 'fake-hermes.mjs')
const hermes = (env = {}, options = {}) => new T.HermesBackend({ command: [process.execPath, fakeHermes], env: { ...process.env, ...env }, ...options })
const callsOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

test('Hermes starts a task, keeps the name given, asks in its asking mode, and ends the turn by what it said', { timeout: 30_000 }, async () => {
  const calls = path.join(scratch(), 'calls.jsonl')
  const backend = hermes({ FAKE_CALLS: calls }, { model: 'openai-codex:gpt-6.1-sol' })
  try {
    assert.deepEqual(await backend.detect(), { installed: true, command: process.execPath, version: 'Hermes Agent v0.0.0-fake' })
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'say ok', title: 'Port the settings screen', asks: true })
    const events = watch(task)
    assert.equal(task.runner, 'hermes')
    assert.equal(task.id, 's1')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ok'], 'the pieces of what it said are one message')
    assert.equal(task.title, 'Port the settings screen', 'the name Hermes gives a session does not replace the one chosen')
    assert.equal(task.state, 'idle')
    const made = callsOf(calls)
    assert.deepEqual(made.map((c) => c.method), ['session/new', 'session/set_model', 'session/set_mode'])
    assert.deepEqual([made[1].modelId, made[2].modeId], ['openai-codex:gpt-6.1-sol', 'default'])
    await task.send('say ok')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the next turn to end')
    // What it offers for the reply box: the commands it told as news of the session, and the models that came with it.
    await until(() => task.offers().commands.length, 'the commands it told')
    assert.deepEqual(task.offers(), {
      commands: [
        { name: 'model', description: 'Show current model and provider, or switch models', hint: 'model name to switch to' },
        { name: 'version', description: 'Show Hermes version' }
      ],
      models: [
        { id: 'openai-codex:gpt-6.1-sol', name: 'gpt-6.1-sol', description: '' },
        { id: 'openrouter:kimi-k3', name: 'kimi-k3', description: 'A second one' }
      ]
    })
  } finally {
    await backend.close()
  }
})

test('a model picked from the list Hermes gave is switched to as ACP has it, and Hermes then says which model it is on', { timeout: 30_000 }, async () => {
  const calls = path.join(scratch(), 'calls.jsonl')
  const backend = hermes({ FAKE_CALLS: calls })
  try {
    const task = await backend.start({ folder: os.tmpdir(), prompt: 'say ok', asks: true })
    const events = watch(task)
    const ended = () => events.filter((e) => e.type === 'turn-ended')
    const said = () => events.filter((e) => e.type === 'message').map((e) => e.text)
    const switched = () => callsOf(calls).filter((c) => c.method === 'session/set_model').map((c) => c.modelId)
    await until(() => ended().length === 1, 'the first turn to end')
    await until(() => task.offers().commands.length, 'the commands it told')
    // An id from its list: sent as words, Hermes would take all of it for a model's name and keep its provider.
    await task.send('/model openai-codex:gpt-6.1-sol')
    await until(() => ended().length === 2, 'the switch to end')
    assert.deepEqual(switched(), ['openai-codex:gpt-6.1-sol'], 'the protocol’s own switch')
    assert.equal(said().at(-1), 'Current model: gpt-6.1-sol\nProvider: openai-codex', 'and its own words for where it is now')
    assert.equal(task.state, 'idle')
    // A model the agent refuses: the turn ends with its reason, and the task goes on.
    await task.send('/model openrouter:kimi-k3')
    await until(() => ended().length === 3, 'the refusal')
    assert.deepEqual([ended().at(-1).outcome, ended().at(-1).error], ['failed', 'Hermes did not switch to openrouter:kimi-k3: model resolution failed.'], 'which model, and the reason Hermes gave beside its bare error')
    assert.equal(task.state, 'idle')
    assert.equal(said().length, 2, 'nothing is said of a model it did not switch to')
    // Other words after "/model" are the agent's own to read, as they are.
    await task.send('/model some-other-name')
    await until(() => ended().length === 4, 'its own command to end')
    assert.equal(said().at(-1), 'Model switched to: some-other-name\nProvider: openai-codex')
    assert.equal(switched().length, 2, 'no switch of the protocol for words that are not a listed id')
    await task.send('say ok')
    await until(() => ended().length === 5, 'a reply after them')
    assert.equal(said().at(-1), 'ok')
  } finally {
    await backend.close()
  }
  // An agent that told no "/model" of its own is switched the same way, and asked nothing after: that would be a turn.
  const quiet = hermes({ FAKE_CALLS: calls, FAKE_NO_COMMANDS: '1' })
  try {
    const task = await quiet.start({ folder: os.tmpdir(), prompt: 'say ok', asks: true })
    const events = watch(task)
    const ended = () => events.filter((e) => e.type === 'turn-ended')
    await until(() => ended().length === 1, 'the first turn to end')
    assert.deepEqual(task.offers().commands, [])
    await task.send('/model openai-codex:gpt-6.1-sol')
    await until(() => ended().length === 2, 'the switch to end')
    assert.deepEqual([ended().at(-1).outcome, task.state], ['completed', 'idle'])
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ok'], 'no words were asked of it')
    assert.equal(callsOf(calls).filter((c) => c.method === 'session/set_model').length, 3)
  } finally {
    await quiet.close()
  }
})

test('a Hermes command waits as a request, and only allow once lets it run', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'run note', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.kind, 'command')
    assert.equal(request.command, 'echo x > note.txt')
    assert.equal(request.offersAlways, true)
    assert.equal(task.state, 'waiting')
    task.answer(request.id, 'allow-once')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.status), ['started', 'finished'])
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ran it'])

    await task.send('run other')
    const second = await until(() => task.pending[0], 'the second command to wait')
    task.answer(second.id, 'refuse')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the second turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.status), ['started', 'finished', 'started', 'declined'])
    assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'it was refused')
  } finally {
    await backend.close()
  }
})

test('an added agent speaks ACP as Hermes does, started by the command given, under its own name', { timeout: 30_000 }, async () => {
  const backend = T.addedBackend({ id: 'acp-fake', name: 'Fake Agent', command: `"${process.execPath}" "${fakeHermes}" acp` }, '9.9.9')
  try {
    assert.equal(backend.runner, 'acp-fake')
    assert.equal((await backend.detect()).installed, true)
    const task = await backend.start({ folder: scratch(), prompt: 'run note', asks: true })
    assert.equal(task.runner, 'acp-fake')
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.command, 'echo x > note.txt')
    assert.equal(request.always, 'Always allow (Fake Agent keeps it)', 'its own words, and its own name')
    task.answer(request.id, 'allow-once')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ran it'])
  } finally {
    await backend.close()
  }
  // A program that is not on this computer: not installed, and starting says so by name.
  const missing = T.addedBackend({ id: 'acp-gone', name: 'Gone', command: 'togle-no-such-agent-here --acp' }, '9.9.9')
  assert.equal((await missing.detect()).installed, false)
  await assert.rejects(missing.start({ folder: os.tmpdir(), prompt: 'x' }), /Gone is not installed on this computer/)
})

test('always, for Hermes, picks its own always option, in its own words', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'run note', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.always, 'Always allow (Hermes keeps it)')
    task.answer(request.id, 'allow-always')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ran it, and will not ask again'])
  } finally {
    await backend.close()
  }
})

test('a Hermes edit shows its file, and an ask with no way to allow once is refused, not widened', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'edit page' })
    const events = watch(task)
    const edit = await until(() => task.pending[0], 'the edit to wait')
    assert.equal(edit.kind, 'edit')
    assert.deepEqual(edit.files, ['C:\\work\\page.txt'])
    task.answer(edit.id, 'allow-once')
    await until(() => events.some((e) => e.type === 'files'), 'the edit to be reported')
    assert.deepEqual(events.find((e) => e.type === 'files'), { type: 'files', paths: ['C:\\work\\page.txt'] })
    await until(() => task.state === 'idle', 'the turn to end')

    await task.send('noonce')
    const ask = await until(() => task.pending[0], 'the ask to wait')
    task.answer(ask.id, 'allow-once')
    await until(() => task.state === 'idle', 'the turn to end')
    assert.ok(events.some((e) => e.type === 'error' && /no way to allow this once/.test(e.message)))
    assert.deepEqual(events.filter((e) => e.type === 'command' && e.status !== 'started').at(-1), { type: 'command', command: 'echo y', status: 'failed', exitCode: null }, 'it did not run')
  } finally {
    await backend.close()
  }
})

test('Hermes that never asks just runs, and the person sees what it did', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'free' })
    const events = watch(task)
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.equal(events.some((e) => e.type === 'request'), false)
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => [e.command, e.status]), [['dir', 'started'], ['dir', 'finished']])
  } finally {
    await backend.close()
  }
})

test('Stop cancels Hermes, which ends the running command itself, and a reply goes on in the same task', { timeout: 60_000 }, async () => {
  const dir = scratch()
  const pidFile = path.join(dir, 'pid')
  const backend = hermes({ FAKE_PID_FILE: pidFile })
  try {
    const task = await backend.start({ folder: dir, prompt: 'sleep' })
    const events = watch(task)
    const childPid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the command to start'))
    assert.ok(alive(childPid))
    await task.stop()
    assert.equal(task.state, 'stopped')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'interrupted', error: null })
    await until(() => !alive(childPid), 'the command to end')
    assert.equal(task.state, 'stopped')
    assert.equal(await task.endCommands(), 0)
    await task.send('say ok')
    await until(() => task.state === 'idle', 'the reply to be answered')
  } finally {
    await backend.close()
  }
})

test('Stop with a Hermes request open refuses it', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'run late' })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    await task.stop()
    assert.equal(task.pending.length, 0)
    assert.deepEqual(events.find((e) => e.type === 'request-ended'), { type: 'request-ended', id: request.id, outcome: 'cancelled' })
  } finally {
    await backend.close()
  }
})

test('a turn Hermes cannot finish says why in its own words', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'fail' })
    const events = watch(task)
    await until(() => task.state === 'idle', 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'error'), { type: 'error', message: 'The provider rejected the request.' })
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'failed', error: 'The provider rejected the request.', fault: 'Internal error' }, 'its words are shown; what its program answered is what tells signed out')
    await task.send('say ok')
    await until(() => events.some((e) => e.type === 'message' && e.text === 'ok'), 'the next turn to be answered')
  } finally {
    await backend.close()
  }
})

test('a Hermes session is picked up again, by resuming when Hermes can and by loading when it cannot, without replaying its past', { timeout: 30_000 }, async () => {
  for (const env of [{}, { FAKE_NO_RESUME: '1' }]) {
    const dir = scratch()
    const calls = path.join(dir, 'calls.jsonl')
    const backend = hermes({ FAKE_CALLS: calls, ...env })
    try {
      const task = await backend.resume('old-session', { folder: dir, asks: true })
      const events = watch(task)
      assert.equal(task.id, 'old-session')
      await task.send('say ok')
      await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
      assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ok'], 'what Hermes replays of the past is not news')
      assert.equal(events.some((e) => e.type === 'command'), false, 'neither are the commands it ran then')
      assert.equal(callsOf(calls)[0].method, env.FAKE_NO_RESUME ? 'session/load' : 'session/resume')
      assert.equal(callsOf(calls)[0].cwd, dir)
      assert.equal((await backend.resume('old-session', { folder: dir })).id, 'old-session', 'a task already picked up is the same one')
    } finally {
      await backend.close()
    }
  }
})

test('when Hermes ends under a task, the task fails; and one that cannot start fails the start', { timeout: 30_000 }, async () => {
  const backend = hermes()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'run gone' })
    const events = watch(task)
    await until(() => task.pending[0], 'the command to wait')
    process.kill(Number(await until(async () => (await T.listProcesses()).find((p) => p.command.includes('fake-hermes.mjs') && p.ppid === process.pid)?.pid, 'the program to be found')))
    await until(() => task.state === 'failed', 'the task to fail', 10_000)
    assert.equal(task.pending.length, 0)
    assert.ok(events.some((e) => e.type === 'ended' && e.reason === 'crashed'))
  } finally {
    await backend.close()
  }
  const missing = new T.HermesBackend({ command: [path.join(os.tmpdir(), 'no-such-hermes-program')] })
  await assert.rejects(missing.start({ folder: os.tmpdir(), prompt: 'say ok' }), /Hermes did not start/)
  assert.deepEqual(await missing.list(), [], 'what Hermes would not list is left to the hub\'s record')
})

test('someone who starts listening late hears what already happened, in order', { timeout: 30_000 }, async () => {
  const backend = codex()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'say ok' })
    const early = watch(task)
    await until(() => task.state === 'idle', 'the turn to end')
    const late = watch(task)
    assert.deepEqual(late.map((e) => e.type), early.map((e) => e.type), 'what is heard late is what was heard as it happened, in the same order')
    assert.ok(late.some((e) => e.type === 'message') && late.some((e) => e.type === 'turn-ended'), 'what was said, and the end of the turn')
    assert.deepEqual(late.filter((e) => e.type === 'state').map((e) => e.state), early.filter((e) => e.type === 'state').map((e) => e.state))
    await task.send('say ok')
    await until(() => late.filter((e) => e.type === 'turn-ended').length === 2, 'the next turn to end')
  } finally {
    await backend.close()
  }
})

test('a Codex program that will not start fails the start with a plain message, and a later start tries again', async () => {
  const backend = new T.CodexBackend({ command: [path.join(os.tmpdir(), 'no-such-codex-program')] })
  await assert.rejects(backend.start({ folder: os.tmpdir(), prompt: 'say ok' }), /Codex did not start/)
  await assert.rejects(backend.start({ folder: os.tmpdir(), prompt: 'say ok' }), /Codex did not start/, 'the failure is not remembered')
})
