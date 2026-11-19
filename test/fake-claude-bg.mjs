// A stand-in for Claude Code's background sessions, for tests. It answers the commands Togle runs, the way Claude Code
// 2.1.323 answers them (checked on Windows), with its state in the folder FAKE_CLAUDE_HOME:
//   --version | --help              as Claude Code prints them (the help names --bg)
//   --bg [flags] [--] [words]       starts a session that goes on without a window: prints "backgrounded · <id>"
//   --bg --resume <session>         the same session; a copy ("started a copy as …") when it already runs
//   agents --json [--all]           the sessions, one object each; `interactive.json` in the folder adds a person's own
//   attach <id>                     a screen on the session (a client of it); a stopped one comes back, reading the settings
//                                   file it was given once more, and failing in a line when that file is gone
//   stop <id> | rm <id>             ends the session | forgets it
//   __killall                       (tests) ends every session
// A session is a program of its own that goes on after whoever started it is gone. It reads the hook address from the
// --settings file it was given, and acts on each line typed into a screen:
//   "run <name>"    asks to run a command: a permission request to the hook, and its own question on the screen. An
//                   answer from Togle (allow or deny) ends it; so does "y" or "n" typed on the screen. Like Claude Code, it
//                   keeps the request open when the answer was typed on the screen.
//   "run2 <a> <b>"  two commands that ask one after the other in one turn
//   "question"      a question to the person (AskUserQuestion): "Which?", red or blue
//   "plan"          a plan to approve (ExitPlanMode), with the plan in the request: approved, or sent back with words
//   "clear"         goes on in another session (the id with -2 after it), under the same job
//   "bye"           ends it
//   "slow"          works for three seconds; "long" for twenty: Esc on the screen ends the turn ("Interrupted") and the session goes on
//   anything else   a message, answered "fine, <the words>"
// Esc on a screen, as in Claude Code 2.1.328: while a turn works it ends the turn; while a question waits it declines it; on an idle
// prompt it does nothing, but two within 800 ms open a rewind menu ("Rewind menu") that takes what is typed next as its own until
// another Esc closes it. A key that reaches the screen before it is ready is lost: FAKE_CLAUDE_READY_MS (default 0) is how long a
// screen takes keys after it connected. The Esc keys the session was given are counted in its job file (`escapes`).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const home = process.env.FAKE_CLAUDE_HOME
if (!home) throw new Error('FAKE_CLAUDE_HOME is not set')
fs.mkdirSync(path.join(home, 'jobs'), { recursive: true })
const argv = process.argv.slice(2)
const jobFile = (job) => path.join(home, 'jobs', `${job}.json`)
const read = (job) => { try { return JSON.parse(fs.readFileSync(jobFile(job), 'utf8')) } catch { return null } }
const write = (job, patch) => { const now = { ...(read(job) ?? {}), ...patch }; for (const key of Object.keys(now)) if (now[key] === undefined) delete now[key]; fs.writeFileSync(jobFile(job), JSON.stringify(now)); return now }
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }
const all = () => fs.readdirSync(path.join(home, 'jobs')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(home, 'jobs', name), 'utf8')))
const out = (words) => process.stdout.write(`${words}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const script = fileURLToPath(import.meta.url)

function start(rec) {
  const child = spawn(process.execPath, [script, '__session', rec.job], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
  child.unref()
}

const [command] = argv
if (command === '--version') out('2.1.999 (Fake Claude)')
else if (command === '--help') out('Usage: claude [options]\n  --bg, --background   Start the session in the background')
else if (command === 'agents') {
  const rows = all().map((rec) => {
    const running = alive(rec.pid)
    return { ...(running ? { pid: rec.pid } : {}), id: rec.job, cwd: rec.cwd, kind: 'background', startedAt: rec.startedAt, sessionId: rec.sessionId, ...(rec.name ? { name: rec.name } : {}), ...(running ? { status: rec.status, state: rec.status === 'busy' ? 'working' : 'blocked', ...(rec.waitingFor && rec.status === 'waiting' ? { waitingFor: rec.waitingFor } : {}) } : { state: rec.state ?? 'stopped' }) }
  })
  let own = []
  try { own = JSON.parse(fs.readFileSync(path.join(home, 'interactive.json'), 'utf8')) } catch { /* none */ }
  out(JSON.stringify([...rows, ...own.map((row) => ({ kind: 'interactive', status: 'idle', ...row }))]))
} else if (command === '--bg') {
  let settings
  let name
  let resume
  let words = []
  const rest = argv.slice(1)
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at]
    if (word === '--') { words = rest.slice(at + 1); break }
    if (word === '--settings') settings = rest[++at]
    else if (word === '--resume') resume = rest[++at]
    else if (word.startsWith('--name=')) name = word.slice('--name='.length)
    else if (['--model', '--permission-mode', '--effort'].includes(word)) at++
    else if (!word.startsWith('--')) words = rest.slice(at)
    if (words.length) break
  }
  if (process.env.FAKE_UNTRUSTED) { console.error(`Workspace not trusted. Run \`claude\` in ${process.cwd()} once and accept the trust prompt, then retry.`); process.exit(1) }
  const running = resume ? all().find((rec) => rec.sessionId === resume && alive(rec.pid)) : undefined
  const sessionId = resume && !running ? resume : randomUUID()
  const job = resume && !running ? resume.replace(/[^0-9a-f]/g, '').slice(0, 8).padEnd(8, '0') : sessionId.slice(0, 8)
  const rec = { job, sessionId, cwd: process.cwd(), settings, args: rest, ...(name ? { name } : {}), startedAt: Date.now(), status: 'idle', first: words.join(' ') || undefined }
  fs.writeFileSync(jobFile(job), JSON.stringify(rec))
  start(rec)
  out(`backgrounded · ${job}${name ? ` · ${name}` : ''} (${words.length ? 'working' : 'idle — send a prompt to start'})`)
  out(`  claude attach ${job}   open in this terminal`)
  if (running) out(`note: session ${running.job} is already running in the background, so this started a copy as ${job}. \`claude attach ${running.job}\` opens the original.`)
} else if (command === 'attach') {
  // (tests) a screen that cannot be opened: it says so in a line and ends
  if (process.env.FAKE_ATTACH_FAILS) { console.error('Cannot attach to this session.'); process.exit(1) }
  const job = argv[1]
  let rec = job ? read(job) : null
  if (!rec) { console.error(`No job matching '${job}'. Run 'claude agents' to list running sessions.`); process.exit(1) }
  if (!alive(rec.pid)) {
    if (rec.settings && !fs.existsSync(rec.settings)) { console.error(`Error: Settings file not found: ${rec.settings}`); process.exit(1) }
    write(job, { pid: undefined, port: undefined })
    start(rec)
  }
  for (let waited = 0; waited < 8000 && !(rec = read(job))?.port; waited += 50) await sleep(50)
  if (!rec?.port) { console.error('The session did not start.'); process.exit(1) }
  const socket = net.connect(rec.port, '127.0.0.1')
  socket.on('data', (data) => process.stdout.write(data))
  socket.on('close', () => process.exit(0))
  socket.on('error', () => process.exit(1))
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (data) => socket.write(data))
} else if (command === 'stop') {
  const rec = read(argv[1])
  if (!rec) { console.error(`No job matching '${argv[1]}'.`); process.exit(1) }
  if (alive(rec.pid)) { try { process.kill(rec.pid) } catch { /* gone */ } }
  write(rec.job, { pid: undefined, port: undefined, status: undefined, waitingFor: undefined, state: 'stopped' })
  out(`stopped ${rec.job}`)
} else if (command === 'rm') {
  const rec = read(argv[1])
  if (rec && alive(rec.pid)) { console.error('It is running: stop it first.'); process.exit(1) }
  fs.rmSync(jobFile(argv[1]), { force: true })
  out(`removed ${argv[1]}`)
} else if (command === '__killall') {
  for (const rec of all()) if (alive(rec.pid)) { try { process.kill(rec.pid) } catch { /* gone */ } }
} else if (command === '__session') {
  await session(argv[1])
} else {
  console.error(`unknown command ${command}`)
  process.exit(2)
}

