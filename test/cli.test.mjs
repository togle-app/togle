import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('cli')
const T = await import('./.build/togle.mjs')

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-cli-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

// ---- reading what is typed ----

test('what follows togle run is read: the agent, the folder, a title, and the words of the task', () => {
  const cwd = path.resolve('somewhere', 'project')
  assert.deepEqual(T.parseRun(['Add', 'a', 'dark', 'mode'], cwd), { agent: 'claude', folder: cwd, prompt: 'Add a dark mode' })
  assert.deepEqual(T.parseRun(['Codex', '--folder', 'api', '--title', 'Dark mode', 'Do', 'it'], cwd), { agent: 'codex', folder: path.join(cwd, 'api'), title: 'Dark mode', prompt: 'Do it' }, 'the first word names the agent')
  assert.deepEqual(T.parseRun([`--folder=${path.resolve('elsewhere')}`, 'hermes', 'x'], cwd), { agent: 'hermes', folder: path.resolve('elsewhere'), prompt: 'x' })
  assert.deepEqual(T.parseRun(['claude'], cwd), { agent: 'claude', folder: cwd, prompt: '' }, 'an agent and no task, as the design has it')
  assert.equal(T.parseRun(['acp-gemini-cli', 'x'], cwd).agent, 'acp-gemini-cli', 'an agent added in Settings, by its id')
  assert.deepEqual(T.parseRun(['Fix', 'the', 'codex', 'config'], cwd), { agent: 'claude', folder: cwd, prompt: 'Fix the codex config' }, 'only the first word can name the agent')
  assert.deepEqual(T.parseRun(['--', 'codex', 'is', 'slow'], cwd), { agent: 'claude', folder: cwd, prompt: 'codex is slow' }, 'after -- everything is the task')
  assert.deepEqual(T.parseRun(['codex', '--', 'hermes', 'too'], cwd), { agent: 'codex', folder: cwd, prompt: 'hermes too' })
  assert.equal(T.parseRun(['--', '--not-a-flag', 'is', 'words'], cwd).prompt, '--not-a-flag is words')
  assert.equal(T.parseRun(['  spaced  ', 'out'], cwd).prompt, 'spaced   out', 'the words are joined as typed, and trimmed at the ends')
  assert.equal(T.parseRun([], cwd).prompt, '', 'no words is an empty task')
  assert.equal(T.parseRun(['acp-', 'x'], cwd).prompt, 'acp- x', 'not an id, so a word of the task')
  assert.throws(() => T.parseRun(['--folder'], cwd), /--folder needs a value/)
  assert.throws(() => T.parseRun(['--title='], cwd), /--title needs a value/)
  assert.throws(() => T.parseRun(['--agent', 'codex', 'x'], cwd), /does not know --agent/, 'the agent is the first word')
  assert.throws(() => T.parseRun(['--fast', 'x'], cwd), /does not know --fast/)
})

test('where an installed Togle keeps its data is told for each system, and a development run names it', () => {
  assert.equal(T.defaultDataFolder({ APPDATA: 'C:\\Users\\Someone\\AppData\\Roaming' }, 'C:\\Users\\Someone', 'win32'), path.join('C:\\Users\\Someone\\AppData\\Roaming', 'Togle'))
  assert.equal(T.defaultDataFolder({}, path.join('C:', 'Users', 'Someone'), 'win32'), path.join('C:', 'Users', 'Someone', 'AppData', 'Roaming', 'Togle'))
  assert.equal(T.defaultDataFolder({}, '/Users/someone', 'darwin'), path.join('/Users/someone', 'Library', 'Application Support', 'Togle'))
  assert.equal(T.defaultDataFolder({}, '/home/someone', 'linux'), path.join('/home/someone', '.config', 'Togle'))
  assert.equal(T.defaultDataFolder({ XDG_CONFIG_HOME: '/data/config' }, '/home/someone', 'linux'), path.join('/data/config', 'Togle'))
  assert.equal(T.defaultDataFolder({ TOGLE_DATA: ' /dev/data ' }, '/home/someone', 'linux'), '/dev/data')
})

// ---- the command, against a Togle that answers ----

