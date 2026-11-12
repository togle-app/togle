// A stand-in for `codex app-server`, for tests. It speaks the same JSON-RPC lines as the real one (as recorded from
// Codex 0.166 on Windows) and acts on the words of the first prompt of a turn:
//   "say ok"         answers "ok" at once
//   "quick"          the same, with the whole turn told before the answer to turn/start
//   "run <name>"     asks to run a PowerShell command and waits for the person (accept runs it, decline refuses it)
//   "edit <name>"    asks to change a file
//   "ask"            asks a question in words
//   "sleep"          starts a long command that Stop does not end: the turn ends at once, the command stays
// Run as: node fake-codex.mjs app-server    (FAKE_PID_FILE names a file that gets the long command's process id)
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  console.log('codex-cli 0.0.0-fake')
  process.exit(0)
}

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const note = (method, params) => out({ method, params })
const threads = new Map()
let nextThread = 1
let nextServerRequest = 100
const waiting = new Map()

const info = (thread) => ({ id: thread.id, name: thread.name ?? null, preview: thread.preview ?? '', cwd: thread.cwd, status: thread.status, updatedAt: thread.updatedAt, source: 'appServer', turns: [] })
const setStatus = (thread, type, flags) => {
  thread.status = flags ? { type, activeFlags: flags } : { type }
  note('thread/status/changed', { threadId: thread.id, status: thread.status })
}
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextServerRequest++
    waiting.set(id, resolve)
    out({ id, method, params })
  })

