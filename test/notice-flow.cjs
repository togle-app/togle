// The real main process, window and notice window, with a stand-in agent (fake-hermes.mjs): a task asks to run a command
// while Togle's own window is not in front, and the notice, the dot on the tray, Allow once, Open and the question before
// quitting all work. Only the shell icon is a test double. No visible windows, accounts or network.
const electron = require('electron')
const { app, BrowserWindow, ipcMain } = electron
app.disableHardwareAcceleration()
const { EventEmitter } = require('node:events')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

let icon
class TestTray extends EventEmitter {
  constructor(file) { super(); this.first = file; this.image = file; icon = this; this.destroyed = false }
  setToolTip(value) { this.tooltip = value }
  setContextMenu(value) { this.menu = value }
  setImage(value) { this.image = value }
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true }
}
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (name, ...args) { return name === 'electron' ? { ...electron, Tray: TestTray } : originalLoad.call(this, name, ...args) }

const profile = path.join(__dirname, '.work', 'notice-' + process.pid)
fs.mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setAppPath(path.resolve(__dirname, '..'))
process.env.TOGLE_HEADLESS = '1'
process.env.TOGLE_TEST_TRAY = '1'
process.env.TOGLE_SILENT_AUDIO = '1'
process.env.TOGLE_TEST_RUNNERS = path.join(__dirname, 'notice-runners.cjs')
// The development messages (a shortcut pressed as if from another app) are there only with a debug port.
process.env.TOGLE_DEBUG_PORT = '0'
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
process.env.TOGLE_SPEECH_SEEDS = ''
process.env.CLAUDE_CONFIG_DIR = path.join(profile, 'claude')
process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR
delete process.env.TOGLE_AUTOSTART

const handlers = new Map()
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (name, callback) => { handlers.set(name, callback); return originalHandle(name, callback) }
const invoke = (name, ...args) => handlers.get(name)({}, ...args)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const wait = async (check, what, ms = 10000) => {
  const began = Date.now()
  while (Date.now() - began < ms) {
    if (await check()) return
    await sleep(30)
  }
  throw new Error('Timed out waiting for ' + what)
}
const find = async (check, what, ms = 10000) => {
  const began = Date.now()
  while (Date.now() - began < ms) {
    const value = await check()
    if (value) return value
    await sleep(30)
  }
  throw new Error('Timed out waiting for ' + what)
}
const timeout = setTimeout(() => { console.error('Notice flow timed out'); app.exit(1) }, 90_000)
require('../out/main/index.js')

