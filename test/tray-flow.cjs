// Actual main, renderer, native menus and IPC; only the shell icon is a test double.
// No visible windows, personal data, devices, subscriptions, or desktop input.
const electron = require('electron')
const { app, BrowserWindow, ipcMain } = electron
app.disableHardwareAcceleration()
const { EventEmitter } = require('node:events')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const defaultMode = process.platform === 'win32' ? 'hold' : 'toggle'
const defaultPrompt = defaultMode === 'hold' ? 'Hold' : 'Press'
let icon
class TestTray extends EventEmitter {
  constructor(file) { super(); assert.ok(typeof file === 'string' ? fs.existsSync(file) : !file.isEmpty()); icon = this; this.destroyed = false }
  setToolTip(value) { this.tooltip = value }
  setContextMenu(value) { this.menu = value }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
}
const Module = require('node:module'), originalLoad = Module._load
Module._load = function(name, ...args) { return name === 'electron' ? { ...electron, Tray: TestTray } : originalLoad.call(this, name, ...args) }
const profile = path.join(__dirname, '.work', 'tray-' + process.pid)
fs.mkdirSync(profile, { recursive: true }); app.setPath('userData', profile)
app.setAppPath(path.resolve(__dirname, '..'))
process.env.TOGLE_HEADLESS = '1'; process.env.TOGLE_TEST_TRAY = '1'; process.env.TOGLE_SILENT_AUDIO = '1'
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech'); process.env.TOGLE_SPEECH_SEEDS = ''
process.env.CLAUDE_CONFIG_DIR = path.join(profile, 'claude')
process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
delete process.env.TOGLE_AUTOSTART
const handlers = new Map(), originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (name, callback) => { handlers.set(name, callback); return originalHandle(name, callback) }
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const wait = async check => { for (let n = 0; n < 160; n++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 30)) }; throw Error('Tray test timed out') }
const timeout = setTimeout(() => { console.error('Tray lifecycle timed out'); app.exit(1) }, 30_000)
require('../out/main/index.js')