class Backend {
  constructor() {
    this.runner = 'claude'
    this.started = []
  }
  async detect() { return { installed: true, version: '2.1.322' } }
  async list() { return [] }
  async start(options) {
    const handle = new T.TaskBase()
    Object.assign(handle, { runner: 'claude', id: `s${this.started.length + 1}`, title: options.title ?? options.prompt.slice(0, 30), folder: options.folder, options })
    handle.send = async () => handle.setBase('working')
    handle.stop = async () => handle.setBase('stopped')
    handle.endCommands = async () => 0
    handle.close = async () => {}
    this.started.push(handle)
    await handle.send(options.prompt)
    return handle
  }
  async close() {}
}
const togle = async (hubOptions = {}) => {
  const dataFolder = scratch()
  const backend = new Backend()
  const hub = new T.RunnerHub({ backends: [backend], changed() {}, ...hubOptions })
  const opened = []
  const server = await T.startChannel({ dataFolder, hub, openBox: (opening) => opened.push(opening) })
  return { dataFolder, backend, hub, server, opened, close: async () => { await server.close(); await hub.dispose() } }
}
const run = async (argv, { dataFolder, cwd = os.tmpdir(), stdin = null } = {}) => {
  const out = []
  const err = []
  const code = await T.runCli(argv, { cwd, env: { TOGLE_DATA: dataFolder }, stdin: async () => stdin, out: (t) => out.push(t), err: (t) => err.push(t) })
  return { code, out: out.join(''), err: err.join('') }
}

test('togle run starts a task in the running Togle, which asks before every command', async () => {
  const running = await togle()
  try {
    const folder = scratch()
    const result = await run(['run', '--title', 'Dark mode', 'Add', 'a', 'dark', 'mode', 'switch'], { dataFolder: running.dataFolder, cwd: folder })
    assert.equal(result.code, 0, result.err)
    assert.equal(result.out, `Started in Togle: Dark mode (Claude Code, ${folder}). It asks before every command. Answer it in Togle, under Agents.\n`)
    assert.equal(result.err, '')
    const [task] = running.backend.started
    assert.deepEqual({ folder: task.options.folder, prompt: task.options.prompt, title: task.options.title, asks: task.options.asks }, { folder, prompt: 'Add a dark mode switch', title: 'Dark mode', asks: true })
    assert.equal((await running.hub.list())[0].key, 'claude:s1', 'it is in the list Togle shows')
  } finally {
    await running.close()
  }
})

