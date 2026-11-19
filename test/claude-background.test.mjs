// Claude Code's background sessions: how Togle starts them, opens their screen, hears what they ask, stops them, and finds
// them again after it quit. A stand-in for Claude Code (fake-claude-bg.mjs) answers the commands as Claude Code 2.1.323 does
// on this computer; what it does is described at its top.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('claude-background')
const T = await import('./.build/togle.mjs')

const fakeBg = path.join(import.meta.dirname, 'fake-claude-bg.mjs')
const made = []
const homes = []
const scratch = () => {
  // The folder as the system names it: on a Mac the temporary folder is /var/folders/..., which is a link to /private/var/folders/..., and a program
  // started in it says the second when it is asked where it is.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'togle-claude-bg-')))
  made.push(dir)
  return dir
}
after(() => {
  for (const home of homes) {
    try {
      execFileSync(process.execPath, [fakeBg, '__killall'], { env: { ...process.env, FAKE_CLAUDE_HOME: home } })
    } catch {
      // Nothing to end.
    }
  }
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const alive = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A whole run starts many programs at once, and a wait that is long enough alone has run out under that load.
const until = async (check, what, ms = 30_000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await sleep(25)
  }
  assert.fail(`timed out waiting for ${what}`)
}
const strip = (text) => text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')

/** Claude Code as the tests have it: a backend over the stand-in, its state folder, what its screens printed, and a kept folder. */
function claude(options = {}) {
  const home = options.home ?? scratch()
  if (!homes.includes(home)) homes.push(home)
  const keep = options.keep ?? scratch()
  const chunks = []
  const backend = new T.ClaudeBackend({
    command: [process.execPath, fakeBg],
    env: { ...process.env, FAKE_CLAUDE_HOME: home, ...(options.env ?? {}) },
    stored: async () => [],
    told: (chunk) => chunks.push(chunk),
    keep,
    every: { busy: 100, idle: 300 },
    said: async () => '',
    ...(options.backend ?? {})
  })
  return { backend, home, keep, chunks, text: (key) => strip(chunks.filter((chunk) => chunk.key === key).map((chunk) => chunk.data).join('')).replace(/\s+/g, ' ') }
}
/** The fake writes a job file in place, so a read in the middle of a write is cut short: look again until it parses. */
const job = (home, id) => {
  const file = path.join(home, 'jobs', `${id}.json`)
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) {
      if (!(error instanceof SyntaxError) || attempt >= 50) throw error
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
}
const watch = (task) => {
  const events = []
  task.on((event) => events.push(event))
  return events
}
const type = (task, words) => task.terminal.write(`${words}\r`)
/** Another program on the session, as a second window is: it connects to the session's own port. */
async function another(home, id) {
  const socket = net.connect(job(home, id).port, '127.0.0.1')
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.on('error', () => undefined)
  return socket
}

// ---- The hook server ----

test('the hook server answers a task that Claude Code asks about, and only that task', { timeout: 30_000 }, async () => {
  const hooks = new T.HookServer()
  const seen = []
  const target = { permission: async (event) => (event.tool_name === 'Bash' ? { behavior: 'allow' } : event.tool_name === 'Write' ? { behavior: 'deny', message: 'No.' } : null) }
  try {
    const { key, settings } = await hooks.attach(target, true)
    const config = JSON.parse(readFileSync(settings, 'utf8'))
    const url = config.hooks.PermissionRequest[0].hooks[0].url
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/hook\/[0-9a-f]{32}\/[0-9a-f]{16}\/permission$/)
    assert.equal(config.hooks.PermissionRequest[0].hooks[0].type, 'http')
    assert.deepEqual(Object.keys(config.hooks), ['PermissionRequest'], 'only the permission hook: Claude Code prints an error under every turn for one whose address is dead')
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
    assert.equal((await post(url.replace('/permission', '/stop'))).status, 404, 'the end of a turn is not told: only permission is')
    assert.equal((await post(url, {}, 'GET')).status, 404)
    assert.equal((await fetch(url, { method: 'POST', body: 'not json' })).status, 400)
    // The call ends when the caller goes away, and the task is told.
    target.permission = async (event, gone) => {
      seen.push(gone)
      await new Promise((resolve) => gone.addEventListener('abort', resolve, { once: true }))
      return { behavior: 'allow' }
    }
    const caller = new AbortController()
    const pending = fetch(url, { method: 'POST', body: JSON.stringify({ tool_name: 'Bash' }), signal: caller.signal }).catch(() => null)
    await until(() => seen.length === 1, 'the request to arrive')
    caller.abort()
    await pending
    await until(() => seen[0].aborted, 'the request to be told the caller went away')
  } finally {
    await hooks.close()
  }
})

test('without a folder to keep things in, the settings are temporary; a task that is gone for good loses its file', { timeout: 30_000 }, async () => {
  const hooks = new T.HookServer()
  const { key, settings } = await hooks.attach({ permission: async () => ({ behavior: 'allow' }) }, false)
  const url = JSON.parse(readFileSync(settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url
  assert.equal(JSON.parse(readFileSync(settings, 'utf8')).permissions, undefined, 'without asks the person\'s own rules stand')
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 200)
  hooks.detach(key)
  assert.equal(existsSync(settings), true, 'a task that is only not heard keeps its file: its session may be opened again')
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 404)
  await hooks.forget(key)
  assert.equal(existsSync(settings), false)
  await hooks.attach({ permission: async () => null }, false)
  await hooks.close()
  assert.equal(existsSync(path.dirname(settings)), false, 'the temporary folder goes when the server closes')
})

