// A stand-in for Claude Code's own screen (`claude --resume <id> --settings <file>`, started in a terminal), for tests. It
// reads the hook addresses from the --settings file, as Claude Code does, and acts on each line typed into it:
//   "run <name>"   a message: it posts a prompt, then asks to run a command (a permission request) and shows its own
//                  question. An answer from Togle (allow or deny) ends it; so does "y" or "n" typed here. Like Claude
//                  Code, it keeps the request open when the answer was typed here. Then it posts the end of the turn.
//   "run2 <a> <b>" the same, with two commands that ask one after the other in one turn
//   "clear"        goes on in another session (the id with -2 after it), which the next hook says
//   "bye"          ends it
//   anything else  a message: answered "fine, <the words>"
// FAKE_STATUS_FILE gets what `claude agents` would say of it (idle, busy, waiting), unless FAKE_STATUS_MANUAL is set and
// the test writes it; FAKE_PID_FILE gets its pid.
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const settings = JSON.parse(readFileSync(flag('--settings'), 'utf8'))
const nested = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_X'].some((name) => process.env[name] !== undefined)
let session = flag('--resume') ?? 'session-new'
const say = (words) => process.stdout.write(`${words}\r\n`)
const status = (value) => process.env.FAKE_STATUS_FILE && !process.env.FAKE_STATUS_MANUAL && writeFileSync(process.env.FAKE_STATUS_FILE, value)
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid))
const open = new Set()

function post(event, body) {
  const to = settings.hooks?.[event]?.[0]?.hooks?.[0]?.url
  if (!to) return Promise.resolve(null)
  const controller = new AbortController()
  open.add(controller)
  return fetch(to, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: session, cwd: process.cwd(), hook_event_name: event, ...body }), signal: controller.signal })
    .then((response) => response.text())
    .catch(() => null)
}

let typedAnswer = null
let turn = Promise.resolve()

async function ask(name) {
  say('Do you want to proceed? (y/n)')
  const hook = post('PermissionRequest', { tool_name: 'Bash', tool_input: { command: `echo x > ${name}.txt` }, permission_suggestions: [] })
  setTimeout(() => status('waiting'), 300)
  const typed = new Promise((resolve) => { typedAnswer = resolve })
  const answer = await Promise.race([
    hook.then((body) => {
      const decision = body ? JSON.parse(body).hookSpecificOutput.decision.behavior : null
      return decision ? { by: 'togle', allowed: decision === 'allow' } : new Promise(() => {})
    }),
    typed.then((yes) => ({ by: 'screen', allowed: yes }))
  ])
  typedAnswer = null
  status('busy')
  say(answer.allowed ? `ran ${name}${answer.by === 'screen' ? ' (answered here)' : ''}` : `refused ${name}`)
}

async function handle(said) {
  if (said === 'bye') {
    for (const controller of open) controller.abort()
    process.exit(0)
  }
  if (said === 'clear') {
    session = `${session}-2`
    say('cleared')
    return
  }
  status('busy')
  await post('UserPromptSubmit', { prompt: said })
  const run = /^run (\S+)/.exec(said)
  const two = /^run2 (\S+) (\S+)/.exec(said)
  if (two) {
    await ask(two[1])
    await ask(two[2])
  } else if (run) await ask(run[1])
  else say(`fine, ${said}`)
  await post('Stop', { last_assistant_message: two ? `done ${two[1]} ${two[2]}` : run ? `done ${run[1]}` : 'ok' })
  status('idle')
  process.stdout.write('ready> ')
}

status('idle')
say(`started with ${JSON.stringify(argv.map((word, at) => (argv[at - 1] === '--settings' ? '<settings>' : word)))} hooks=${Object.keys(settings.hooks ?? {}).join(',')} asks=${!!settings.permissions?.ask} nested=${nested}`)
say('fake claude ready')
process.stdout.write('ready> ')
let line = ''
process.stdin.setEncoding('utf8')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (chunk) => {
  for (const key of chunk) {
    if (key === '\x03') process.exit(130)
    if (key === '\r' || key === '\n') {
      const said = line
      line = ''
      process.stdout.write('\r\n')
      if (typedAnswer && (said === 'y' || said === 'n')) typedAnswer(said === 'y')
      else turn = turn.then(() => handle(said))
    } else {
      line += key
      process.stdout.write(key)
    }
  }
})
