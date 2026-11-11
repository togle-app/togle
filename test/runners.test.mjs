import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

// ---- Claude Code ----

const fakeClaude = path.join(import.meta.dirname, 'fake-claude.mjs')
const claude = (env = {}, options = {}) => new T.ClaudeBackend({ command: [process.execPath, fakeClaude], env: { ...process.env, ...env }, live: async () => [], stored: async () => [], ...options })

test('the hook server answers a task that Claude Code asks about, and only that task', { timeout: 30_000 }, async () => {
  const hooks = new T.HookServer()
  const seen = []
  const target = {
    permission: async (event, gone) => {
      seen.push({ event, gone })
      return event.tool_name === 'Bash' ? { behavior: 'allow' } : event.tool_name === 'Write' ? { behavior: 'deny', message: 'No.' } : null
    }
  }
  try {
    const { key, settings } = await hooks.attach(target, true)
    const config = JSON.parse(readFileSync(settings, 'utf8'))
    const url = config.hooks.PermissionRequest[0].hooks[0].url
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]{32}\/[0-9a-f]{16}\/permission$/)
    assert.equal(config.hooks.PermissionRequest[0].hooks[0].type, 'http')
    assert.deepEqual(config.permissions.ask, ['Bash', 'PowerShell', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'], 'with asks, every command and edit stops for the person')
    const post = (to, body = {}, method = 'POST') => fetch(to, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined })
    const allowed = await post(url, { tool_name: 'Bash', tool_input: { command: 'ls' } })
    assert.deepEqual(await allowed.json(), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
    const denied = await post(url, { tool_name: 'Write' })
    assert.deepEqual((await denied.json()).hookSpecificOutput.decision, { behavior: 'deny', message: 'No.' })
    const none = await post(url, { tool_name: 'Read' })
    assert.equal(none.status, 200)
    assert.equal(await none.text(), '', 'no decision leaves the choice to Claude Code')
    assert.equal((await post(url.replace(/\/hook\/[0-9a-f]{32}\//, '/hook/' + '0'.repeat(32) + '/'))).status, 404, 'a wrong secret is not heard')
    assert.equal((await post(url.replace(key, 'f'.repeat(16)))).status, 404, 'an unknown task is not heard')
    assert.equal((await post(url, {}, 'GET')).status, 404)
    assert.equal((await fetch(url, { method: 'POST', body: 'not json' })).status, 400)
    // The call ends when the caller goes away, and the task is told.
    seen.length = 0
    target.permission = async (event, gone) => {
      seen.push(gone)
      await new Promise((resolve) => gone.addEventListener('abort', resolve, { once: true }))
      return { behavior: 'allow' }
    }
    const pending = post(url, { tool_name: 'Bash' }).catch(() => null)
    await until(() => seen.length === 1, 'the request to arrive')
    await hooks.close()
    await pending
    await until(() => seen[0].aborted, 'the request to be told the caller went away')
  } finally {
    await hooks.close()
  }
})

test('after a task is detached its address and settings are gone', { timeout: 30_000 }, async () => {
  const hooks = new T.HookServer()
  try {
    const { key, settings } = await hooks.attach({ permission: async () => ({ behavior: 'allow' }) }, false)
    const url = JSON.parse(readFileSync(settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).permissions, undefined, 'without asks the person\'s own rules stand')
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 200)
    await hooks.detach(key, settings)
    assert.equal(existsSync(settings), false)
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 404)
  } finally {
    await hooks.close()
  }
})

test('Claude Code starts in the task folder with a hook of its own, and answers a plain turn', { timeout: 30_000 }, async () => {
  const dir = scratch()
  const argsFile = path.join(dir, 'args.json')
  const settingsCopy = path.join(dir, 'settings.json')
  const backend = claude({ FAKE_ARGS_FILE: argsFile, FAKE_SETTINGS_COPY: settingsCopy })
  try {
    assert.equal((await backend.detect()).installed, true)
    const task = await backend.start({ folder: dir, prompt: 'say ok', title: 'Port the settings screen', asks: true })
    const events = watch(task)
    assert.equal(task.runner, 'claude')
    assert.equal(task.title, 'Port the settings screen')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.ok(task.id?.startsWith('session-'), 'its session id comes from the first thing Claude Code says')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ok'])
    assert.equal(task.state, 'idle')
    const started = JSON.parse(readFileSync(argsFile, 'utf8'))
    assert.equal(path.resolve(started.cwd).toLowerCase(), path.resolve(dir).toLowerCase())
    for (const flag of ['-p', '--input-format', 'stream-json', '--output-format', '--verbose', '--permission-mode', 'default', '--settings', '--name', 'Port the settings screen']) assert.ok(started.argv.includes(flag), flag)
    assert.ok(!started.argv.includes('--resume'))
    assert.ok(JSON.parse(readFileSync(settingsCopy, 'utf8')).permissions.ask.includes('Bash'))
    await task.send('say ok')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'a reply to be answered')
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

test('a Claude Code command waits as a request, and what the person answers reaches the agent', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const dir = scratch()
    const task = await backend.start({ folder: dir, prompt: 'run note', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.kind, 'command')
    assert.equal(request.command, 'echo x > note.txt')
    assert.equal(request.offersAlways, true)
    assert.equal(task.state, 'waiting')
    task.answer(request.id, 'allow-once')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.status), ['started', 'finished'])
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['did it'])
    assert.equal(task.state, 'idle')

    await task.send('run other')
    const second = await until(() => task.pending[0], 'the second command to wait')
    task.answer(second.id, 'refuse')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the second turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'command').map((e) => e.status), ['started', 'finished', 'started', 'declined'])
    assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'it was refused', 'the agent was told, and went on')
  } finally {
    await backend.close()
  }
})