test('with a folder to keep things in, the address and the settings stay from one run to the next', { timeout: 30_000 }, async () => {
  const keep = scratch()
  const first = new T.HookServer(keep)
  const a = await first.attach({ permission: async () => null }, false)
  const url = JSON.parse(readFileSync(a.settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url
  await first.close()
  assert.equal(existsSync(a.settings), true, 'closing the server does not take the settings of a task that goes on')
  assert.ok(existsSync(path.join(keep, 'address.json')))
  const second = new T.HookServer(keep)
  try {
    const b = await second.attach({ permission: async () => ({ behavior: 'allow' }) }, false, a.key)
    assert.equal(b.key, a.key, 'the same task key')
    assert.equal(b.settings, a.settings)
    assert.equal(JSON.parse(readFileSync(b.settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url, url, 'the same address, so a session that kept the old one is heard again')
    assert.equal(second.portMoved, false)
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 200)
    await assert.rejects(() => second.attach({ permission: async () => null }, false, '../etc/passwd'), /not a task key/)
  } finally {
    await second.close()
  }
})

test('when the port of the last run is taken, the address moves, and the settings written now carry it', { timeout: 30_000 }, async () => {
  const keep = scratch()
  const first = new T.HookServer(keep)
  const a = await first.attach({ permission: async () => null }, false)
  const old = new URL(JSON.parse(readFileSync(a.settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url)
  await first.close()
  const squatter = net.createServer()
  await new Promise((resolve) => squatter.listen(Number(old.port), '127.0.0.1', resolve))
  const second = new T.HookServer(keep)
  try {
    const b = await second.attach({ permission: async () => null }, false, a.key)
    const now = new URL(JSON.parse(readFileSync(b.settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url)
    assert.notEqual(now.port, old.port)
    assert.equal(second.portMoved, true, 'a task still running from before cannot be heard')
    assert.equal(now.pathname, old.pathname.replace(/\/[0-9a-f]{16}\/permission$/, `/${a.key}/permission`), 'the secret stays')
  } finally {
    squatter.close()
    await second.close()
  }
})

test('when the server closes, each request that waits ends with no decision and its task is told', { timeout: 30_000 }, async () => {
  const hooks = new T.HookServer()
  let gone
  const { settings } = await hooks.attach({ permission: (event, signal) => new Promise((resolve) => { gone = signal; signal.addEventListener('abort', () => resolve({ behavior: 'allow' })) }) }, false)
  const url = JSON.parse(readFileSync(settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url
  const request = fetch(url, { method: 'POST', body: JSON.stringify({ tool_name: 'Bash' }) })
  await until(() => gone, 'the request to arrive')
  await hooks.close()
  const answer = await request
  assert.equal(answer.status, 200)
  assert.equal(await answer.text(), '', 'no decision: Claude Code asks on its own screen')
  assert.equal(gone.aborted, true)
})

// ---- Starting a task ----

test('a task starts in the background with a hook of its own, its words after --, and its screen open', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const { backend, home, keep, text } = claude()
  try {
    assert.equal((await backend.detect()).installed, true)
    const task = await backend.start({ folder: dir, prompt: '--help me. say ok', title: 'Port "the" settings & screen', asks: true })
    assert.equal(task.runner, 'claude')
    assert.equal(task.title, 'Port "the" settings & screen')
    assert.match(task.screen.job, /^[0-9a-f]{8}$/)
    assert.equal(task.screen.line, `claude attach ${task.screen.job}`)
    const record = job(home, task.screen.job)
    assert.equal(record.cwd, dir, 'in the task folder')
    assert.deepEqual(record.args.slice(0, 1), ['--settings'])
    assert.equal(record.args[2], '--name=Port "the" settings & screen', 'the name as one argument')
    assert.deepEqual(record.args.slice(3), ['--', '--help me. say ok'], 'the words go after --, so they are never read as flags')
    assert.ok(record.settings.startsWith(path.join(keep, 'hooks')), 'the settings are in the kept folder')
    const config = JSON.parse(readFileSync(record.settings, 'utf8'))
    assert.deepEqual(config.permissions.ask.slice(0, 2), ['Bash', 'PowerShell'], 'asks was asked for')
    assert.equal(task.state === 'working' || task.state === 'idle', true)
    assert.ok(task.terminal, 'its screen is open here')
    assert.equal(task.screen.open, true)
    assert.ok(task.screen.screenId)
    const key = `claude:${task.id}`
    await until(() => text(key).includes('fine, --help me. say ok'), 'the session to answer on its screen')
    await until(() => task.state === 'idle', 'the turn to end', 15_000)
  } finally {
    await backend.close()
  }
})

test('a task started without asks leaves the person\'s own rules alone', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: dir, prompt: '', title: 'Own rules' })
    assert.equal(JSON.parse(readFileSync(job(home, task.screen.job).settings, 'utf8')).permissions, undefined)
    assert.equal(task.state, 'idle', 'nothing was asked of it yet')
  } finally {
    await backend.close()
  }
})

test('a folder Claude Code has not been opened in is told in words, and nothing is left behind', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const { backend, keep } = claude({ env: { FAKE_UNTRUSTED: '1' } })
  try {
    await assert.rejects(() => backend.start({ folder: dir, prompt: 'hello', title: 'New folder' }), /has not been opened in .* yet.*Run claude there, say yes, and start the task again/s)
    assert.deepEqual(readdirSync(path.join(keep, 'hooks')), [], 'the settings made for it are gone')
  } finally {
    await backend.close()
  }
})

test('words too long for a command line are not started with', async () => {
  const { backend } = claude()
  try {
    await assert.rejects(() => backend.start({ folder: scratch(), prompt: 'x'.repeat(20_001), title: 'Long' }), /too long/)
  } finally {
    await backend.close()
  }
})

// ---- What a session asks ----

test('a command that asks is a request in Togle, answered once, and what the person answers reaches the session', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const { backend, text } = claude()
  try {
    const task = await backend.start({ folder: dir, prompt: '', title: 'Asks' })
    const events = watch(task)
    const key = `claude:${task.id}`
    type(task, 'run a')
    await until(() => task.pending.length === 1, 'the request')
    assert.equal(task.state, 'waiting')
    assert.equal(task.pending[0].kind, 'command')
    assert.equal(task.pending[0].command, 'echo x > a.txt')
    task.answer(task.pending[0].id, 'allow-once')
    await until(() => text(key).includes('ran a'), 'the command to run')
    await until(() => task.pending.length === 0 && task.state === 'idle', 'the turn to end')
    type(task, 'run b')
    await until(() => task.pending.length === 1, 'the second request')
    task.answer(task.pending[0].id, 'refuse')
    await until(() => text(key).includes('refused b'), 'the refusal to reach it')
    assert.deepEqual(events.filter((event) => event.type === 'request-ended').map((event) => event.outcome), ['allowed', 'refused'])
  } finally {
    await backend.close()
  }
})

test('a question is answered in words, with the choices the agent gave', { timeout: 40_000 }, async () => {
  const { backend, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Asks a question' })
    const key = `claude:${task.id}`
    type(task, 'question')
    await until(() => task.pending.length === 1, 'the question')
    const [request] = task.pending
    assert.equal(request.kind, 'question')
    assert.deepEqual(request.questions[0].options, ['red', 'blue'])
    task.reply(request.id, 'blue')
    await until(() => text(key).includes('answered blue'), 'the answer to reach it')
  } finally {
    await backend.close()
  }
})

test('a plan to approve is shown whole, with two answers and room for words, and what is answered reaches Claude Code', { timeout: 40_000 }, async () => {
  const { backend, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Plans' })
    const key = `claude:${task.id}`
    for (const [answer, shown] of [['Approve the plan', 'plan approved'], ['Keep planning', 'plan sent back: The person wants the plan changed'], ['Add a test first', 'plan sent back: The person asked for changes to the plan: Add a test first']]) {
      type(task, 'plan')
      await until(() => task.pending.length === 1, 'the plan')
      const [request] = task.pending
      assert.equal(request.kind, 'question')
      assert.equal(request.questions[0].text, '1. Do A\n2. Do B', 'the plan itself, whole')
      assert.deepEqual(request.questions[0].options, ['Approve the plan', 'Keep planning'])
      assert.equal(request.questions[0].free, true)
      task.reply(request.id, answer)
      await until(() => text(key).includes(shown), `"${shown}" to reach it`)
      await until(() => task.state === 'idle' && task.pending.length === 0, 'the turn to end')
    }
  } finally {
    await backend.close()
  }
})

test('a command answered on the screen is no longer asked in Togle, once the program says it waits no more', { timeout: 40_000 }, async () => {
  const { backend, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Answered here' })
    const key = `claude:${task.id}`
    type(task, 'run c')
    await until(() => task.pending.length === 1, 'the request')
    // The list has to say it waits first, and then that it does not.
    await sleep(500)
    type(task, 'y')
    await until(() => task.pending.length === 0, 'the card to go', 15_000)
    assert.ok(text(key).includes('ran c (answered here)'))
  } finally {
    await backend.close()
  }
})

test('what is asked while the screen is closed shows as a request, and is answered from Togle', { timeout: 40_000 }, async () => {
  const { backend, home, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Screen closed' })
    const key = `claude:${task.id}`
    await task.screen.hide()
    assert.equal(task.terminal, undefined)
    const other = await another(home, task.screen.job)
    other.write('run d\r')
    await until(() => task.pending.length === 1, 'the request while the screen is closed')
    task.answer(task.pending[0].id, 'allow-once')
    await until(() => task.state === 'idle', 'the turn to end')
    other.destroy()
    // The screen the person opens next shows what was said meanwhile.
    await task.screen.show()
    await until(() => text(key).includes('ran d'), 'the screen to show what happened')
  } finally {
    await backend.close()
  }
})

test('a session that waits with no request of Togle\'s own says what it waits for, and is answered on its screen', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const { backend, home } = claude()
  try {
    // Started by the person in their own terminal: it has no hook of Togle's.
    const out = execFileSync(process.execPath, [fakeBg, '--bg', '--name=theirs'], { cwd: dir, env: { ...process.env, FAKE_CLAUDE_HOME: home }, encoding: 'utf8' })
    const theirs = /backgrounded · ([0-9a-f]{8})/.exec(out)[1]
    const row = (await backend.list()).find((task) => task.job === theirs)
    assert.ok(row, 'it is listed, with the id its screen opens with')
    assert.equal(row.pid, undefined, 'a session in the background has no program of its own to take over')
    const task = await backend.resume(row.id, { folder: dir, job: theirs })
    assert.equal(task.title, 'theirs')
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen here to be connected')
    const other = await another(home, theirs)
    other.write('run e\r')
    await until(() => task.state === 'waiting' && task.waitingFor, 'the list to say it waits')
    assert.equal(task.waitingFor, 'permission prompt')
    assert.equal(task.pending.length, 0, 'Togle has no request to show for it')
    other.destroy()
  } finally {
    await backend.close()
  }
})

// ---- The screen ----

test('the screen closes and opens again, a new one each time, and the task goes on', { timeout: 40_000 }, async () => {
  const { backend, home, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Screens' })
    const key = `claude:${task.id}`
    const events = watch(task)
    const first = task.screen.screenId
    type(task, 'before')
    await until(() => text(key).includes('fine, before'), 'the first words')
    const pid = job(home, task.screen.job).pid
    await task.screen.hide()
    assert.equal(task.terminal, undefined)
    assert.equal(task.screen.open, false)
    assert.equal(alive(pid), true, 'the session goes on when its screen closes')
    await task.screen.show()
    assert.notEqual(task.screen.screenId, first)
    assert.equal(job(home, task.screen.job).pid, pid, 'the same session')
    assert.ok(events.some((event) => event.type === 'screen' && event.shown === false) && events.some((event) => event.type === 'screen' && event.shown === true))
    await until(() => task.terminal.read().text.includes('fine, before'), 'what was said to show on the new screen')
  } finally {
    await backend.close()
  }
})

test('a reply from the cards view is typed in with Enter, and opens a closed screen out of sight', { timeout: 40_000 }, async () => {
  const { backend, home, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Replies' })
    const key = `claude:${task.id}`
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    await task.send('first reply')
    await until(() => text(key).includes('fine, first reply'), 'the reply to be answered')
    assert.equal(task.state, 'working', 'it works from the reply, before the list says so')
    // A second task, whose screen is closed: the reply opens it again.
    const other = await backend.start({ folder: scratch(), prompt: '', title: 'Closed' })
    const otherKey = `claude:${other.id}`
    await until(() => other.terminal.read().text.includes('fake claude ready'), 'the second screen to be connected')
    await other.screen.hide()
    assert.equal(other.terminal, undefined)
    const pid = job(home, other.screen.job).pid
    await other.send('while closed')
    assert.ok(other.terminal, 'the reply opened its screen')
    assert.equal(job(home, other.screen.job).pid, pid, 'the same session')
    await until(() => text(otherKey).includes('fine, while closed'), 'the reply to be answered on the screen that opened')
  } finally {
    await backend.close()
  }
})

test('a reply is refused while the session asks, and when it is a command of the agent’s own', { timeout: 40_000 }, async () => {
  const { backend, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Refused' })
    const key = `claude:${task.id}`
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    await assert.rejects(() => task.send('/model'), /command is typed on the agent/)
    await assert.rejects(() => task.send('!ls'), /command is typed on the agent/)
    type(task, 'question')
    await until(() => task.pending.length === 1, 'the question to be asked')
    await assert.rejects(() => task.send('red'), /waits for you on its screen/, 'a line typed then would answer the question on its screen')
    task.reply(task.pending[0].id, 'red')
    await until(() => task.pending.length === 0, 'the question to be answered')
    await until(() => task.state === 'idle', 'the turn to end', 20_000)
    await task.send('now')
    await until(() => text(key).includes('fine, now'), 'the words to be typed and answered')
  } finally {
    await backend.close()
  }
})

test('words sent while the session only works are typed at once, as on its screen: its own queue takes them', { timeout: 40_000 }, async () => {
  const { backend, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Busy' })
    const key = `claude:${task.id}`
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    type(task, 'slow')
    await until(() => task.state === 'working', 'the turn to be at work')
    // Not refused, not waiting: typed on the screen while it works, and answered when the turn gets to it.
    await task.send('also this')
    assert.equal(task.state, 'working')
    await until(() => text(key).includes('fine, also this'), 'the queued words to be taken in and answered', 20_000)
  } finally {
    await backend.close()
  }
})

test('a screen opened in another window closes this one, which says so, and the task stays', { timeout: 40_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Taken' })
    const events = watch(task)
    // The screen here connects a moment after it was started: the other window comes after it, as the test is about.
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen here to be connected')
    const other = await another(home, task.screen.job)
    await until(() => !task.screen.open, 'the screen here to close')
    assert.equal(task.screen.closed, 'It is open in another window.')
    assert.equal(events.some((event) => event.type === 'ended'), false)
    assert.ok(alive(job(home, task.screen.job).pid))
    other.destroy()
    await task.screen.show()
    assert.equal(task.screen.closed, undefined, 'opened here again, it is not closed any more')
  } finally {
    await backend.close()
  }
})

