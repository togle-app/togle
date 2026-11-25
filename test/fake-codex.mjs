// A stand-in for Codex, for tests. It speaks the same JSON-RPC as the real one (as recorded from Codex 0.166 and 0.169 on
// Windows) in the ways Togle meets it:
//   node fake-codex.mjs app-server                    a server of its own on standard input and output (one client)
//   node fake-codex.mjs app-server daemon <word>      version | start | stop: the shared server, kept in FAKE_DAEMON_FILE
//   node fake-codex.mjs app-server proxy              carries bytes between standard input and output and the shared server
//   node fake-codex.mjs --remote unix:// resume <id>  a "screen" on a thread: it prints a line and echoes what is typed
// The shared server is a detached process of this file that serves WebSockets on a loopback port. It holds threads for every
// client, tells a thread's news to the clients that joined it, asks all of them what a thread asks (the first answer wins, the
// others are told it was answered), and asks a client that joins a thread again what is still open: as the real one does.
// A thread acts on the words of the first prompt of a turn:
//   "say ok"         answers "ok" at once
//   "quick"          the same, with the whole turn told before the answer to turn/start
//   "run <name>"     asks to run a PowerShell command and waits for the person (accept runs it, decline refuses it)
//   "edit <name>"    asks to change a file
//   "ask"            asks a question in words
//   "sleep"          starts a long command that interrupting does not end: the turn ends at once, the command stays
//   "slow"           a command that ends by itself after a second and a half, then the turn ends
//   "unload"         the server says `notLoaded` in the middle of the turn, and the turn goes on to its answer
// FAKE_CALLS names a file that gets a line for every answer a client gave; FAKE_SCREEN_FAILS makes a screen print that and end;
// FAKE_DAEMON_FAILS makes `daemon start` fail with that.
// FAKE_PID_FILE names a file that gets the long command's process id.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const argv = process.argv.slice(2)

if (argv[0] === '--version') {
  console.log('codex-cli 0.0.0-fake')
  process.exit(0)
}

// ---- A screen ----
if (argv[0] === '--remote') {
  const id = argv[argv.indexOf('resume') + 1] ?? ''
  // FAKE_SCREEN_FAILS: a screen that could not open (the server is not there) prints why and ends.
  if (process.env.FAKE_SCREEN_FAILS) {
    process.stdout.write(`Error: ${process.env.FAKE_SCREEN_FAILS}\r\n`)
    process.exit(1)
  }
  process.stdout.write(`FAKE CODEX SCREEN ${id}\r\n`)
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === '/exit') process.exit(0)
    process.stdout.write(`typed: ${line}\r\n`)
  })
  setInterval(() => undefined, 1 << 30)
} else if (argv[0] === 'app-server' && argv[1] === 'daemon') {
  await daemonCommand(argv[2])
} else if (argv[0] === 'app-server' && argv[1] === 'proxy') {
  const state = readState()
  if (!state) {
    process.stderr.write(`Error: failed to connect to ${process.env.FAKE_DAEMON_FILE}\n\nCaused by:\n    No connection could be made because the target machine actively refused it.\n`)
    process.exit(1)
  }
  const socket = net.connect(state.port, '127.0.0.1')
  socket.on('error', () => process.exit(1))
  socket.on('close', () => process.exit(0))
  process.stdin.pipe(socket)
  socket.pipe(process.stdout)
} else if (argv[0] === 'daemon-server') {
  serve(argv[1])
} else if (argv[0] === 'app-server') {
  stdio()
}

function readState() {
  const file = process.env.FAKE_DAEMON_FILE
  if (!file || !existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function reachable(state) {
  return new Promise((resolve) => {
    if (!state) return resolve(false)
    const socket = net.connect(state.port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); resolve(true) })
    socket.once('error', () => resolve(false))
  })
}

