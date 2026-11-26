// Private Android/VPS smoke test. Run under unpackaged Electron with a fresh directory and a disposable account fixture.
// No control port. The local operator writes one word (pair, status, start, remove or quit) to A/run-command.
// For pair, place the code from the phone in A/pairing.txt first. A/proof.jsonl contains sanitized observations.
// electron test/phone-pilot-host.cjs A fixture.json
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, dialog, globalShortcut, ipcMain } = require('electron')

const [, , workArg, fixtureArg] = process.argv
assert.ok(workArg && path.isAbsolute(workArg) && fixtureArg && path.isAbsolute(fixtureArg), 'Use absolute paths for the new pilot directory and local account fixture.')
const work = fs.realpathSync.native(workArg)
const fixture = JSON.parse(fs.readFileSync(fixtureArg, 'utf8').replace(/^\uFEFF/, ''))
const repo = path.resolve(__dirname, '..')
const profile = path.join(work, 'profile')
const folder = path.join(work, 'task')
fs.mkdirSync(profile)
fs.mkdirSync(folder)
assert.ok(!app.isPackaged)
for (const [address, protocol] of [[fixture.relay, 'ws:'], [fixture.auth, 'http:']]) {
  const url = new URL(address)
  assert.ok(url.protocol === protocol && url.hostname === '127.0.0.1' && !url.username && !url.password, 'Use a loopback address for the isolated pilot.')
}
Object.assign(process.env, {
  TOGLE_COURIER: fixture.relay, TOGLE_ACCOUNT_SUPABASE_URL: fixture.auth, TOGLE_ACCOUNT_SUPABASE_KEY: fixture.publicKey,
  TOGLE_PHONE_PILOT: '1', TOGLE_GENUINE_QUESTION_SMOKE: '1', TOGLE_PHONE_PILOT_FOLDER: folder, TOGLE_DATA: profile,
  TOGLE_DEVICE_NAME: 'Private VPS pilot desktop', TOGLE_HEADLESS: '1', TOGLE_SILENT_AUDIO: '1', TOGLE_SPEECH_SEEDS: '',
  TOGLE_SPEECH_HOME: path.join(profile, 'speech'), CLAUDE_CONFIG_DIR: path.join(profile, 'claude'),
  CLAUDE_SECURESTORAGE_CONFIG_DIR: path.join(profile, 'claude')
})
delete process.env.TOGLE_TEST_RUNNERS
delete process.env.TOGLE_AUTOSTART
app.disableHardwareAcceleration()
app.setPath('userData', profile)
app.setAppPath(repo)
globalShortcut.register = () => false
const handlers = new Map()
const register = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (name, listener) => {
  handlers.set(name, listener)
  return register(name, listener)
}
// The headless loopback fixture stands in for the operator's local activation consent.
const showMessageBox = dialog.showMessageBox.bind(dialog)
dialog.showMessageBox = (...args) => args.at(-1)?.title === 'Enable remote access?'
  ? Promise.resolve({ response: 1, checkboxChecked: false })
  : showMessageBox(...args)