test('a screen that cannot open says why, and the task goes on', { timeout: 40_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Settings gone' })
    await task.endCommands()
    // The session was given a settings file, and a stopped one reads it once more when it comes back.
    rmSync(job(home, task.screen.job).settings, { force: true })
    await task.screen.show()
    await until(() => !task.screen.open, 'the screen to close')
    assert.match(task.screen.closed, /Settings file not found/)
  } finally {
    await backend.close()
  }
})

test('"/clear" goes on in another session, and the task keeps its id and is not listed twice', { timeout: 40_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Cleared' })
    const id = task.id
    const events = watch(task)
    type(task, 'clear')
    await until(() => task.screen.session() !== id, 'the session to change')
    assert.equal(task.id, id)
    assert.equal(task.screen.session(), job(home, task.screen.job).sessionId)
    assert.ok(events.some((event) => event.type === 'cleared'))
    const listed = (await backend.list()).filter((row) => row.job === task.screen.job)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, id)
  } finally {
    await backend.close()
  }
})

// ---- Stopping, and coming back ----

test('Stop is Esc on the session\'s screen: the turn ends, the program and its conversation go on, and a reply goes into the same session', { timeout: 60_000 }, async () => {
  const { backend, home, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Stop is Esc' })
    const key = `claude:${task.id}`
    const jobId = task.screen.job
    const pid = job(home, jobId).pid
    const sessionId = job(home, jobId).sessionId
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    type(task, 'long')
    await until(() => task.state === 'working', 'the turn to be at work')
    await task.stop()
    await until(() => task.state === 'idle', 'the turn to end')
    assert.equal(job(home, jobId).escapes, 1, 'one Esc reached the session')
    assert.equal(alive(pid), true, 'the same program runs')
    assert.equal(job(home, jobId).sessionId, sessionId, 'the same session and conversation')
    assert.equal(job(home, jobId).state, undefined, 'the session was not ended: `claude stop` was not run')
    assert.equal(task.screen.open, true, 'its screen is still open')
    assert.ok(text(key).includes('Interrupted'), 'the screen shows that the turn was interrupted')
    // A reply after it goes into the same session, which takes it as a new turn.
    await task.send('again')
    await until(() => text(key).includes('fine, again'), 'the reply to be answered')
    assert.equal(job(home, jobId).sessionId, sessionId)
  } finally {
    await backend.close()
  }
})

