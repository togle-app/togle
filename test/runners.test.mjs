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

test('Claude Code tells the commands and models it has, in its own words, and nothing else it tells is kept', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'say ok', asks: true })
    await until(() => task.offers().commands.length, 'what it offers')
    const offers = task.offers()
    assert.deepEqual(offers.commands.map((command) => command.name), ['model', 'compact', 'clear'], 'a name it keeps for itself is left out')
    assert.deepEqual(offers.commands[0], { name: 'model', description: 'Set the AI model for Claude Code', hint: '<model>' })
    assert.deepEqual(offers.commands[2], { name: 'clear', description: 'Start a new session with empty context' }, 'no hint where it gave none')
    assert.deepEqual(offers.models, [
      { id: 'default', name: 'Default (recommended)', description: 'Fable 5.2' },
      { id: 'haiku', name: 'Haiku 5.5', description: 'Fastest for quick answers' }
    ])
    assert.ok(!JSON.stringify(offers).includes('example.com'), 'the account it also told is not kept')
  } finally {
    await backend.close()
  }
})

test('a command of its own that Claude Code is sent as a reply is answered in its words, and ends the turn', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'say ok', asks: true })
    const events = watch(task)
    const ended = () => events.filter((e) => e.type === 'turn-ended').length
    const said = () => events.filter((e) => e.type === 'message').map((e) => e.text)
    await until(() => ended() === 1, 'the first turn to end')
    await task.send('/model')
    await until(() => ended() === 2, 'the command to end')
    await task.send('/model haiku')
    await until(() => ended() === 3, 'the switch to end')
    assert.deepEqual(said().slice(1), ['Current model: `Sonnet 5.5`', 'Set model to `haiku` for this session only'])
    assert.equal(task.state, 'idle')
    // One that prints as a command prints, with no word from a model, and one that prints nothing at all.
    await task.send('/compact')
    await until(() => ended() === 4, 'compacting to end')
    assert.equal(said().at(-1), 'Compacted', 'what it printed, without a terminal’s colors')
    assert.equal(said().length, 4, 'the summary it keeps for itself is not shown as words')
    await task.send('/quiet')
    await until(() => ended() === 5, 'a command that prints nothing to end')
    assert.equal(task.state, 'idle')
    assert.equal(said().length, 4)
  } finally {
    await backend.close()
  }
})

test('"/clear" empties the conversation: the task keeps its id, and the session it goes on in is not a second task', { timeout: 30_000 }, async () => {
  const dir = scratch()
  let later = null
  const backend = claude({}, { stored: async () => (later ? [{ id: later, title: 'say ok', cwd: dir, updatedAt: 9 }] : []) })
  try {
    const task = await backend.start({ folder: dir, prompt: 'say ok', title: 'Port the settings screen', asks: true })
    const events = watch(task)
    const ended = () => events.filter((e) => e.type === 'turn-ended').length
    await until(() => ended() === 1, 'the first turn to end')
    const id = task.id
    await task.send('/clear')
    await until(() => ended() === 2, 'the clearing to end')
    assert.ok(events.some((e) => e.type === 'cleared'), 'it tells that the conversation was emptied')
    assert.equal(task.state, 'idle')
    assert.equal(task.id, id, 'the task is known by the id it had')
    assert.equal(task.session, `${id}-cleared`, 'and Claude Code goes on in another session')
    later = task.session
    const listed = await backend.list()
    assert.deepEqual(listed.map((t) => [t.id, t.title]), [[id, 'Port the settings screen']], 'one row, not two')
    await task.send('say ok')
    await until(() => ended() === 3, 'a reply after it to be answered')
    assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'ok')
  } finally {
    await backend.close()
  }
})