async function runTurn(thread, turn, prompt) {
  setStatus(thread, 'active', [])
  note('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', items: [] } })
  const finish = (status) => {
    setStatus(thread, 'idle')
    note('turn/completed', { threadId: thread.id, turn: { id: turn.id, status, items: [] } })
  }
  const say = (text) => note('item/completed', { threadId: thread.id, turnId: turn.id, item: { id: `m${Math.random()}`, type: 'agentMessage', text } })
  const run = /^run (\S+)/.exec(prompt)
  if (run) {
    const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Set-Content -Path ${run[1]}.txt -Value x'`
    const item = { id: `c${turn.id}`, type: 'commandExecution', command, cwd: thread.cwd, status: 'inProgress', commandActions: [] }
    note('item/started', { threadId: thread.id, turnId: turn.id, item })
    setStatus(thread, 'active', ['waitingOnApproval'])
    const answer = await ask('item/commandExecution/requestApproval', { itemId: item.id, threadId: thread.id, turnId: turn.id, command, cwd: thread.cwd, proposedExecpolicyAmendment: ['Set-Content'], startedAtMs: Date.now() })
    setStatus(thread, 'active', [])
    const decision = answer?.result?.decision
    // Always: Codex keeps the rule it proposed, and runs the command.
    const rule = decision?.acceptWithExecpolicyAmendment?.execpolicy_amendment
    const done = decision === 'accept' || rule ? { ...item, status: 'completed', exitCode: 0 } : { ...item, status: 'declined' }
    note('item/completed', { threadId: thread.id, turnId: turn.id, item: done })
    say(rule ? `kept the rule ${rule.join(' ')}` : decision === 'accept' ? 'ran it' : 'it was refused')
    return finish('completed')
  }
  const edit = /^edit (\S+)/.exec(prompt)
  if (edit) {
    const item = { id: `f${turn.id}`, type: 'fileChange', status: 'inProgress', changes: [{ path: `${thread.cwd}\\${edit[1]}.txt`, diff: '+x', kind: { type: 'add' } }] }
    note('item/started', { threadId: thread.id, turnId: turn.id, item })
    setStatus(thread, 'active', ['waitingOnApproval'])
    const answer = await ask('item/fileChange/requestApproval', { itemId: item.id, threadId: thread.id, turnId: turn.id, reason: 'new file', startedAtMs: Date.now() })
    const accepted = answer?.result?.decision === 'accept'
    note('item/completed', { threadId: thread.id, turnId: turn.id, item: { ...item, status: accepted ? 'completed' : 'declined' } })
    say(accepted ? 'changed it' : 'left it')
    return finish('completed')
  }
  if (/^ask/.test(prompt)) {
    const answer = await ask('item/tool/requestUserInput', { itemId: 'q1', threadId: thread.id, turnId: turn.id, isBlocking: true, questions: [{ id: 'which', header: 'Table', question: 'Which pricing table?', isOther: true, options: [{ label: 'Two plans', description: '' }] }] })
    say(`you said ${answer?.result?.answers?.which?.answers?.[0] ?? 'nothing'}`)
    return finish('completed')
  }
  if (/^sleep/.test(prompt)) {
    const marker = 'togle-fake-sleep'
    const command = `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Start-Sleep -Seconds 60 # ${marker}'`
    const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, 60000) /* Start-Sleep -Seconds 60 # ${marker} */`], { stdio: 'ignore', windowsHide: true })
    if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(child.pid))
    note('item/started', { threadId: thread.id, turnId: turn.id, item: { id: `s${turn.id}`, type: 'commandExecution', command, cwd: thread.cwd, status: 'inProgress', commandActions: [] } })
    thread.interrupt = () => finish('interrupted')
    return undefined
  }
  say('ok')
  return finish('completed')
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) {
    const resolve = waiting.get(message.id)
    if (resolve) {
      waiting.delete(message.id)
      resolve(message)
    }
    return
  }
  const { id, method, params } = message
  const reply = (result) => out({ id, result })
  const fail = (text) => out({ id, error: { code: -32600, message: text } })
  switch (method) {
    case 'initialize':
      return reply({ codexHome: 'fake', platformFamily: 'windows', platformOs: 'windows', userAgent: 'fake' })
    case 'initialized':
      return undefined
    case 'thread/start': {
      const thread = { id: `t${nextThread++}`, cwd: params.cwd, status: { type: 'idle' }, updatedAt: Math.floor(Date.now() / 1000), policy: { approvalPolicy: params.approvalPolicy ?? null, sandbox: params.sandbox ?? null } }
      threads.set(thread.id, thread)
      return reply({ thread: info(thread), approvalPolicy: params.approvalPolicy ?? 'never', sandbox: params.sandbox ?? 'danger-full-access', model: 'fake' })
    }
    case 'thread/name/set': {
      const thread = threads.get(params.threadId)
      if (!thread) return fail('no such thread')
      thread.name = params.name
      reply({})
      return note('thread/name/updated', { threadId: thread.id, name: params.name })
    }
    case 'thread/list':
      return reply({ data: [...threads.values(), { id: 'old1', name: null, preview: 'Fix the login redirect', cwd: 'C:\\work\\site', status: { type: 'notLoaded' }, updatedAt: 1793852778, source: 'cli', turns: [] }].map((t) => (t.turns ? t : info(t))), nextCursor: null })
    case 'thread/resume': {
      const thread = threads.get(params.threadId) ?? { id: params.threadId, cwd: 'C:\\work\\site', status: { type: 'notLoaded' }, updatedAt: 1, name: 'Fix the login redirect' }
      threads.set(thread.id, thread)
      thread.policy = { approvalPolicy: params.approvalPolicy ?? null, sandbox: params.sandbox ?? null }
      return reply({ thread: info(thread) })
    }
    case 'thread/read':
      return reply({ thread: info(threads.get(params.threadId)) })
    case 'thread/unsubscribe':
      return reply({})
    case 'turn/start': {
      const thread = threads.get(params.threadId)
      if (!thread) return fail('no such thread')
      const turn = { id: `u${Math.random().toString(36).slice(2, 6)}`, status: 'inProgress', items: [] }
      thread.turn = turn.id
      thread.preview ||= params.input?.[0]?.text
      // "quick": the whole turn is told before the answer to turn/start, as a fast agent can.
      if (/^quick/.test(String(params.input?.[0]?.text ?? ''))) {
        void runTurn(thread, turn, 'say ok').then(() => reply({ turn }))
        return undefined
      }
      reply({ turn })
      void runTurn(thread, turn, String(params.input?.[0]?.text ?? ''))
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
})