test('Stop on a closed screen opens it out of sight and presses Esc once it takes keys: a key before that is lost', { timeout: 60_000 }, async () => {
  // The stand-in loses what a screen is given in its first 1.2 seconds, as Claude Code does (0.3 s lost, 1.5 s taken); Stop waits 2 s.
  const { backend, home } = claude({ env: { FAKE_CLAUDE_READY_MS: '1200' } })
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'long', title: 'Closed and stopped' })
    const jobId = task.screen.job
    await until(() => task.state === 'working', 'the turn to be at work')
    await task.screen.hide()
    assert.equal(task.terminal, undefined)
    await task.stop()
    assert.ok(task.terminal, 'Stop opened its screen')
    await until(() => task.state === 'idle', 'the turn to end')
    assert.equal(job(home, jobId).escapes, 1, 'the Esc was taken, not lost')
    assert.equal(alive(job(home, jobId).pid), true, 'the session goes on')
  } finally {
    await backend.close()
  }
})

// A prompt as Claude Code 2.1.328 edits it (tried on a prompt of three lines): Ctrl+A goes to the start of its line, Ctrl+K takes the rest of the line
// away, and Backspace takes the character before the cursor away (at the start of a line, the break before it, which joins it to the line above).
const editedBy = (prompt, keys) => {
  const lines = prompt.split('\n')
  let row = lines.length - 1
  let col = lines[row].length
  for (const key of keys) {
    if (key === '\x01') col = 0
    else if (key === '\x0b') lines[row] = lines[row].slice(0, col)
    else if (key === '\x7f') {
      if (col > 0) { lines[row] = lines[row].slice(0, col - 1) + lines[row].slice(col); col-- }
      else if (row > 0) { col = lines[row - 1].length; lines[row - 1] += lines[row]; lines.splice(row, 1); row-- }
    }
  }
  return lines.join('\n')
}

test('the keys that empty the prompt after the queue was given back empty it: one message, several, with lines of their own, long ones; and do nothing more to an empty one', () => {
  for (const words of [['one'], ['first queued', 'second queued'], ['a\nb\nc', 'd'], ['x'.repeat(300)], ['x'.repeat(100) + '\n' + 'y'.repeat(100), 'z']]) {
    assert.equal(editedBy(words.join('\n'), T.clearKeys(words)), '', JSON.stringify(words).slice(0, 50))
  }
  assert.equal(editedBy('', T.clearKeys(['one'])), '', 'an empty prompt stays empty')
  // Ctrl+C and Esc would stop the turn that is running: neither is among the keys.
  assert.equal(/[\x03\x1b]/.test(T.clearKeys(['one', 'two'])), false)
})

test('Take back presses the Up arrow once on a screen that was closed, once it takes keys, and empties the prompt a line at a time, without stopping the turn', { timeout: 60_000 }, async () => {
  // The stand-in loses what a screen is given in its first 1.2 seconds, as Claude Code does; the keys wait for 2 s.
  const { backend, home } = claude({ env: { FAKE_CLAUDE_READY_MS: '1200' } })
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'long', title: 'Take back' })
    const jobId = task.screen.job
    await until(() => task.state === 'working', 'the turn to be at work')
    await task.screen.hide()
    assert.equal(task.terminal, undefined)
    const words = ['first queued', 'second queued\nwith two lines']
    // The record: the queue as it is when the screen takes keys, and empty once the arrow reached the session (what it shows when the arrow gave it back).
    const read = async () => ({ queued: job(home, jobId).ups ? [] : words, said: ['Fix it'] })
    assert.deepEqual(await task.takeBackQueue(read), words, 'the words came back, in the order they were queued')
    assert.ok(task.terminal, 'its screen was opened out of sight')
    const keys = T.clearKeys(words)
    const count = (key) => keys.split(key).length - 1
    await until(() => job(home, jobId).kills === count('\x0b'), 'the prompt to be emptied')
    const seen = job(home, jobId)
    assert.equal(seen.ups, 1, 'the Up arrow was pressed once, and taken')
    assert.equal(seen.homes, count('\x01'))
    assert.equal(seen.backspaces, count('\x7f'))
    assert.equal(seen.escapes, undefined, 'no Esc')
    assert.equal(seen.downs, 0, 'and no Down: the arrow did give the queue back')
    assert.equal(task.state, 'working', 'the turn goes on')
    assert.equal(alive(seen.pid), true)
  } finally {
    await backend.close()
  }
})

test('Take back that the record does not confirm puts back what the arrow did and says nothing was changed: the prompt is not emptied, it may hold what a person typed', { timeout: 60_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'long', title: 'Not given back' })
    const jobId = task.screen.job
    await until(() => task.state === 'working', 'the turn to be at work')
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    // The record still shows the queue after the arrow: the turn had taken it in already, or the key was lost.
    await assert.rejects(task.takeBackQueue(async () => ({ queued: ['one'], said: [] })), /did not give its queue back/)
    await until(() => job(home, jobId).downs === 1, 'Down to reach the session')
    await sleep(300)
    const seen = job(home, jobId)
    assert.equal(seen.ups, 1, 'the arrow was pressed once')
    assert.equal(seen.downs, 1, 'and Down put back what it did (an earlier prompt, or the cursor)')
    assert.ok(!seen.kills && !seen.backspaces, 'nothing was cleared')
    assert.equal(task.state, 'working', 'the turn goes on')
  } finally {
    await backend.close()
  }
})

