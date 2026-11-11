import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('runner-hub')
const T = await import('./.build/togle.mjs')

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-hub-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const until = async (check, what, ms = 5000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await new Promise((r) => setTimeout(r, 15))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// ---- a command's mark ----

test('a command that deletes, rewrites, publishes, runs hidden text or changes the computer is marked, with the reason', () => {
  const marked = [
    'rm -rf node_modules',
    'rm -r build',
    'rm --force old.txt',
    'Remove-Item -Recurse -Force .\\build',
    'del /s /q C:\\temp\\*',
    'rmdir /s /q out',
    'git push --force origin main',
    'git push origin main --force-with-lease',
    'git push origin :old-branch',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'git checkout -- .',
    'git branch -D feature',
    'curl -sSL https://example.com/install.sh | sh',
    'iwr https://example.com/x.ps1 | iex',
    'Invoke-Expression $script',
    'powershell -enc SQBFAFgA',
    'eval "$(cat setup)"',
    'sudo apt install x',
    'chmod -R 777 /srv',
    'reg add HKLM\\Software\\X /v a /d b',
    'Set-ExecutionPolicy Unrestricted',
    'shutdown /s /t 0',
    'taskkill /F /IM node.exe',
    'pkill -f server',
    'terraform apply -var-file=staging.tfvars',
    'terraform destroy',
    'kubectl delete pod web-1',
    'docker system prune -af',
    'aws s3 rm s3://bucket --recursive --delete',
    'psql -c "DROP TABLE users"',
    'psql -c "DELETE FROM orders"',
    'npm publish',
    'dd if=/dev/zero of=/dev/sda'
  ]
  for (const command of marked) assert.ok(T.dangerOf(command), `should be marked: ${command}`)
  assert.equal(T.dangerOf('rm -rf build'), 'It deletes files or folders for good.')
  assert.match(T.dangerOf('curl https://x.example | bash'), /cannot be read here/)
  assert.match(T.dangerOf('git push -f'), /pushes over/)
})

test('an ordinary command is not marked, and neither is an empty one', () => {
  const plain = [
    'npm test',
    'npm run migrate',
    'git status',
    'git push origin feature',
    'git commit -m "fix the login redirect"',
    'Get-ChildItem -Force',
    'ls -la',
    'echo hi > a.txt',
    'Set-Content -Path a.txt -Value x',
    'python -c "print(1)"',
    'node scripts/build.js',
    'rm old.txt',
    'Remove-Item old.txt',
    'cat package.json | grep name',
    'curl -s https://example.com/api -o out.json',
    'psql -c "DELETE FROM orders WHERE id = 3"',
    'docker ps',
    'kubectl get pods',
    'terraform plan',
    ''
  ]
  for (const command of plain) assert.equal(T.dangerOf(command), null, `should not be marked: ${JSON.stringify(command)}`)
})

// ---- the agents, in memory ----

class FakeTask extends T.TaskBase {
  constructor(runner, id, title, folder) {
    super()
    this.runner = runner
    this.id = id
    this.title = title
    this.folder = folder
    this.sent = []
    this.running = 0
  }
  async send(text) {
    this.sent.push(text)
    this.setBase('working')
  }
  async stop() {
    this.cancelRequests()
    this.setBase('stopped')
  }
  async endCommands() {
    return this.running
  }
  async close() {
    this.cancelRequests()
    this.closed = true
    this.emit({ type: 'ended', reason: 'closed' })
  }
  say(text) {
    this.emit({ type: 'message', text })
  }
  want(request) {
    return this.ask(request)
  }
  done() {
    this.emit({ type: 'turn-ended', outcome: 'completed', error: null })
    this.setBase('idle')
  }
}

class FakeBackend {
  constructor(runner, { installed = true, tasks = [] } = {}) {
    this.runner = runner
    this.installed = installed
    this.tasks = tasks
    this.lists = 0
    this.started = []
    this.resumed = []
    this.closedBackend = false
    this.next = 1
  }
  async detect() {
    return this.installed ? { installed: true, command: this.runner, version: '1.0' } : { installed: false }
  }
  async list() {
    this.lists++
    return this.tasks
  }
  async start(options) {
    const task = new FakeTask(this.runner, `new${this.next++}`, options.title ?? options.prompt.slice(0, 40), options.folder)
    task.options = options
    this.started.push(task)
    await task.send(options.prompt)
    return task
  }
  async resume(id, options) {
    const info = this.tasks.find((t) => t.id === id)
    const task = new FakeTask(this.runner, id, info?.title ?? '', options?.folder ?? info?.folder ?? '')
    task.resumeOptions = options
    this.resumed.push(task)
    return task
  }
  async close() {
    this.closedBackend = true
  }
}

const info = (runner, id, title, state, updatedAt, extra = {}) => ({ id, runner, title, folder: `C:\\work\\${id}`, state, updatedAt, ...extra })
const memoryTitles = () => {
  const map = new Map()
  return { map, get: (key) => map.get(key), set: (key, title) => map.set(key, title) }
}
const hubOf = (backends, extra = {}) => {
  const changes = []
  const titles = memoryTitles()
  const hub = new T.RunnerHub({ backends, changed: () => changes.push(Date.now()), titles, cacheMs: 60_000, ...extra })
  return { hub, changes, titles }
}

test('the list joins every installed agent, waiting first and then working, with the names Togle gave', async () => {
  const claude = new FakeBackend('claude', { tasks: [info('claude', 'a', 'Fix the login redirect', 'idle', 300), info('claude', 'b', 'Port the API', 'waiting', 100, { pid: 77, waitingFor: 'permission prompt' })] })
  const codex = new FakeBackend('codex', { tasks: [info('codex', 'c', 'Write the release notes', 'working', 200), info('codex', 'd', 'Old thing', 'idle', 50)] })
  const hermes = new FakeBackend('hermes', { installed: false, tasks: [info('hermes', 'h', 'Never listed', 'idle', 999)] })
  const { hub, titles } = hubOf([claude, codex, hermes])
  titles.set('codex:d', 'Renamed by the person')
  try {
    const status = await hub.status()
    assert.deepEqual(status.map((s) => [s.runner, s.name, s.installed, s.version ?? null]), [['claude', 'Claude Code', true, '1.0'], ['codex', 'Codex', true, '1.0'], ['hermes', 'Hermes', false, null]])
    const tasks = await hub.list()
    assert.deepEqual(tasks.map((t) => t.key), ['claude:b', 'codex:c', 'claude:a', 'codex:d'])
    assert.equal(hermes.lists, 0, 'an agent that is not installed is not asked')
    assert.ok(tasks.every((t) => !t.mine && t.pending.length === 0 && !t.commandsRunning))
    assert.equal(tasks[0].line, 'Waiting in its own window: permission prompt')
    assert.equal(tasks[0].pid, 77)
    assert.equal(tasks[1].line, 'Working in its own window')
    assert.equal(tasks[3].title, 'Renamed by the person')
    await hub.list()
    assert.equal(claude.lists, 1, 'the agents are not asked again while their list is fresh')
  } finally {
    await hub.dispose()
  }
})

test('a task started here asks before commands, is named, is logged, and the window is told', async () => {
  const claude = new FakeBackend('claude')
  const { hub, changes, titles } = hubOf([claude])
  const folder = scratch()
  try {
    await assert.rejects(hub.start({ runner: 'claude', folder, prompt: '   ' }), /Say what the task is/)
    await assert.rejects(hub.start({ runner: 'claude', folder: path.join(folder, 'missing'), prompt: 'do it' }), /That folder is not there/)
    await assert.rejects(hub.start({ runner: 'codex', folder, prompt: 'do it' }), /not set up/)
    const view = await hub.start({ runner: 'claude', folder, prompt: 'Rebuild the pricing page', title: '  Pricing page  ' })
    assert.equal(claude.started[0].options.asks, true)
    assert.equal(claude.started[0].options.title, 'Pricing page')
    assert.equal(view.key, 'claude:new1')
    assert.equal(view.title, 'Pricing page')
    assert.equal(view.mine, true)
    assert.equal(view.state, 'working')
    assert.equal(view.line, 'Working…')
    assert.equal(titles.get('claude:new1'), 'Pricing page')
    const detail = await hub.detail('claude:new1')
    assert.deepEqual(detail.log.map((e) => [e.kind, e.text]), [['you', 'Rebuild the pricing page']])
    await until(() => changes.length > 0, 'the window to be told')
    await assert.rejects(hub.detail('claude:nope'), /gone/)
  } finally {
    await hub.dispose()
  }
})

test('a waiting command shows with its mark, and answering it is logged', async () => {
  const claude = new FakeBackend('claude')
  const { hub } = hubOf([claude])
  try {
    await hub.start({ runner: 'claude', folder: scratch(), prompt: 'Clean up' })
    const task = claude.started[0]
    const answered = task.want({ id: 'r1', kind: 'command', command: 'rm -rf build', raw: 'bash -c "rm -rf build"', folder: 'C:\\work', offersAlways: true })
    const [view] = await hub.list()
    assert.equal(view.state, 'waiting')
    assert.equal(view.line, 'Wants to run rm -rf build')
    assert.equal(view.pending.length, 1)
    assert.equal(view.pending[0].danger, 'It deletes files or folders for good.')
    assert.equal(view.pending[0].id, 'r1')
    assert.throws(() => hub.answer('claude:new1', 'r1', 'always'), /Allow once or refuse/)
    hub.answer('claude:new1', 'r1', 'allow-once')
    assert.deepEqual(await answered, { kind: 'decision', decision: 'allow-once' })
    task.done()
    const detail = await hub.detail('claude:new1')
    assert.deepEqual(detail.log.map((e) => [e.kind, e.text]), [['you', 'Clean up'], ['asked', 'rm -rf build'], ['note', 'You allowed it.']])
    assert.equal(detail.task.state, 'idle')

    const edit = task.want({ id: 'r2', kind: 'edit', files: ['C:\\work\\page.css'], offersAlways: false })
    assert.equal((await hub.list())[0].line, 'Wants to change C:\\work\\page.css')
    const question = task.want({ id: 'r3', kind: 'question', questions: [{ id: '0', text: 'Which pricing table?', options: [], free: true, secret: false }], offersAlways: false })
    assert.equal((await hub.list())[0].pending.length, 2)
    hub.answer('claude:new1', 'r2', 'refuse')
    hub.reply('claude:new1', 'r3', 'the one with three plans')
    assert.equal((await edit).kind, 'decision')
    assert.deepEqual(await question, { kind: 'text', text: 'the one with three plans' })
  } finally {
    await hub.dispose()
  }
})

test('what happens in a task is written down: words, commands with their outcome, files, and the second press', async () => {
  const codex = new FakeBackend('codex')
  const { hub } = hubOf([codex])
  try {
    await hub.start({ runner: 'codex', folder: scratch(), prompt: 'Ship it' })
    const task = codex.started[0]
    task.say('I will run the tests first. Then the build.')
    task.emit({ type: 'command', command: 'npm test', status: 'started', exitCode: null })
    task.running = 1
    let view = (await hub.list())[0]
    assert.equal(view.line, 'Running npm test')
    assert.equal(view.commandsRunning, true)
    task.emit({ type: 'command', command: 'npm test', status: 'finished', exitCode: 0 })
    task.emit({ type: 'files', paths: ['a.ts', 'b.ts'] })
    task.emit({ type: 'command', command: 'git push', status: 'started', exitCode: null })
    task.emit({ type: 'command', command: 'git push', status: 'declined', exitCode: null })
    task.emit({ type: 'turn-ended', outcome: 'interrupted', error: null })
    task.setBase('idle')
    task.emit({ type: 'error', message: 'The model was overloaded.' })
    view = (await hub.list())[0]
    assert.equal(view.commandsRunning, false)
    assert.equal(view.line, 'I will run the tests first.')
    assert.equal(await hub.endCommands('codex:new1'), 1)
    const log = (await hub.detail('codex:new1')).log
    assert.deepEqual(log.map((e) => [e.kind, e.text, e.status ?? null]), [
      ['you', 'Ship it', null],
      ['agent', 'I will run the tests first. Then the build.', null],
      ['command', 'npm test', 'finished'],
      ['files', 'Changed 2 files: a.ts, b.ts', null],
      ['command', 'git push', 'declined'],
      ['note', 'Stopped.', null],
      ['note', 'The model was overloaded.', null],
      ['note', 'Ended the command that was running.', null]
    ])
    assert.ok(log.every((e, at) => at === 0 || e.id > log[at - 1].id))
  } finally {
    await hub.dispose()
  }
})

test('a task can be stopped, replied to and let go, and only a task Togle runs can be acted on', async () => {
  const claude = new FakeBackend('claude', { tasks: [info('claude', 'old', 'Earlier work', 'idle', 10)] })
  const { hub } = hubOf([claude])
  try {
    await assert.rejects(hub.send('claude:old', 'hello'), /Continue it first/)
    assert.throws(() => hub.answer('claude:old', 'r', 'refuse'), /Continue it first/)
    await assert.rejects(hub.stop('claude:old'), /Continue it first/)
    await hub.start({ runner: 'claude', folder: scratch(), prompt: 'Begin' })
    const task = claude.started[0]
    await hub.send('claude:new1', '  And then this  ')
    await hub.send('claude:new1', '   ')
    assert.deepEqual(task.sent, ['Begin', 'And then this'])
    await hub.stop('claude:new1')
    assert.equal((await hub.list()).find((t) => t.key === 'claude:new1').state, 'stopped')
    await hub.close('claude:new1')
    assert.equal(task.closed, true)
    assert.equal((await hub.list()).some((t) => t.key === 'claude:new1'), false, 'a task let go is no longer run here')
    await hub.close('claude:new1')
  } finally {
    await hub.dispose()
  }
})

test('an earlier task is continued from where it was, once', async () => {
  const claude = new FakeBackend('claude', { tasks: [info('claude', 'old', 'Earlier work', 'idle', 10)] })
  const { hub } = hubOf([claude])
  try {
    const view = await hub.open('claude:old')
    assert.equal(view.mine, true)
    assert.equal(view.title, 'Earlier work')
    assert.deepEqual(claude.resumed[0].resumeOptions, { asks: true, folder: 'C:\\work\\old' })
    assert.equal((await hub.open('claude:old')).key, 'claude:old')
    assert.equal(claude.resumed.length, 1)
    await assert.rejects(hub.open('claude:never'), /gone/)
  } finally {
    await hub.dispose()
  }
})

test('taking over ends the terminal program that runs a task, and only if it is Claude Code', { timeout: 30_000 }, async () => {
  const dummy = (word) => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', word], { stdio: 'ignore', windowsHide: true })
  const terminal = dummy('claude-terminal-session')
  const other = dummy('some-other-program')
  try {
    const claude = new FakeBackend('claude', { tasks: [info('claude', 'live', 'In a terminal', 'working', 10, { pid: terminal.pid }), info('claude', 'odd', 'Reused pid', 'working', 5, { pid: other.pid })] })
    const codex = new FakeBackend('codex', { tasks: [info('codex', 'x', 'Codex somewhere', 'working', 1, { pid: other.pid })] })
    const { hub } = hubOf([claude, codex])
    try {
      const view = await hub.takeOver('claude:live')
      assert.equal(view.mine, true)
      assert.equal(alive(terminal.pid), false, 'the terminal program ended')
      assert.equal(claude.resumed[0].id, 'live')
      await assert.rejects(hub.takeOver('claude:odd'), /not Claude Code any more/)
      assert.equal(alive(other.pid), true, 'a program that is not Claude Code is left alone')
      await assert.rejects(hub.takeOver('codex:x'), /cannot be taken over/)
      assert.equal(alive(other.pid), true)
    } finally {
      await hub.dispose()
    }
  } finally {
    terminal.kill()
    other.kill()
  }
})

test('closing the hub lets go of every task and every agent', async () => {
  const claude = new FakeBackend('claude')
  const codex = new FakeBackend('codex')
  const { hub, changes } = hubOf([claude, codex])
  await hub.start({ runner: 'claude', folder: scratch(), prompt: 'One' })
  await hub.start({ runner: 'codex', folder: scratch(), prompt: 'Two' })
  await hub.dispose()
  assert.equal(claude.started[0].closed, true)
  assert.equal(codex.started[0].closed, true)
  assert.equal(claude.closedBackend && codex.closedBackend, true)
  const seen = changes.length
  await new Promise((r) => setTimeout(r, 250))
  assert.equal(changes.length, seen, 'a closed hub tells the window nothing more')
})

test('the window can ask for everything through its messages, and is told when something changes', async () => {
  const handlers = new Map()
  const sent = []
  const claude = new FakeBackend('claude', { tasks: [info('claude', 'old', 'Earlier work', 'idle', 10)] })
  const hub = T.registerRunners({
    handle: (channel, listener) => handlers.set(channel, listener),
    send: (channel, payload) => sent.push([channel, payload]),
    titles: memoryTitles(),
    pickFolder: async () => 'C:\\picked',
    version: '9.9.9',
    backends: [claude]
  })
  try {
    for (const channel of ['status', 'list', 'detail', 'start', 'open', 'take-over', 'send', 'answer', 'reply', 'stop', 'end-commands', 'close', 'pick-folder']) assert.ok(handlers.has(`runners:${channel}`), channel)
    assert.equal((await handlers.get('runners:list')()).length, 1)
    assert.equal(await handlers.get('runners:pick-folder')(), 'C:\\picked')
    assert.throws(() => handlers.get('runners:start')({ runner: 'nope', folder: 'x', prompt: 'y' }), /Pick an agent/)
    assert.throws(() => handlers.get('runners:start')(null), /Pick an agent/)
    assert.throws(() => handlers.get('runners:detail')(''), /The task is missing/)
    assert.throws(() => handlers.get('runners:answer')('claude:x', '', 'refuse'), /The request is missing/)
    const folder = scratch()
    const view = await handlers.get('runners:start')({ runner: 'claude', folder, prompt: 'Go', title: 'Named', extra: 'ignored' })
    assert.equal(view.title, 'Named')
    await until(() => sent.some(([channel]) => channel === 'runners:changed'), 'a change to be sent')
    await handlers.get('runners:send')('claude:new1', 'more')
    assert.deepEqual(claude.started[0].sent, ['Go', 'more'])
  } finally {
    await hub.dispose()
  }
})