test('a task picked up again whose first reply is a command still ends its turn, past the stale result', { timeout: 30_000 }, async () => {
  const dir = scratch()
  for (const command of ['/model', '/clear', '/compact']) {
    const backend = claude({}, { stored: async () => [{ id: 'session-old', title: 'Fix the login redirect', cwd: dir, updatedAt: 5 }] })
    try {
      const task = await backend.resume('session-old', { asks: true })
      const events = watch(task)
      await task.send(command)
      await until(() => events.some((e) => e.type === 'turn-ended'), `${command} to end`)
      assert.equal(events.filter((e) => e.type === 'turn-ended').length, 1, command)
      assert.equal(task.state, 'idle', command)
      await task.send('say ok')
      await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, `a reply after ${command}`)
      assert.equal(events.filter((e) => e.type === 'message').at(-1).text, 'ok', command)
    } finally {
      await backend.close()
    }
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

test('always, for Claude Code, keeps the one rule it suggested where it said, never a change of mode', { timeout: 30_000 }, async () => {
  const backend = claude()
  try {
    const dir = scratch()
    const task = await backend.start({ folder: dir, prompt: 'run note', asks: true })
    const events = watch(task)
    const request = await until(() => task.pending[0], 'the command to wait')
    assert.equal(request.always, `Always allow this command in ${path.basename(dir)}`)
    task.answer(request.id, 'allow-always')
    await until(() => events.some((e) => e.type === 'turn-ended'), 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['did it, and kept addRules echo x > note.txt in localSettings'])
    // An edit's only suggestion is a change of mode: it is not offered as always.
    await task.send('edit page')
    const edit = await until(() => task.pending[0], 'the edit to wait')
    assert.equal(edit.always, undefined)
    task.answer(edit.id, 'refuse')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 2, 'the second turn to end')
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

// ---- Claude Code's own screen, in a terminal of Togle's own ----

const fakeScreen = path.join(import.meta.dirname, 'fake-claude-screen.mjs')
/** Claude Code's own screen, with a stand-in program. What `claude agents` would say of it is read from a file the stand-in writes. */
function screenBackend(extra = {}) {
  const dir = scratch()
  const files = { status: path.join(dir, 'status.txt'), pid: path.join(dir, 'pid.txt') }
  const told = []
  const backend = new T.ClaudeBackend({
    command: [process.execPath, fakeScreen],
    env: { ...process.env, FAKE_STATUS_FILE: files.status, FAKE_PID_FILE: files.pid, ...extra },
    live: async () => {
      try {
        return [{ sessionId: 'session-old', pid: Number(readFileSync(files.pid, 'utf8')), status: readFileSync(files.status, 'utf8') }]
      } catch {
        return []
      }
    },
    stored: async () => [{ id: 'session-old', title: 'Fix the login redirect', cwd: dir, updatedAt: 5 }],
    told: (chunk) => told.push(chunk)
  })
  return { backend, dir, files, told }
}
const shown = (task) => task.terminal.read().text

test('the hook server tells news of the turn only to a task that asked for it', { timeout: 30_000 }, async () => {
  const hooks = new T.HookServer()
  const heard = []
  const target = { permission: async () => null, news: (what, event) => heard.push([what, event.session_id]) }
  try {
    const plain = await hooks.attach(target, false)
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(plain.settings, 'utf8')).hooks), ['PermissionRequest'], 'a task that did not ask hears no news')
    const { settings } = await hooks.attach(target, false, true)
    const config = JSON.parse(readFileSync(settings, 'utf8'))
    assert.deepEqual(Object.keys(config.hooks), ['PermissionRequest', 'UserPromptSubmit', 'Stop'])
    assert.equal(config.permissions, undefined, 'nothing is forced on it: no rule that asks')
    const prompt = config.hooks.UserPromptSubmit[0].hooks[0]
    const stop = config.hooks.Stop[0].hooks[0]
    assert.deepEqual([prompt.type, stop.type, prompt.timeout, stop.timeout], ['http', 'http', 10, 10], 'Claude Code does not wait long for news')
    assert.match(prompt.url, /\/prompt$/)
    assert.match(stop.url, /\/stop$/)
    const post = (to, body) => fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const one = await post(prompt.url, { session_id: 's1' })
    assert.deepEqual([one.status, await one.text()], [200, ''], 'news needs no answer')
    await post(stop.url, { session_id: 's2' })
    assert.deepEqual(heard, [['prompt', 's1'], ['stop', 's2']])
    // A task that hears no news is not held up by it.
    const quiet = await hooks.attach({ permission: async () => null }, false, true)
    const quietStop = JSON.parse(readFileSync(quiet.settings, 'utf8')).hooks.Stop[0].hooks[0].url
    assert.equal((await post(quietStop, {})).status, 200)
    assert.equal((await post(stop.url.replace(/\/stop$/, '/other'), {})).status, 404, 'only the known words are heard')
  } finally {
    await hooks.close()
  }
})

test('Claude Code’s own screen starts on the session in the task folder, with Togle’s hook and nothing forced on it', { timeout: 30_000 }, async () => {
  const { backend, dir, told } = screenBackend({ CLAUDE_CODE_CHILD_SESSION: '1', CLAUDECODE: '1' })
  try {
    const task = await backend.resume('session-old', { folder: dir, screen: true })
    assert.equal(task.runner, 'claude')
    assert.equal(task.id, 'session-old')
    assert.equal(task.title, 'Fix the login redirect')
    assert.ok(task.terminal && task.screen, 'a terminal, and Togle hears it')
    assert.equal(task.state, 'idle', 'it opens on a conversation that waits for a message')
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    assert.match(shown(task), /started with \["--resume","session-old","--settings","<settings>"\] hooks=PermissionRequest,UserPromptSubmit,Stop asks=false nested=false/, 'no permission mode, no rule that asks, and not marked as started inside Claude Code')
    assert.ok(told.length > 0 && told.every((chunk) => chunk.key === 'claude:session-old'), 'what it prints goes to the window, under the task’s key')
    assert.equal(typeof task.screen.pid, 'number')
  } finally {
    await backend.close()
  }
})

test('on Claude Code’s own screen a command that asks is a request in Togle, and a turn is working until it ends', { timeout: 30_000 }, async () => {
  const { backend, dir } = screenBackend()
  try {
    const task = await backend.resume('session-old', { folder: dir, screen: true })
    const events = watch(task)
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    task.terminal.write('run a\r')
    const card = await until(() => task.pending[0], 'the request')
    assert.deepEqual([card.kind, card.command, card.folder], ['command', 'echo x > a.txt', dir])
    assert.equal(task.state, 'waiting')
    task.answer(card.id, 'allow-once')
    await until(() => shown(task).includes('ran a'), 'the command to run')
    await until(() => task.state === 'idle', 'the turn to end')
    assert.deepEqual(events.filter((e) => e.type === 'message').map((e) => e.text), ['done a'], 'what it said last, for the notice and the to-do list')
    assert.deepEqual(events.filter((e) => e.type === 'turn-ended').map((e) => e.outcome), ['completed'])
    // Refused: it does not run, and the task goes on.
    task.terminal.write('run b\r')
    const second = await until(() => task.pending[0], 'the second request')
    task.answer(second.id, 'refuse')
    await until(() => shown(task).includes('refused b'), 'the refusal to reach it')
    await until(() => task.state === 'idle', 'the second turn to end')
    // A message that asks nothing is working while it lasts, and then done.
    task.terminal.write('hello\r')
    await until(() => shown(task).includes('fine, hello'), 'the answer')
    await until(() => events.filter((e) => e.type === 'turn-ended').length === 3, 'the third turn to end')
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

test('a command answered on Claude Code’s own screen is no longer asked in Togle, as soon as the program says it does not wait', { timeout: 30_000 }, async () => {
  const { backend, dir, files } = screenBackend()
  try {
    const task = await backend.resume('session-old', { folder: dir, screen: true })
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    task.terminal.write('run c\r')
    const card = await until(() => task.pending[0], 'the request')
    // The screen asks as well. Claude Code says it waits, then the person answers there; the request is kept open, as Claude Code keeps it.
    await until(() => readFileSync(files.status, 'utf8') === 'waiting', 'the program to say it waits')
    assert.equal(task.pending.length, 1, 'not dropped while it waits')
    task.terminal.write('y\r')
    await until(() => task.pending.length === 0, 'the request to go', 10_000)
    assert.ok(shown(task).includes('ran c (answered here)'))
    assert.notEqual(task.state, 'waiting')
    // Answering the dropped card does nothing now.
    task.answer(card.id, 'refuse')
    await until(() => task.state === 'idle', 'the turn to end')
    assert.equal(task.pending.length, 0)
  } finally {
    await backend.close()
  }
})

test('Claude Code’s own screen follows the session the person moves to, and is over when its program ends', { timeout: 30_000 }, async () => {
  const { backend, dir, files } = screenBackend()
  try {
    const task = await backend.resume('session-old', { folder: dir, screen: true })
    const events = watch(task)
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    assert.equal(task.screen.session(), 'session-old')
    task.terminal.write('clear\r')
    await until(() => shown(task).includes('cleared'), 'the conversation to be cleared')
    task.terminal.write('hello\r')
    await until(() => task.screen.session() === 'session-old-2', 'the next hook to name the new session')
    assert.equal(task.id, 'session-old', 'the task keeps the id it was known by')
    const pid = task.screen.pid
    assert.equal(alive(pid), true)
    task.terminal.write('bye\r')
    await until(() => events.some((e) => e.type === 'ended'), 'the program to end')
    assert.equal(task.screen.pid, null)
    assert.equal(alive(pid), false)
    assert.ok(events.some((e) => e.type === 'ended' && e.reason === 'closed'), 'ended by itself: the task is over for the hub')
    assert.equal(task.state, 'idle')
  } finally {
    await backend.close()
  }
})

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('a second command that asks right after the first has a card of its own, and is not dropped for what the first one saw', { timeout: 40_000 }, async () => {
  const { backend, dir, files } = screenBackend({ FAKE_STATUS_MANUAL: '1' })
  const says = (value) => writeFileSync(files.status, value)
  try {
    says('idle')
    const task = await backend.resume('session-old', { folder: dir, screen: true })
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    task.terminal.write('run2 a b\r')
    const first = await until(() => task.pending[0], 'the first request')
    assert.equal(first.command, 'echo x > a.txt')
    says('waiting')
    await pause(2200)
    // Allowed from the card: the program is busy a moment, and asks again. What was seen of the first does not count.
    says('busy')
    task.answer(first.id, 'allow-once')
    const second = await until(() => task.pending.find((request) => request.id !== first.id), 'the second request')
    assert.equal(second.command, 'echo x > b.txt')
    await pause(3000)
    assert.deepEqual(task.pending.map((request) => request.id), [second.id], 'it stays while the program has not said it waits')
    says('waiting')
    await pause(2200)
    assert.equal(task.pending.length, 1, 'and while it says it waits')
    says('busy')
    await until(() => task.pending.length === 0, 'the card to go once the program does not wait', 10_000)
  } finally {
    await backend.close()
  }
})

test('a card whose question was answered on the screen goes when the next request comes, even before the program said so', { timeout: 30_000 }, async () => {
  const { backend, dir, files } = screenBackend({ FAKE_STATUS_MANUAL: '1' })
  try {
    writeFileSync(files.status, 'idle')
    const task = await backend.resume('session-old', { folder: dir, screen: true })
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    task.terminal.write('run2 a b\r')
    const first = await until(() => task.pending[0], 'the first request')
    task.terminal.write('y\r')
    const second = await until(() => task.pending.find((request) => request.id !== first.id), 'the second request')
    assert.deepEqual(task.pending.map((request) => request.command), ['echo x > b.txt'], 'no stale card beside the new one')
    assert.notEqual(second.id, first.id)
  } finally {
    await backend.close()
  }
})

test('Claude Code\u2019s own screen opens the way the program was started, and not for a session that has no conversation', { timeout: 30_000 }, async () => {
  const { backend, dir } = screenBackend()
  try {
    assert.equal(await backend.screenProblem('session-old'), undefined)
    assert.match(await backend.screenProblem('never-used'), /has not had a message yet, so there is no conversation to open here\. It was left as it is\./)
    const task = await backend.resume('session-old', { folder: dir, screen: true, flags: ['--model', 'opus', '--permission-mode', 'plan'] })
    await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
    assert.match(shown(task), /started with \["--model","opus","--permission-mode","plan","--resume","session-old","--settings","<settings>"\]/)
  } finally {
    await backend.close()
  }
})

test('the flags that decide what a Claude Code does are read from the command line it ran under, and nothing else', () => {
  const flags = T.carriedFlags
  assert.deepEqual(flags('"C:\\Users\\a b\\.local\\bin\\claude.exe" --model opus --permission-mode plan --add-dir C:\\x'), ['--model', 'opus', '--permission-mode', 'plan'])
  assert.deepEqual(flags('claude --model=sonnet[1m] --effort high --dangerously-skip-permissions'), ['--model', 'sonnet[1m]', '--effort', 'high', '--dangerously-skip-permissions'])
  assert.deepEqual(flags('claude --resume abc --settings C:\\a.json --name "Fix it"'), [])
  assert.deepEqual(flags('claude --model'), [], 'a flag with no value is dropped')
  assert.deepEqual(flags('claude --model "two words" --effort ;rm --permission-mode $(x)'), [], 'only a plain value is taken')
  assert.deepEqual(flags(''), [])
})

test('closing Claude Code\u2019s own screen ends its program, and closing the backend ends every screen', { timeout: 30_000 }, async () => {
  const { backend, dir, files } = screenBackend()
  const task = await backend.resume('session-old', { folder: dir, screen: true })
  await until(() => shown(task).includes('fake claude ready'), 'the screen to open')
  const pid = Number(readFileSync(files.pid, 'utf8'))
  assert.equal(alive(pid), true)
  await backend.close()
  await until(() => !alive(pid), 'the program to end')
  await until(() => task.screen.pid === null, 'the task to know its program ended')
})

test('a screen that cannot open fails the start in words, and leaves no hook behind', { timeout: 30_000 }, async () => {
  const backend = new T.ClaudeBackend({ command: [path.join(os.tmpdir(), 'no-such-claude-program.exe')], live: async () => [], stored: async () => [] })
  try {
    await assert.rejects(backend.resume('session-old', { folder: os.tmpdir(), screen: true }), /Claude Code could not be started/)
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
