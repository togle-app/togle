// Own fixture windows only: proves real Windows UI Automation targeting and Unicode insertion.
const { app, BrowserWindow, clipboard, ipcMain, globalShortcut } = require('electron')
const path = require('node:path')
const assert = require('node:assert/strict')
const koffi = require('koffi')
const fs = require('node:fs')
const { execFileSync, spawn } = require('node:child_process')
const user32 = koffi.load('user32.dll'), kernel32 = koffi.load('kernel32.dll')
const foreground = user32.func('void* __stdcall GetForegroundWindow()')
const foregroundThread = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void*, void*)')
const enumWindows = user32.func('bool __stdcall EnumWindows(void*, intptr_t)')
const windowText = user32.func('int __stdcall GetWindowTextW(void*, void*, int)')
const visibleWindow = user32.func('bool __stdcall IsWindowVisible(void*)')
const closeWindow = user32.func('bool __stdcall PostMessageW(void*, uint32_t, uintptr_t, intptr_t)')
const attach = user32.func('bool __stdcall AttachThreadInput(uint32_t, uint32_t, bool)')
const bring = user32.func('bool __stdcall SetForegroundWindow(void*)')
const keyEvent = user32.func('void __stdcall keybd_event(uint8_t, uint8_t, uint32_t, uintptr_t)')
const keyDown = user32.func('int16_t __stdcall GetAsyncKeyState(int)')
const thread = kernel32.func('uint32_t __stdcall GetCurrentThreadId()')
// Match an ordinary desktop app: UI Automation must initialize accessibility itself.
if (process.argv.includes('--force-accessibility')) app.commandLine.appendSwitch('force-renderer-accessibility')
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.setPath('userData', path.join(__dirname, '.work/dictation-native-profile'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let target, win, bar, dictation, press, consoleProcess, consoleHandle
ipcMain.handle('hotkeys:list', () => [])
ipcMain.handle('dictation:status', () => dictation?.status() ?? { phase: 'polishing', message: 'Finishing…' })
ipcMain.handle('settings:get', () => ({ dictation: { mode: 'hold' } }))
ipcMain.on('dictation:expand', (event, expanded, explicit) => { if (bar?.owns(event.sender)) bar.setExpanded(expanded, explicit === true) })
ipcMain.on('dictation:audio', (event, id, pcm) => { if (bar?.owns(event.sender)) dictation?.push(id, pcm) })
ipcMain.handle('dictation:finish', (event, id) => { if (bar?.owns(event.sender)) return dictation?.finish(id) })
ipcMain.on('dictation:failed', (_event, id, message) => dictation?.failed(id, message))
app.whenReady().then(async () => {
  const { DictationTargetBridge, Dictation, HotkeyPress } = await import('./.build/togle.mjs')
  target = new DictationTargetBridge(path.resolve(__dirname, '../resources/dictation-windows.ps1'))
  await target.start()
  win = new BrowserWindow({ width: 640, height: 360, title: 'Togle dictation test — isolated text fields', webPreferences: { contextIsolation: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Dictation fixture</title><style>body{padding:20px;font:16px system-ui}textarea,input,[contenteditable]{display:block;width:90%;padding:5px;margin:5px;border:1px solid #aaa}</style><textarea id="text" aria-label="Message"></textarea><input id="line" aria-label="Single line"><input id="combo" role="combobox" aria-expanded="false" aria-label="Search or type a message"><div id="rich" role="textbox" contenteditable="true" aria-label="Rich message"></div><input id="secret" type="password" aria-label="Password"><script>window.enters=0;document.addEventListener("keydown",e=>{if(e.key==="Enter")window.enters++})</script>'))
  const js = code => win.webContents.executeJavaScript(code, true)
  const focus = async (id, value = '') => {
    for (let attempt = 0; attempt < 5; attempt++) {
      win.show(); win.focus()
      const own = thread(), other = foregroundThread(foreground(), null)
      try { if (other && own !== other) attach(own, other, true); bring(win.getNativeWindowHandle().readBigUInt64LE()) }
      finally { if (other && own !== other) attach(own, other, false) }
      if (BigInt(foreground()) === win.getNativeWindowHandle().readBigUInt64LE()) break
      await sleep(100)
    }
    await sleep(100)
    await js(`(()=>{const e=document.getElementById(${JSON.stringify(id)});if(e.isContentEditable){e.textContent=${JSON.stringify(value)};e.focus();const r=document.createRange();r.selectNodeContents(e);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r)}else{e.value=${JSON.stringify(value)};e.focus();e.setSelectionRange(e.value.length,e.value.length)}})()`)
    await sleep(250)
    assert.equal(BigInt(foreground()).toString(), win.getNativeWindowHandle().readBigUInt64LE().toString(), 'Test fixture must own foreground before reading or typing')
  }
  const originalClipboard = await clipboard.readText()
  if (!process.argv.includes('--console-only')) {
  for (const [id, text] of [['text', 'Hello, Luka — café 你好 😀.'], ['line', 'Thank you.'], ['combo', 'Please send the update.'], ['rich', 'Ship the update tomorrow.']]) {
    await focus(id)
    const captured = await target.capture()
    assert.ok(captured.token, JSON.stringify({ id, captured }))
    assert.equal(captured.windowHandle, win.getNativeWindowHandle().readBigUInt64LE().toString(), 'Only this test window may receive text')
    const result = await target.insert(captured.token, text)
    const actual = await js(`document.getElementById('${id}').${id === 'rich' ? 'textContent' : 'value'}`)
    assert.equal(actual, text)
    assert.equal(result.inserted, true, JSON.stringify({ id, result }))
    assert.equal((await target.insert(captured.token, text).catch(() => ({ inserted: false }))).inserted, false)
    console.log('PASS actual insertion:', id)
  }
  await focus('text', 'Hello OLD world')
  await js(`document.getElementById('text').setSelectionRange(6,9)`)
  const selected = await target.capture()
  assert.ok(selected.token)
  assert.equal((await target.insert(selected.token, 'new')).inserted, true)
  assert.equal(await js(`document.getElementById('text').value`), 'Hello new world')
  console.log('PASS selection replacement')
  await focus('text')
  const withBar = await target.capture()
  assert.equal(withBar.windowHandle, win.getNativeWindowHandle().readBigUInt64LE().toString())
  const { DictationWindow } = require('../eval/.build/togle.cjs')
  bar = new DictationWindow(() => {}, path.resolve(__dirname, '../out/main'))
  bar.update({ phase: 'polishing', message: 'Finishing…' })
  await new Promise(resolve => bar.window.once('ready-to-show', resolve)); await sleep(100)
  assert.equal(BigInt(foreground()).toString(), withBar.windowHandle, 'The real dictation bar must not steal text focus')
  assert.equal((await target.insert(withBar.token, 'The bar kept my cursor.')).inserted, true)
  assert.equal(await js(`document.getElementById('text').value`), 'The bar kept my cursor.')
  bar.close(); bar = undefined
  console.log('PASS production dictation bar preserves foreground and insertion')
  await focus('text', 'Stay here')
  const moved = await target.capture()
  await focus('line', 'Do not change')
  assert.equal((await target.insert(moved.token, 'private')).inserted, false)
  assert.equal(await js(`document.getElementById('line').value`), 'Do not change')
  console.log('PASS changed target is not touched')
  await focus('text', 'Cursor')
  const cursor = await target.capture()
  await js(`document.getElementById('text').setSelectionRange(0,0)`)
  assert.equal((await target.insert(cursor.token, 'private')).inserted, false)
  console.log('PASS changed cursor is not touched')
  await focus('secret', 'untouched')
  assert.equal((await target.capture()).token, undefined)
  console.log('PASS password excluded')
  for (const id of ['text', 'combo']) {
    await focus(id, 'Read only')
    await js(`document.getElementById('${id}').readOnly=true`)
    assert.equal((await target.capture()).token, undefined, 'Read-only fields must remain read-only regardless of their accessibility role')
    await js(`document.getElementById('${id}').readOnly=false`)
  }
  console.log('PASS read-only excluded')
  await focus('text')
  const multiline = await target.capture()
  const result = await target.insert(multiline.token, 'First line\nSecond line')
  assert.equal(await js(`document.getElementById('text').value`), 'First line\nSecond line', 'Multiline dictation is inserted without a Copy step')
  assert.equal(result.inserted, true, JSON.stringify(result))
  assert.equal(await js('window.enters'), 0, 'Must never send an Enter key')
  assert.ok((await clipboard.readText()) === originalClipboard, 'Automatic insertion must not replace the clipboard')
  console.log('PASS multiline automatic insertion, no Enter key, clipboard restored')
  const controls = await target.capture()
  assert.equal((await target.insert(controls.token, 'Ignore\u001bthis')).inserted, false)
  assert.equal(await js(`document.getElementById('text').value`), 'First line\nSecond line', 'Unsupported control characters must not leave partial input')
  // Exercise the actual physical F9 edge, production bar/preload, audio flush,
  // Dictation controller and native insertion together. Only speech results are
  // scripted; this never opens a real microphone or sends a model request.
  let samples = 0, speechEnds = 0, insertions = 0, phrase = ''
  const phases = []
  dictation = new Dictation({
    target: { capture: () => target.capture(), insert: async (token, text) => { insertions++; return target.insert(token, text) } },
    speech: () => ({ streaming: true, polishes: false, ready: async () => {},
      push: pcm => { samples += pcm.length }, finish: async () => { speechEnds++; return phrase },
      transcribe: () => assert.fail('The recording must stream'), polish: async text => text }),
    changed: state => { phases.push(state.phase); bar?.update(state) }, inCall: () => false
  })
  press = new HotkeyPress(key => !!(keyDown(key) & 0x8000))
  assert.equal(globalShortcut.register('F9', () => press.run('F9', () => void dictation.start(true), () => dictation.stop())), true, 'F9 must be available to this isolated test')
  bar = new DictationWindow(() => dictation.cancel(), path.resolve(__dirname, '../out/main'))
  bar.setIndicator(true)
  await new Promise(resolve => bar.window.webContents.once('did-finish-load', resolve))
  const waitFor = async check => { for (let n = 0; n < 200; n++) { if (await check()) return; await sleep(25) }; throw Error('F9 flow did not finish: ' + JSON.stringify({ phase: dictation.status().phase, message: dictation.status().message })) }
  for (const [id, text] of [['text', 'Released F9 enters the words.'], ['combo', 'Send the update tomorrow.'], ['rich', 'Café 你好 — ready to send.']]) {
    await focus(id)
    samples = 0; phrase = text; phases.length = 0
    const beforeInsert = insertions, beforeEnd = speechEnds
    assert.equal(BigInt(foreground()), win.getNativeWindowHandle().readBigUInt64LE(), 'Only the fixture may receive the test key')
    keyEvent(0x78, 0, 0, 0)
    await waitFor(() => dictation.status().phase === 'recording' && samples > 0)
    assert.equal(await js(`document.getElementById('${id}').${id === 'rich' ? 'textContent' : 'value'}`), '', 'Holding F9 never inserts early')
    assert.equal(BigInt(foreground()), win.getNativeWindowHandle().readBigUInt64LE(), 'The recording bar must keep the destination focused')
    keyEvent(0x78, 0, 2, 0)
    await waitFor(() => !dictation.active)
    assert.equal(dictation.status().phase, 'done', JSON.stringify({ id, phase: dictation.status().phase, message: dictation.status().message }))
    assert.equal(await js(`document.getElementById('${id}').${id === 'rich' ? 'textContent' : 'value'}`), text)
    assert.equal(insertions, beforeInsert + 1); assert.equal(speechEnds, beforeEnd + 1)
    assert.ok(phases.includes('finishing') && phases.includes('inserting') && !phases.includes('ready'), 'Release completes insertion without a Copy step')
    assert.equal((await clipboard.readText()), originalClipboard)
    assert.equal(await js('window.enters'), 0)
    console.log('PASS real F9 release automatically inserts once:', id)
  }
  globalShortcut.unregister('F9'); press.reset(); press = undefined
  bar.close(); bar = undefined; dictation.dispose(); dictation = undefined
  }
  const consolePrefix = path.resolve(__dirname, '.work', 'dictation-console-' + process.pid)
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'compile-dictation-console.ps1'), '-Source', path.join(__dirname, 'dictation-console.cs'), '-Destination', consolePrefix + '.exe'], { windowsHide: true })
  // A real console is necessary to exercise console keyboard delivery. It has no command interpreter.
  const consoleTitle = 'Togle isolated console ' + process.pid
  consoleProcess = spawn(consolePrefix + '.exe', [consolePrefix, consoleTitle], { detached: true, stdio: 'ignore' })
  for (let n = 0; n < 100 && !fs.existsSync(consolePrefix + '.window'); n++) await sleep(30)
  let consoleWindow = 0n
  // Windows 11 can host a console in Terminal; GetConsoleWindow then names a hidden proxy.
  // Match only the unique title assigned by our fixture and never log or target other windows.
  const visitor = koffi.register(hwnd => {
    const buffer = Buffer.alloc(2048); windowText(hwnd, buffer, 1024)
    if (visibleWindow(hwnd) && buffer.toString('utf16le').split('\0')[0].includes(consoleTitle)) consoleWindow = BigInt(hwnd)
    return true
  }, koffi.pointer(koffi.proto('bool __stdcall TogleConsoleVisitor(void*, intptr_t)')))
  try { for (let n = 0; n < 100 && !consoleWindow; n++) { enumWindows(visitor, 0); if (!consoleWindow) await sleep(40) } }
  finally { koffi.unregister(visitor) }
  consoleHandle = consoleWindow
  assert.notEqual(consoleWindow, 0n, 'Own console must have a window')
  await sleep(400)
  for (let attempt = 0; attempt < 10; attempt++) {
    const ownThread = thread(), otherThread = foregroundThread(foreground(), null)
    try { if (otherThread && ownThread !== otherThread) attach(ownThread, otherThread, true); bring(consoleWindow) }
    finally { if (otherThread && ownThread !== otherThread) attach(ownThread, otherThread, false) }
    await sleep(100)
    if (BigInt(foreground()) === consoleWindow) break
  }
  assert.equal(BigInt(foreground()), consoleWindow, 'Only the isolated console may receive test input')
  const terminal = await target.capture()
  assert.equal(terminal.windowHandle, consoleWindow.toString())
  assert.ok(terminal.token, JSON.stringify(terminal))
  const consoleBefore = fs.existsSync(consolePrefix + '.text') ? fs.readFileSync(consolePrefix + '.text', 'utf8') : ''
  const consoleText = 'echo caf\u00e9 safe-text'
  assert.equal((await target.insert(terminal.token, consoleText)).inserted, true)
  for (let n = 0; n < 100 && (!fs.existsSync(consolePrefix + '.text') || fs.readFileSync(consolePrefix + '.text', 'utf8') !== consoleBefore + consoleText); n++) await sleep(30)
  assert.equal(fs.readFileSync(consolePrefix + '.text', 'utf8'), consoleBefore + consoleText, 'Console receives Unicode text, with no Enter or control characters')
  const blockedTerminal = await target.capture()
  assert.ok(blockedTerminal.token)
  assert.equal((await target.insert(blockedTerminal.token, 'Do not execute\nanything')).inserted, false)
  assert.equal(fs.readFileSync(consolePrefix + '.text', 'utf8'), consoleBefore + consoleText, 'Multiline dictation must send no input to a terminal')
  closeWindow(consoleHandle, 16, 0, 0); consoleHandle = undefined
  consoleProcess.kill(); consoleProcess = undefined
  console.log('PASS actual console input: text delivered, no Enter, no command execution')
  console.log('DICTATION NATIVE PASS')
}).then(() => { if (consoleHandle) closeWindow(consoleHandle, 16, 0, 0); consoleProcess?.kill(); target?.stop(); bar?.close(); dictation?.dispose(); press?.reset(); globalShortcut.unregisterAll(); win?.destroy(); app.exit(0) }, error => { console.error(error); if (consoleHandle) closeWindow(consoleHandle, 16, 0, 0); consoleProcess?.kill(); target?.stop(); bar?.close(); dictation?.dispose(); press?.reset(); globalShortcut.unregisterAll(); win?.destroy(); app.exit(1) })
app.on('will-quit', () => target?.stop())
