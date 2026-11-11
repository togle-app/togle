import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('outside')
const T = await import('./.build/togle.mjs')

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-outside-'))
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
const payload = (extra = {}) => ({ session_id: 'sess-1', transcript_path: '', cwd: 'C:\\work\\website', permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm run migrate', description: 'Runs the migration' }, ...extra })

// ---- what Claude Code sends, and what it is answered with ----

test('a request from Claude Code is read into a command, an edit or another tool, as the person will read it', () => {
  assert.deepEqual({ ...T.permissionFrom(payload()) }, { sessionId: 'sess-1', tool: 'Bash', folder: 'C:\\work\\website', kind: 'command', command: 'npm run migrate', raw: 'npm run migrate', reason: 'Runs the migration' })
  assert.equal(T.permissionFrom(payload({ tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem' } })).command, 'Get-ChildItem')
  assert.deepEqual({ ...T.permissionFrom(payload({ tool_name: 'Edit', tool_input: { file_path: 'C:\\work\\a.css', old_string: 'x', new_string: 'y' } })) }, { sessionId: 'sess-1', tool: 'Edit', folder: 'C:\\work\\website', kind: 'edit', files: ['C:\\work\\a.css'] })
  assert.deepEqual(T.permissionFrom(payload({ tool_name: 'Write', tool_input: { file_path: '/tmp/x.txt', content: 'hello' } })).files, ['/tmp/x.txt'])
  assert.deepEqual(T.permissionFrom(payload({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/n.ipynb' } })).files, ['/n.ipynb'])
  const other = T.permissionFrom(payload({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/a', prompt: 'summarize' } }))
  assert.equal(other.kind, 'command')
  assert.equal(other.command, 'WebFetch {"url":"https://example.com/a","prompt":"summarize"}', 'the tool and what it was given, as written')
  assert.equal(other.reason, 'The WebFetch tool')
  assert.equal(T.permissionFrom(payload({ tool_name: 'mcp__github__create_issue', tool_input: { title: 'Bug' } })).command, 'mcp__github__create_issue {"title":"Bug"}')
  assert.equal(T.permissionFrom(payload({ transcript_path: 'C:\\t\\s.jsonl' })).transcript, 'C:\\t\\s.jsonl')
})

test('what is not a permission request, and text with control characters or too long, is handled', () => {
  for (const bad of [null, 'text', [], {}, payload({ session_id: '' }), payload({ session_id: '../../x' }), payload({ session_id: 'a b' }), payload({ session_id: 7 }), payload({ tool_name: '' }), payload({ tool_name: undefined })]) {
    assert.throws(() => T.permissionFrom(bad), /not a permission request/)
  }
  assert.equal(T.permissionFrom(payload({ tool_input: [1, 2] })).kind, 'command', 'a tool_input that is not an object is nothing')
  assert.equal(T.permissionFrom(payload({ tool_input: 'x' })).command, 'Bash {}')
  const clean = T.permissionFrom(payload({ tool_input: { command: 'echo \u0000hi\u0007 there\nsecond\tline\u001b[31m' } }))
  assert.equal(clean.command, 'echo hi there\nsecond\tline[31m', 'control characters out, line breaks and tabs kept')
  assert.equal(T.permissionFrom(payload({ tool_input: { command: 'x'.repeat(50000) } })).command.length, 20000)
  assert.equal(T.permissionFrom(payload({ cwd: 'c'.repeat(5000) })).folder.length, 1000)
  assert.equal(T.permissionFrom(payload({ tool_input: { command: 'ls', description: 'd'.repeat(2000) } })).reason.length, 500)
})

test('the answer printed for Claude Code is what it takes, and nothing leaves the question to the person', () => {
  assert.deepEqual(JSON.parse(T.hookOutput({ decision: 'allow' })), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } })
  assert.deepEqual(JSON.parse(T.hookOutput({ decision: 'deny', message: 'No, thanks.' })), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'No, thanks.', interrupt: false } } })
  assert.equal(JSON.parse(T.hookOutput({ decision: 'deny' })).hookSpecificOutput.decision.message, 'The person refused it in Togle.')
  assert.equal(JSON.parse(T.hookOutput({ decision: 'deny', message: 'm'.repeat(900) })).hookSpecificOutput.decision.message.length, 500)
  for (const nothing of [{ decision: 'none' }, { decision: 'maybe' }, { decision: undefined }, {}, { decision: 'Allow' }]) assert.equal(T.hookOutput(nothing), null)
})

// ---- requests held for a session that runs elsewhere ----

const asked = (extra = {}) => T.permissionFrom(payload(extra))
const never = () => new AbortController().signal

test('a request is held until it is answered, by key and id, and only once', async () => {
  const told = []
  const external = new T.ExternalRequests({ changed: () => told.push(1) })
  const held = external.hold({ runner: 'claude', asked: asked() }, never())
  assert.deepEqual(external.keys(), ['claude:sess-1'])
  const [entry] = external.forKey('claude:sess-1')
  assert.deepEqual({ kind: entry.request.kind, command: entry.request.command, folder: entry.request.folder, reason: entry.request.reason, offersAlways: entry.request.offersAlways }, { kind: 'command', command: 'npm run migrate', folder: 'C:\\work\\website', reason: 'Runs the migration', offersAlways: false })
  assert.equal(external.answer('claude:other', entry.id, 'allow-once'), false, 'another session\'s key does not answer it')
  assert.equal(external.answer('claude:sess-1', 'ext-999', 'allow-once'), false)
  assert.equal(external.answer('claude:sess-1', entry.id, 'refuse'), true)
  assert.equal(await held, 'refuse')
  assert.equal(external.answer('claude:sess-1', entry.id, 'allow-once'), false, 'answered once only')
  assert.deepEqual(external.keys(), [])
  assert.ok(told.length >= 2, 'told when it came and when it went')
})

test('a request goes when the one who asked has gone, or when Togle lets go of everything', async () => {
  const external = new T.ExternalRequests({ changed() {} })
  const controller = new AbortController()
  const first = external.hold({ runner: 'claude', asked: asked() }, controller.signal)
  const second = external.hold({ runner: 'claude', asked: asked({ session_id: 'sess-2' }) }, never())
  assert.deepEqual(external.keys().sort(), ['claude:sess-1', 'claude:sess-2'])
  controller.abort()
  assert.equal(await first, 'gone')
  assert.deepEqual(external.keys(), ['claude:sess-2'])
  external.dropAll()
  assert.equal(await second, 'gone')
  assert.equal(await external.hold({ runner: 'claude', asked: asked() }, AbortSignal.abort()), 'gone', 'one that came after its caller left is not held')
  assert.deepEqual(external.keys(), [])
})

test('a hundred are held at most, and one session\'s requests come in the order they were asked', async () => {
  const external = new T.ExternalRequests({ changed() {} })
  const holds = []
  for (let n = 0; n < 100; n++) holds.push(external.hold({ runner: 'claude', asked: asked({ session_id: `s${n % 3}`, tool_input: { command: `cmd ${n}` } }) }, never()))
  assert.equal(await external.hold({ runner: 'claude', asked: asked({ session_id: 'extra' }) }, never()), 'gone', 'the hundred and first is not held')
  assert.deepEqual(external.forKey('claude:s0').slice(0, 3).map((e) => e.request.command), ['cmd 0', 'cmd 3', 'cmd 6'])
  external.dropAll()
  await Promise.all(holds)
})

test('a question is let go when its session moved on: the transcript grew, or it stopped waiting, and not before it can be told', async () => {
  const looks = new Map()
  const external = new T.ExternalRequests({ changed() {}, everyMs: 20, graceMs: 0, look: async (held) => looks.get(held.sessionId) ?? { transcriptGrew: false, state: null } })
  const stays = external.hold({ runner: 'claude', asked: asked({ session_id: 'unknown' }) }, never())
  const grew = external.hold({ runner: 'claude', asked: asked({ session_id: 'grew' }) }, never())
  const moved = external.hold({ runner: 'claude', asked: asked({ session_id: 'moved' }) }, never())
  const early = external.hold({ runner: 'claude', asked: asked({ session_id: 'early' }) }, never())
  const blip = external.hold({ runner: 'claude', asked: asked({ session_id: 'blip' }) }, never())
  looks.set('grew', { transcriptGrew: true, state: 'waiting' })
  looks.set('moved', { transcriptGrew: false, state: 'waiting' })
  looks.set('early', { transcriptGrew: false, state: 'working' })
  looks.set('blip', { transcriptGrew: false, state: 'waiting' })
  assert.equal(await grew, 'gone', 'the transcript grew')
  await new Promise((r) => setTimeout(r, 100))
  assert.deepEqual(external.keys().sort(), ['claude:blip', 'claude:early', 'claude:moved', 'claude:unknown'], 'the others were seen waiting, or never, and stay')
  looks.set('moved', { transcriptGrew: false, state: 'working' })
  assert.equal(await moved, 'gone', 'it was seen waiting and is not any more')
  // A session never seen waiting is not judged by its not waiting: the agent may not tell a question from work.
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(external.keys().includes('claude:early'))
  // One look that says working between two that say waiting is a moment, not an answer.
  looks.set('blip', { transcriptGrew: false, state: 'working' })
  await new Promise((r) => setTimeout(r, 30))
  looks.set('blip', { transcriptGrew: false, state: 'waiting' })
  await new Promise((r) => setTimeout(r, 120))
  assert.ok(external.keys().includes('claude:blip'))
  external.dropAll()
  assert.deepEqual(await Promise.all([stays, early, blip]), ['gone', 'gone', 'gone'])
})

test('a request is left alone for a while before what the agent says is believed', async () => {
  let asked_ = 0
  const external = new T.ExternalRequests({ changed() {}, everyMs: 15, graceMs: 200, look: async () => (asked_++, { transcriptGrew: true, state: null }) })
  const held = external.hold({ runner: 'claude', asked: asked() }, never())
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(asked_, 0, 'not looked at yet')
  assert.equal(await held, 'gone', 'looked at after the wait, and found moved on')
  assert.ok(asked_ >= 1)
})

// ---- the hub ----

class Backend {
  constructor(tasks = []) {
    this.runner = 'claude'
    this.tasks = tasks
    this.states = new Map()
  }
  async detect() { return { installed: true, version: '2.1.322' } }
  async list() { return this.tasks }
  async sessionState(id) { return this.states.get(id) ?? null }
  async close() {}
}
const hubWith = (tasks, options = {}) => {
  const backend = new Backend(tasks)
  const hub = new T.RunnerHub({ backends: [backend], changed() {}, cacheMs: 60000, outsideEveryMs: 30, outsideGraceMs: 0, ...options })
  return { hub, backend }
}
const info = (id, extra = {}) => ({ id, runner: 'claude', title: 'Port the API', folder: 'C:\\work\\api', state: 'working', updatedAt: 1000, pid: 4242, ...extra })

test('a question from a session in a terminal shows as that session waiting, and answering it reaches the hook', async () => {
  const { hub } = hubWith([info('sess-1'), info('other', { title: 'Other', state: 'idle' })])
  try {
    const decision = hub.askOutside({ runner: 'claude', asked: asked() }, never())
    const waiting = (await hub.list()).find((task) => task.key === 'claude:sess-1')
    assert.equal(waiting.state, 'waiting', 'it was working; now it waits for the person')
    assert.equal(waiting.mine, false)
    assert.equal(waiting.title, 'Port the API')
    assert.equal(waiting.pid, 4242, 'what Togle knew of it is kept')
    assert.equal(waiting.line, 'Wants to run npm run migrate')
    assert.equal(waiting.pending.length, 1)
    assert.equal(waiting.pending[0].command, 'npm run migrate')
    assert.equal((await hub.list())[0].key, 'claude:sess-1', 'what waits is first')
    assert.deepEqual(hub.attention().map((a) => [a.key, a.state, a.pending.length, a.title]), [['claude:sess-1', 'waiting', 1, 'Port the API']])
    hub.answer('claude:sess-1', waiting.pending[0].id, 'allow-once')
    assert.equal(await decision, 'allow-once')
    assert.equal((await hub.list()).find((task) => task.key === 'claude:sess-1').state, 'working', 'answered: it is as the agent lists it again')
    assert.deepEqual(hub.attention(), [])
  } finally {
    await hub.dispose()
  }
})

test('a session Togle has not heard of is made from its question, a dangerous command is marked, and a refused one reaches the hook', async () => {
  const { hub } = hubWith([])
  try {
    const decision = hub.askOutside({ runner: 'claude', asked: asked({ session_id: 'new', cwd: 'C:\\work\\shop', tool_input: { command: 'rm -rf build' } }) }, never())
    const [task] = await hub.list()
    assert.deepEqual({ key: task.key, title: task.title, folder: task.folder, state: task.state, mine: task.mine, id: task.id }, { key: 'claude:new', title: 'Claude Code in shop', folder: 'C:\\work\\shop', state: 'waiting', mine: false, id: 'new' })
    assert.equal(task.pending[0].danger, 'It deletes files or folders for good.')
    hub.answer('claude:new', task.pending[0].id, 'refuse')
    assert.equal(await decision, 'refuse')
    assert.deepEqual(await hub.list(), [], 'nothing to show of a session that is not listed and asks nothing')
  } finally {
    await hub.dispose()
  }
})

test('a question that is gone cannot be answered, and a session Togle runs itself is not asked about this way', async () => {
  const { hub, backend } = hubWith([info('sess-1')])
  try {
    const controller = new AbortController()
    const decision = hub.askOutside({ runner: 'claude', asked: asked() }, controller.signal)
    const [{ pending }] = hub.attention()
    controller.abort()
    assert.equal(await decision, 'gone')
    assert.throws(() => hub.answer('claude:sess-1', pending[0].id, 'allow-once'), /not found|gone|Continue it first/, 'answered after it was gone')
    // A session that Togle runs is answered through its own route.
    backend.start = async (options) => {
      const handle = new T.TaskBase()
      Object.assign(handle, { runner: 'claude', id: 'sess-1', title: 'Mine', folder: options.folder, send: async () => handle.setBase('working'), stop: async () => handle.setBase('stopped'), endCommands: async () => 0, close: async () => {} })
      return handle
    }
    await hub.start({ runner: 'claude', folder: scratch(), prompt: 'Do it' })
    assert.equal(await hub.askOutside({ runner: 'claude', asked: asked() }, never()), 'gone', 'Togle runs that session; the hook is told nothing was decided')
  } finally {
    await hub.dispose()
  }
})

test('a question is let go when the session is seen to move on, by what its agent says', async () => {
  const { hub, backend } = hubWith([info('sess-1')])
  try {
    backend.states.set('sess-1', 'waiting')
    const decision = hub.askOutside({ runner: 'claude', asked: asked() }, never())
    await until(() => hub.attention().length === 1, 'the question')
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(hub.attention().length, 1, 'still waiting there, so still here')
    backend.states.set('sess-1', 'working')
    assert.equal(await decision, 'gone', 'answered in the terminal: the question here goes')
  } finally {
    await hub.dispose()
  }
})

test('a question is let go when the transcript of the session grows', async () => {
  const folder = scratch()
  const transcript = path.join(folder, 's.jsonl')
  writeFileSync(transcript, '{"type":"user"}\n')
  const { hub } = hubWith([info('sess-1')])
  try {
    const decision = hub.askOutside({ runner: 'claude', asked: asked({ transcript_path: transcript }) }, never())
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(hub.attention().length, 1, 'not written to: still asking')
    const later = new Date(Date.now() + 5000)
    utimesSync(transcript, later, later)
    assert.equal(await decision, 'gone')
  } finally {
    await hub.dispose()
  }
})

test('closing the hub tells every waiting hook that nothing was decided', async () => {
  const { hub } = hubWith([info('sess-1')])
  const decisions = [hub.askOutside({ runner: 'claude', asked: asked() }, never()), hub.askOutside({ runner: 'claude', asked: asked({ session_id: 'sess-2' }) }, never())]
  await hub.dispose()
  assert.deepEqual(await Promise.all(decisions), ['gone', 'gone'])
  assert.equal(await hub.askOutside({ runner: 'claude', asked: asked() }, never()), 'gone', 'and nothing is held after')
})

// ---- the whole way: the hook program, the channel, the hub ----

const channelOf = async (hub) => {
  const dataFolder = scratch()
  const server = await T.startChannel({ dataFolder, hub })
  return { dataFolder, server, args: ['claude-permission', '--data', dataFolder] }
}
const stdin = (value) => () => Promise.resolve(typeof value === 'string' ? value : JSON.stringify(value))
const allow = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
const deny = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'The person refused it in Togle.', interrupt: false } } }

test('the hook program hands a question to Togle and prints the person\'s answer, or nothing when the question is gone', async () => {
  const { hub, backend } = hubWith([info('sess-1')])
  const { server, args } = await channelOf(hub)
  try {
    const allowed = T.hookAnswer(args, stdin(payload()))
    const first = await until(() => hub.attention()[0], 'the question')
    assert.equal(first.pending[0].command, 'npm run migrate')
    hub.answer('claude:sess-1', first.pending[0].id, 'allow-once')
    assert.deepEqual(JSON.parse(await allowed), allow)

    const refused = T.hookAnswer(args, stdin(payload({ tool_input: { command: 'git push --force' } })))
    const second = await until(() => hub.attention()[0], 'the second question')
    assert.equal(second.pending[0].danger, 'It pushes over what is on the server, or deletes it there.')
    hub.answer('claude:sess-1', second.pending[0].id, 'refuse')
    assert.deepEqual(JSON.parse(await refused), deny)

    // Answered where the session runs: it was seen waiting, and now it works. Nothing is printed, and the hook ends.
    backend.states.set('sess-1', 'waiting')
    const moved = T.hookAnswer(args, stdin(payload()))
    await until(() => hub.attention().length === 1, 'the third question')
    await new Promise((r) => setTimeout(r, 120))
    backend.states.set('sess-1', 'working')
    assert.equal(await moved, null)

    // Togle closed with a question waiting: nothing decided, and the question stays where it is asked.
    const left = T.hookAnswer(args, stdin(payload()))
    await until(() => hub.attention().length === 1, 'the fourth question')
    await hub.dispose()
    assert.equal(await left, null)
  } finally {
    await server.close()
  }
})

test('the hook program prints nothing when Togle is not running, cannot prove itself, or is sent what it cannot read', async () => {
  const dataFolder = scratch()
  // Nobody listening, and no secret made yet.
  assert.equal(await T.hookAnswer(['claude-permission', '--data', dataFolder], stdin(payload())), null)
  const { hub } = hubWith([])
  const server = await T.startChannel({ dataFolder, hub })
  try {
    const args = ['claude-permission', '--data', dataFolder]
    assert.equal(await T.hookAnswer(['claude-permission'], stdin(payload())), null, 'no data folder')
    assert.equal(await T.hookAnswer(['something-else', '--data', dataFolder], stdin(payload())), null, 'not a kind it knows')
    assert.equal(await T.hookAnswer(args, stdin('not json')), null)
    assert.equal(await T.hookAnswer(args, stdin('')), null)
    assert.equal(await T.hookAnswer(args, stdin({ hello: 'there' })), null, 'Togle refuses it in words, and the hook prints nothing')
    assert.equal(await T.hookAnswer(args, () => Promise.reject(new Error('no input'))), null)
    assert.deepEqual(hub.attention(), [], 'none of that reached the person as a question')
  } finally {
    await server.close()
    await hub.dispose()
  }
  // Something else took the pipe's name before Togle did: it cannot prove it holds the secret, so it is told nothing.
  const taken = scratch()
  await T.loadSecret(taken)
  const heard = []
  const impostor = new T.ChannelServer({ secret: T.secretOf('ab'.repeat(32)), address: T.channelAddress(taken), handlers: { 'claude-permission': async (body) => (heard.push(body), { decision: 'allow' }) } })
  await impostor.listen()
  try {
    assert.equal(await T.hookAnswer(['claude-permission', '--data', taken], stdin(payload())), null)
    assert.deepEqual(heard, [], 'the impostor was never told the command')
  } finally {
    await impostor.close()
  }
})

test('reading what arrives on the hook\'s input takes it whole, and does not wait for ever', async () => {
  const { Readable } = await import('node:stream')
  assert.equal(await T.readAll(Readable.from(['{"a":', '1}'])), '{"a":1}')
  const silent = new Readable({ read() {} })
  const began = Date.now()
  assert.equal(await T.readAll(silent, 120), '')
  assert.ok(Date.now() - began < 1000)
})

test('the hook writes what it did to a file when asked to, and nothing when not', () => {
  const file = path.join(scratch(), 'hook.log')
  delete process.env.TOGLE_HOOK_LOG
  T.logHook('not written')
  process.env.TOGLE_HOOK_LOG = file
  try {
    T.logHook('first')
    T.logHook('second')
    process.env.TOGLE_HOOK_LOG = path.join(scratch(), 'no', 'such', 'folder', 'log.txt')
    assert.doesNotThrow(() => T.logHook('nowhere to write'), 'a log that cannot be written is no reason to fail')
  } finally {
    delete process.env.TOGLE_HOOK_LOG
  }
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\d\d:\d\d:\d\d\.\d{3} first$/)
  assert.match(lines[1], / second$/)
})
