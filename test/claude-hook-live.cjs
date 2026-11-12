// Live test, not part of `npm test`: the real Togle app, a real Claude Code session in a terminal, and Togle's hook between
// them. Claude Code asks about a command; Togle shows it in a notice; the person's answer there decides the command, and an
// answer given in the terminal first makes the question here go. It uses the signed-in Claude Code on this computer for three
// short prompts, in a terminal from node-pty (Togle's own, for agents without ACP; TOGLE_PTY_MODULE names another copy).
//
// Nothing of the person's own Claude settings is changed: the hook is given to Claude Code with --settings.
const { app, BrowserWindow, ipcMain } = require('electron')
app.disableHardwareAcceleration()
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const repo = path.resolve(__dirname, '..')
const pty = require(process.env.TOGLE_PTY_MODULE || 'node-pty')

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-live-profile-'))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-live-work-'))
app.setPath('userData', profile)
process.env.TOGLE_HEADLESS = '1'
process.env.TOGLE_SILENT_AUDIO = '1'
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
process.env.TOGLE_SPEECH_SEEDS = ''
delete process.env.TOGLE_AUTOSTART
const handlers = new Map()
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (name, callback) => { handlers.set(name, callback); return originalHandle(name, callback) }
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const began = Date.now()
const at = () => ((Date.now() - began) / 1000).toFixed(1).padStart(5)
const events = []
const note = (what) => { events.push(`${at()} s  ${what}`); console.log(`${at()} s  ${what}`) }
const until = async (check, what, ms = 60000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await check()
    if (value) return value
    await sleep(150)
  }
  throw new Error('timed out waiting for ' + what)
}
const hookPrograms = () => {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '--togle-hook' -and $_.ProcessId -ne $PID } | Measure-Object).Count"], { encoding: 'utf8' })
  return Number(out.trim())
}
const dataFolderState = () => {
  const folder = path.join(process.env.APPDATA ?? '', 'togle')
  try { return fs.readdirSync(folder).map((name) => `${name}:${Math.round(fs.statSync(path.join(folder, name)).mtimeMs)}`).sort().join('|') } catch { return 'none' }
}
const timeout = setTimeout(() => { console.error('Live test timed out'); finish(1) }, 280000)

let term
let finished = false
const finish = (code) => {
  if (finished) return
  finished = true
  clearTimeout(timeout)
  try { term?.kill() } catch { /* gone */ }
  try { execFileSync('claude', ['purge', '--yes', work], { stdio: 'ignore' }) } catch { /* not there */ }
  for (const folder of [work, profile]) {
    try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) } catch { /* in use */ }
  }
  app.exit(code)
}

require('../out/main/index.js')