test('a Claude Code edit shows its file, and a question is answered in words', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const dir = scratch()
    const task = await backend.start({ folder: dir, prompt: 'edit page' })
    const edit = await until(() => task.pending[0], 'the edit to wait')
    assert.equal(edit.kind, 'edit')
    assert.match(edit.files[0], /page\.txt$/)
    task.answer(edit.id, 'refuse')
    await until(() => task.state === 'idle', 'the turn to end')

    const events = watch(task)
    await task.send('ask')
    const question = await until(() => task.pending[0], 'the question to wait')
    assert.equal(question.kind, 'question')
    assert.deepEqual(question.questions, [{ id: '0', text: 'Which pricing table?', options: ['Two plans'], free: true, secret: false }])
    task.answer(question.id, 'allow-once')
    assert.equal(task.pending.length, 1, 'Allow does not answer a question')
    task.reply(question.id, 'the one with three plans')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the second turn to end')
    assert.ok(events.some((e) => e.type === 'message' && e.text === 'you said the one with three plans'))
  } finally {
    await backend.close()
  }
})

test('Stop interrupts Claude Code, which ends the running command itself, and a reply then goes to the same task', { timeout: 60_000 }, async () => {
  const dir = scratch()
  const pidFile = path.join(dir, 'pid')
  const backend = claude({ FAKE_PID_FILE: pidFile })
  try {
    const task = await backend.start({ folder: dir, prompt: 'sleep', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    task.answer(request.id, 'allow-once')
    const childPid = Number(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8'), 'the command to start'))
    assert.ok(alive(childPid))
    await task.stop()
    assert.equal(task.state, 'stopped')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'interrupted', error: null })
    await until(() => !alive(childPid), 'the command to end')
    assert.equal(task.state, 'stopped')
    assert.equal(await task.endCommands(), 0, 'nothing is left for a second press')
    await task.send('say ok')
    await until(() => task.state === 'idle', 'the reply to be answered')
  } finally {
    await backend.close()
  }
})

test('Stop with a request open refuses it', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'run late', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    await task.stop()
    assert.equal(task.pending.length, 0)
    assert.deepEqual(events.find((e) => e.type === 'request-ended'), { type: 'request-ended', id: request.id, outcome: 'cancelled' })
    assert.ok(!events.some((e) => e.type === 'command' && e.status === 'finished'))
  } finally {
    await backend.close()
  }
})

test('a turn that fails is reported, and the task can be asked again', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'fail' })
    const events = watch(task)
    await until(() => task.state === 'idle', 'the turn to end')
    assert.deepEqual(events.find((e) => e.type === 'turn-ended'), { type: 'turn-ended', outcome: 'failed', error: 'API Error: overloaded' })
    assert.deepEqual(events.find((e) => e.type === 'error'), { type: 'error', message: 'API Error: overloaded' })
    await task.send('say ok')
    await until(() => events.some((e) => e.type === 'message' && e.text === 'ok'), 'the next turn to be answered')
  } finally {
    await backend.close()
  }
})

