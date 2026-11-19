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
// FAKE_NO_RESUME takes session/resume away so that session/load is used; FAKE_PID_FILE gets the long command's pid;
// FAKE_NO_COMMANDS makes it an agent that tells no commands of its own; FAKE_NO_LIST takes the session list away (no `list` among its
// session capabilities), FAKE_ACP_SESSIONS gives it sessions it kept before (JSON), FAKE_ACP_PAGE pages its list.
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
  const say = (words) => { for (const piece of words.match(/[\s\S]{1,6}/g) ?? []) update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: piece }, messageId: 'm1' }) }
  const call = (id, kind, title, extra = {}) => update(session.id, { sessionUpdate: 'tool_call', toolCallId: id, title, kind, content: kind === 'execute' ? [{ type: 'content', content: { type: 'text', text: `$ ${title.replace(/^terminal: /, '')}` } }] : [], locations: [], ...extra })
  const done = (id, status) => update(session.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status })
  const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }]
  // Its own "/model", as Hermes 0.22.5 answers it: which model the session is on; and, given words, a switch that
  // reads all of them as one model's name ("provider:model" becomes "provider/model") and keeps the provider.
  const model = /^\/model(?:\s+(\S+))?$/.exec(prompt)
  if (model) {
    if (model[1]) session.model = model[1].replace(':', '/')
    say(`${model[1] ? 'Model switched to' : 'Current model'}: ${session.model ?? 'claude-sonnet-5'}\nProvider: ${session.provider ?? 'anthropic'}`)
    return finish('end_turn')
  }
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
      return reply({ protocolVersion: 1, agentInfo: { name: 'hermes-agent', version: 'fake' }, agentCapabilities: { loadSession: true, sessionCapabilities: { ...(process.env.FAKE_NO_LIST ? {} : { list: {} }), ...(process.env.FAKE_NO_RESUME ? {} : { resume: {}, fork: {} }) } } })
    case 'session/list': {
      // The sessions the agent keeps: those FAKE_ACP_SESSIONS names (as JSON: sessionId, cwd, title, updatedAt), then those made here;
      // FAKE_ACP_PAGE is how many go in one answer, the rest behind a cursor. FAKE_LIST_FAILS makes it an error.
      calls({ method, cursor: params?.cursor })
      if (process.env.FAKE_LIST_FAILS) return fail('session/list is not available')
      const kept = [...JSON.parse(process.env.FAKE_ACP_SESSIONS ?? '[]'), ...[...sessions.values()].map((made) => ({ sessionId: made.id, cwd: made.cwd, title: null, updatedAt: new Date().toISOString() }))]
      const size = Number(process.env.FAKE_ACP_PAGE ?? 0) || kept.length || 1
      const from = Number(params?.cursor ?? 0)
      return reply({ sessions: kept.slice(from, from + size), ...(from + size < kept.length ? { nextCursor: String(from + size) } : {}) })
    }
    case 'session/new': {
      const session = { id: `s${nextSession++}`, cwd: params.cwd }
      sessions.set(session.id, session)
      calls({ method, cwd: params.cwd })
      // As Hermes 0.22 does: the models a session can be switched to come with the session, its commands as news of it.
      reply({ sessionId: session.id, modes: modes(), models: { availableModels: [{ modelId: 'openai-codex:gpt-6.1-sol', name: 'gpt-6.1-sol' }, { modelId: 'openrouter:kimi-k3', name: 'kimi-k3', description: 'A second one' }], currentModelId: 'openai-codex:gpt-6.1-sol' } })
      if (!process.env.FAKE_NO_COMMANDS) update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'model', description: 'Show current model and provider, or switch models', input: { hint: 'model name to switch to' } }, { name: 'version', description: 'Show Hermes version' }] })
      return undefined
    }
    case 'session/resume':
    case 'session/load': {
      const session = sessions.get(params.sessionId) ?? { id: params.sessionId, cwd: params.cwd }
      sessions.set(session.id, session)
      calls({ method, sessionId: params.sessionId, cwd: params.cwd })
      // Real Hermes tells the past again on resume as well as on load.
      update(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old words from before' } })
      update(session.id, { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'terminal: echo old', kind: 'execute', content: [] })
      update(session.id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'model', description: 'Show current model and provider, or switch models', input: { hint: 'model name to switch to' } }] })
      return reply({ modes: modes(), models: { availableModels: [{ modelId: 'openai-codex:gpt-6.1-sol', name: 'gpt-6.1-sol' }], currentModelId: 'openai-codex:gpt-6.1-sol' } })
    }
    case 'session/set_mode':
      calls({ method, ...params })
      return reply({})
    case 'session/set_model': {
      calls({ method, ...params })
      // The protocol's own switch: "provider:model" names both. One model cannot be found, and is refused as Hermes
      // 0.22.5 refuses: a bare "Internal error", with the reason as a code beside it.
      const [provider, name] = String(params.modelId).split(':')
      if (name === 'kimi-k3') return out({ id, error: { code: -32603, message: 'Internal error', data: { details: 'model_resolution_failed' } } })
      const session = sessions.get(params.sessionId)
      if (session) Object.assign(session, { provider, model: name })
      return reply({})
    }
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
