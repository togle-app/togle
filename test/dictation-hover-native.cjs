// Real Windows pointer routing over two isolated fixture windows. No microphone,
// account, clipboard, user text field or global shortcut is used.
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const koffi = require('koffi')
if (process.platform !== 'win32') { console.log('Windows hover check skipped'); process.exit(0) }
const user32 = koffi.load('user32.dll')
const Point = koffi.struct('DictationHoverPoint', { x: 'int32_t', y: 'int32_t' })
const cursorAt = user32.func('bool __stdcall GetCursorPos(_Out_ DictationHoverPoint*)')
const moveCursor = user32.func('bool __stdcall SetCursorPos(int, int)')
const windowAt = user32.func('void* __stdcall WindowFromPoint(DictationHoverPoint)')
const ancestor = user32.func('void* __stdcall GetAncestor(void*, uint32_t)')
const foreground = user32.func('void* __stdcall GetForegroundWindow()')
const windowThread = user32.func('uint32_t __stdcall GetWindowThreadProcessId(void*, void*)')
const attach = user32.func('bool __stdcall AttachThreadInput(uint32_t, uint32_t, bool)')
const bring = user32.func('bool __stdcall SetForegroundWindow(void*)')
const thread = koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentThreadId()')
const mouse = user32.func('void __stdcall mouse_event(uint32_t, uint32_t, uint32_t, uint32_t, uintptr_t)')
const metric = user32.func('int __stdcall GetSystemMetrics(int)')
const artifacts = path.join(__dirname, '.work/dictation-hover-native')
fs.mkdirSync(artifacts, { recursive: true })
app.setPath('userData', path.join(artifacts, 'profile'))
delete process.env.TOGLE_HEADLESS
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let fixture, surface, bar, state = { phase: 'idle' }, originalCursor, lastCursor
let copied=0
ipcMain.handle('hotkeys:list', () => [{ id: 'dictate', keys: 'F9', ok: true }])
ipcMain.handle('settings:get', () => ({ dictation: { mode: 'hold' } }))
ipcMain.handle('dictation:status', () => state)
ipcMain.on('dictation:expand', (event, expanded, explicit) => { if (surface?.owns(event.sender)) surface.setExpanded(expanded, explicit === true) })
ipcMain.handle('dictation:copy',()=>{copied++;change({...state,phase:'done',outcome:'copied',message:'Copied to clipboard'})})
const change = next => { state = next; surface.update(next) }
const handle = win => win.getNativeWindowHandle().readBigUInt64LE()
const rootAt = point => BigInt(ancestor(windowAt(point), 2) || 0)
const position = () => { const p = {}; assert.ok(cursorAt(p)); return p }
const near = (a, b) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2
const cleanup = () => {
  // Do not pull the mouse back if the user has moved it during the test.
  const current = position()
  if (lastCursor && near(current, lastCursor)) moveCursor(originalCursor.x, originalCursor.y)
  surface?.close(); if (fixture && !fixture.isDestroyed()) fixture.destroy()
}
const timeout = setTimeout(() => { console.error('Native hover check timed out'); cleanup(); app.exit(1) }, 25_000)
app.whenReady().then(async () => {
  originalCursor = position()
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  fixture = new BrowserWindow({ width: 700, height: 400, x: area.x + Math.round((area.width - 700) / 2), y: area.y + area.height - 412,
    frame: false, title: 'Togle isolated hover check', show: true, webPreferences: { contextIsolation: true } })
  await fixture.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><title>Togle isolated hover check</title><style>body{margin:0;background:#222c3c;color:white;font:14px system-ui}input{position:absolute;left:20px;top:20px;width:300px}button{position:absolute;left:0;top:0;width:100%;height:100%;background:transparent;color:white;border:0}</style><button id="behind">Isolated hover test — clicks stay in this window</button><input id="destination" aria-label="Fixture text box"><script>window.clicked=0;document.querySelector("button").onclick=()=>window.clicked++</script>'))
  fixture.show(); fixture.focus()
  const ownThread = thread(), activeThread = windowThread(foreground(), null)
  try { if (activeThread && ownThread !== activeThread) attach(ownThread, activeThread, true); bring(handle(fixture)) }
  finally { if (activeThread && ownThread !== activeThread) attach(ownThread, activeThread, false) }
  await fixture.webContents.executeJavaScript('document.getElementById("destination").focus()')
  await sleep(200)
  assert.equal(BigInt(foreground() || 0), handle(fixture), 'Only the isolated fixture may be active')
  const { DictationWindow } = require('../eval/.build/togle.cjs')
  surface = new DictationWindow(() => {}, path.resolve(__dirname, '../out/main'))
  surface.setIndicator(true); bar = surface.window
  await new Promise(resolve => bar.webContents.once('did-finish-load', resolve))
  const js = code => bar.webContents.executeJavaScript(code)
  const wait = async check => { for (let n = 0; n < 100; n++) { if (await check()) return; await sleep(20) }; throw Error('Native hover state did not settle') }
  await wait(() => js("!!document.querySelector('.dictation-hit')"))
  await wait(() => bar.isVisible())
  const bounds = bar.getBounds()
  let resizes = 0, reshows = 0
  bar.on('resize', () => resizes++)
  bar.on('show', () => reshows++)
  await js('window.__hoverChanges=[];window.__pointerLog=[];for(const type of ["mousemove","mouseover","mouseout"]){document.addEventListener(type,e=>{window.__pointerLog.push({type,x:e.clientX,y:e.clientY,target:e.target.className});window.__pointerLog=window.__pointerLog.slice(-12)},true)};new MutationObserver(()=>window.__hoverChanges.push(document.querySelector(".dictation-bar").dataset.expanded)).observe(document.querySelector(".dictation-bar"),{attributes:true,attributeFilter:["data-expanded"]})')
  const move = async (x, y) => {
    if (lastCursor) assert.ok(near(position(), lastCursor), 'User moved the pointer; stop instead of fighting for it')
    const point = screen.dipToScreenPoint({ x: bounds.x + x, y: bounds.y + y })
    const under = rootAt(point)
    assert.ok([handle(fixture), handle(bar)].includes(under), `Pointer movement stays over the isolated fixture or its own bar: ${JSON.stringify({ point, bounds, fixture: fixture.getBounds(), under: under.toString(), expected: handle(fixture).toString(), bar: handle(bar).toString() })}`)
    // SetCursorPos does not traverse Electron's low-level forwarding hook.
    // Inject real mouse movement, restricted to our two observed fixture HWNDs.
    const dx = Math.floor((point.x - metric(76) + .5) * 65536 / metric(78))
    const dy = Math.floor((point.y - metric(77) + .5) * 65536 / metric(79))
    mouse(0xC001, dx, dy, 0, 0)
    await sleep(70)
    const actual = position()
    assert.ok(near(actual, point), 'Pointer changed during the test')
    lastCursor = actual
  }
  const expanded = () => js('document.querySelector(".dictation-bar").dataset.expanded === "true"')
  // Start outside the pill but inside the native canvas.
  await move(20, 30); await sleep(400)
  assert.equal(await expanded(), false)
  assert.equal(rootAt(lastCursor), handle(fixture), 'Empty canvas is native click-through')
  const center = { x: Math.round(bounds.width / 2), y: bounds.height - 16 }
  for (let n = 0; n < 5; n++) {
    await move(center.x, center.y)
    await wait(expanded)
    // Keep the real cursor motionless through the entire animation and dwell.
    for (let sample = 0; sample < 8; sample++) {
      await sleep(50)
      assert.equal(await expanded(), true, 'Hover must not oscillate under a stationary pointer')
      assert.deepEqual(bar.getBounds(), bounds, 'Native geometry must stay fixed')
    }
    assert.equal(BigInt(foreground() || 0), handle(fixture), 'Hover must not steal text focus')
    await move(center.x + 100, bounds.height - 48)
    assert.equal(await expanded(), true, 'Moving from the bar to its controls stays expanded')
    assert.equal(rootAt(lastCursor), handle(bar), 'Controls receive native pointer input')
    await move(20, 30)
    await wait(async () => !(await expanded()))
    assert.equal(rootAt(lastCursor), handle(fixture), 'Leaving immediately restores underlying input')
  }
  // Exercise processing/recovery transitions while hovering; no native resize/show.
  await move(center.x, center.y); await wait(expanded)
  for (const next of [{ phase: 'polishing', message: 'Finishing…' }, { phase: 'ready', text: 'Fixture words', message: 'Copy your text.' }]) {
    change(next); await sleep(250)
    assert.equal(await expanded(), true)
    assert.deepEqual(bar.getBounds(), bounds)
  }
  const image = await bar.webContents.capturePage()
  fs.writeFileSync(path.join(artifacts, 'hover.png'), image.toPNG())
  const clickControl=async selector=>{
    const point=await js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Missing fixture control');const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
    await move(point.x,point.y)
    assert.equal(rootAt(lastCursor),handle(bar),'The real click stays in the isolated bar')
    mouse(0x0002,0,0,0,0);mouse(0x0004,0,0,0,0)
  }
  await clickControl('.dictation-actions button.primary')
  await wait(()=>copied===1)
  await sleep(250)
  await clickControl('[aria-label="Collapse voice bar"]')
  await wait(async()=>!(await expanded()))
  await sleep(600)
  assert.equal(await expanded(),false,'Close stays closed without further pointer movement')
  await move(20, 30); await wait(async () => !(await expanded()))
  assert.equal(rootAt(lastCursor), handle(fixture))
  assert.equal(BigInt(foreground() || 0), handle(fixture), 'Only our fixture can receive the click')
  mouse(0x0002, 0, 0, 0, 0); mouse(0x0004, 0, 0, 0, 0)
  await wait(() => fixture.webContents.executeJavaScript('window.clicked===1'))
  assert.equal(resizes, 0); assert.equal(reshows, 0)
  const transitions = await js('window.__hoverChanges')
  assert.deepEqual(transitions, Array.from({ length: 12 }, (_, i) => i % 2 === 0 ? 'true' : 'false'), 'Exactly one expansion and collapse per real pointer visit')
  console.log('NATIVE HOVER PASS: 6 pointer visits, real Copy/Close button clicks, stationary close, 12 transitions, zero native resizes/reshows, focus retained, transparent canvas passes a real click')
}).then(() => { clearTimeout(timeout); cleanup(); app.exit(0) }, async error => {
  console.error(error)
  if (bar && !bar.isDestroyed()) console.error(await bar.webContents.executeJavaScript('JSON.stringify({events:window.__pointerLog,changes:window.__hoverChanges,rect:document.querySelector(".dictation-hit")?.getBoundingClientRect().toJSON(),size:[innerWidth,innerHeight,devicePixelRatio]})').catch(() => 'Renderer unavailable'))
  clearTimeout(timeout); cleanup(); app.exit(1)
})