test('a task is picked up again from its session, and a stale empty result is not taken for its answer', { timeout: 30_000 }, async () => {
  const dir = scratch()
  const argsFile = path.join(dir, 'args.json')
  const backend = claude({ FAKE_ARGS_FILE: argsFile }, { stored: async () => [{ id: 'session-old', title: 'Fix the login redirect', cwd: dir, updatedAt: 5 }] })
  try {
    const task = await backend.resume('session-old', { asks: true })
    assert.equal(task.id, 'session-old')
    assert.equal(task.title, 'Fix the login redirect')
    const events = watch(task)
    await task.send('say ok')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['ok'], 'the stale result before it did not end the turn early')
    assert.equal(events.filter((e) => e.type === 'turn-ended').length, 1)
    const started = JSON.parse(readFileSync(argsFile, 'utf8'))
    assert.deepEqual(started.argv.slice(started.argv.indexOf('--resume'), started.argv.indexOf('--resume') + 2), ['--resume', 'session-old'])
    assert.equal(path.resolve(started.cwd).toLowerCase(), path.resolve(dir).toLowerCase(), 'it starts in the folder the session worked in')
  } finally {
    await backend.close()
  }
})

test('the list joins what Claude Code kept, what is running, and what Togle runs', { timeout: 30_000 }, async () => {
  const backend = claude(
    {},
    {
      stored: async () => [
        { id: 'a', title: 'Fix the login redirect', cwd: 'C:\\work\\site', updatedAt: 300 },
        { id: 'b', title: 'Write the release notes', cwd: 'C:\\work\\notes', updatedAt: 200 }
      ],
      live: async () => [
        { sessionId: 'a', cwd: 'C:\\work\\site', kind: 'interactive', status: 'waiting', waitingFor: 'permission prompt', pid: 4242, startedAt: 100 },
        { sessionId: 'c', cwd: 'C:\\work\\api', kind: 'background', state: 'working', name: 'Port the API', startedAt: 150 },
        { kind: 'interactive', cwd: 'C:\\somewhere' }
      ]
    }
  )
  try {
    const listed = await backend.list()
    assert.deepEqual(
      listed.map((t) => [t.id, t.title, t.state, t.pid ?? null]),
      [
        ['a', 'Fix the login redirect', 'waiting', 4242],
        ['b', 'Write the release notes', 'idle', null],
        ['c', 'Port the API', 'working', null]
      ]
    )
    const own = await backend.start({ folder: scratch(), prompt: 'say ok', title: 'Mine' })
    await until(() => own.state === 'idle', 'the turn to end')
    const again = await backend.list()
    assert.equal(again.find((t) => t.id === own.id).title, 'Mine')
    assert.equal(again.length, 4)
  } finally {
    await backend.close()
  }
})

test('when Claude Code ends under a task, the task fails and what it waited for is cancelled', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'run gone', asks: true })
    const events = watch(task)
    await until(() => task.pending[0], 'the command to wait')
    process.kill(Number(await until(async () => (await T.listProcesses()).find((p) => p.command.includes('fake-claude.mjs') && p.ppid === process.pid)?.pid, 'the program to be found')))
    await until(() => task.state === 'failed', 'the task to fail', 10_000)
    assert.equal(task.pending.length, 0)
    assert.ok(events.some((e) => e.type === 'ended' && e.reason === 'crashed'))
    assert.ok(events.some((e) => e.type === 'error' && /Claude Code stopped/.test(e.message)))
  } finally {
    await backend.close()
  }
})

test('a Claude Code program that cannot be started fails the start, and nothing is left listening', async () => {
  const backend = new T.ClaudeBackend({ command: [path.join(os.tmpdir(), 'no-such-claude-program')], live: async () => [], stored: async () => [] })
  try {
    await assert.rejects(backend.start({ folder: os.tmpdir(), prompt: 'say ok' }), /Claude Code could not be started/)
    await assert.rejects(backend.resume('session-old', { folder: os.tmpdir() }), /Claude Code could not be started/, 'the failure is not remembered')
    assert.deepEqual(await backend.list(), [], 'the failed task is not listed')
  } finally {
    await backend.close()
  }
})

test('someone who starts listening late hears what already happened, in order', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'say ok' })
    await until(() => task.state === 'idle', 'the turn to end')
    const events = watch(task)
    assert.deepEqual(events.map((e) => e.type), ['state', 'message', 'turn-ended', 'state'], 'working, what was said, the turn, idle')
    assert.deepEqual(events.filter((e) => e.type === 'state').map((e) => e.state), ['working', 'idle'])
    await task.send('say ok')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the next turn to end')
  } finally {
    await backend.close()
  }
})

test('a Codex program that will not start fails the start with a plain message, and a later start tries again', async () => {
  const backend = new T.CodexBackend({ command: [path.join(os.tmpdir(), 'no-such-codex-program')] })
  await assert.rejects(backend.start({ folder: os.tmpdir(), prompt: 'say ok' }), /Codex did not start/)
  await assert.rejects(backend.start({ folder: os.tmpdir(), prompt: 'say ok' }), /Codex did not start/, 'the failure is not remembered')
})
