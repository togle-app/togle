// A stand-in for the `hermes` program in the ways Togle meets it as a screen (as recorded from Hermes 0.22 on Windows):
//   hermes --version
//   hermes chat --tui --query=<words> --in <dir> -c <name> --create-if-missing     a new session, with its first words
//   hermes --tui --resume <id or name>                                               an old one
//   hermes sessions list [--source local|cli|tui|desktop|cron|...] [--limit N] [--workspace NAME]   one source at a time, as Hermes does
//   hermes sessions rename <id> <title>       hermes sessions delete --yes <id>
// The sessions are kept in FAKE_HERMES_HOME/sessions.json; a test may write rows there before it starts. A screen sets its
// window title the way Hermes's does: `<marker> <session> · <model> · <folder>`, with ⏳ while it works, ⚠ while it waits on
// the person and ✓ when idle. The words of a turn say what it does:
//   "say ok"   works for a moment, then prints "ok"
//   "slow"     works for a second and a half
//   "ask"      waits on the person (⚠) until a line is typed, then goes on
//   "sleep"    works until Ctrl+C
// A line typed while a turn works is not queued and does not end the turn: it steers it ("steering: <words>"), and the answer takes it in
// ("ok + <words>"), as the real Hermes 0.22.5 does (measured: it puts the line in the turn at the next tool).
//   "fail"     the turn fails at once; the session is kept with no folder, as Hermes does when its model fails
// FAKE_HERMES_FIRST_ENTER_IGNORED: a typed line is kept in the input at its first Enter and taken at the second (a screen not ready for
// Enter yet); FAKE_HERMES_DEAF: a typed line is never taken. FAKE_HERMES_HELD makes `--resume` refuse, as Hermes does when another window holds the session; FAKE_HERMES_ARGS names a file
// that gets the arguments each screen was started with.
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const argv = process.argv.slice(2)
const home = process.env.FAKE_HERMES_HOME ?? ''
const file = path.join(home, 'sessions.json')
const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [])
const save = (rows) => {
  mkdirSync(home, { recursive: true })
  writeFileSync(file, JSON.stringify(rows))
}
const valueOf = (flag) => {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

if (argv[0] === '--version') {
  console.log('Hermes Agent v0.0.0-fake')
} else if (argv[0] === 'sessions') {
  sessions()
} else if (argv.includes('--tui')) {
  screen()
} else {
  console.error(`unknown: ${argv.join(' ')}`)
  process.exit(2)
}

function ago(at) {
  const seconds = (Date.now() - at) / 1000
  if (seconds < 90) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`
  return new Date(at).toISOString().slice(0, 10)
}

function sessions() {
  const rows = load()
  if (argv[1] === 'list') {
    const source = valueOf('--source')
    const workspace = valueOf('--workspace')
    const shown = rows
      .filter((row) => (source ? (row.source ?? 'local') === source : true))
      .filter((row) => (workspace ? row.workspace === workspace || row.workspace.includes(workspace) : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const pad = (text, width) => text.padEnd(width).slice(0, Math.max(width, text.length))
    console.log(`${pad('Title', 29)}${pad('Workspace', 19)}${pad('Last Active', 14)}ID`)
    console.log('─'.repeat(110))
    for (const row of shown) console.log(`${pad(row.title.slice(0, 26), 29)}${pad(row.workspace || '—', 19)}${pad(ago(row.updatedAt), 14)}${row.id}`)
    return
  }
  if (argv[1] === 'export') {
    // `export - --session-id <id>`: one line of JSON for the session, with the messages a test wrote on its row. An error is said on
    // stdout, as Hermes does, with exit 1.
    const id = valueOf('--session-id')
    const row = rows.find((candidate) => candidate.id === id)
    if (!row) {
      console.log(`Error: Session '${id}' not found.`)
      process.exit(1)
    }
    console.log(JSON.stringify({ id: row.id, source: row.source ?? 'local', message_count: (row.messages ?? []).length, system_prompt: 'x'.repeat(2000), messages: row.messages ?? [] }))
    return
  }
  if (argv[1] === 'rename') {
    const row = rows.find((candidate) => candidate.id === argv[2])
    if (!row) return fail(`no session ${argv[2]}`)
    if (rows.some((other) => other !== row && other.title === argv[3])) return fail('that title is already used')
    row.title = argv[3]
    save(rows)
    console.log('Renamed')
    return
  }
  if (argv[1] === 'delete') {
    const id = argv[argv.length - 1]
    if (!rows.some((row) => row.id === id)) return fail(`no session ${id}`)
    save(rows.filter((row) => row.id !== id))
    console.log(`Deleted session '${id}'`)
    return
  }
  fail('unknown sessions command')
}

function fail(words) {
  console.error(`Error: ${words}`)
  process.exit(1)
}

function screen() {
  if (process.env.FAKE_HERMES_ARGS) appendFileSync(process.env.FAKE_HERMES_ARGS, `${JSON.stringify(argv)}\n`)
  const resume = valueOf('--resume')
  const dir = valueOf('--in') ?? process.cwd()
  let name = valueOf('-c') ?? ''
  let words = (argv.find((word) => word.startsWith('--query=')) ?? '').slice('--query='.length)
  let row
  if (resume !== undefined) {
    row = load().find((candidate) => candidate.id === resume || candidate.title === resume)
    if (process.env.FAKE_HERMES_HELD) {
      console.error(`Error: This chat is open in another Hermes window/terminal, and attaching this terminal to it is not available in this build. Close the chat there and run hermes --resume ${resume} here to take it over.`)
      process.exit(1)
    }
    if (!row) return fail(`no session ${resume}`)
    name = row.title
  }
  const folder = path.basename(dir)
  const title = (marker) => process.stdout.write(`\x1b]0;${marker} ${name ? `${name} · ` : ''}fake-model · ${folder}\x07`)
  let busy = false
  let ignored = false
  let waiting = null
  let sleeping = null
  // What was typed while the turn worked: Hermes puts it in the turn (it steers it, and does not end it or queue it), and the turn's
  // answer takes it in.
  const steers = []
  const keep = (workspace = folder) => {
    const rows = load()
    row = rows.find((candidate) => candidate.title === name) ?? row
    if (!row) {
      row = { id: `local-${randomBytes(16).toString('hex')}`, title: name, workspace, source: 'local', updatedAt: Date.now() }
      rows.push(row)
    }
    row.updatedAt = Date.now()
    save(rows)
  }
  const end = (said, workspace = folder) => {
    busy = false
    keep(workspace)
    const told = steers.length && said ? `${said} + ${steers.splice(0).join(' + ')}` : said
    steers.length = 0
    if (told) process.stdout.write(`${told}\r\n`)
    title('✓')
  }
  const turn = (text) => {
    busy = true
    title('⏳')
    // Hermes keeps the session of a first turn that failed, with no folder in its list.
    if (/^fail/.test(text)) return setTimeout(() => end('Your request was not processed. Send it again if you still want me to carry it out.', ''), 400)
    if (/^ask/.test(text)) {
      return setTimeout(() => {
        title('⚠')
        process.stdout.write('Allow this command? (y/n)\r\n')
        waiting = () => {
          waiting = null
          title('⏳')
          setTimeout(() => end('allowed'), 300)
        }
      }, 200)
    }
    if (/^sleep/.test(text)) {
      sleeping = setInterval(() => undefined, 1 << 30)
      process.stdout.write('sleeping\r\n')
      return undefined
    }
    if (/^slow/.test(text)) process.stdout.write('working slowly\r\n')
    return setTimeout(() => end(/^slow/.test(text) ? 'slow done' : 'ok'), /^slow/.test(text) ? 1500 : 300)
  }
  process.stdout.write(`HERMES SCREEN ${resume ?? name}\r\n`)
  title('✓')
  if (resume !== undefined) process.stdout.write(`RESUMED ${row.id}\r\n`)
  // FAKE_HERMES_RESUME_BUSY: the session was in the middle of a turn when this screen opened (it began on another screen, or before this one was
  // closed): the screen says so by its title at once, and the turn ends a moment later.
  if (resume !== undefined && process.env.FAKE_HERMES_RESUME_BUSY) {
    busy = true
    title('⏳')
    process.stdout.write('resumed mid-turn\r\n')
    setTimeout(() => end('mid done'), 2500)
  }
  if (words) setTimeout(() => turn(words), 300)
  let line = ''
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (data) => {
    for (const char of String(data)) {
      if (char === '\x03') {
        // Ctrl+C: it ends a turn that works, and leaves when idle.
        if (busy) {
          if (sleeping) clearInterval(sleeping)
          sleeping = null
          waiting = null
          steers.length = 0
          end('interrupted')
        } else process.exit(0)
      } else if (char === '\r' || char === '\n') {
        const typed = line.trim()
        line = ''
        if (typed === '/exit') process.exit(0)
        if (waiting) waiting()
        else if (typed && !busy) {
          if (process.env.FAKE_HERMES_DEAF) continue
          if (process.env.FAKE_HERMES_FIRST_ENTER_IGNORED && !ignored) {
            ignored = true
            line = typed
            continue
          }
          words = typed
          turn(typed)
        } else if (typed && busy) {
          // A line typed while the turn works steers it.
          steers.push(typed)
          process.stdout.write(`steering: ${typed}\r\n`)
        }
      } else line += char
    }
  })
  setInterval(() => undefined, 1 << 30)
}
