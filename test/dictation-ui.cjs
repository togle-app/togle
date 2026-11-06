// Production bar, preload and IPC, with a fake microphone. No user audio or account is accessed.
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs'), path = require('node:path')
const artifacts = path.join(__dirname, '.work/dictation-ui'); fs.mkdirSync(artifacts, { recursive: true })
app.setPath('userData', path.join(artifacts, 'profile'))
fs.rmSync(path.join(artifacts, 'profile/voice-bar.json'), { force: true })
app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})
const native = process.argv.includes('--native')
const reducedMotion = process.argv.includes('--reduced-motion')
if (native) delete process.env.TOGLE_HEADLESS
else process.env.TOGLE_HEADLESS = '1'
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
let surface, win, state = { phase: 'idle' }, stopped = [], chunks = [], copied = 0, failCopy = false, holdFinal = false
let testCursor = {x:-100000,y:-100000}
const hold = process.platform === 'win32'
const fixedCanvas = process.platform !== 'linux'
const captureFailures = []
let reportFailure = async () => {}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const timeout = setTimeout(() => { console.error('Dictation UI timed out'); app.exit(1) }, 60_000)
ipcMain.handle('hotkeys:list', () => [{ id: 'dictate', keys: 'F9', ok: true }])
ipcMain.handle('dictation:status', () => state)
ipcMain.on('dictation:expand', (event, expanded, explicit) => { if (surface.owns(event.sender) && typeof expanded === 'boolean') surface.setExpanded(expanded, explicit === true) })
ipcMain.on('dictation:drag', (event, action, x, y) => { if (surface.owns(event.sender)) surface.drag(action, x, y) })
ipcMain.handle('settings:get', () => ({ dictation: { mode: hold ? 'hold' : 'toggle' } }))
const change = next => { state = next; surface.update(next); win = surface.window }
ipcMain.handle('dictation:cancel', () => change({ phase: 'idle' }))
ipcMain.handle('dictation:toggle', () => state.phase === 'idle' ? change({ phase: 'recording', id: 'one', startedAt: Date.now(), destination: 'Fixture chat' }) : change({ ...state, phase: 'finishing' }))
ipcMain.handle('dictation:finish', (_event, id) => { stopped.push(id); if (!holdFinal) change({ ...state, phase: 'polishing', message: 'Cleaning up your text…' }) })
ipcMain.on('dictation:audio', (_event, id, pcm) => chunks.push({ id, length: pcm.length }))
ipcMain.on('dictation:failed', (_event, id, message) => captureFailures.push({ id, message }))
ipcMain.handle('dictation:copy', () => {
  if (failCopy) { failCopy = false; throw Error('Clipboard temporarily unavailable') }
  copied++; change({ ...state, phase: 'done', outcome: 'copied', message: 'Copied to clipboard' })
})
app.whenReady().then(async () => {
  const { DictationWindow } = require('../eval/.build/togle.cjs')
  surface = new DictationWindow(() => change({ phase: 'idle' }), path.resolve(__dirname, '../out/main'), () => testCursor)
  surface.setIndicator(true); win = surface.window
  const readyToShow = new Promise(resolve => win.once('ready-to-show', resolve))
  let nativeCanvas
  const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message) })
  const js = async code => { try { return await win.webContents.executeJavaScript(code) } catch(error) { console.error('Failed UI expression:', code, errors); throw error } }
  const picture = async name => { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await sleep(80); fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG()) }
  const boundsEvents = []
  reportFailure = async condition => {
    const detail = await js(`({status:document.querySelector('[role=status]')?.textContent,phase:document.querySelector('.dictation-bar')?.dataset.phase,
      contexts:window.__testContexts?.map(ctx=>({state:ctx.state,sampleRate:ctx.sampleRate})),streams:window.__testStreams?.length,events:window.__audioEvents})`).catch(error => ({ error: error.message }))
    const diagnostics = { failedAt: new Date().toISOString(), condition, detail, captureFailures, errors, chunks: chunks.length, boundsEvents }
    fs.writeFileSync(path.join(artifacts, 'failure.json'), JSON.stringify(diagnostics, null, 2))
    try { fs.writeFileSync(path.join(artifacts, 'failure.png'), (await win.webContents.capturePage()).toPNG()) } catch { /* The renderer may have crashed. */ }
    return diagnostics
  }
  const wait = async (code, ms = 2500) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (await js(code)) return; if (captureFailures.length) break; await sleep(25) }
    throw Error('UI did not reach ' + code)
  }
  // Match the production bar's 12-second microphone-start deadline on cold Macs.
  const listening = () => wait("document.querySelector('[role=status]').textContent==='Listening'", 13_000)
  let resizes = 0, shows = 0, passthrough = true
  const setBounds = win.setBounds.bind(win), showInactive = win.showInactive.bind(win), setIgnoreMouseEvents = win.setIgnoreMouseEvents.bind(win)
  const sendInput = win.webContents.sendInputEvent.bind(win.webContents)
  win.webContents.sendInputEvent = input => {
    const bounds = win.getContentBounds()
    if(input.type==='mouseMove')testCursor={x:bounds.x+input.x,y:bounds.y+input.y}
    if(input.type==='mouseLeave')testCursor={x:bounds.x-20,y:bounds.y-20}
    const result = sendInput(input)
    // Hidden/offscreen windows on macOS and Linux do not receive native hover
    // reliably. Deliver DOM mouse events through the real React/preload/IPC path.
    // --native retains actual Chromium input and the real visible-window check.
    if (!native && process.platform !== 'win32' && ['mouseMove','mouseLeave'].includes(input.type)) {
      void js(`(()=>{const next=${input.type === 'mouseLeave' ? 'document.body' : `document.elementFromPoint(${input.x},${input.y}) || document.body`};
        const previous=window.__hoverTarget;
        if(previous!==next){previous?.dispatchEvent(new MouseEvent('mouseout',{bubbles:true,relatedTarget:next}));next.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,relatedTarget:previous || document.body}));window.__hoverTarget=next}
        next.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:${input.x},clientY:${input.y}}));})()`).catch(error=>errors.push(error.message))
    }
    return result
  }
  win.setBounds = (...args) => {
    const before = win.getBounds(), requested = args[0]
    boundsEvents.push({ before, requested })
    // Display work-area changes may move the canvas; only size changes count as resizes.
    if ((requested.width ?? before.width) !== before.width || (requested.height ?? before.height) !== before.height) resizes++
    return setBounds(...args)
  }
  win.showInactive = (...args) => { shows++; return showInactive(...args) }
  win.setIgnoreMouseEvents = (ignore, options) => { passthrough = ignore; return setIgnoreMouseEvents(ignore, options) }
  const hover = async entered => {
    const bounds = win.getBounds()
    win.webContents.sendInputEvent({ type: entered ? 'mouseMove' : 'mouseLeave', x: entered ? Math.floor(bounds.width / 2) : -1, y: entered ? bounds.height - 16 : -1 })
    await wait(`document.querySelector('.dictation-bar').dataset.expanded === '${entered}'`)
    await sleep(220)
  }
  const compact = async () => {
    if (fixedCanvas) assert.ok(win.getSize().every((size, n) => Math.abs(size - nativeCanvas[n]) <= 1), 'Native DPI rounding stays within one DIP; the app never resizes for phase changes')
    const hasStatus = await js("!['idle','recording'].includes(document.querySelector('.dictation-bar').dataset.phase)")
    await wait(`document.querySelector('.dictation-bar').getBoundingClientRect().width === ${hasStatus ? 140 : 48}`)
    assert.deepEqual(await js("(()=>{const r=document.querySelector('.dictation-bar').getBoundingClientRect();return [r.width,r.height]})()"), hasStatus ? [140, 28] : [48, 12])
    assert.equal(await js("getComputedStyle(document.querySelector('.dictation-details')).visibility === 'hidden' && document.querySelector('.dictation-details').inert"), true, 'Collapsed controls cannot receive clicks or keyboard focus')
    if (fixedCanvas) assert.equal(passthrough, true, 'The surrounding canvas passes clicks to the app underneath')
    else assert.ok(win.getSize()[0] <= 156 && win.getSize()[1] <= 44, 'Linux uses a small native input region instead of a large ignored canvas')
  }
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve))
  await readyToShow
  // Native DIP bounds vary with the monitor’s scale. Phase and hover changes must retain this canvas.
  nativeCanvas = win.getSize()
  await wait("!!document.querySelector('.dictation-bar')")
  if (reducedMotion) {
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    assert.equal(await js("matchMedia('(prefers-reduced-motion: reduce)').matches"), true)
  }
  if (native) {
    for (let n = 0; n < 100 && !win.isVisible(); n++) await sleep(20)
    assert.equal(win.isVisible(), true); assert.equal(win.isAlwaysOnTop(), true); assert.equal(win.isFocusable(), false)
  }
  await js(`window.__testContexts=[]; window.__audioEvents=[];
    window.AudioContext=new Proxy(window.AudioContext,{construct(target,args){const ctx=Reflect.construct(target,args);window.__testContexts.push(ctx);
      ctx.addEventListener('statechange',()=>window.__audioEvents.push('context:'+ctx.state));
      const resume=ctx.resume.bind(ctx);ctx.resume=async()=>{window.__audioEvents.push('resume:start');await resume();window.__audioEvents.push('resume:ready')};
      const add=ctx.audioWorklet.addModule.bind(ctx.audioWorklet);ctx.audioWorklet.addModule=async(...args)=>{window.__audioEvents.push('worklet:start');await add(...args);window.__audioEvents.push('worklet:ready')};return ctx}});undefined`)
  await js(`window.__testStreams=[]; window.__quietNext=false; window.__getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=async options=>{window.__audioEvents.push('microphone:start');const stream=await window.__getMedia(options);window.__audioEvents.push('microphone:ready');window.__testStreams.push(stream);if(window.__quietNext)stream.getAudioTracks()[0].enabled=false;window.__quietNext=false;return stream};undefined`)
  assert.equal(await js('window.__testContexts.length'), 0, 'Always-visible idle bar never opens a microphone')
  await compact()
  await readyToShow
  // Reconcile placement once startup display metrics are available.
  surface.update(state)
  await picture('idle.png')
  const initialBounds = win.getBounds()
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.floor(initialBounds.width / 2), y: initialBounds.height - 16 })
  await sleep(300)
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"), 'false', 'Passing over the bar does not expand it immediately')
  win.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 })
  await sleep(300)
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"), 'false', 'Leaving before 500 ms cancels expansion')
  // The first native paint can adjust the initial placement on hosted Macs.
  // Measure hover and phase changes only after that initial render has completed.
  resizes = 0; shows = 0; boundsEvents.length = 0
  const anchor = () => {
    const bounds = win.getBounds(), area = screen.getDisplayMatching(bounds).workArea
    return { center: bounds.x + bounds.width / 2 - area.x - area.width / 2, bottom: area.y + area.height - bounds.y - bounds.height }
  }
  const restingAnchor = anchor()
  await hover(true)
  if (fixedCanvas) assert.equal(passthrough, false, 'Revealed controls receive the mouse')
  assert.deepEqual(anchor(), restingAnchor, 'Hover preserves the anchor relative to the current display work area')
  assert.equal(win.isFocusable(), false, 'Hover never takes focus from the destination')
  await picture('idle-hover.png')
  assert.equal(await js('window.__testContexts.length'), 0, 'Hover never opens a microphone')
  await js("document.querySelector('[aria-label=\"Collapse voice bar\"]').click()")
  await wait("document.querySelector('.dictation-bar').dataset.expanded==='false'")
  await sleep(650)
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"),'false','Explicit close cannot reopen beneath a stationary pointer')
  await hover(false);await hover(true)
  surface.setExpanded(false)
  await sleep(300)
  if (fixedCanvas) assert.equal(passthrough,false,'A spurious leave cannot disable visible controls under the cursor')
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"),'true')
  // A brief exit during growth must not collapse the bar underneath the pointer.
  win.webContents.sendInputEvent({ type: 'mouseLeave', x: -1, y: -1 })
  await sleep(60)
  await hover(true); await sleep(200)
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"), 'true')
  await hover(false); await compact()
  // Moving through transparent canvas above the bar must not expand it.
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 20, y: 20 })
  await sleep(300)
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"), 'false')
  if (fixedCanvas) assert.equal(passthrough, true)
  // A status pill can grow under an unmoved cursor; that is not a hover visit.
  const stationaryBounds=win.getContentBounds()
  testCursor={x:stationaryBounds.x+stationaryBounds.width/2+55,y:stationaryBounds.y+stationaryBounds.height-16}
  const stationaryPoint={...testCursor}
  change({phase:'starting',id:'stationary'})
  const statusBounds=win.getContentBounds()
  win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(stationaryPoint.x-statusBounds.x),y:Math.round(stationaryPoint.y-statusBounds.y)})
  await sleep(650)
  assert.equal(await js("document.querySelector('.dictation-bar').dataset.expanded"),'false','Status growth under the cursor must not expand the panel')
  change({phase:'idle'});await hover(false);await compact()
  await hover(true)
  testCursor={x:stationaryBounds.x-50,y:stationaryBounds.y-50}
  await wait("document.querySelector('.dictation-bar').dataset.expanded==='false'")
  if (fixedCanvas) assert.equal(passthrough,true,'Native pointer exit recovers even when Chromium loses mouse-leave')
  await hover(false)
  // Repeated crossings and status updates must never resize or reshow the native window.
  for (let n = 0; n < 6; n++) { await hover(true); await hover(false) }
  if (fixedCanvas) assert.equal(resizes, 0, 'Hover animation must never resize the native window')
  assert.equal(shows, 0, 'Hover must never reshow or raise the native window')
  // F9 starts capture in this platform's mode; no pointer or on-screen finish button is needed.
  change({ phase: 'recording', id: 'one', hold, streaming: true, startedAt: Date.now(), destination: 'Fixture chat' })
  await listening()
  await wait("[...document.querySelectorAll('.dictation-wave span')].some(bar=>parseFloat(bar.style.transform.slice(7)) > .25)")
  await compact()
  assert.equal(await js("getComputedStyle(document.querySelector('.dictation-wave')).animationName"), 'none', 'Recording animates only from real audio levels')
  await wait('window.__testStreams.length === 1')
  assert.ok(chunks.some(chunk => chunk.id === 'one'), 'Streaming audio is sent before recording stops')
  assert.equal(await js("[...document.querySelectorAll('button')].some(button=>/^(Done|Use original)$/.test(button.textContent))"), false)
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
  await picture('recording.png')
  await hover(true)
  assert.equal(await js("document.querySelector('.dictation-shortcut').textContent"), hold ? 'Release F9' : 'Press F9')
  await picture('recording-hover.png')
  await js("(()=>{const track=window.__testStreams.at(-1).getAudioTracks()[0];Object.defineProperty(track,'muted',{value:true,configurable:true});track.dispatchEvent(new Event('mute'))})()")
  await wait("document.querySelector('[role=status]').textContent==='Microphone paused'")
  await picture('microphone-paused.png')
  await js("(()=>{const track=window.__testStreams.at(-1).getAudioTracks()[0];Object.defineProperty(track,'muted',{value:false,configurable:true});track.dispatchEvent(new Event('unmute'))})()")
  await wait("document.querySelector('[role=status]').textContent==='Listening'")
  change({ ...state, inCall: true, destination: 'A very long meeting title and chat destination that must be truncated' })
  await wait("!!document.querySelector('.dictation-call-note')")
  assert.equal(await js("[...document.querySelectorAll('button,.dictation-call-note')].every(el=>{const r=el.getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth})"), true)
  await picture('during-call.png')
  await hover(false)
  // Stopping with F9 finishes while the bar stays compact.
  holdFinal = true
  change({ ...state, phase: 'finishing', preparing: true, message: 'Transcribing…' })
  await wait("document.querySelector('.dictation-stage')?.textContent === 'Connecting'")
  await compact()
  await picture('connecting.png')
  change({ ...state, preparing: false })
  await wait("document.querySelector('.dictation-stage')?.textContent === 'Transcribing'")
  await picture('transcribing.png')
  assert.deepEqual(stopped, ['one'])
  assert.equal(await js('window.__testContexts.every(ctx=>ctx.state === "closed")'), true, 'The microphone is off during processing')
  holdFinal = false
  change({ ...state, phase: 'polishing', message: 'Cleaning up your text…' })
  await wait("document.querySelector('[role=status]').textContent.includes('Cleaning')")
  await compact()
  const reduce = await js("matchMedia('(prefers-reduced-motion: reduce)').matches")
  assert.equal(await js("getComputedStyle(document.querySelector('.dictation-spinner')).animationName"), reduce ? 'none' : 'dictation-turn', 'Processing respects the motion preference')
  assert.equal(await js("(()=>{const el=document.querySelector('.dictation-spinner'),r=el.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(el).visibility==='visible'})()"), true, 'Processing retains a visible activity indicator with reduced motion')
  assert.equal(await js("document.querySelector('.dictation-stage').textContent"), 'Cleaning up')
  await picture('cleanup.png')
  assert.equal(await js("[...document.querySelectorAll('button')].some(button=>/^(Done|Use original)$/.test(button.textContent))"), false)
  assert.deepEqual(stopped, ['one'])
  assert.equal(await js("document.querySelector('[aria-label=\"Collapse voice bar\"]').disabled"), false)
  change({ ...state, message: 'Finding your text box…' })
  await wait("document.querySelector('.dictation-stage')?.textContent === 'Finding text box'")
  change({ phase: 'inserting', id: 'one', message: 'Entering text…' })
  await wait("document.querySelector('[aria-label=\"Collapse voice bar\"]')?.disabled === false")
  assert.equal(await js("document.querySelector('.dictation-stage').textContent"), 'Inserting')
  await picture('inserting.png')
  change({ phase: 'done', id: 'one', message: 'Text entered', lastText: 'First dictation' })
  await wait("document.querySelector('[role=status]').textContent==='Text entered'")
  assert.equal(await js("document.querySelector('.dictation-stage').textContent"), 'Inserted')
  await compact()
  await picture('done.png')
  await wait("!!document.querySelector('[aria-label=\"Start dictation\"]')")
  assert.equal(await js('window.__testContexts.length'), 1, 'Returning to idle never reopens capture')
  await hover(true)
  win.webContents.send('hotkeys:changed', [{ id: 'dictate', keys: 'Ctrl+Alt+Shift+Space', ok: true }])
  await wait("document.querySelector('kbd')?.textContent==='Ctrl+Alt+Shift+Space'")
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
  await picture('custom-shortcut.png')
  win.webContents.send('hotkeys:changed', [{ id: 'dictate', keys: 'F9', ok: false }])
  await wait("!!document.querySelector('[aria-label=\"Fix dictation shortcut\"]')")
  assert.equal(await js("!!document.querySelector('[aria-label=\"Start dictation\"]')"), true, 'Click-to-dictate remains available when the shortcut is taken')
  await hover(false)
  change({ phase: 'ready', id: 'one', text: 'Please send the report by Tuesday.', lastText: 'Please send the report by Tuesday.', message: 'The text box or cursor changed. Copy your text where you need it.' })
  await wait("!!document.querySelector('.dictation-result')")
  await compact()
  await picture('recovery-compact.png')
  await hover(true)
  assert.equal(await js('document.documentElement.scrollWidth <= innerWidth'), true)
  assert.equal(await js("[...document.querySelectorAll('button')].every(b=>b.getBoundingClientRect().bottom <= innerHeight)"), true)
  await picture('recovery.png')
  await hover(false); await hover(true)
  assert.equal(await js("document.querySelector('.dictation-result').textContent"), 'Please send the report by Tuesday.', 'Collapsing never loses recovered text')
  await js("document.querySelector('[aria-label=\"Collapse voice bar\"]').click()")
  await wait("document.querySelector('.dictation-bar').dataset.expanded==='false'")
  assert.equal(state.text,'Please send the report by Tuesday.','Closing recovery preserves the text')
  await hover(false);await hover(true)
  failCopy = true
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Copy text').click()")
  await wait("document.querySelector('[role=alert]')?.textContent.includes('Could not copy')")
  assert.equal(copied, 0); assert.equal(await js("!!document.querySelector('.dictation-result')"), true)
  await picture('copy-failed.png')
  await js("[...document.querySelectorAll('button')].find(b=>b.textContent==='Copy text').click()")
  await wait("document.querySelector('[role=status]')?.textContent==='Copied to clipboard'"); assert.equal(copied, 1)
  await picture('copied.png')
  await wait("!!document.querySelector('[aria-label=\"Start dictation\"]')")
  change({ phase: 'finishing', id: 'fast-stop' })
  await wait("document.querySelector('[role=status]').textContent.includes('Cleaning')")
  assert.deepEqual(stopped, ['one', 'fast-stop'], 'Stop before microphone mounts must still complete')
  change({ phase: 'done', id: 'fast-stop', message: 'Text entered' })
  await wait("document.querySelector('[role=status]').textContent==='Text entered'")
  await js('window.__quietNext=true')
  change({ phase: 'recording', id: 'cancel', startedAt: Date.now(), destination: 'Fixture chat' })
  await listening()
  await sleep(4200)
  await wait("document.querySelector('[role=status]').textContent==='No sound yet'")
  await picture('no-sound.png')
  await js("document.querySelector('[aria-label=\"Cancel dictation\"]').click()")
  await wait("window.__testContexts.length===2 && window.__testContexts.every(ctx=>ctx.state==='closed')")
  await wait("!!document.querySelector('[aria-label=\"Start dictation\"]')")
  await js("document.querySelector('[aria-label=\"Start dictation\"]').click()")
  await listening()
  await js("document.querySelector('[aria-label=\"Stop dictation\"]').click()")
  await wait("document.querySelector('[role=status]').textContent.includes('Cleaning')")
  assert.equal(stopped.length, 3, 'The tiny bar still supports click start/stop when F9 is unavailable')
  change({ phase: 'idle' })
  if (native) assert.equal(win.isAlwaysOnTop(), true, 'Processing and hover retain the visible overlay')
  surface.setIndicator(false)
  assert.equal(win.isVisible(), false)
  if (fixedCanvas) assert.equal(resizes, 0, 'Recording, processing, errors and recovery share the same native canvas')
  change({ phase: 'starting' })
  await wait("document.querySelector('[role=status]')?.textContent==='Getting ready…'")
  await compact()
  change({ phase: 'idle' })
  assert.equal(win.isVisible(), false)
  assert.deepEqual(captureFailures, [], 'Every microphone capture completes without an unexpected failure')
  assert.deepEqual(errors, [])
  surface.setIndicator(true)
  await hover(false)
  const beforeDrag = win.getBounds()
  const dragPoint=await js(`(()=>{const r=document.querySelector('.dictation-handle').getBoundingClientRect();return{x:${beforeDrag.x}+r.x+r.width/2,y:${beforeDrag.y}+r.y+r.height/2}})()`)
  await js(`(()=>{const handle=document.querySelector('.dictation-handle'),x=${dragPoint.x},y=${dragPoint.y};
    handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7,button:0,screenX:x,screenY:y}));
    handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:7,screenX:x+60,screenY:y-40}));})()`)
  for (let n = 0; n < 50 && win.getBounds().x === beforeDrag.x; n++) await sleep(20)
  assert.equal(win.getBounds().x, beforeDrag.x + 60, 'Dragging changes placement without resizing')
  assert.equal(win.getBounds().y, beforeDrag.y - 40)
  if (fixedCanvas) assert.equal(passthrough, false, 'Dragging keeps receiving the native pointer until release')
  await js(`(()=>{const handle=document.querySelector('.dictation-handle');
    handle.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,button:0,screenX:${dragPoint.x + 60},screenY:${dragPoint.y - 40}}));
    handle.dispatchEvent(new MouseEvent('click',{bubbles:true}));})()`)
  for (let n = 0; n < 50 && !passthrough; n++) await sleep(20)
  if (fixedCanvas) assert.equal(passthrough, true, 'Releasing restores click-through outside the visible bar')
  assert.equal(state.phase, 'idle', 'Dragging never starts dictation')
  assert.equal(win.isFocusable(), false, 'Dragging never takes focus from the text box')
  await picture('dragged-idle.png')
  const draggedBounds = win.getContentBounds()
  let recoveredReady = false
  app.once('browser-window-created', (_event, recovered) => recovered.once('ready-to-show', () => { recoveredReady = true }))
  const crashed = win
  crashed.webContents.forcefullyCrashRenderer()
  for (let n = 0; n < 100; n++) {
    await sleep(30)
    const recovered = surface.window
    if (recovered && recovered !== crashed && recoveredReady && !recovered.webContents.isLoading()) { win = recovered; break }
  }
  assert.ok(win && win !== crashed && !win.isDestroyed(), 'The always-on indicator recovers without pressing F9')
  const recoveredBounds = win.getContentBounds()
  assert.ok(Math.abs(recoveredBounds.x + recoveredBounds.width / 2 - draggedBounds.x - draggedBounds.width / 2) <= 1, 'Recovery retains the visible bar’s horizontal anchor across DPI rounding: ' + JSON.stringify({ draggedBounds, recoveredBounds }))
  assert.ok(Math.abs(recoveredBounds.y + recoveredBounds.height - draggedBounds.y - draggedBounds.height) <= 1, 'Recovery retains the visible bar’s bottom anchor across DPI rounding: ' + JSON.stringify({ draggedBounds, recoveredBounds }))
  await wait("!!document.querySelector('[aria-label=\"Start dictation\"]')")
  assert.equal(await js('window.__testContexts?.length ?? 0'), 0, 'Recovery never reopens the microphone')
  if (native) {
    assert.equal(win.isAlwaysOnTop(), true)
    win.hide()
    for (let n = 0; n < 70 && !win.isVisible(); n++) await sleep(30)
    assert.equal(win.isVisible(), true, 'An externally hidden indicator returns without taking focus')
    surface.keepAbove()
    assert.equal(win.isFocusable(), false)
  }
  const persistedBounds = win.getContentBounds()
  for (let n = 0; n < 50 && !fs.existsSync(path.join(artifacts, 'profile/voice-bar.json')); n++) await sleep(20)
  assert.ok(fs.existsSync(path.join(artifacts, 'profile/voice-bar.json')), 'Dragging persists placement on disk')
  surface.close()
  surface = new DictationWindow(() => change({ phase: 'idle' }), path.resolve(__dirname, '../out/main'))
  surface.setIndicator(true); win = surface.window
  await new Promise(resolve => win.once('ready-to-show', resolve))
  await wait("!!document.querySelector('[aria-label=\"Start dictation\"]')")
  const restoredBounds = win.getContentBounds()
  assert.ok(Math.abs(restoredBounds.x + restoredBounds.width / 2 - persistedBounds.x - persistedBounds.width / 2) <= 1, 'A new bar instance restores its horizontal placement from disk')
  assert.ok(Math.abs(restoredBounds.y + restoredBounds.height - persistedBounds.y - persistedBounds.height) <= 1, 'A new bar instance restores its vertical placement from disk')
  surface.setIndicator(false)
  await sleep(1100)
  assert.equal(win.isVisible(), false, 'The user can still turn the indicator off')
  console.log('VOICE BAR RECOVERY PASS: renderer failure recovers without F9 or reopening the microphone; visibility preference is respected')
  console.log(`DICTATION UI PASS (${process.platform}, ${hold ? 'hold/release' : 'press-to-start/stop'}): stable native canvas, repeated hover without resize/reshow, transparent hit testing, no idle capture or processing blink, live ripple, microphone recovery, copy retry, shortcut conflict and hidden idle preference`)
}).then(() => { clearTimeout(timeout); surface?.close(); app.exit(0) }, async error => {
  console.error(error)
  try { console.error(JSON.stringify(await reportFailure(error.stack || String(error)), null, 2)) } catch (diagnosticError) { console.error(diagnosticError) }
  clearTimeout(timeout); surface?.close(); app.exit(1)
})