test('Take back returns only words that came back: what the turn took in meanwhile is in the conversation, not in the box; with nothing queued nothing is pressed', { timeout: 60_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'long', title: 'Taken in' })
    const jobId = task.screen.job
    await until(() => task.state === 'working', 'the turn to be at work')
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    // Nothing waits: the arrow is not pressed.
    assert.deepEqual(await task.takeBackQueue(async () => ({ queued: [], said: ['Fix it'] })), [])
    await sleep(300)
    assert.equal(job(home, jobId).ups, undefined, 'no key was pressed')
    // Two wait; by the time the arrow reaches it the turn has taken "One" in (it is said now), and "Two" came back.
    const read = async () => (job(home, jobId).ups ? { queued: [], said: ['Fix it', 'One'] } : { queued: ['One', 'Two'], said: ['Fix it'] })
    assert.deepEqual(await task.takeBackQueue(read), ['Two'])
    const kills = T.clearKeys(['One', 'Two']).split('\x0b').length - 1
    await until(() => job(home, jobId).kills === kills, 'the prompt to be emptied, for what was queued when the arrow was pressed')
  } finally {
    await backend.close()
  }
})

test('Take back presses nothing while a question or a permission waits on the screen: the arrow would move its choice', { timeout: 60_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Waiting' })
    const jobId = task.screen.job
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    type(task, 'run a')
    await until(() => task.pending.length === 1, 'the request')
    await assert.rejects(task.takeBackQueue(async () => ({ queued: ['one'], said: [] })), /waits for you on its screen/)
    await sleep(300)
    assert.equal(job(home, jobId).ups, undefined, 'no key was pressed')
    assert.equal(job(home, jobId).kills, undefined)
    task.answer(task.pending[0].id, 'allow-once')
  } finally {
    await backend.close()
  }
})

test('Stop pressed twice presses Esc once, and presses none for a session that is not at work: two Esc close together open the rewind menu, which takes the next words', { timeout: 60_000 }, async () => {
  const { backend, home, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Careful' })
    const key = `claude:${task.id}`
    const jobId = task.screen.job
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    type(task, 'long')
    await until(() => task.state === 'working', 'the turn to be at work')
    await Promise.all([task.stop(), task.stop()])
    await until(() => task.state === 'idle', 'the turn to end')
    assert.equal(job(home, jobId).escapes, 1, 'two presses, one Esc')
    // Idle: nothing is pressed (on a prompt with words in it, Esc asks to clear them).
    await task.stop()
    await sleep(300)
    assert.equal(job(home, jobId).escapes, 1, 'nothing at work, nothing pressed')
    assert.equal(text(key).includes('Rewind menu'), false, 'the rewind menu did not open')
    await task.send('still here')
    await until(() => text(key).includes('fine, still here'), 'the next words to be taken as a message')
  } finally {
    await backend.close()
  }
})

test('Stop where the screen cannot be used ends the session instead, and opening it brings it back', { timeout: 60_000 }, async () => {
  const { backend, home } = claude({ env: { FAKE_ATTACH_FAILS: '1' } })
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'long', title: 'No screen' })
    const jobId = task.screen.job
    await until(() => task.state === 'working', 'the turn to be at work')
    const pid = job(home, jobId).pid
    await task.stop()
    await until(() => !alive(pid), 'the program to end')
    assert.equal(task.state, 'stopped')
    assert.equal(job(home, jobId).escapes, undefined, 'no Esc could reach it')
  } finally {
    await backend.close()
  }
})

test('End it ends the session and closes its screen; opening it brings the same session back', { timeout: 60_000 }, async () => {
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'End it' })
    const id = task.id
    const sessionId = job(home, task.screen.job).sessionId
    const pid = job(home, task.screen.job).pid
    await task.endCommands()
    await until(() => !alive(pid), 'the program to end')
    assert.equal(task.state, 'stopped')
    assert.equal(task.screen.open, false, 'its screen was a client of the session that is gone')
    assert.equal(task.pending.length, 0)
    const again = await backend.resume(id, { folder: task.folder, job: task.screen.job })
    assert.equal(again, task, 'the same task')
    await until(() => alive(job(home, task.screen.job).pid), 'the session to come back')
    assert.equal(job(home, task.screen.job).sessionId, sessionId, 'the same session and conversation')
    assert.equal(task.screen.open, true)
    await until(() => task.state === 'idle', 'the list to say it is running')
  } finally {
    await backend.close()
  }
})

test('a task that has done nothing for a day is put to rest: its program ends, it stays Done and waits for nothing, and opening it brings the same session back', { timeout: 60_000 }, async () => {
  // A day is 600 milliseconds here, and the session's file says it was written long ago.
  const { backend, home } = claude({ backend: { restMs: 600, written: async () => 1, every: { busy: 100, idle: 100 } } })
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Rest' })
    const id = task.id
    const sessionId = job(home, task.screen.job).sessionId
    const pid = job(home, task.screen.job).pid
    await sleep(1500)
    assert.ok(alive(pid), 'a session with a screen of Togle open on it is left alone')
    await task.screen.hide()
    await until(() => !alive(pid), 'the program to end once its screen was closed and a day had passed')
    // The list says it has no program and was stopped: for a task at rest that is still Done, not a task that waits for the person.
    await until(() => job(home, task.screen.job).pid === undefined, 'the session to say it has no program')
    await sleep(600)
    assert.equal(task.state, 'idle', 'at rest, it is Done')
    assert.equal(T.needsYou({ state: task.state, mine: true, terminal: !!task.terminal }), false, 'and it waits for nothing')
    assert.equal(task.pending.length, 0)
    assert.equal((await backend.list()).find((row) => row.id === id)?.state, 'idle', 'the list says Done too')
    // Opening it, from either view, brings the same session back.
    const again = await backend.resume(id, { folder: task.folder, job: task.screen.job })
    assert.equal(again, task, 'the same task')
    await until(() => alive(job(home, task.screen.job).pid), 'the session to come back')
    assert.equal(job(home, task.screen.job).sessionId, sessionId, 'the same session and conversation')
    assert.equal(task.screen.open, true)
    await sleep(1200)
    assert.ok(alive(job(home, task.screen.job).pid), 'not put to rest again while its screen is open')
    // A reply from the Chat view brings a task at rest back too, and the words reach it.
    await task.screen.hide()
    await until(() => !alive(job(home, task.screen.job).pid), 'it to rest again')
    await task.send('hello again')
    await until(() => alive(job(home, task.screen.job).pid), 'the session to come back for the reply')
    assert.equal(job(home, task.screen.job).sessionId, sessionId, 'the same session again')
  } finally {
    await backend.close()
  }
})