async function run() {
  await wait(() => icon?.menu && BrowserWindow.getAllWindows().length === 2 && BrowserWindow.getAllWindows().some((win) => win.webContents.getURL().includes('surface=dictation')), 'the windows and the tray')
  const bar = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('surface=dictation'))
  const main = BrowserWindow.getAllWindows().find((win) => win !== bar)
  const js = (win, code) => win.webContents.executeJavaScript(code)
  const problems = []
  for (const win of BrowserWindow.getAllWindows()) win.webContents.on('console-message', (event) => { if (event.level === 'error') problems.push(event.message) })
  try {
    await wait(() => js(main, "!!document.querySelector('.workspace-nav')"), 'the window')
  } catch (error) {
    throw new Error(error.message + '\n' + JSON.stringify({ url: main.webContents.getURL(), text: await js(main, 'document.body.innerText.slice(0,400)').catch(String), problems }))
  }
  main.show = () => { opened++ }
  main.focus = () => {}
  let opened = 0
  const item = (label) => icon.menu.items.find((entry) => entry.label === label)
  const noticeWindow = () => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('surface=notice'))
  assert.equal(noticeWindow(), undefined, 'no notice window until there is something to say')
  assert.ok(!icon.tooltip.includes('waiting'), 'and the tray says nothing waits')
  assert.equal(typeof icon.image, 'string', 'with its own icon')

  // A task asks to run a command while Togle's window is not in front: a notice, and a dot on the tray.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-notice-'))
  const first = await invoke('runners:start', { runner: 'hermes', folder, prompt: 'run notes', title: 'Update the notes' })
  await wait(() => noticeWindow(), 'the notice window')
  const notice = noticeWindow()
  await wait(() => js(notice, "!!document.querySelector('.task-notice')"), 'the notice')
  assert.equal(await js(notice, "document.querySelector('.task-notice-head strong').textContent"), 'Update the notes')
  assert.equal(await js(notice, "document.querySelector('.task-notice-says').textContent"), `Hermes · ${path.basename(folder)} wants to run`)
  assert.equal(await js(notice, "document.querySelector('.task-notice-detail').textContent"), 'echo x > notes.txt')
  assert.deepEqual(await js(notice, "[...document.querySelectorAll('.task-notice-actions button')].map(b=>b.textContent)"), ['Allow once', 'Refuse', 'Open'])
  assert.ok(icon.tooltip.includes('1 task waiting for you'), icon.tooltip)
  assert.equal(icon.menu.items[0].label, '1 task waiting for you')
  assert.equal(typeof icon.image, 'object', 'the tray shows its picture with the dot')
  assert.equal(icon.image.isEmpty(), false)
  const marked = icon.image.getSize()
  const dotPixel = [...icon.image.toBitmap().subarray(((marked.height - 9) * marked.width + marked.width - 9) * 4, ((marked.height - 9) * marked.width + marked.width - 9) * 4 + 3)].sort((a, b) => a - b)
  assert.deepEqual(dotPixel, [0x24, 0xa5, 0xf5], 'amber, whatever the byte order of the picture')
  fs.writeFileSync(path.join(profile, 'tray-waiting.png'), icon.image.toPNG())
  const size = notice.getBounds()
  // A display with a fractional scale can round the width by a pixel; the notice follows the cursor's display.
  assert.ok(Math.abs(size.width - 392) <= 1 && size.height > 100 && size.height < 400, 'the window is as tall as the notice: ' + JSON.stringify(size))

  // Allowing in the notice runs the command, and ends the notice and the dot. It cannot be allowed the instant it appears.
  const press = (label) => js(notice, `[...document.querySelectorAll('.task-notice-actions button')].find(b=>b.textContent===${JSON.stringify(label)}).click()`)
  await wait(() => js(notice, "document.querySelector('.task-notice-actions .primary')?.disabled===false"), 'Allow once to be ready')
  await press('Allow once')
  await wait(async () => (await invoke('runners:detail', first.key)).log.some((entry) => entry.kind === 'agent' && entry.text.includes('ran it')), 'the command to run')
  assert.ok((await invoke('runners:detail', first.key)).log.some((entry) => entry.text === 'You allowed it.'))
  await wait(() => !icon.tooltip.includes('waiting'), 'the dot to go')
  assert.equal(typeof icon.image, 'string', 'the tray has its own icon again')
  // The task finished: that is news too, for a few seconds.
  await wait(() => js(notice, "document.querySelector('.task-notice')?.dataset.kind==='done'"), 'the finished notice')
  assert.equal(await js(notice, "document.querySelector('.task-notice-says').textContent"), `Hermes · ${path.basename(folder)} finished`)
  assert.equal(await js(notice, "document.querySelector('.task-notice-detail').textContent"), 'ran it')
  await js(notice, "document.querySelector('.task-notice-head button').click()")
  await wait(async () => !(await js(notice, "!!document.querySelector('.task-notice')")), 'the notice to close')

  // The to-do list is a plain file in Togle's folder, and an item can be given to the task that was run.
  const todoFile = path.join(profile, 'to-do.md')
  const listed = await invoke('todo:add', 'Update the notes')
  assert.deepEqual(listed, { items: [{ line: 2, text: 'Update the notes', done: false }], file: todoFile })
  await invoke('todo:link', { line: 2, text: 'Update the notes' }, first.key)
  assert.equal(fs.readFileSync(todoFile, 'utf8'), `# To do\n\n- [ ] Update the notes <!-- togle:task=${first.key} -->\n`)
  assert.equal((await invoke('todo:list')).items[0].task, first.key)

  // While Togle's own window is in front nothing pops up, and the tray still counts. When it goes behind, the notice comes.
  main.isFocused = () => true
  main.isVisible = () => true
  const second = await invoke('runners:start', { runner: 'hermes', folder, prompt: 'run more', title: 'Second task' })
  await wait(() => icon.tooltip.includes('1 task waiting for you'), 'the tray to say so')
  await sleep(400)
  assert.equal(await js(notice, "!!document.querySelector('.task-notice')"), false, 'no notice while Togle itself is in front')
  main.isFocused = () => false
  main.emit('blur')
  await wait(() => js(notice, "document.querySelector('.task-notice-head strong')?.textContent==='Second task'"), 'the notice, once Togle went behind')

  // Open: Togle opens on that task.
  const before = opened
  await press('Open')
  await wait(() => opened > before, 'Togle to open')
  await wait(() => js(main, "document.querySelector('.task-title h2')?.textContent==='Second task'"), 'the task to show')
  await wait(async () => !(await js(notice, "!!document.querySelector('.task-notice')")), 'the notice to go')

  // The task box opens from its key, starts a task with what is typed in it, and keeps itself out of the way.
  await invoke('dev:hotkey', 'task')
  const boxWindow = () => BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes('surface=taskbox'))
  await wait(() => boxWindow(), 'the task box window')
  const box = boxWindow()
  await wait(() => js(box, "document.querySelectorAll('.taskbox-agents button').length>0 && document.querySelector('.taskbox-folder select').value!==''"), 'the box to show its agent and folder')
  assert.deepEqual(await js(box, "[...document.querySelectorAll('.taskbox-agents button')].map(b=>b.textContent)"), ['Hermes'], 'the agents that are installed: here, the stand-in')
  await js(box, "(() => { const area = document.querySelector('.taskbox textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, 'run frombox'); area.dispatchEvent(new Event('input', { bubbles: true })) })()")
  await js(box, "document.querySelector('.taskbox textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))")
  const fromBox = await find(async () => (await invoke('runners:list')).find((task) => task.title === 'run frombox'), 'the task from the box')
  assert.equal(fromBox.runner, 'hermes')
  await wait(() => js(box, "document.querySelector('.taskbox textarea').value===''"), 'the box to empty')
  // Notices can be turned off in Settings: the tray still counts, and nothing appears; turned on again, it does.
  await invoke('settings:update', { tasks: { notices: false } })
  await wait(async () => !(await js(notice, "!!document.querySelector('.task-notice')")), 'the notice to go')
  const waitingNow = await find(async () => (await invoke('runners:list')).find((task) => task.key === fromBox.key && task.state === 'waiting'), 'the task from the box to wait')
  await sleep(400)
  assert.equal(await js(notice, "!!document.querySelector('.task-notice')"), false, 'with notices off, nothing appears')
  assert.ok(icon.tooltip.includes('waiting for you'), 'and the tray still says so')
  await invoke('settings:update', { tasks: { notices: true } })
  await wait(() => js(notice, "!!document.querySelector('.task-notice')"), 'the notice, once notices are on again')
  await invoke('runners:answer', fromBox.key, waitingNow.pending[0].id, 'refuse')
  await wait(async () => (await invoke('runners:list')).some((task) => task.key === fromBox.key && task.state === 'idle'), 'the task from the box to finish')

  // During a call, notices wait (the news that a task finished, still showing, goes as the call starts): the tray still counts, and the notice comes once the call is over.
  await invoke('session:listening', true)
  const during = await invoke('runners:start', { runner: 'hermes', folder, prompt: 'run during', title: 'During the call' })
  const asking = await find(async () => (await invoke('runners:list')).find((task) => task.key === during.key && task.state === 'waiting'), 'the task to ask during the call')
  await sleep(600)
  assert.equal(await js(notice, "!!document.querySelector('.task-notice')"), false, 'nothing pops up during a call')
  assert.ok(icon.tooltip.includes('waiting for you'), 'and the tray still says so')
  await invoke('session:listening', false)
  await wait(() => js(notice, "!!document.querySelector('.task-notice')"), 'the notice, once the call is over')
  await invoke('runners:answer', during.key, asking.pending[0].id, 'refuse')
  await wait(async () => (await invoke('runners:list')).some((task) => task.key === during.key && task.state === 'idle'), 'the task asked during the call to finish')
  await invoke('session:clear')

  // The task still waits: quitting asks, and says which.
  item('Quit Togle').click()
  await wait(() => js(main, "document.body.innerText.includes('Quit Togle?')"), 'the question')
  assert.equal(await js(main, "document.querySelector('[aria-label=\"Confirm quit Togle\"] span').textContent"), 'Quit Togle? “Second task” has not finished. Quitting stops it. You can continue it from Tasks.')
  assert.equal(main.isDestroyed(), false, 'asked, not quit')
  assert.equal((await invoke('runners:detail', second.key)).task.state, 'waiting', 'asking changed nothing')
  await js(main, "[...document.querySelectorAll('button')].find(button=>button.textContent==='Keep going').click()")
  assert.equal((await invoke('runners:detail', second.key)).task.state, 'waiting')

  app.on('will-quit', () => {
    try {
      assert.equal(icon.destroyed, true)
      assert.equal(BrowserWindow.getAllWindows().length, 0, 'Quit removes every window, the notice too')
      clearTimeout(timeout)
      console.log('NOTICE PASS: notice when a task waits, dot on the tray, Allow once held for a moment, finished notice, quiet while Togle is in front, Open, the task box, notices turned off and on, notices waiting during a call, question before quitting')
    } catch (error) { console.error(error); app.exit(1) }
  })
  item('Quit Togle').click()
  await wait(() => js(main, "document.body.innerText.includes('Quit Togle?')"), 'the question again')
  await js(main, "[...document.querySelectorAll('button')].find(button=>button.textContent==='Quit Togle').click()")
}
run().catch((error) => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
