// A stand-in for `claude -p --input-format stream-json --output-format stream-json`, for tests. It reads the hook
// address from the --settings file, as Claude Code does, and acts on the words of each user message:
//   "say ok"         answers "ok"
//   "run <name>"     wants to run a Bash command: asks the hook, then runs it or reports the refusal
//   "edit <name>"    wants to write a file (the Write tool)
//   "ask"            asks a question with the AskUserQuestion tool
//   "fail"           ends the turn with an error
//   "sleep"          starts a long command; an interrupt control request ends it and the turn
// On --resume the first message is answered after a stale empty result, as a resumed Claude Code can do.
// FAKE_ARGS_FILE and FAKE_SETTINGS_COPY name files that get the arguments and the settings it was started with.
import { spawn } from 'node:child_process'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const argv = process.argv.slice(2)
if (argv.includes('--version')) {
  console.log('2.0.0-fake (Claude Code)')
  process.exit(0)
}
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const settingsFile = flag('--settings')
const resume = flag('--resume')
const settings = settingsFile ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
if (process.env.FAKE_ARGS_FILE) writeFileSync(process.env.FAKE_ARGS_FILE, JSON.stringify({ argv, cwd: process.cwd() }))
if (process.env.FAKE_SETTINGS_COPY && settingsFile) copyFileSync(settingsFile, process.env.FAKE_SETTINGS_COPY)
const hookUrl = settings.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.url
const sessionId = resume ?? `session-${Math.random().toString(36).slice(2, 8)}`
const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
let first = true
let running = null
let toolCounter = 0

async function permission(tool_name, tool_input) {
  const controller = new AbortController()
  running.abort = () => controller.abort()
  const response = await fetch(hookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, cwd: process.cwd(), permission_mode: 'default', hook_event_name: 'PermissionRequest', tool_name, tool_input, permission_suggestions: [{ type: 'addRules', behavior: 'allow' }] }),
    signal: controller.signal
  })
  const body = await response.text()
  if (!body) return { behavior: 'none' }
  return JSON.parse(body).hookSpecificOutput.decision
}

const assistant = (content) => out({ type: 'assistant', message: { role: 'assistant', content }, session_id: sessionId })
const toolResult = (id, text, isError = false) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] }, session_id: sessionId })
const result = (extra = {}) => out({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: sessionId, ...extra })

async function turn(prompt) {
  running = { abort: null, child: null, interrupted: false }
  if (resume && first) result()
  if (first) out({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), permissionMode: 'default' })
  first = false
  const tool = async (name, input) => {
    const id = `tu${++toolCounter}`
    assistant([{ type: 'tool_use', id, name, input }])
    try {
      return { id, decision: await permission(name, input) }
    } catch {
      return { id, decision: null }
    }
  }
  const run = /^run (\S+)/.exec(prompt)
  const write = /^edit (\S+)/.exec(prompt)
  if (run || write) {
    const { id, decision } = run ? await tool('Bash', { command: `echo x > ${run[1]}.txt`, description: 'Write a file' }) : await tool('Write', { file_path: `${process.cwd()}/${write[1]}.txt`, content: 'x' })
    if (!decision) return undefined
    if (decision.behavior === 'allow') {
      toolResult(id, 'ok')
      assistant([{ type: 'text', text: 'did it' }])
    } else {
      toolResult(id, decision.message ?? 'No permission.', true)
      assistant([{ type: 'text', text: 'it was refused' }])
    }
    return result({ result: 'done' })
  }
  if (/^ask/.test(prompt)) {
    const { id, decision } = await tool('AskUserQuestion', { questions: [{ question: 'Which pricing table?', header: 'Table', options: [{ label: 'Two plans', description: '' }], multiSelect: false }] })
    const said = decision?.updatedInput?.answers ? Object.values(decision.updatedInput.answers)[0] : 'nothing'
    toolResult(id, 'answered')
    assistant([{ type: 'text', text: `you said ${said}` }])
    return result({ result: 'done' })
  }
  if (/^sleep/.test(prompt)) {
    const { id, decision } = await tool('Bash', { command: 'sleep 60 # togle-fake-claude', description: 'Wait' })
    if (decision?.behavior !== 'allow') return result()
    running.child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000) /* togle-fake-claude */'], { stdio: 'ignore', windowsHide: true })
    if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(running.child.pid))
    await new Promise((resolve) => {
      running.stop = resolve
    })
    toolResult(id, 'The user doesn\'t want to proceed with this tool use.', true)
    return result({ subtype: 'error_during_execution', is_error: true })
  }
  if (/^fail/.test(prompt)) return result({ subtype: 'error_during_execution', is_error: true, result: 'API Error: overloaded' })
  assistant([{ type: 'text', text: 'ok' }])
  return result({ result: 'ok' })
}

let queue = Promise.resolve()
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.type === 'control_request') {
    out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { still_queued: [] } } })
    if (message.request?.subtype === 'interrupt' && running) {
      running.interrupted = true
      running.child?.kill()
      running.abort?.()
      running.stop?.()
    }
    return
  }
  if (message.type === 'user') {
    const prompt = String(message.message?.content?.[0]?.text ?? '')
    queue = queue.then(() => turn(prompt)).catch(() => undefined)
  }
})