async function run() {
  await wait(() => icon?.menu && BrowserWindow.getAllWindows().length === 2 && BrowserWindow.getAllWindows().some(win => win.webContents.getURL().includes('surface=dictation')))
  const bar = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('surface=dictation'))
  const main = BrowserWindow.getAllWindows().find(win => win !== bar)
  const js = code => main.webContents.executeJavaScript(code)
  await wait(() => js("!!document.querySelector('.workspace-nav')"))
  await js(`window.__microphoneRequests=0;
    Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[{kind:'audioinput',deviceId:'default',label:'Default'},{kind:'audioinput',deviceId:'headset',label:'USB headset'},{kind:'audioinput',deviceId:'desk',label:'Desk microphone'}],configurable:true});
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:()=>{window.__microphoneRequests++;throw Error('Settings must never open a microphone')},configurable:true});undefined`)
  let opened = 0; main.show = () => { opened++ }; main.focus = () => {}
  const item = label => icon.menu.items.find(entry => entry.label === label)
  assert.equal(invoke('hotkeys:list').find(key => key.id === 'dictate').defaultKeys, 'F9')
  assert.equal(bar.isFocusable(), false)
  // Windows reports always-on-top only once a window is shown. The native bar UI check verifies it.
  assert.equal(main.isVisible(), false); assert.equal(bar.isVisible(), false)
  assert.equal(item('Show voice bar').checked, true)
  main.close(); assert.equal(main.isDestroyed(), false, 'Closing keeps the app and shortcut alive')
  icon.emit('click'); assert.equal(opened, 1, 'Tray click reopens the main window')
  item('Show voice bar').click({ checked: false })
  await wait(() => invoke('settings:get').dictation.showBar === false)
  item('Show voice bar').click({ checked: true })
  await wait(() => invoke('settings:get').dictation.showBar === true)
  assert.equal(BrowserWindow.getAllWindows().length, 2, 'Toggling the bar reuses its one renderer')
  item('Dictation settings').click()
  await wait(() => js("!!document.querySelector('#settings-dictation')"))
  assert.equal(await js("document.querySelectorAll('[aria-label=\"Dictation shortcut\"]').length"), 1, 'The shortcut has one editable home')
  await wait(() => js("!!document.querySelector('#settings-dictation option[value=headset]')"))
  assert.equal(invoke('settings:get').dictation.mode, process.platform === 'win32' ? 'hold' : 'toggle', 'Dictation uses the shortcut mode supported by this platform')
  await js("(()=>{const select=document.querySelector('[aria-label=\"Dictation microphone\"]');select.value='headset';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await wait(() => invoke('settings:get').dictation.microphoneId === 'headset')
  assert.equal(await js('window.__microphoneRequests'), 0, 'Choosing a microphone never starts capture')
  await js("Object.defineProperty(navigator.mediaDevices,'enumerateDevices',{value:async()=>[{kind:'audioinput',deviceId:'desk',label:'Desk microphone'}],configurable:true});navigator.mediaDevices.dispatchEvent(new Event('devicechange'))")
  await wait(() => js("document.querySelector('#settings-dictation option[value=headset]')?.textContent.includes('not listed')"))
  assert.equal(invoke('settings:get').dictation.microphoneId, 'headset', 'Removing a device never silently switches the saved choice')
  fs.writeFileSync(path.join(profile, 'dictation-settings.png'), (await main.webContents.capturePage()).toPNG())
  await js("(()=>{const select=document.querySelector('[aria-label=\"Voice typing account\"]');select.value='claude-default';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await wait(() => invoke('settings:get').dictation.accountId === 'claude-default')
  await wait(() => js("document.querySelector('#settings-dictation').textContent.includes('Claude adds punctuation')"))
  assert.equal(await js("!!document.querySelector('#settings-dictation option[value=local]')"), false, 'Dictation never offers a local model')
  fs.writeFileSync(path.join(profile, 'claude-dictation-settings.png'), (await main.webContents.capturePage()).toPNG())
  await js("(()=>{const select=document.querySelector('[aria-label=\"Voice typing account\"]');select.value='';select.dispatchEvent(new Event('change',{bubbles:true}))})()")
  await wait(() => invoke('settings:get').dictation.accountId === '')
  await wait(() => js("document.querySelector('[aria-label=\"Voice typing account\"]').value === ''"))
  assert.equal(await js('window.__microphoneRequests'), 0, 'Choosing the speech service never opens the microphone')
  item('Show voice bar').click({ checked: false })
  await wait(() => js("!document.querySelector('#settings-dictation [role=switch]').checked"))
  const changed = await invoke('hotkeys:set', 'dictate', 'F18')
  assert.equal(changed.find(key => key.id === 'dictate').keys, 'F18')
  await wait(() => bar.webContents.executeJavaScript("document.querySelector('.dictation-prompt kbd')?.textContent === 'F18'"))
  assert.ok(icon.tooltip.includes('F18'))
  const voiceOwner = invoke('agents:list')[0]
  const otherAgent = await invoke('agents:create', 'blank')
  await invoke('agents:update', voiceOwner.id, { preferences: { dictation: { mode: 'toggle', polish: false, showBar: true, microphoneId: 'headset' } } })
  await invoke('dictation:agent', voiceOwner.id)
  await wait(() => bar.webContents.executeJavaScript("document.querySelector('.dictation-prompt')?.textContent.startsWith('Press')"))
  assert.equal(invoke('settings:get').dictation.mode, defaultMode, 'selected-agent voice preferences never rewrite General settings')
  assert.equal(await bar.webContents.executeJavaScript('window.togle.getSettings().then(settings=>settings.dictation.microphoneId)'), 'headset')
  await invoke('dictation:agent', otherAgent.id)
  await wait(() => bar.webContents.executeJavaScript(`document.querySelector('.dictation-prompt')?.textContent.startsWith(${JSON.stringify(defaultPrompt)})`))
  await invoke('session:listening', true)
  await wait(() => bar.webContents.executeJavaScript("document.querySelector('.dictation-prompt')?.textContent.startsWith('Press')"))
  main.close(); assert.equal(main.isDestroyed(), false)
  assert.equal(invoke('call:current').session.status, 'live', 'Closing to the tray does not end a meeting')
  assert.ok(icon.tooltip.includes('Call assistance'))
  item('Quit Togle').click()
  await wait(() => js("document.body.innerText.includes('Quit Togle?')"))
  assert.equal(await js("document.querySelector('.notice.ask').getBoundingClientRect().top < document.querySelector('.settings').getBoundingClientRect().top"), true, 'Quit remains visible above Settings without navigating away')
  assert.equal(main.isDestroyed(), false, 'Quit during a call asks in the app')
  await js("[...document.querySelectorAll('button')].find(button=>button.textContent==='Keep going').click()")
  await invoke('session:listening', false)
  await wait(() => bar.webContents.executeJavaScript(`document.querySelector('.dictation-prompt')?.textContent.startsWith(${JSON.stringify(defaultPrompt)})`))
  let lateView
  app.once('before-quit', () => {
    const view = invoke('call:current').view
    lateView = { ...view, reviewedLines: view.reviewedLines + 1 }
    ipcMain.emit('call:view', {}, lateView)
  })
  app.on('will-quit', () => {
    try {
      assert.equal(icon.destroyed, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'Quit removes both windows')
      const saved = JSON.parse(electron.safeStorage.decryptString(fs.readFileSync(path.join(profile, 'call.bin'))))
      assert.deepEqual(saved.view, lateView, 'Quit preserves a call update arriving after the initial save')
      clearTimeout(timeout)
      console.log('TRAY PASS: open, close to tray, live call survives, bar preference stays in sync, F9 default and custom shortcut propagation, guarded quit, late-save shutdown, complete cleanup')
    } catch (error) { console.error(error); app.exit(1) }
  })
  item('Quit Togle').click()
}
run().catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