async function session(job) {
  let rec = write(job, { pid: process.pid })
  let current = rec.sessionId
  // A session the person started themselves has no settings file of Togle's, and no hook.
  const settings = rec.settings ? JSON.parse(fs.readFileSync(rec.settings, 'utf8')) : {}
  const url = settings.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.url
  const lines = []
  let client = null
  const say = (words) => {
    lines.push(`${words}\r\n`)
    if (lines.length > 80) lines.shift()
    client?.write(`${words}\r\n`)
  }
  const status = (value, waitingFor) => write(job, { status: value, waitingFor })
  const open = new Set()
  async function post(body) {
    if (!url) return null
    const controller = new AbortController()
    open.add(controller)
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: current, cwd: rec.cwd, hook_event_name: 'PermissionRequest', permission_suggestions: [], ...body }), signal: controller.signal })
      .then((response) => response.text())
      .catch(() => null)
  }
  let typed = null
  async function ask(name) {
    say('Do you want to proceed? (y/n)')
    status('waiting', 'permission prompt')
    const hook = post({ tool_name: 'Bash', tool_input: { command: `echo x > ${name}.txt` } })
    const screen = new Promise((resolve) => { typed = resolve })
    const answer = await Promise.race([
      hook.then((body) => {
        const decision = body ? JSON.parse(body).hookSpecificOutput.decision.behavior : null
        return decision ? { by: 'togle', allowed: decision === 'allow' } : new Promise(() => {})
      }),
      screen.then((yes) => ({ by: 'screen', allowed: yes }))
    ])
    typed = null
    status('busy')
    say(answer.allowed ? `ran ${name}${answer.by === 'screen' ? ' (answered here)' : ''}` : `refused ${name}`)
  }
  async function question() {
    say('Which? (1 red, 2 blue)')
    status('waiting', 'permission prompt')
    const hook = post({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which?', header: 'Which', options: [{ label: 'red' }, { label: 'blue' }], multiSelect: false }] } })
    const screen = new Promise((resolve) => { typed = resolve })
    const answer = await Promise.race([
      hook.then((body) => {
        const decision = body ? JSON.parse(body).hookSpecificOutput.decision : null
        return decision?.updatedInput ? { by: 'togle', words: Object.values(decision.updatedInput.answers ?? {})[0] } : new Promise(() => {})
      }),
      screen.then((yes) => ({ by: 'screen', words: yes ? 'red' : 'blue' }))
    ])
    typed = null
    status('busy')
    say(`answered ${answer.words}${answer.by === 'screen' ? ' (answered here)' : ''}`)
  }
  async function plan() {
    say('Plan: 1. Do A, 2. Do B. Approve? (y/n)')
    status('waiting', 'permission prompt')
    const hook = post({ tool_name: 'ExitPlanMode', tool_input: { plan: '1. Do A\n2. Do B' } })
    const screen = new Promise((resolve) => { typed = resolve })
    const answer = await Promise.race([
      hook.then((body) => {
        const decision = body ? JSON.parse(body).hookSpecificOutput.decision : null
        // As Claude Code does: a plan is approved by an answer that gives its input back; a plain "allow" leaves its own question open.
        if (decision?.behavior === 'allow' && !decision.updatedInput) { say('(its own question is still open)'); return new Promise(() => {}) }
        return decision ? { by: 'togle', approved: decision.behavior === 'allow', message: decision.message } : new Promise(() => {})
      }),
      screen.then((yes) => ({ by: 'screen', approved: yes }))
    ])
    typed = null
    status('busy')
    say(answer.approved ? `plan approved${answer.by === 'screen' ? ' (answered here)' : ''}` : `plan sent back: ${answer.message ?? 'no words'}`)
  }
  let turn = Promise.resolve()
  // Esc: what it does depends on what the session is doing (see the top).
  let interrupt = null
  let escapes = 0
  let lastEsc = 0
  let menu = false
  const esc = () => {
    escapes++
    write(job, { escapes })
    const quick = Date.now() - lastEsc < 800
    lastEsc = Date.now()
    if (menu) { menu = false; say('menu closed'); return }
    if (typed) { typed(false); return }
    if (interrupt) { interrupt(); return }
    if (quick) { menu = true; say('Rewind menu') }
  }
  async function handle(said) {
    if (said === 'bye') { for (const controller of open) controller.abort(); process.exit(0) }
    if (said === 'clear') {
      current = `${current}-2`
      write(job, { sessionId: current })
      say('cleared')
      return
    }
    status('busy')
    const run = /^run (\S+)/.exec(said)
    const two = /^run2 (\S+) (\S+)/.exec(said)
    if (two) { await ask(two[1]); await ask(two[2]) }
    else if (run) await ask(run[1])
    else if (said === 'slow' || said === 'long') {
      const stopped = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), said === 'slow' ? 3_000 : 20_000)
        interrupt = () => { clearTimeout(timer); resolve(true) }
      })
      interrupt = null
      if (stopped) say('Interrupted')
    }
    else if (said === 'question') await question()
    else if (said === 'plan') await plan()
    else say(`fine, ${said}`)
    status('idle')
    say('ready>')
  }
  const server = net.createServer((socket) => {
    if (client) { client.write('Session opened in another window\r\n'); client.end() }
    client = socket
    socket.write(lines.join(''))
    let line = ''
    const connected = Date.now()
    const ready = Number(process.env.FAKE_CLAUDE_READY_MS ?? 0)
    // The keys that edit the prompt, counted in the job file: the Up arrow (it gives a queue back to the prompt), the Down arrow (it puts back what
    // Up did when nothing was queued), Ctrl+A, Ctrl+K and Backspace.
    const edits = { ups: 0, downs: 0, homes: 0, kills: 0, backspaces: 0 }
    socket.on('data', (data) => {
      // A key that comes before the screen takes keys is lost.
      if (Date.now() - connected < ready) return
      const keys = [...data.toString('utf8')]
      for (let at = 0; at < keys.length; at++) {
        const key = keys[at]
        if (key === '\x03') continue
        if (key === '\x1b') {
          // An arrow key is a sequence that starts with Esc: not the key.
          if (keys[at + 1] === '[' || keys[at + 1] === 'O') {
            if (keys[at + 2] === 'A') { edits.ups++; write(job, { ...edits }) }
            else if (keys[at + 2] === 'B') { edits.downs++; write(job, { ...edits }) }
            at += 2
          } else esc()
          continue
        }
        if (key === '\x01' || key === '\x0b' || key === '\x7f') {
          if (key === '\x01') edits.homes++
          else if (key === '\x0b') edits.kills++
          else edits.backspaces++
          write(job, { ...edits })
          continue
        }
        // The rewind menu takes what is typed as its own.
        if (menu) continue
        if (key === '\r' || key === '\n') {
          const said = line
          line = ''
          socket.write('\r\n')
          if (typed && (said === 'y' || said === 'n')) typed(said === 'y')
          else if (typed && (said === '1' || said === '2')) typed(said === '1')
          else turn = turn.then(() => handle(said))
        } else {
          line += key
          socket.write(key)
        }
      }
    })
    socket.on('close', () => { if (client === socket) client = null })
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  rec = write(job, { pid: process.pid, port: server.address().port, status: 'idle', state: undefined })
  say('fake claude ready')
  const first = rec.first
  if (first) { write(job, { first: undefined }); turn = turn.then(() => handle(first)) }
  process.on('SIGTERM', () => process.exit(0))
  await new Promise(() => {})
}
