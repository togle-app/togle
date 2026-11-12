// A stand-in for `hermes acp`, for tests: ACP over JSON-RPC lines (as recorded from Hermes 0.22 on Windows). It acts
// on the words of a prompt:
//   "say ok"      says "ok", and Hermes names the session by it
//   "run <name>"  asks to run a command (allow once, allow always, reject once), then runs it or reports the refusal
//   "edit <name>" asks to change a file
//   "free"        runs a command without asking, as Hermes does when its own settings never ask
//   "noonce"      asks with no way to allow once (only always or reject)
//   "sleep"       starts a long command; session/cancel ends it and the turn
//   "fail"        says why in words, then answers with a plain error
// FAKE_CALLS names a file that gets one line for each of set_mode, set_model, new, resume and load;
// FAKE_NO_RESUME takes session/resume away so that session/load is used; FAKE_PID_FILE gets the long command's pid.
import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv[2] === '--version') {
  console.log('Hermes Agent v0.0.0-fake')
  process.exit(0)
}

const out = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
const calls = (what) => process.env.FAKE_CALLS && appendFileSync(process.env.FAKE_CALLS, JSON.stringify(what) + '\n')
const update = (sessionId, body) => out({ method: 'session/update', params: { sessionId, update: body } })
const sessions = new Map()
let nextSession = 1
let nextAsk = 100
const waiting = new Map()
const ask = (params) => new Promise((resolve) => {
  const id = nextAsk++
  waiting.set(id, resolve)
  out({ id, method: 'session/request_permission', params })
})
const modes = () => ({ currentModeId: 'dont_ask', availableModes: [{ id: 'default', name: 'Default' }, { id: 'accept_edits', name: 'Accept edits' }, { id: 'dont_ask', name: "Don't ask" }] })

async function turn(session, prompt, finish) {
  const say = (words) => { for (const piece of words.match(/.{1,6}/g) ?? []) update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece }, messageId: 'm1' }) }
  const call = (id, kind, title, extra = {}) => update(session.id, { sessionUpdate: 'tool_call', toolCallId: id, title, kind, content: kind === 'execute' ? [{ type: 'content', content: { type: 'text', text: `$ ${title.replace(/^terminal: /, '')}` } }] : [], locations: [], ...extra })
  const done = (id, status) => update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status })
  const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
  const run = /^run (\S+)/.exec(prompt)
  const edit = /^edit (\S+)/.exec(prompt)
  if (run) {
    const title = `terminal: echo x > ${run[1]}.txt`
    call('tc1', 'execute', title)
    const answer = await ask({ sessionId: session.id, toolCall: { toolCallId: 'tc1', title, kind: 'execute', content: [{ type: 'content', content: { type: 'text', text: `$ echo x > ${run[1]}.txt` } }] }, options })
    const picked = answer.result?.outcome
    done('tc1', picked?.outcome === 'selected' && (picked.optionId === 'once' || picked.optionId === 'always') ? 'completed' : 'failed')
    say(picked?.optionId === 'once' ? 'ran it' : picked?.optionId === 'always' ? 'ran it, and will not ask again' : 'it was refused')
    return finish('end_turn')
  }
  if (edit) {
    call('tc2', 'edit', `Edit ${edit[1]}.txt`, { locations: [{ path: `C:\\work\\${edit[1]}.txt` }] })
    const answer = await ask({ sessionId: session.id, toolCall: { toolCallId: 'tc2', title: `Edit ${edit[1]}.txt`, kind: 'edit', locations: [{ path: `C:\\work\\${edit[1]}.txt` }] }, options })
    const accepted = answer.result?.outcome?.optionId === 'once'
    done('tc2', accepted ? 'completed' : 'failed')
    say(accepted ? 'changed it' : 'left it')
    return finish('end_turn')
  }
  if (/^free/.test(prompt)) {
    call('tc3', 'execute', 'terminal: dir')
    done('tc3', 'completed')
    say('listed it')
    return finish('end_turn')
  }
  if (/^noonce/.test(prompt)) {
    call('tc4', 'execute', 'terminal: echo y')
    const answer = await ask({ sessionId: session.id, toolCall: { toolCallId: 'tc4', title: 'terminal: echo y', kind: 'execute' }, options: [options[1], options[2]] })
    const picked = answer.result?.outcome
    done('tc4', picked?.optionId === 'always' ? 'completed' : 'failed')
    say('done with it')
    return finish('end_turn')
  }
  if (/^sleep/.test(prompt)) {
    call('tc5', 'execute', 'terminal: ping -n 60 127.0.0.1 # togle-fake-hermes')
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000) /* togle-fake-hermes */'], { stdio: 'ignore', windowsHide: true })
    if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(child.pid))
    session.cancel = () => { child.kill(); done('tc5', 'failed'); finish('cancelled') }
    return undefined
  }
  if (/^fail/.test(prompt)) {
    say('The provider rejected the request.')
    return finish(null, { code: -32603, message: 'Internal error', data: { details: 'admitted_turn_failed' } })
  }
  say('ok')
  update(session.id, { sessionUpdate: 'session_info_update', title: 'Fake title for the first words' })
  return finish('end_turn')
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
      return reply({ protocolVersion: 1, agentInfo: { name: 'hermes-agent', version: 'fake' }, agentCapabilities: { loadSession: true, sessionCapabilities: process.env.FAKE_NO_RESUME ? { list: {} } : { list: {}, resume: {}, fork: {} } } })
    case 'session/new': {
      const session = { id: `s${nextSession++}`, cwd: params.cwd }
      sessions.set(session.id, session)
      calls({ method, cwd: params.cwd })
      return reply({ sessionId: session.id, modes: modes() })
    }
    case 'session/resume':
    case 'session/load': {
      const session = sessions.get(params.sessionId) ?? { id: params.sessionId, cwd: params.cwd }
      sessions.set(session.id, session)
      calls({ method, sessionId: params.sessionId, cwd: params.cwd })
      // Real Hermes tells the past again on resume as well as on load.
      update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old words from before' } })
      update(session.id, { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'terminal: echo old', kind: 'execute', content: [] })
      return reply({ modes: modes() })
    }
    case 'session/set_mode':
    case 'session/set_model':
      calls({ method, ...params })
      return reply({})
    case 'session/prompt': {
      const session = sessions.get(params.sessionId)
      if (!session) return fail('no such session')
      const prompt = String(params.prompt?.[0]?.text ?? '')
      const finish = (stopReason, error) => {
        session.cancel = undefined
        error ? out({ id, error }) : out({ id, result: { stopReason } })
      }
      void turn(session, prompt, finish)
      return undefined
    }
    case 'session/cancel':
      sessions.get(params.sessionId)?.cancel?.()
      return undefined
    default:
      return id === undefined ? undefined : fail(`unknown method ${method}`)
  }
})