;(async () => {
  const T = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  const before = dataFolderState()
  await until(() => handlers.has('runners:list') && BrowserWindow.getAllWindows().length, 'the app', 30000)
  // The channel is open once something answers on it.
  await until(() => new Promise((resolve) => { const probe = net.connect(T.channelAddress(profile)); probe.once('connect', () => { probe.destroy(); resolve(true) }); probe.once('error', () => resolve(false)) }), 'the channel', 30000)
  note('Togle is up and the channel answers')

  // The hook, exactly as Togle would write it into Claude Code's settings, in a settings file of its own.
  const settingsFile = path.join(profile, 'claude-settings.json')
  const settings = new T.ClaudeSettings(settingsFile, () => ({ command: process.execPath, args: [repo, '--togle-hook', 'claude-permission', '--data', profile] }))
  assert.equal((await settings.connect()).installed, true)

  // Claude Code in a terminal: a session of its own, not a child of the one that may be running this test.
  const env = { ...process.env, ANTHROPIC_MODEL: 'haiku' }
  for (const name of Object.keys(env)) if (/^(CLAUDE_CODE_|CLAUDECODE|CLAUDE_PID)/.test(name)) delete env[name]
  delete env.ELECTRON_RUN_AS_NODE
  const claude = process.env.TOGLE_CLAUDE_PATH || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude')
  term = pty.spawn(claude, ['--settings', settingsFile, '--permission-mode', 'default'], { name: 'xterm-256color', cols: 130, rows: 45, cwd: work, env, useConpty: true })
  let raw = ''
  const strip = (text) => text.replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/[\x00-\x08\x0b-\x1f]/g, '')
  term.onData((data) => { raw += data })
  const flat = () => strip(raw.slice(-9000)).replace(/\s+/g, '')
  const ready = () => flat().includes('?forshortcuts')
  for (let tries = 0; tries < 10 && !ready(); tries++) {
    await sleep(2500)
    // A new folder asks whether to trust it; the question starts on "No, exit": one step down, then Enter.
    if (!ready() && /Quicksafetycheck|trustthisfolder/i.test(flat())) { term.write('\x1b[B'); await sleep(800); term.write('\r') }
  }
  await until(ready, 'the prompt box', 30000)
  note('Claude Code is up in the terminal')
  await sleep(1200)

  const ask = async (file) => {
    raw = ''
    term.write(`Use your Bash tool to run exactly this command and nothing else: touch ${file}`)
    await sleep(500)
    term.write('\r')
    const sent = Date.now()
    let checked = 0
    const waiting = await until(async () => {
      if (Date.now() - sent > ++checked * 8000) note(`still waiting for the question in Togle; hook programs running: ${hookPrograms()}; the terminal shows its question: ${/Doyouwanttoproceed|1\.Yes/i.test(flat())}`)
      return (await invoke('runners:list')).find((task) => task.state === 'waiting' && !task.mine && task.pending.length)
    }, 'the question in Togle', 60000).catch((error) => {
      console.error('The terminal at that moment: ' + strip(raw).replace(/\s+/g, ' ').slice(-1200))
      throw error
    })
    note(`Togle holds the question after ${Date.now() - sent} ms: ${waiting.line}`)
    return { waiting, sent }
  }
  const shows = async (words) => until(() => /Doyouwanttoproceed|1\.Yes/i.test(flat()) || flat().includes(words), 'the terminal to show something', 20000)
  const noticeWindow = () => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('surface=notice'))
  const press = (win, label) => win.webContents.executeJavaScript(`[...document.querySelectorAll('.task-notice-actions button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)

  // 1. Allowed from the notice.
  const first = await ask('allowed-by-togle.txt')
  assert.equal(first.waiting.pending[0].command, 'touch allowed-by-togle.txt')
  assert.equal(first.waiting.folder.toLowerCase(), work.toLowerCase().replace(/\\/g, '\\'), 'the question says which folder it is about')
  await until(noticeWindow, 'the notice window')
  const notice = noticeWindow()
  await until(() => notice.webContents.executeJavaScript("!!document.querySelector('.task-notice')"), 'the notice')
  const says = await notice.webContents.executeJavaScript("document.querySelector('.task-notice-says').textContent + ' | ' + document.querySelector('.task-notice-detail').textContent")
  note('notice: ' + says)
  assert.ok(says.includes('wants to run') && says.includes('touch allowed-by-togle.txt'))
  await shows('')
  note('the terminal shows its own question as well')
  await until(() => notice.webContents.executeJavaScript("document.querySelector('.task-notice-actions .primary')?.disabled===false"), 'Allow once to be ready')
  const answered = Date.now()
  await press(notice, 'Allow once')
  await until(() => fs.existsSync(path.join(work, 'allowed-by-togle.txt')), 'the command to run', 30000)
  note(`allowed in Togle; the command ran ${Date.now() - answered} ms later`)
  await until(() => /AllowedbyPermissionRequesthook/i.test(flat()), 'the terminal to say the hook allowed it', 20000)
  await until(() => ready(), 'the prompt box again', 60000)
  await sleep(1500)
  assert.equal((await invoke('runners:list')).some((task) => task.pending.length && !task.mine), false, 'the question is gone from Togle')

  // 2. Refused from the notice: the command does not run, and the agent is told.
  await ask('refused-by-togle.txt')
  const notice2 = noticeWindow()
  await until(() => notice2.webContents.executeJavaScript("[...document.querySelectorAll('.task-notice-actions button')].some(b=>b.textContent==='Refuse')"), 'Refuse in the notice')
  await press(notice2, 'Refuse')
  await until(() => /DeniedbyPermissionRequesthook/i.test(flat()), 'the terminal to say it was refused', 30000)
  note('refused in Togle; the terminal says the hook denied it')
  await until(() => ready(), 'the prompt box again', 60000)
  assert.equal(fs.existsSync(path.join(work, 'refused-by-togle.txt')), false, 'the refused command did not run')

  // 3. Answered in the terminal first: the question here goes, and the hook program ends.
  const third = await ask('answered-in-terminal.txt')
  assert.ok(third.waiting.pending.length === 1)
  await until(() => /Doyouwanttoproceed|1\.Yes/i.test(flat()), 'the terminal question', 20000)
  const programsBefore = hookPrograms()
  term.write('\r')
  await until(() => fs.existsSync(path.join(work, 'answered-in-terminal.txt')), 'the command to run', 30000)
  note('answered in the terminal; the command ran')
  const goneAfter = Date.now()
  await until(async () => !(await invoke('runners:list')).some((task) => task.pending.length && !task.mine), 'the question to go from Togle', 40000)
  note(`the question went from Togle ${Date.now() - goneAfter} ms after the terminal was answered`)
  await until(() => hookPrograms() < Math.max(1, programsBefore), 'the hook program to end', 30000)
  note(`hook programs still running: ${hookPrograms()}`)
  await until(() => ready(), 'the prompt box again', 60000)

  const after = dataFolderState()
  note('the data folder of a plain development run ' + (before === after ? 'was not touched by the hook programs' : 'changed while this ran (the hook programs, or something else)'))
  console.log('CLAUDE HOOK LIVE PASS: a question from a Claude Code terminal session shows in Togle, is allowed and refused there, and goes when it is answered in the terminal')
  finish(0)
})().catch((error) => {
  console.error(error.stack || error)
  try { fs.writeFileSync(path.join(profile, 'events.txt'), events.join('\n')) } catch { /* nowhere to write */ }
  finish(1)
})
