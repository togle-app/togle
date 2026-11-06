// Exercises the production Windows insertion bridge against an actual CodeMirror
// editor. Only this disposable fixture can receive native input; no user vault is opened.
const { app, BrowserWindow, clipboard, ClipboardItem } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const koffi = require('koffi')
const { build } = require('rolldown')
app.setPath('userData', path.join(__dirname, '.work/dictation-editors-profile'))
const user32 = koffi.load('user32.dll')
const foreground = user32.func('void* __stdcall GetForegroundWindow()')
const foregroundThread = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void*, void*)')
const attach = user32.func('bool __stdcall AttachThreadInput(uint32_t, uint32_t, bool)')
const bring = user32.func('bool __stdcall SetForegroundWindow(void*)')
const thread = koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentThreadId()')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let win, bridge, restoreFixtureClipboard
app.whenReady().then(async () => {
  const bundle = await build({ input: path.join(__dirname, 'dictation-editors-entry.js'), output: { format: 'iife' }, write: false })
  const { DictationTargetBridge } = await import('./.build/togle.mjs')
  bridge = new DictationTargetBridge(path.resolve(__dirname, '../resources/dictation-windows.ps1'))
  await bridge.start()
  if (process.argv.includes('--compile-only')) { console.log('Windows insertion helper compiled and started.'); return }
  win = new BrowserWindow({ width: 680, height: 420, title: 'Togle disposable Markdown dictation test', webPreferences: { contextIsolation: true } })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Disposable editor</title><style>body{font:16px system-ui;padding:20px}.cm-editor{border:1px solid #aaa;min-height:150px}.cm-scroller{max-height:230px}</style><p>Temporary dictation test — no real notes.</p><div id="editor"></div>'))
  const js = code => win.webContents.executeJavaScript(code, true)
  await js(bundle.output[0].code)
  const ownWindow = win.getNativeWindowHandle().readBigUInt64LE()
  const snapshotClipboard = async () => {
    const items = await clipboard.read(), result = []
    for (const item of items) {
      const formats = {}
      for (const format of item.types.toSorted()) {
        // OLE generates new transport bookkeeping when restoring IDataObject;
        // compare every payload format, without printing users' clipboard data.
        if (/format="(?:DataObject|Ole Private Data)"$/.test(format)) continue
        const value = await item.getType(format)
        const bytes = value.arrayBuffer ? Buffer.from(await value.arrayBuffer()) : Buffer.from(JSON.stringify(value))
        formats[format] = createHash('sha256').update(bytes).digest('hex')
      }
      result.push(formats)
    }
    return result
  }
  const originalClipboard = await snapshotClipboard()
  const savedItems = []
  for (const item of await clipboard.read()) {
    const formats = {}
    for (const format of item.types) {
      if (!/format="(?:DataObject|Ole Private Data)"$/.test(format)) formats[format] = await item.getType(format)
    }
    if (Object.keys(formats).length) savedItems.push(new ClipboardItem(formats))
  }
  const ownedClipboard = new Set()
  restoreFixtureClipboard = async () => {
    // Restore test-owned payloads only; an unrelated user copy always wins.
    if (!ownedClipboard.has(JSON.stringify(await snapshotClipboard()))) return
    if (savedItems.length) await clipboard.write(savedItems)
    else clipboard.clear()
  }
  const focusWindow = async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      win.show(); win.focus()
      const own = thread(), other = foregroundThread(foreground(), null)
      try { if (other && own !== other) attach(own, other, true); bring(ownWindow) }
      finally { if (other && own !== other) attach(own, other, false) }
      await sleep(50)
      if (BigInt(foreground()) === ownWindow) return
    }
    assert.fail('Only the disposable editor may receive test input')
  }
  const focus = async (text = '', start = text.length, end = start, readOnly = false) => {
    await focusWindow()
    await js(`editorFixture.open(${JSON.stringify(text)},${start},${end},${readOnly})`)
    await js('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
    await sleep(180)
    assert.equal(BigInt(foreground()), ownWindow, 'Only the disposable editor may receive test input')
  }
  const rows = []
  for (const [name, original, start, end, phrase] of [
    ['empty Markdown editor', '', 0, 0, 'Togle can type into Markdown.'],
    ['existing Markdown at caret', '# Notes\n\nBefore  after\n', 16, 16, 'the meeting'],
    ['selected Markdown', 'Replace OLD here', 8, 11, 'new'],
    ['multilingual rich editor', '', 0, 0, 'Café 你好 — مرحبا 😀.'],
    ['one empty line', '\n', 0, 0, 'The blank line stays.'],
    ['blank paragraph', '\n\n', 1, 1, 'The note continues.'],
    ['multiline dictation', '', 0, 0, 'First line\nSecond line'],
    ['dictated paragraphs', '', 0, 0, 'First paragraph\n\nSecond paragraph'],
    ['CRLF dictation', '', 0, 0, 'First line\r\nSecond line'],
    ['tabs in Markdown', '', 0, 0, 'Column A\tColumn B'],
    ['replace whole note', '# Old\n\nDetails', 0, 14, '# New\n\nReady'],
    ['large virtualized note', 'A long note.\n'.repeat(18000), 100004, 100004, 'inserted words']
  ]) {
    await focus(original, start, end)
    const target = await bridge.capture()
    if (!target.token) { rows.push({ name, target }); continue }
    assert.equal(target.windowHandle, ownWindow.toString())
    const result = await bridge.insert(target.token, phrase).catch(error => ({ inserted: false, message: error.message }))
    await sleep(80)
    const actual = await js('editorFixture.text()')
    const expected = original.slice(0, start) + phrase.replace(/\r\n?/g, '\n') + original.slice(end)
    rows.push({ name, result, matches: actual === expected })
    console.log(name + ': ' + JSON.stringify(rows.at(-1)))
    assert.deepEqual(await snapshotClipboard(), originalClipboard, 'All existing clipboard formats must survive automatic insertion')
  }
  for (const kind of ['textbox', 'document', 'paragraph', 'plaintext', 'shadow', 'blocked-unicode']) {
    await focusWindow()
    await js(`editorFixture.surface(${JSON.stringify(kind)})`)
    await sleep(150)
    assert.equal(BigInt(foreground()), ownWindow)
    const target = await bridge.capture()
    if (!target.token) { rows.push({ name: kind, target }); continue }
    const phrase = 'Café 你好 — text entered once.'
    const result = await bridge.insert(target.token, phrase).catch(error => ({ inserted: false, message: error.message }))
    await sleep(80)
    const actual = await js('editorFixture.text()')
    rows.push({ name: kind, result, matches: actual.trimEnd() === phrase })
    console.log(kind + ': ' + JSON.stringify(rows.at(-1)))
    assert.deepEqual(await snapshotClipboard(), originalClipboard)
  }
  await focus('Keep the original', 5)
  const moved = await bridge.capture()
  await js('editorFixture.select(0)')
  assert.equal((await bridge.insert(moved.token, 'Wrong place')).inserted, false)
  assert.equal(await js('editorFixture.text()'), 'Keep the original')
  await focus('Read only', 0, 0, true)
  assert.equal(await js(`document.querySelector('.cm-content').getAttribute('aria-readonly')`), 'true')
  const readOnly = await bridge.capture()
  if (readOnly.token) assert.equal((await bridge.insert(readOnly.token, 'Do not insert')).inserted, false)
  assert.equal(await js('editorFixture.text()'), 'Read only', 'Read-only Markdown must remain unchanged even if its editor exposes a writable DOM')
  await js(`editorFixture.open('Reading view',0,0,true,false)`)
  await sleep(200)
  assert.equal((await bridge.capture()).token, undefined, 'A noneditable reading surface is excluded')
  assert.equal(await js('nativeEditorEvents.enter'), 0, 'Paragraph insertion must never press Enter')
  assert.equal(await js('nativeEditorEvents.tab'), 0, 'Tab text must never move keyboard focus')
  assert.ok(await js('nativeEditorEvents.paste') > 0, 'Editors receive a native paste event, not direct DOM writes')
  await focus('')
  await clipboard.write([new ClipboardItem({
    'text/plain': 'Owned rich clipboard fixture',
    'text/html': '<b>Owned rich clipboard fixture</b>',
    'electron application/osclipboard;format="Togle Fixture Bytes"': new Blob([new Uint8Array([12, 34, 56, 78])])
  })])
  const richClipboard = await snapshotClipboard()
  ownedClipboard.add(JSON.stringify(richClipboard))
  const richTarget = await bridge.capture()
  assert.ok(richTarget.token)
  assert.equal((await bridge.insert(richTarget.token, 'First paragraph\n\nSecond paragraph')).inserted, true)
  assert.equal(await js('editorFixture.text()'), 'First paragraph\n\nSecond paragraph')
  assert.deepEqual(await snapshotClipboard(), richClipboard, 'HTML, text, and custom binary clipboard payloads must all survive')
  await focus('')
  let competingCopy
  win.webContents.on('console-message', event => {
    if (event.message === 'TOGLE_OWNED_COPY_DURING_PASTE') competingCopy = clipboard.writeText('New clipboard copied during the fixture')
  })
  await js(`document.querySelector('.cm-content').addEventListener('paste',()=>console.log('TOGLE_OWNED_COPY_DURING_PASTE'),{once:true})`)
  const copying = await bridge.capture()
  assert.ok(copying.token)
  assert.equal((await bridge.insert(copying.token, 'A single inserted sentence.')).inserted, true)
  await competingCopy
  assert.ok(competingCopy, 'The competing copy must actually occur during the native paste')
  assert.equal(await clipboard.readText(), 'New clipboard copied during the fixture', 'Automatic restore must never overwrite a newer copy')
  ownedClipboard.add(JSON.stringify(await snapshotClipboard()))
  assert.equal(await js('editorFixture.text()'), 'A single inserted sentence.')
  await js(`editorFixture.surface('reject-paste')`)
  await sleep(180)
  const rejected = await bridge.capture()
  assert.ok(rejected.token)
  const pastes = await js('nativeEditorEvents.paste')
  assert.equal((await bridge.insert(rejected.token, 'Ignored text')).inserted, false)
  assert.equal(await js('editorFixture.text()'), '')
  assert.equal(await js('nativeEditorEvents.paste'), pastes + 1, 'A rejected paste is never retried automatically')
  await restoreFixtureClipboard()
  assert.deepEqual(await snapshotClipboard(), originalClipboard)
  fs.mkdirSync(path.join(__dirname, '.work'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '.work/dictation-editors-result.json'), JSON.stringify(rows, null, 2))
  console.log(JSON.stringify(rows, null, 2))
  assert.ok(rows.every(row => row.matches && row.result.inserted), 'Every editor case must insert its exact text and confirm success')
  console.log('DICTATION EDITORS PASS: 18 insertion cases; read-only/cursor guards; rich clipboard preservation; concurrent copy; rejected paste; no Enter/Tab key')
}).then(async () => { await restoreFixtureClipboard?.(); bridge?.stop(); win?.destroy(); app.exit(0) }, async error => { console.error(error); try { await restoreFixtureClipboard?.() } finally { bridge?.stop(); win?.destroy(); app.exit(1) } })