async function daemonCommand(word) {
  const file = process.env.FAKE_DAEMON_FILE
  const state = readState()
  const up = await reachable(state)
  if (word === 'version') {
    if (!up) {
      process.stderr.write(`Error: failed to connect to ${file}\n\nCaused by:\n    No connection could be made because the target machine actively refused it. (os error 10061)\n`)
      process.exit(1)
    }
    console.log(JSON.stringify({ status: 'running', backend: 'pid', managedCodexVersion: '0.0.0-fake', socketPath: file, cliVersion: '0.0.0-fake', appServerVersion: '0.0.0-fake' }))
  } else if (word === 'start') {
    if (up) return console.log(JSON.stringify({ status: 'alreadyRunning', backend: 'pid', pid: state.pid }))
    if (process.env.FAKE_DAEMON_FAILS) {
      process.stderr.write(`{"stage":"process_spawn","outcome":"failed"}\nError: ${process.env.FAKE_DAEMON_FAILS}\n`)
      process.exit(1)
    }
    rmSync(file, { force: true })
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon-server', file, 'app-server', '--listen', 'unix://', '--managed-daemon'], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
    child.unref()
    for (let waited = 0; waited < 8000 && !readState(); waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
    console.log(JSON.stringify({ status: 'started', backend: 'pid', pid: child.pid, socketPath: file }))
  } else if (word === 'stop') {
    if (state?.pid) {
      try {
        process.kill(state.pid)
      } catch {
        // already gone
      }
    }
    rmSync(file, { force: true })
    console.log(JSON.stringify({ status: up ? 'stopped' : 'notRunning', backend: 'pid' }))
  }
  process.exit(0)
}

// ---- The server: threads, clients, and what is asked ----

/** Everything the server holds, whichever way it is reached. */
function core() {
  const threads = new Map()
  const conns = new Set()
  let nextThread = 1
  let nextKey = 1

  const info = (thread, withTurns = false) => ({ id: thread.id, name: thread.name ?? null, preview: thread.preview ?? '', cwd: thread.cwd, environments: [{ environmentId: 'local', cwd: thread.cwd }], status: thread.status, updatedAt: thread.updatedAt, source: 'appServer', turns: withTurns ? (thread.turns ?? []) : [] })
  const tell = (conn, method, params) => conn.send({ method, params })
  const broadcast = (method, params) => conns.forEach((conn) => tell(conn, method, params))
  /** What a thread did is kept as its turns, which a client that joins late can read. */
  const keepTurns = (thread, method, params) => {
    thread.turns ??= []
    if (method === 'turn/started') thread.turns.push({ ...params.turn, items: [] })
    const turn = thread.turns.at(-1)
    if (!turn) return
    if (method === 'item/started') turn.items.push(params.item)
    if (method === 'item/completed') {
      const at = turn.items.findIndex((item) => item.id === params.item.id)
      if (at >= 0) turn.items[at] = params.item
      else turn.items.push(params.item)
    }
    if (method === 'turn/completed') turn.status = params.turn.status
  }
  const toSubscribers = (thread, method, params) => {
    keepTurns(thread, method, params)
    thread.subscribers.forEach((conn) => tell(conn, method, params))
  }
  const setStatus = (thread, type, flags) => {
    thread.status = flags ? { type, activeFlags: flags } : { type }
    broadcast('thread/status/changed', { threadId: thread.id, status: thread.status })
  }

  /** What a thread asks: every client that joined it is asked; the first answer settles it, and the others are told. */
  const sendRequest = (conn, thread, pending) => {
    const id = conn.nextRequest++
    pending.ids.set(conn, id)
    conn.waiting.set(id, pending)
    conn.send({ id, method: pending.method, params: pending.params })
  }
  const ask = (thread, method, params) =>
    new Promise((resolve) => {
      const pending = { key: nextKey++, method, params, ids: new Map(), settled: false, resolve, thread }
      thread.pending.set(pending.key, pending)
      for (const conn of thread.subscribers) sendRequest(conn, thread, pending)
    })

  async function runTurn(thread, turn, prompt, input) {
    setStatus(thread, 'active', [])
    toSubscribers(thread, 'turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } })
    // What was asked is the turn's first item, as Codex keeps it.
    thread.turns.at(-1)?.items.push({ id: `um${turn.id}`, type: 'userMessage', content: input ?? [{ type: 'text', text: prompt, text_elements: [] }] })
    const finish = (status) => {
      thread.turn = null
      setStatus(thread, 'idle')
      toSubscribers(thread, 'turn/completed', { threadId: thread.id, turn: { id: turn.id, status, items: [] } })
    }
    const say = (text) => toSubscribers(thread, 'item/completed', { threadId: thread.id, turnId: turn.id, item: { id: `m${Math.random()}`, type: 'agentMessage', text } })
    const item = (kind, fields) => ({ id: `${kind}${turn.id}`, ...fields })
    const run = /^run (\S+)/.exec(prompt)
    if (run) {
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Set-Content -Path ${run[1]}.txt -Value x'`
      const started = item('c', { type: 'commandExecution', command, cwd: thread.cwd, status: 'inProgress', commandActions: [] })
      toSubscribers(thread, 'item/started', { threadId: thread.id, turnId: turn.id, item: started })
      setStatus(thread, 'active', ['waitingOnApproval'])
      const answer = await ask(thread, 'item/commandExecution/requestApproval', { itemId: started.id, threadId: thread.id, turnId: turn.id, command, cwd: thread.cwd, proposedExecpolicyAmendment: ['Set-Content'], startedAtMs: Date.now() })
      setStatus(thread, 'active', [])
      const decision = answer?.result?.decision
      // Always: Codex keeps the rule it proposed, and runs the command.
      const rule = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment
      const done = decision === 'accept' || rule ? { ...started, status: 'completed', exitCode: 0 } : { ...started, status: 'declined' }
      toSubscribers(thread, 'item/completed', { threadId: thread.id, turnId: turn.id, item: done })
      say(rule ? `kept the rule ${rule.join(' ')}` : decision === 'accept' ? 'ran it' : 'it was refused')
      return finish(decision === 'cancel' ? 'interrupted' : 'completed')
    }
    const edit = /^edit (\S+)/.exec(prompt)
    if (edit) {
      const started = item('f', { type: 'fileChange', status: 'inProgress', changes: [{ path: `${thread.cwd}\\${edit[1]}.txt`, diff: '+x', kind: { type: 'add' } }] })
      toSubscribers(thread, 'item/started', { threadId: thread.id, turnId: turn.id, item: started })
      setStatus(thread, 'active', ['waitingOnApproval'])
      const answer = await ask(thread, 'item/fileChange/requestApproval', { itemId: started.id, threadId: thread.id, turnId: turn.id, reason: 'new file', startedAtMs: Date.now() })
      const accepted = answer?.result?.decision === 'accept'
      toSubscribers(thread, 'item/completed', { threadId: thread.id, turnId: turn.id, item: { ...started, status: accepted ? 'completed' : 'declined' } })
      say(accepted ? 'changed it' : 'left it')
      return finish('completed')
    }
    if (/^ask/.test(prompt)) {
      const pilot = prompt === 'ask pilot color'
      const question = pilot
        ? { id: 'pilot_color', header: 'Color', question: 'Which pilot color should I report?', isOther: true, isSecret: false, options: [{ label: 'Blue', description: '' }, { label: 'Green', description: '' }] }
        : { id: 'which', header: 'Table', question: 'Which pricing table?', isOther: true, options: [{ label: 'Two plans', description: '' }] }
      const answer = await ask(thread, 'item/tool/requestUserInput', { itemId: 'q1', threadId: thread.id, turnId: turn.id, isBlocking: !pilot, questions: [question] })
      say(`you said ${answer?.result?.answers?.[question.id]?.answers?.[0] ?? 'nothing'}`)
      return finish('completed')
    }
    if (/^unload/.test(prompt)) {
      // The server says it let go of its copy of the thread in the middle of a turn, and the turn goes on.
      broadcast('thread/status/changed', { threadId: thread.id, status: { type: 'notLoaded' } })
      await new Promise((resolve) => setTimeout(resolve, 600))
      say('still here')
      return finish('completed')
    }
    if (/^slow/.test(prompt)) {
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Start-Sleep -Seconds 1 # slow'`
      const started = item('w', { type: 'commandExecution', command, cwd: thread.cwd, status: 'inProgress', commandActions: [] })
      toSubscribers(thread, 'item/started', { threadId: thread.id, turnId: turn.id, item: started })
      await new Promise((resolve) => setTimeout(resolve, 1500))
      toSubscribers(thread, 'item/completed', { threadId: thread.id, turnId: turn.id, item: { ...started, status: 'completed', exitCode: 0 } })
      say('slow done')
      return finish('completed')
    }
    if (/^sleep/.test(prompt)) {
      const marker = 'togle-fake-sleep'
      const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Start-Sleep -Seconds 60 # ${marker}'`
      const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) /* Start-Sleep -Seconds 60 # ${marker} */`], { stdio: 'ignore', windowsHide: true })
      if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(child.pid))
      toSubscribers(thread, 'item/started', { threadId: thread.id, turnId: turn.id, item: { id: `s${turn.id}`, type: 'commandExecution', command, cwd: thread.cwd, status: 'inProgress', commandActions: [] } })
      thread.interrupt = () => finish('interrupted')
      return undefined
    }
    say('ok')
    return finish('completed')
  }

  /** What one client says. `conn.send` delivers to it. */
  function handle(conn, message) {
    if (message.method === undefined) {
      // FAKE_CALLS: every answer a client gave to a question, for tests that count them.
      if (process.env.FAKE_CALLS) appendFileSync(process.env.FAKE_CALLS, `${JSON.stringify({ answered: message.id, result: message.result ?? null })}\n`)
      const pending = conn.waiting.get(message.id)
      if (!pending || pending.settled) return
      conn.waiting.delete(message.id)
      pending.settled = true
      pending.thread.pending.delete(pending.key)
      for (const [other, id] of pending.ids) {
        other.waiting.delete(id)
        tell(other, 'serverRequest/resolved', { threadId: pending.thread.id, requestId: id })
      }
      pending.resolve(message)
      return
    }
    const { id, method, params } = message
    const reply = (result) => conn.send({ id, result })
    const fail = (text) => conn.send({ id, error: { code: -32600, message: text } })
    switch (method) {
      case 'initialize':
        return reply({ codexHome: 'fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'fake' })
      case 'initialized':
        return undefined
      case 'thread/start': {
        const thread = { id: `01a1d400-0000-7000-8000-${String(nextThread++).padStart(12, '0')}`, cwd: params.cwd, status: { type: 'idle' }, updatedAt: Math.floor(Date.now() / 1000), policy: { approvalPolicy: params.approvalPolicy ?? null, sandbox: params.sandbox ?? null }, subscribers: new Set([conn]), pending: new Map(), persisted: false }
        threads.set(thread.id, thread)
        conn.subs.add(thread.id)
        thread.serviceTier = process.env.FAKE_CODEX_SERVICE_TIER ?? null
        return reply({ thread: info(thread), approvalPolicy: params.approvalPolicy ?? 'never', sandbox: params.sandbox ?? 'danger-full-access', model: 'fake', serviceTier: thread.serviceTier })
      }
      case 'thread/name/set': {
        const thread = threads.get(params.threadId)
        if (!thread) return fail('no such thread')
        thread.name = params.name
        reply({})
        return broadcast('thread/name/updated', { threadId: thread.id, name: params.name })
      }
      case 'thread/list': {
        const old = { id: 'old1', name: null, preview: 'Fix the login redirect', cwd: 'C:\\work\\site', status: { type: 'notLoaded' }, updatedAt: 1793852778, source: 'cli', turns: [] }
        return reply({ data: [...[...threads.values()].filter((t) => t.persisted).map(info), old], nextCursor: null })
      }
      case 'thread/loaded/list':
        return reply({ data: [...threads.keys()], nextCursor: null })
      case 'thread/resume': {
        const known = threads.get(params.threadId)
        if (known && !known.persisted) return fail(`no rollout found for thread id ${known.id}`)
        const thread = known ?? { id: params.threadId, cwd: 'C:\\work\\site', status: { type: 'notLoaded' }, updatedAt: 1, name: 'Fix the login redirect', subscribers: new Set(), pending: new Map(), persisted: true }
        threads.set(thread.id, thread)
        thread.policy = { approvalPolicy: params.approvalPolicy ?? null, sandbox: params.sandbox ?? null }
        thread.subscribers.add(conn)
        conn.subs.add(thread.id)
        reply({ thread: info(thread, true), serviceTier: thread.serviceTier ?? null })
        // What is still open is asked again of the client that joins.
        for (const pending of thread.pending.values()) if (!pending.ids.has(conn)) sendRequest(conn, thread, pending)
        return undefined
      }
      case 'thread/read': {
        const thread = threads.get(params.threadId)
        return thread ? reply({ thread: info(thread, params.includeTurns === true) }) : fail('no such thread')
      }
      case 'thread/settings/update': {
        const thread = threads.get(params.threadId)
        if (!thread) return fail('no such thread')
        thread.serviceTier = params.serviceTier
        const threadSettings = { serviceTier: thread.serviceTier }
        toSubscribers(thread, 'thread/settings/updated', { threadId: thread.id, threadSettings })
        return reply({ threadSettings })
      }
      case 'thread/items/list': {
        const turn = threads.get(params.threadId)?.turns?.find(turn => turn.id === params.turnId)
        if (!turn) return fail('no such turn')
        const from = Number(params.cursor) || 0
        const limit = Number(params.limit) || 25
        const data = turn.items.slice(from, from + limit).map(item => ({ turnId: turn.id, item }))
        return reply({ data, nextCursor: from + limit < turn.items.length ? String(from + limit) : null })
      }
      case 'thread/turns/list': {
        // Newest first, a page at a time; a "summary" turn has only what was asked and the last thing said.
        const thread = threads.get(params.threadId)
        if (!thread) return fail('no such thread')
        const turns = [...(thread.turns ?? [])].reverse()
        const from = params.cursor ? Number(params.cursor) : 0
        const limit = Math.min(Number(params.limit) || 25, 100)
        const data = turns.slice(from, from + limit).map((turn) => {
          if (params.itemsView === 'summary') return { ...turn, itemsView: 'summary', items: [turn.items.find((item) => item.type === 'userMessage'), [...turn.items].reverse().find((item) => item.type === 'agentMessage')].filter(Boolean) }
          if (params.itemsView === 'notLoaded') return { ...turn, itemsView: 'notLoaded', items: [] }
          return { ...turn, itemsView: 'full' }
        })
        return reply({ data, nextCursor: from + limit < turns.length ? String(from + limit) : null, backwardsCursor: 'back' })
      }
      case 'thread/unsubscribe': {
        const thread = threads.get(params.threadId)
        thread?.subscribers.delete(conn)
        conn.subs.delete(params.threadId)
        return reply({ status: 'unsubscribed' })
      }
      case 'thread/delete': {
        threads.delete(params.threadId)
        return reply({})
      }
      case 'turn/start': {
        const thread = threads.get(params.threadId)
        if (!thread) return fail('no such thread')
        const turn = { id: `u${Math.random().toString(36).slice(2, 6)}`, status: 'inProgress', items: [] }
        thread.turn = turn.id
        thread.persisted = true
        thread.preview ||= params.input?.[0]?.text
        // "quick": the whole turn is told before the answer to turn/start, as a fast agent can.
        if (/^quick/.test(String(params.input?.[0]?.text ?? ''))) {
          void runTurn(thread, turn, 'say ok').then(() => reply({ turn }))
          return undefined
        }
        reply({ turn })
        void runTurn(thread, turn, String(params.input?.[0]?.text ?? ''), params.input)
        return undefined
      }
      case 'turn/steer': {
        const thread = threads.get(params.threadId)
        if (!thread || thread.turn !== params.expectedTurnId) return fail('no active turn')
        return reply({ turnId: thread.turn })
      }
      case 'turn/interrupt': {
        const thread = threads.get(params.threadId)
        reply({})
        thread?.interrupt?.()
        if (thread) thread.interrupt = undefined
        return undefined
      }
      default:
        return id === undefined ? undefined : fail(`unknown method ${method}`)
    }
  }

  return {
    handle,
    join(send) {
      const conn = { send, nextRequest: 0, waiting: new Map(), subs: new Set() }
      conns.add(conn)
      return conn
    },
    drop(conn) {
      conns.delete(conn)
      for (const thread of threads.values()) thread.subscribers.delete(conn)
    }
  }
}

/** A server of its own, on standard input and output: one client, gone with the program. */
function stdio() {
  const server = core()
  const conn = server.join((message) => process.stdout.write(`${JSON.stringify(message)}\n`))
  createInterface({ input: process.stdin }).on('line', (line) => server.handle(conn, JSON.parse(line)))
}

/** The shared server: WebSockets on a loopback port, written to the state file once it listens. */
function serve(file) {
  const server = core()
  const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  sockets.on('connection', (socket) => {
    const conn = server.join((message) => socket.send(JSON.stringify(message)))
    socket.on('message', (data) => server.handle(conn, JSON.parse(String(data))))
    socket.on('close', () => server.drop(conn))
    socket.on('error', () => undefined)
  })
  sockets.on('listening', () => writeFileSync(file, JSON.stringify({ port: sockets.address().port, pid: process.pid })))
}