test('a task with a command still running in the background says so, tells the window when that changes, and is not put to rest', { timeout: 60_000 }, async () => {
  // Claude Code's own folder, apart from the stand-in's: a job's state file lists what it started.
  const config = scratch()
  const { backend, home } = claude({ env: { CLAUDE_CONFIG_DIR: config }, backend: { restMs: 600, written: async () => 1, every: { busy: 100, idle: 100 } } })
  const state = (job, fan) => { mkdirSync(path.join(config, 'jobs', job), { recursive: true }); writeFileSync(path.join(config, 'jobs', job, 'state.json'), JSON.stringify({ state: 'done', tempo: 'idle', fan })) }
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Shell' })
    const pid = job(home, task.screen.job).pid
    const events = watch(task)
    await task.screen.hide()
    await sleep(300)
    assert.deepEqual([...task.shells], [], 'nothing runs in the background')
    // A command it started runs: said by the task and the list, and the window is told.
    state(task.screen.job, [{ id: 'b0000001', kind: 'shell', label: 'npm run dev', startedAt: Date.now() }])
    await until(() => task.shells.length === 1, 'the task to say what runs')
    assert.equal(task.shells[0].label, 'npm run dev')
    assert.ok(events.some((event) => event.type === 'shells'), 'the window is told, with no change of state')
    assert.deepEqual((await backend.list()).find((row) => row.id === task.id)?.shells?.map((item) => item.label), ['npm run dev'], 'the list says it too')
    // More than a quiet day (600 ms here) with the command running: its program, and the command with it, is left alone.
    await sleep(2000)
    assert.ok(alive(pid), 'a task with a command running is not put to rest')
    // The command ended: nothing runs, and the quiet day counts.
    state(task.screen.job, [])
    await until(() => task.shells.length === 0, 'the task to say nothing runs')
    await until(() => !alive(pid), 'the program to end once nothing ran and a day had passed')
  } finally {
    await backend.close()
  }
})

test('a task that waits, was written lately, or that the person has open in their own terminal is not put to rest', { timeout: 90_000 }, async () => {
  let lately = true
  const { backend, home } = claude({ backend: { restMs: 400, written: async () => (lately ? Date.now() : 1), every: { busy: 100, idle: 100 } } })
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Quiet' })
    const pid = () => job(home, task.screen.job).pid
    type(task, 'run a')
    await until(() => task.pending.length === 1, 'the request')
    await task.screen.hide()
    await sleep(1500)
    assert.ok(alive(pid()), 'a task that waits for the person is left alone')
    task.answer(task.pending[0].id, 'allow-once')
    await until(() => task.pending.length === 0 && task.state === 'idle', 'the turn to end')
    await sleep(1500)
    assert.ok(alive(pid()), 'a session written lately is left alone, however long Togle has watched')
    // The person has it open in a terminal of their own.
    lately = false
    const own = spawn(process.execPath, [fakeBg, 'attach', task.screen.job], { env: { ...process.env, FAKE_CLAUDE_HOME: home }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    try {
      await sleep(2500)
      assert.ok(alive(pid()), 'a session the person has open in their own terminal is left alone')
    } finally {
      own.kill()
    }
    await until(() => !alive(pid()), 'the program to end once nothing had it open', 20_000)
    assert.equal(task.state === 'stopped', false, 'it is not a task the person stopped')
  } finally {
    await backend.close()
  }
})

test('a restart of Togle does not start the quiet day again: a session quiet since before it is put to rest as soon as it is seen', { timeout: 60_000 }, async () => {
  // A day is 3 seconds here. The first Togle starts a session and lets go of its screen; the next starts after the day has passed.
  const first = claude({ backend: { restMs: 3_000, written: async () => 1, every: { busy: 100, idle: 100 } } })
  let pid
  try {
    const task = await first.backend.start({ folder: scratch(), prompt: '', title: 'Before' })
    pid = job(first.home, task.screen.job).pid
    await task.screen.hide()
  } finally {
    // Closing Togle leaves the session running.
    await first.backend.close()
  }
  assert.ok(alive(pid), 'it goes on without Togle')
  await sleep(3_300)
  const next = claude({ home: first.home, keep: first.keep, backend: { restMs: 3_000, written: async () => 1, every: { busy: 100, idle: 100 } } })
  try {
    const taken = []
    await next.backend.restore((task) => taken.push(task))
    assert.equal(taken.length, 1, 'the new Togle took the session up')
    // Counted from when it was last seen to work (never, by this Togle), when it started and when its file was written: all over
    // a day ago, so it rests at once, and not another day after this Togle started.
    await until(() => !alive(pid), 'the session to be put to rest', 2_000)
    await until(() => taken[0].state === 'idle', 'it to stay Done')
  } finally {
    await next.backend.close()
  }
})

test('a request that waits when the task is stopped is not answered by Togle: Esc declines the question on the screen, and the session goes on', { timeout: 40_000 }, async () => {
  const { backend, home, text } = claude()
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Stop with a request' })
    const key = `claude:${task.id}`
    await until(() => task.terminal.read().text.includes('fake claude ready'), 'the screen to be connected')
    type(task, 'run f')
    await until(() => task.pending.length === 1, 'the request')
    await task.stop()
    assert.equal(task.pending.length, 0, 'the card is gone: nothing of Togle\'s answers it')
    await until(() => text(key).includes('refused f'), 'the question to be declined on its screen')
    assert.equal(job(home, task.screen.job).escapes, 1)
    await until(() => task.state === 'idle', 'the turn to end')
  } finally {
    await backend.close()
  }
})

test('the end of a turn is told with what the session said last, before the task is done', { timeout: 40_000 }, async () => {
  const { backend } = claude({ backend: { said: async () => 'Added the column. The tests pass.' } })
  try {
    const task = await backend.start({ folder: scratch(), prompt: '', title: 'Says' })
    const events = watch(task)
    type(task, 'run g')
    await until(() => task.pending.length === 1, 'the request')
    await sleep(400)
    task.answer(task.pending[0].id, 'allow-once')
    await until(() => task.state === 'idle' && events.some((event) => event.type === 'message'), 'the turn to end with its words')
    assert.deepEqual(events.filter((event) => event.type === 'message').map((event) => event.text), ['Added the column. The tests pass.'])
    const at = (type) => events.findIndex((event) => event.type === type)
    assert.ok(at('message') < events.findLastIndex((event) => event.type === 'state' && event.state === 'idle'), 'the words come before done')
  } finally {
    await backend.close()
  }
})

// ---- Quitting Togle, and the next run ----