const call = (name, ...args) => {
  const sender = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Togle')?.webContents
  return handlers.get(name)({ sender, senderFrame: sender?.mainFrame }, ...args)
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(check, label, ms = 30000) {
  const expiry = Date.now() + ms
  while (Date.now() < expiry) {
    const value = await check()
    if (value) return value
    await wait(200)
  }
  throw new Error('Timed out waiting for ' + label)
}
const event = (stage, details = {}) => fs.appendFileSync(path.join(work, 'proof.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage, ...details }) + '\n')
const digest = value => crypto.createHash('sha256').update(value).digest('hex').slice(0, 16)
const phoneName = 'Android pilot phone'
const title = 'VPS phone color check'
const question = 'Which pilot color should I report?'
const colors = ['Blue', 'Green']
const marker = 'TOGLE-VPS-' + crypto.randomBytes(4).toString('hex').toUpperCase()
let taskKey, phone, online, started, sawQuestion, verified, removed
require(path.join(repo, 'out/main/index.js'))

async function command(verb) {
  if (verb === 'pair') {
    assert.ok(!phone, 'A phone is already paired.')
    const codeFile = path.join(work, 'pairing.txt')
    const code = fs.readFileSync(codeFile, 'utf8').trim().replace(/[\s-]/g, '')
    fs.unlinkSync(codeFile)
    assert.match(code, /^[A-Z\d]{8}$/)
    await call('reach:add', code)
    const state = await until(async () => {
      const { adding } = await call('reach:state')
      if (adding?.stage === 'failed') throw new Error('Phone pairing failed.')
      return adding?.stage === 'confirm' && adding
    }, 'the device confirmation')
    assert.equal(state.role, 'phone')
    assert.equal(state.name, phoneName)
    await call('reach:confirm-add')
    phone = (await until(async () => (await call('reach:state')).devices.find(device => device.role === 'phone' && device.name === phoneName && device.online), 'the online phone')).device
    event('phone-paired', { peer: digest(phone), role: 'phone' })
  } else if (verb === 'start') {
    assert.ok(phone && !removed && !started, 'Pair a phone before starting the single test task.')
    const { devices, actOnThis, phonePilot } = await call('reach:state')
    assert.ok(phonePilot && actOnThis && devices.some(device => device.device === phone && device.online))
    started = true
    const prompt = `Use the request_user_input tool once to ask exactly one non-secret multiple-choice question: "${question}" with the choices Blue and Green. Wait for the human to select a choice. For Blue respond exactly ${marker}-BLUE. For Green respond exactly ${marker}-GREEN. Do not infer a choice. Do not run commands, open files or use any other tool.`
    const task = await call('runners:start', { runner: 'codex', folder, title, prompt, asks: true })
    assert.equal(task.runner, 'codex')
    assert.ok(task.mine && path.resolve(task.folder) === folder)
    taskKey = task.key
    event('task-started', { task: digest(taskKey), runner: 'Codex', folderScope: 'exact demo folder' })
  } else if (verb === 'remove') {
    assert.ok(phone && !removed)
    await call('reach:remove', phone)
    assert.ok(!(await call('reach:state')).devices.some(device => device.device === phone))
    removed = true
    event('phone-removed', { peer: digest(phone) })
  } else if (verb === 'status') {
    const state = await call('reach:state')
    event('status', { host: state.link, phone: phone ? state.devices.some(device => device.device === phone && device.online) : false, sawQuestion: !!sawQuestion, verified: !!verified, removed: !!removed })
  } else if (verb === 'quit') {
    if (taskKey && !verified) {
      const { task } = await call('runners:detail', taskKey)
      if (task.state === 'working' || task.state === 'waiting') await call('runners:stop', taskKey)
    }
    if (phone && !removed) await command('remove')
    event('host-stopped', { verified: !!verified })
    app.exit(0)
  }
}

async function observe() {
  const state = await call('reach:state')
  if (phone && !removed) {
    const current = state.devices.some(device => device.device === phone && device.online)
    if (current !== online) event(current ? 'phone-online' : 'phone-offline', { peer: digest(phone) })
    online = current
  }
  if (!taskKey || verified) return
  const { task, log } = await call('runners:detail', taskKey)
  assert.equal(task.key, taskKey)
  assert.ok(task.mine && path.resolve(task.folder) === folder)
  if (task.pending.some(request => request.kind !== 'question')) throw new Error('The task requested an unexpected operation.')
  const pending = task.pending.find(request => request.codexInputId && request.questions?.length === 1)
  if (pending && !sawQuestion) {
    const [input] = pending.questions
    assert.equal(input.text, question)
    assert.deepEqual(input.options, colors)
    assert.equal(input.secret, false)
    sawQuestion = true
    event('live-codex-question', { task: digest(taskKey), question, choices: colors })
  }
  if (!sawQuestion || pending) return
  const replies = state.acted.filter(record => record.device === phone && record.what === 'Answered a Codex question in ' + title)
  assert.ok(replies.length <= 1, 'The phone answered more than once.')
  const chosen = colors.find(color => log.some(entry => entry.kind === 'agent' && entry.text.trim() === marker + '-' + color.toUpperCase()))
  if (replies.length === 1 && chosen && task.state === 'idle') {
    verified = true
    event('same-task-completed', { task: digest(taskKey), peer: digest(phone), selected: chosen, acceptedReplies: replies.length, result: marker + '-' + chosen.toUpperCase(), state: task.state })
  }
}

async function main() {
  await until(() => handlers.has('reach:state') && handlers.has('runners:start'), 'Togle startup')
  await call('reach:sign-in', fixture.email, fixture.otp)
  await call('reach:connect')
  const state = await until(async () => {
    const state = await call('reach:state')
    return state.standing === 'member' && state.connection === 'on' && state
  }, 'Pro connection')
  assert.ok(state.phonePilot && state.actOnThis && state.devices.length === 1)
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  event('host-ready', { pairedDevices: 0, connection: state.connection, desktop: 'unpackaged', revision, relayForwardPort: new URL(fixture.relay).port, host: digest(state.me.device) })
  const commandFile = path.join(work, 'run-command')
  while (true) {
    if (fs.existsSync(commandFile)) {
      const verb = fs.readFileSync(commandFile, 'utf8').trim()
      fs.unlinkSync(commandFile)
      await command(verb)
    }
    await observe()
    await wait(350)
  }
}
app.whenReady().then(main).catch(async error => {
  event('host-error', { reason: String(error.message).split('\n')[0].replace(/\b\d{6,10}\b/g, '[redacted]').slice(0, 200) })
  if (taskKey && !verified) await Promise.resolve().then(() => call('runners:stop', taskKey)).catch(() => {})
  if (phone && !removed) await Promise.resolve().then(() => call('reach:remove', phone)).catch(() => {})
  app.exit(1)
})
