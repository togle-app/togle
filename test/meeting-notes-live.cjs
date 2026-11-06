// Explicit opt-in: the real Electron main process, real call-end scheduler and
// connected Claude subscription, using fictional transcript text in a fresh profile.
const { app, ipcMain, globalShortcut } = require('electron')
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const directory = path.join(__dirname, '.work', 'meeting-notes-live-' + process.pid)
fs.mkdirSync(directory, { recursive: true }); app.setPath('userData', directory)
process.env.TOGLE_HEADLESS = '1'; process.env.TOGLE_SILENT_AUDIO = '1'; process.env.TOGLE_DEBUG_PORT = '0'
process.env.TOGLE_SPEECH_HOME = path.join(directory, 'speech'); process.env.TOGLE_SPEECH_SEEDS = ''
delete process.env.TOGLE_AUTOSTART
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
// The integration fixture must never reserve the user's global shortcuts.
globalShortcut.register = () => true; globalShortcut.unregister = () => {}; globalShortcut.unregisterAll = () => {}; globalShortcut.isRegistered = () => false
const handlers = new Map(), handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => { handlers.set(channel, callback); return handle(channel, callback) }
const invoke = (channel, ...args) => handlers.get(channel)({}, ...args)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Automatic meeting notes integration check timed out'); app.exit(1) }, 120000)
require('../out/main/index.js')
async function run() {
  while (!handlers.has('dev:transcript')) await delay(50)
  const accounts = await invoke('accounts:list')
  assert.ok(accounts.find(account => account.id === 'claude-default')?.signedIn, 'Sign in to the default Claude account for this opt-in check')
  await invoke('settings:update', { subscriptionAccountId: 'claude-default', dictation: { showBar: false }, assist: { auto: false, rememberCalls: true, autoNotes: true, calendarReminders: false, voiceLabels: false } })
  const agent = (await invoke('agents:list'))[0]
  await invoke('agents:update', agent.id, { learning: 'off' })
  const live = await invoke('session:listening', true)
  assert.equal(live.accountId, 'claude-default')
  invoke('dev:transcript', 'me', 'This is a fictional test meeting. We agreed to postpone the launch. No new launch date has been set.')
  invoke('dev:transcript', 'them', 'Denis will send the fictional incident report by Friday. That action is confirmed.')
  invoke('dev:transcript', 'me', 'Reviewing the billing flow is only a proposal. Nobody has been assigned to it.')
  await invoke('session:listening', false)
  let saved
  for (;;) {
    saved = await invoke('calls:get', live.id)
    if (saved.minutes?.state === 'error') throw Error(saved.minutes.error)
    if (saved.minutes?.state === 'ready') break
    await delay(150)
  }
  assert.equal(saved.learning.state, 'not-reviewed'); assert.match(saved.summary, /Denis/); assert.match(saved.summary, /Friday/); assert.match(saved.summary, /\[\d+:\d{2}\]/)
  assert.match(saved.summary, /postpon/i); assert.match(saved.summary, /(?:not assigned|unassigned|no owner|nobody|no one)/i)
  const edited = await invoke('calls:notes-save', saved.id, saved.minutes.revision, 'My reviewed notes: the launch date is still undecided.')
  const personal = await invoke('calls:notes-personal', saved.id, '', 'Ask for the incident timeline next time.')
  assert.equal(personal.minutes.edited, true); assert.equal(personal.summary, edited.summary)
  await invoke('session:clear')
  await invoke('settings:update', { assist: { autoNotes: false } })
  const disabled = await invoke('session:listening', true)
  invoke('dev:transcript', 'me', 'Another fictional meeting. No notes should generate automatically.')
  await invoke('session:listening', false); await delay(2200)
  assert.equal((await invoke('calls:get', disabled.id)).minutes, undefined)
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ fixtureOnly: true, original: saved.summary, edited: personal.summary, personalNotes: personal.personalNotes, learningState: saved.learning.state, accountId: saved.accountId, autoOffVerified: true }, null, 2))
  console.log('PASS actual call-end scheduler + Claude: automatic timestamped notes with learning off, pinned account, edits, personal notes, and auto-notes off')
  console.log('Fixture result: ' + path.join(directory, 'result.json'))
  clearTimeout(timeout); ipcMain.emit('window:close', {}, true)
}
run().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