test('quitting Togle leaves the session running, and a new Togle takes it up and hears it ask', { timeout: 60_000 }, async () => {
  const dir = scratch()
  const home = scratch()
  const keep = scratch()
  const a = claude({ home, keep })
  const task = await a.backend.start({ folder: dir, prompt: '', title: 'Outlives Togle' })
  const jobId = task.screen.job
  const pid = job(home, jobId).pid
  const settings = job(home, jobId).settings
  const url = JSON.parse(readFileSync(settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url
  type(task, 'run h')
  await until(() => task.pending.length === 1, 'the request')
  await a.backend.close()
  assert.equal(task.pending.length, 0, 'what waited is left to the session\'s own screen')
  assert.equal(alive(pid), true, 'the session goes on')
  assert.equal(existsSync(settings), true)
  assert.ok(JSON.parse(readFileSync(path.join(keep, 'jobs.json'), 'utf8')).jobs.some((known) => known.job === jobId))
  // The next run: the same address, the same task.
  const b = claude({ home, keep })
  const adopted = []
  try {
    await b.backend.restore((handle) => adopted.push(handle))
    assert.equal(adopted.length, 1)
    const back = adopted[0]
    assert.equal(back.screen.job, jobId)
    assert.equal(back.id, task.id)
    assert.equal(back.title, 'Outlives Togle')
    assert.equal(back.terminal, undefined, 'its screen is not open until someone looks')
    assert.equal(JSON.parse(readFileSync(settings, 'utf8')).hooks.PermissionRequest[0].hooks[0].url, url, 'the address did not change')
    // The session that asked before Togle quit asks again, and is heard at the address it kept.
    const other = await another(home, jobId)
    other.write('y\r')
    other.write('run i\r')
    await until(() => back.pending.length === 1 && back.pending[0].command === 'echo x > i.txt', 'a request after the restart')
    back.answer(back.pending[0].id, 'allow-once')
    await until(() => back.state === 'idle', 'the turn to end')
    other.destroy()
  } finally {
    await b.backend.close()
  }
})

test('a task that was removed meanwhile is forgotten, with its settings', { timeout: 40_000 }, async () => {
  const home = scratch()
  const keep = scratch()
  const a = claude({ home, keep })
  const task = await a.backend.start({ folder: scratch(), prompt: '', title: 'Removed' })
  const settings = job(home, task.screen.job).settings
  await a.backend.close()
  execFileSync(process.execPath, [fakeBg, '__killall'], { env: { ...process.env, FAKE_CLAUDE_HOME: home } })
  await sleep(200)
  rmSync(path.join(home, 'jobs', `${task.screen.job}.json`))
  const b = claude({ home, keep })
  try {
    await b.backend.restore(() => assert.fail('nothing is running'))
    assert.deepEqual(JSON.parse(readFileSync(path.join(keep, 'jobs.json'), 'utf8')).jobs, [])
    assert.equal(existsSync(settings), false)
  } finally {
    await b.backend.close()
  }
})

test('a task of Togle\'s that the person opens in their own terminal later is Togle\'s again', { timeout: 60_000 }, async () => {
  const home = scratch()
  const keep = scratch()
  const a = claude({ home, keep })
  const task = await a.backend.start({ folder: scratch(), prompt: '', title: 'Comes back' })
  const jobId = task.screen.job
  await task.endCommands()
  await a.backend.close()
  const b = claude({ home, keep })
  const adopted = []
  let person
  try {
    await b.backend.restore((handle) => adopted.push(handle))
    assert.equal(adopted.length, 0, 'it is stopped: nothing to take up yet')
    // `claude attach` in the person's own terminal brings it back.
    person = spawn(process.execPath, [fakeBg, 'attach', jobId], { env: { ...process.env, FAKE_CLAUDE_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] })
    await until(() => adopted.length === 1, 'Togle to take the session up again', 15_000)
    assert.equal(adopted[0].screen.job, jobId)
    assert.equal(adopted[0].id, task.id)
  } finally {
    person?.kill()
    await b.backend.close()
  }
})

// ---- The list ----

test('the list says which sessions are in the background, and gives a program only to those in a terminal', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const sessionId = 'aaaa1111-0000-4000-8000-000000000001'
  const { backend, home } = claude({ backend: { stored: async () => [{ id: sessionId, title: 'Kept on disk', cwd: dir, updatedAt: 1000 }] } })
  try {
    writeFileSync(path.join(home, 'interactive.json'), JSON.stringify([{ pid: process.pid, sessionId: 'bbbb2222-0000-4000-8000-000000000002', cwd: dir, name: 'bbbb2222' }]))
    const task = await backend.start({ folder: dir, prompt: '', title: 'In the background' })
    const rows = await backend.list()
    const background = rows.find((row) => row.id === task.id)
    assert.equal(background.job, task.screen.job)
    assert.equal(background.pid, undefined)
    assert.equal(background.title, 'In the background')
    const terminal = rows.find((row) => row.id === 'bbbb2222-0000-4000-8000-000000000002')
    assert.equal(terminal.pid, process.pid, 'a program in a terminal can be taken over')
    assert.equal(terminal.job, undefined)
    assert.equal(terminal.title, path.basename(dir), 'a name that is only its id is no name')
    assert.equal(rows.find((row) => row.id === sessionId).title, 'Kept on disk')
  } finally {
    await backend.close()
  }
})

// ---- Opening what the list shows ----

test('a session kept on disk goes to the background as the same session, with the flags it had', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const id = 'abcdef12-0000-4000-8000-000000000003'
  const { backend, home } = claude({ backend: { stored: async () => [{ id, title: 'Old conversation', cwd: dir, updatedAt: 5 }] } })
  try {
    const task = await backend.resume(id, { folder: dir, flags: ['--model', 'haiku', '--permission-mode', 'plan'] })
    assert.equal(task.id, id)
    assert.equal(task.title, 'Old conversation')
    const record = job(home, task.screen.job)
    assert.equal(record.sessionId, id)
    assert.deepEqual(record.args.slice(0, 2), ['--resume', id])
    assert.deepEqual(record.args.slice(-4), ['--model', 'haiku', '--permission-mode', 'plan'])
    assert.ok(task.terminal, 'its screen is open')
  } finally {
    await backend.close()
  }
})

test('a session already in the background has its screen opened, never a copy started', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const { backend, home } = claude()
  try {
    const first = await backend.start({ folder: dir, prompt: '', title: 'One' })
    await first.screen.hide()
    const opened = await backend.resume(first.id, { folder: dir })
    assert.equal(opened, first)
    assert.equal(readdirSync(path.join(home, 'jobs')).length, 1, 'no second session')
    assert.equal(first.screen.open, true)
  } finally {
    await backend.close()
  }
})

test('a copy Claude Code starts instead of going on is ended, and the open fails in words', { timeout: 40_000 }, async () => {
  const dir = scratch()
  // The list does not show the running session, so Togle tries to start it: Claude Code says it already runs.
  const real = claude()
  const task = await real.backend.start({ folder: dir, prompt: '', title: 'Original' })
  const hidden = claude({ home: real.home, backend: { live: async () => [], stored: async () => [{ id: task.id, title: 'Original', cwd: dir, updatedAt: 1 }] } })
  try {
    await assert.rejects(() => hidden.backend.resume(task.id, { folder: dir }), /started a copy of that conversation.*nothing was changed/s)
    await sleep(2500)
    assert.deepEqual(readdirSync(path.join(real.home, 'jobs')), [`${task.screen.job}.json`], 'the copy is gone')
    assert.ok(alive(job(real.home, task.screen.job).pid), 'the original goes on')
  } finally {
    await hidden.backend.close()
    await real.backend.close()
  }
})