test('piped text is the task when none is typed, and a task needs words', async () => {
  const running = await togle()
  try {
    const piped = await run(['run'], { dataFolder: running.dataFolder, stdin: '  Fix the failing test\nin the login form.  \n' })
    assert.equal(piped.code, 0, piped.err)
    assert.equal(running.backend.started[0].options.prompt, 'Fix the failing test\nin the login form.')
    // A pipe with nothing in it is a script that forgot the task, not a person: it is refused, and no box opens.
    const none = await run(['run'], { dataFolder: running.dataFolder, stdin: ' \n' })
    assert.equal(none.code, 2)
    assert.match(none.err, /^Say what the task is\./)
    assert.match(none.err, /togle run \[claude\|codex/, 'and shows how')
    const titled = await run(['run', '--title', 'Dark mode'], { dataFolder: running.dataFolder })
    assert.equal(titled.code, 2, 'a title is for a task, so it needs one')
    assert.match(titled.err, /^Say what the task is\./)
    assert.equal(running.backend.started.length, 1)
    assert.deepEqual(running.opened, [])
  } finally {
    await running.close()
  }
})

test('togle run claude, with no task, opens the task box in Togle with that agent and folder', async () => {
  const running = await togle()
  try {
    const folder = scratch()
    const result = await run(['run', 'claude'], { dataFolder: running.dataFolder, cwd: folder })
    assert.equal(result.code, 0, result.err)
    assert.equal(result.out, `Togle's task box is open, with Claude Code in ${folder}. Type or say the task there, and press Enter.\n`)
    assert.deepEqual(running.opened, [{ runner: 'claude', folder }])
    assert.equal(running.backend.started.length, 0, 'nothing starts before the person says what')
    // What it cannot be opened with is said in the terminal, and the box stays shut.
    const missing = await run(['run', 'claude', '--folder', 'not-there'], { dataFolder: running.dataFolder, cwd: folder })
    assert.deepEqual([missing.code, missing.err], [1, 'That folder is not there.\n'])
    const other = await run(['run', 'codex'], { dataFolder: running.dataFolder, cwd: folder })
    assert.deepEqual([other.code, other.err], [1, 'Pick an agent: claude, codex, hermes, or one added in Settings.\n'], 'one this Togle does not work with')
    assert.equal(running.opened.length, 1)
  } finally {
    await running.close()
  }
})

test('togle tasks lists what Togle can see, with the words a person would use', async () => {
  const running = await togle()
  try {
    assert.deepEqual(await run(['tasks'], { dataFolder: running.dataFolder }), { code: 0, out: 'No tasks.\n', err: '' })
    await run(['run', 'Write the release notes'], { dataFolder: running.dataFolder, cwd: scratch() })
    const listed = await run(['tasks'], { dataFolder: running.dataFolder })
    assert.equal(listed.code, 0)
    assert.match(listed.out, /^working {4}Claude Code {2}Write the release notes {2}\(Working…\)\n$/)
  } finally {
    await running.close()
  }
})

test('what cannot be done is said in words, with a code that tells a script: 1 for Togle, 2 for what was typed', async () => {
  const running = await togle()
  try {
    const missing = await run(['run', '--folder', path.join(scratch(), 'not-there'), 'x'], { dataFolder: running.dataFolder })
    assert.equal(missing.code, 1)
    assert.equal(missing.err, 'That folder is not there.\n')
    for (const [argv, words] of [[[], /^togle run/], [['help'], null], [['--help'], null], [['fly'], /does not know "fly"/], [['run', '--agent', 'codex', 'x'], /does not know --agent/], [['run', '--bogus', 'x'], /does not know --bogus/]]) {
      const result = await run(argv, { dataFolder: running.dataFolder })
      assert.equal(result.code, argv[0] === 'help' || argv[0] === '--help' ? 0 : 2, JSON.stringify(argv))
      if (words) assert.match(result.out + result.err, words)
      else assert.match(result.out, /togle run \[claude\|codex/)
    }
  } finally {
    await running.close()
  }
})

test('with Togle not running, or something else answering, it says so and sends nothing', async () => {
  const quiet = scratch()
  const none = await run(['run', 'x'], { dataFolder: quiet })
  assert.deepEqual([none.code, none.out, none.err], [1, '', 'Togle is not running, so it cannot do that. Start Togle and try again.\n'])
  // A listener on this Togle's pipe that does not hold its secret.
  const taken = scratch()
  await T.loadSecret(taken)
  const heard = []
  const impostor = new T.ChannelServer({ secret: T.secretOf('cd'.repeat(32)), address: T.channelAddress(taken), handlers: { run: async (body) => (heard.push(body), 'x') } })
  await impostor.listen()
  try {
    const refused = await run(['run', 'a secret task'], { dataFolder: taken })
    assert.equal(refused.code, 1)
    assert.match(refused.err, /not this Togle/)
    assert.deepEqual(heard, [], 'the task was never sent')
  } finally {
    await impostor.close()
  }
})

// ---- what Togle checks of what it is asked ----

test('Togle checks what it is asked: the agent, a folder in full, words, and a length', async () => {
  const hub = { started: [], async start(request) { this.started.push(request); return { key: 'claude:x', title: request.title ?? 'T', runner: request.runner, folder: request.folder } } }
  const folder = path.resolve('project')
  const ask = (given) => T.startTask(hub, typeof given === 'string' ? given : JSON.stringify(given))
  assert.deepEqual(await ask({ runner: 'codex', folder, prompt: 'Do it', title: '  A name  ' }), { key: 'claude:x', title: 'A name', runner: 'codex', folder })
  assert.deepEqual(hub.started[0], { runner: 'codex', folder, prompt: 'Do it', title: 'A name' })
  await assert.rejects(ask('not json'), /not a task/)
  await assert.rejects(ask('null'), /Pick an agent/)
  await assert.rejects(ask({ runner: 'gpt', folder, prompt: 'x' }), /Pick an agent/)
  await assert.rejects(ask({ runner: 'claude', folder: 'relative/path', prompt: 'x' }), /folder in full/)
  await assert.rejects(ask({ runner: 'claude', folder: 5, prompt: 'x' }), /folder in full/)
  await assert.rejects(ask({ runner: 'claude', folder, prompt: '   ' }), /Say what the task is/)
  await assert.rejects(ask({ runner: 'claude', folder, prompt: 'x'.repeat(20001) }), /too long/)
  assert.equal(hub.started.length, 1, 'none of those started anything')
  await ask({ runner: 'hermes', folder, prompt: 'x', title: 'y'.repeat(300) })
  assert.equal(hub.started[1].title.length, 120)
  await ask({ runner: 'hermes', folder, prompt: 'x', title: '   ' })
  assert.equal('title' in hub.started[2], false, 'a blank title is no title')
  // An agent added in Settings: whatever the hub works with.
  const added = { ...hub, has: (runner) => ['claude', 'acp-gemini'].includes(runner) }
  await T.startTask(added, JSON.stringify({ runner: 'acp-gemini', folder, prompt: 'x' }))
  assert.equal(hub.started.at(-1).runner, 'acp-gemini')
  await assert.rejects(T.startTask(added, JSON.stringify({ runner: 'codex', folder, prompt: 'x' })), /Pick an agent/, 'one the hub does not work with')
})

test('Togle checks what the task box is opened with: an agent it has, installed, and a folder that is there', async () => {
  const hub = { async status() { return [{ runner: 'claude', name: 'Claude Code', installed: true }, { runner: 'hermes', name: 'Hermes', installed: false }] } }
  const folder = scratch()
  const opened = []
  const ask = (given) => T.openBox(hub, typeof given === 'string' ? given : JSON.stringify(given), (opening) => opened.push(opening))
  assert.deepEqual(await ask({ runner: 'claude', folder, prompt: 'ignored' }), { runner: 'claude', name: 'Claude Code', folder })
  assert.deepEqual(opened, [{ runner: 'claude', folder }], 'with only the agent and the folder')
  await assert.rejects(ask('not json'), /not a task/)
  await assert.rejects(ask({ runner: 'codex', folder }), /Pick an agent/)
  await assert.rejects(ask({ runner: 'hermes', folder }), /^Error: Hermes is not installed on this computer\.$/)
  await assert.rejects(ask({ runner: 'claude', folder: 'relative' }), /folder in full/)
  await assert.rejects(ask({ runner: 'claude', folder: path.join(folder, 'gone') }), /That folder is not there/)
  assert.equal(opened.length, 1, 'none of those opened it')
})

// ---- the program itself, started the way the command starts it ----

test('the command works as the program it is built into, started as plain Node by Electron', async () => {
  const { spawn } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const built = path.resolve(import.meta.dirname, '..', 'out', 'main', 'cli.js')
  if (!existsSync(built)) return // not built: `npm run build` makes it
  const electron = (await import('node:module')).createRequire(import.meta.url)('electron')
  const running = await togle()
  // Started without blocking this process: the Togle it talks to is in this process too.
  const exec = (args, { env, input, cwd } = {}) =>
    new Promise((resolve, reject) => {
      const child = spawn(electron, [built, ...args], { env, cwd, windowsHide: true })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => { child.kill(); reject(new Error(`the command did not end: ${stdout} ${stderr}`)) }, 20000)
      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }) })
      if (input !== undefined) child.stdin.write(input)
      child.stdin.end()
    })
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', TOGLE_DATA: running.dataFolder }
    const started = await exec(['run', '--title', 'From a terminal', 'Add', 'a', 'test'], { env, cwd: scratch() })
    assert.equal(started.status, 0, started.stderr)
    assert.match(started.stdout, /^Started in Togle: From a terminal \(Claude Code, /)
    assert.equal(running.backend.started[0].options.prompt, 'Add a test')
    const piped = await exec(['run'], { env, input: 'Task from a pipe' })
    assert.equal(piped.status, 0, piped.stderr)
    assert.equal(running.backend.started[1].options.prompt, 'Task from a pipe')
    const empty = await exec(['run', 'claude'], { env })
    assert.equal(empty.status, 2, 'started by a script with nothing piped in: no box opens')
    assert.deepEqual(running.opened, [])
    const listed = await exec(['tasks'], { env })
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /From a terminal/)
    const off = await exec(['tasks'], { env: { ...env, TOGLE_DATA: scratch() } })
    assert.equal(off.status, 1)
    assert.match(off.stderr, /Togle is not running/)
    const wrong = await exec(['fly'], { env })
    assert.equal(wrong.status, 2)
  } finally {
    await running.close()
  }
})