test('a conversation still open in a terminal is not started a second time', { timeout: 40_000 }, async () => {
  const dir = scratch()
  const id = 'cccc3333-0000-4000-8000-000000000004'
  const { backend, home } = claude({ backend: { stored: async () => [{ id, title: 'Open elsewhere', cwd: dir, updatedAt: 1 }] } })
  try {
    writeFileSync(path.join(home, 'interactive.json'), JSON.stringify([{ pid: process.pid, sessionId: id, cwd: dir }]))
    await assert.rejects(() => backend.resume(id, { folder: dir }), /still open in a terminal/)
    assert.equal(readdirSync(path.join(home, 'jobs')).length, 0)
  } finally {
    await backend.close()
  }
})

test('a session a terminal has open and a stopped background session that has it are one task, taken over from the terminal, and opened after', { timeout: 60_000 }, async () => {
  const dir = scratch()
  const { backend, home } = claude()
  try {
    const task = await backend.start({ folder: dir, prompt: '', title: 'Both' })
    await task.endCommands()
    await until(() => !alive(job(home, task.screen.job).pid), 'the session to end')
    writeFileSync(path.join(home, 'interactive.json'), JSON.stringify([{ pid: process.pid, sessionId: task.id, cwd: dir }]))
    // The list is reused for a moment: wait until it has seen the program.
    await until(async () => (await backend.list()).find((row) => row.id === task.id)?.pid === process.pid, 'the list to show the program in the terminal')
    const rows = (await backend.list()).filter((row) => row.id === task.id)
    assert.equal(rows.length, 1, 'one task')
    assert.equal(rows[0].pid, process.pid, 'the program in the terminal is the one to take over')
    assert.equal(rows[0].job, task.screen.job, 'and the background session is the one that opens after')
    // Opened while that program runs, it would split the conversation: refused, and nothing is started.
    await assert.rejects(() => backend.resume(task.id, { folder: dir, job: task.screen.job }), /still open in a terminal/)
    await assert.rejects(() => task.screen.show(), /still open in a terminal/)
    assert.match(task.screen.closed, /still open in a terminal/, 'and the task says why its screen is closed')
    assert.equal(alive(job(home, task.screen.job).pid), false, 'the stopped session stays stopped')
    // The program was ended (the hub does that first): now it opens, as the same session.
    writeFileSync(path.join(home, 'interactive.json'), '[]')
    const again = await backend.resume(task.id, { folder: dir, job: task.screen.job })
    assert.equal(again, task)
    await until(() => alive(job(home, task.screen.job).pid), 'the session to come back')
    assert.equal(job(home, task.screen.job).sessionId, task.id)
  } finally {
    await backend.close()
  }
})

test('a session that was removed is gone when it is opened', async () => {
  const { backend } = claude()
  try {
    await assert.rejects(() => backend.resume('dddd4444-0000-4000-8000-000000000005', { job: 'dddd4444' }), /gone/)
  } finally {
    await backend.close()
  }
})

// ---- What is read from the session's file, and from the list ----

test('what a session said last is the text of its last answer, without secrets, and nothing when it said none', async () => {
  const config = scratch()
  const id = 'eeee5555-0000-4000-8000-000000000006'
  const folder = path.join(config, 'projects', 'proj')
  mkdirSync(folder, { recursive: true })
  const line = (value) => JSON.stringify(value)
  writeFileSync(
    path.join(folder, `${id}.jsonl`),
    [
      line({ type: 'user', message: { role: 'user', content: 'do it' }, cwd: '/x', sessionId: id }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First, a plan.' }] } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done. The key is sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 and it is out.' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }),
      line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'A helper said this.' }] } })
    ].join('\n') + '\n'
  )
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  try {
    const said = await T.claudeLastSaid(id)
    assert.match(said, /^Done\. The key is \[secret removed\] and it is out\.$/)
    assert.equal(await T.claudeLastSaid('ffff6666-0000-4000-8000-000000000007'), '', 'a session with no file said nothing')
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
})

test('a row of the list is read as it is, and a session in the background is one with an id of its own', () => {
  const row = T.rowOf({ pid: 12, id: 'a1b2c3d4', cwd: '/w', kind: 'background', startedAt: 5, sessionId: 'a1b2c3d4-0000', name: 'n', status: 'waiting', state: 'blocked', waitingFor: 'permission prompt', extra: 'ignored' })
  assert.deepEqual(row, { id: 'a1b2c3d4', sessionId: 'a1b2c3d4-0000', cwd: '/w', kind: 'background', status: 'waiting', state: 'blocked', pid: 12, name: 'n', waitingFor: 'permission prompt', startedAt: 5 })
  assert.equal(T.isJob(row), true)
  assert.equal(T.isJob(T.rowOf({ pid: 3, kind: 'interactive', sessionId: 'x' })), false)
  assert.equal(T.isJob({ kind: 'background' }), false, 'without the id its screen opens with it is not one Togle can open')
  assert.equal(T.isJob({ kind: 'background', id: '--help' }), false, 'an id that is not eight hex characters is never put in a command')
})

test('a session id that is not a UUID is not put in a command, where it could be read as a flag', async () => {
  const { backend } = claude({ backend: { stored: async () => [{ id: '--help', title: 'Odd', cwd: scratch(), updatedAt: 1 }] } })
  try {
    await assert.rejects(() => backend.resume('--help', {}), /not a session Claude Code knows/)
  } finally {
    await backend.close()
  }
})

test('a session is working, waiting or idle by its program and its status, and stopped without a program', () => {
  const state = T.stateOfJob
  assert.equal(state({ pid: 1, status: 'busy', state: 'working' }), 'working')
  assert.equal(state({ pid: 1, status: 'waiting', state: 'blocked' }), 'waiting')
  assert.equal(state({ pid: 1, status: 'idle', state: 'blocked' }), 'idle', '"blocked" is how a session that waits for its first message is listed')
  assert.equal(state({ pid: 1, status: 'idle', state: 'working' }), 'idle', 'and "working" is still said a moment after an interrupt')
  assert.equal(state({ state: 'done' }), 'idle')
  assert.equal(state({ state: 'stopped' }), 'stopped')
  assert.equal(state({ state: 'done' }, true), 'stopped', 'a session the person stopped')
  assert.equal(state({ state: 'failed' }), 'failed')
})

test('the flags that decide what a Claude Code does are read from the command line it ran under, and nothing else', () => {
  const flags = T.carriedFlags
  assert.deepEqual(flags('claude --model opus --permission-mode plan'), ['--model', 'opus', '--permission-mode', 'plan'])
  assert.deepEqual(flags('claude --model=sonnet[1m] --effort high --dangerously-skip-permissions'), ['--model', 'sonnet[1m]', '--effort', 'high', '--dangerously-skip-permissions'])
  assert.deepEqual(flags('"C:\\Program Files\\claude.exe" --resume 123 --add-dir ..\\x --model "a b"'), [], 'a name with a space, a folder, an id: not taken')
  assert.deepEqual(flags('claude'), [])
})
