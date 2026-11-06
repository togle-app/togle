// Actual Windows getDisplayMedia -> production ScreenRecorder -> real preload/IPC -> rolling buffer.
// Only this test's fictional chart window is selected. --live additionally exercises the signed-in AI.
const { app, BrowserWindow, ipcMain, desktopCapturer, nativeImage } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const live = process.argv.includes('--live')
process.on('unhandledRejection', error => { console.error('Unhandled rejection in actual capture:', error); app.exit(1) })
const artifacts = path.join(__dirname, '.work', 'screen-capture')
fs.mkdirSync(artifacts, { recursive: true })
const profile = fs.mkdtempSync(path.join(artifacts, 'profile-'))
app.setPath('userData', profile)
process.env.TOGLE_HEADLESS = '1'
process.env.TOGLE_SILENT_AUDIO = '1'
process.env.TOGLE_DEBUG_PORT = '0'
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
process.env.TOGLE_SPEECH_SEEDS = ''
delete process.env.TOGLE_AUTOSTART
const handlers = new Map()
const captured = []
let chart, driver, root, checkpoint = 'startup'
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, callback) => {
  handlers.set(channel, callback)
  if (channel === 'screen-monitor:frame') {
    return originalHandle(channel, async (event, id, at, bytes) => {
      const accepted = await callback(event, id, at, bytes)
      if (accepted) {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes))
        const { width, height } = image.getSize()
        const bitmap = image.toBitmap()
        const offset = (20 * width + 20) * 4
        const [blue, green, red] = bitmap.subarray(offset, offset + 3)
        captured.push({ at, id, width, height, kind: blue > red + 20 ? 'spoken' : red > blue + 20 ? 'later' : 'unknown', rgb: [red, green, blue] })
      }
      return accepted
    })
  }
  return originalHandle(channel, callback)
}
const invoke = (channel, ...args) => handlers.get(channel)({}, ...args)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, label, duration = 12_000) {
  checkpoint = label
  const until = Date.now() + duration
  while (Date.now() < until) { if (await check()) return; await delay(40) }
  throw new Error('Capture verification timed out at ' + label + ': ' + JSON.stringify(captured.slice(-3)))
}
const timeout = setTimeout(() => { console.error('Capture verification timed out at ' + checkpoint); app.exit(1) }, 150_000)
require('../out/main/index.js')

async function run() {
  await wait(() => handlers.has('dev:transcript') && BrowserWindow.getAllWindows().length, 'registered production IPC')
  root = BrowserWindow.getAllWindows().find(window => window.getTitle() !== 'Togle voice bar')
  const evaluate = code => root.webContents.executeJavaScript(code)
  await wait(() => evaluate("!!window.togle&&!!document.querySelector('.workspace-nav')"), 'production renderer')
  const agent = invoke('agents:list')[0]
  await invoke('agents:update', agent.id, { learning: 'off' })
  const settings = invoke('settings:get')
  const subscriptionLanes = Object.fromEntries(Object.keys(settings.claude.subscriptionLanes).map(lane => [lane, { model: 'haiku', effort: 'low' }]))
  await invoke('settings:update', { provider: 'claude', assist: { auto: false }, claude: { auth: 'subscription', subscriptionLanes } })
  if (live) {
    const auth = await invoke('claude:auth-status')
    assert.ok(auth.signedIn, auth.error || 'Claude CLI must already be signed in for --live.')
  }
  await evaluate('window.captureEvents=[];window.togle.onAssist(event=>window.captureEvents.push(event));true')
  await invoke('session:listening', true)
  const title = 'Togle fictional capture verification ' + process.pid
  chart = new BrowserWindow({ title, width: 960, height: 600, frame: false, show: false, backgroundColor: '#112039', webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } })
  const html = (later = false) => `<html><head><title>${title}</title></head><body style="margin:0;background:${later ? '#601220' : '#112039'};color:white;font:32px Arial;padding:60px"><h2>Fictional team results</h2><p>Alpha: ${later ? 99 : 20}</p><div style="width:${later ? 650 : 160}px;height:40px;background:#6195ff"></div><p>Beta: ${later ? 1 : 35}</p><div style="width:${later ? 10 : 280}px;height:40px;background:#55d7ae"></div></body></html>`
  await chart.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html()))
  chart.showInactive()
  let source
  await wait(async () => {
    source = (await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })).find(item => item.name === title)
    return !!source
  }, 'fictional source enumeration')
  driver = root
  await driver.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, '.build/screen-capture-driver.js'), 'utf8') + ';true')
  await wait(() => driver.webContents.executeJavaScript('!!window.captureCheck'), 'capture driver')
  const unprepared = await driver.webContents.executeJavaScript('navigator.mediaDevices.getDisplayMedia({video:true,audio:false}).then(stream=>{stream.getTracks().forEach(track=>track.stop());return "unexpected capture"},error=>error.name)', true)
  assert.notEqual(unprepared, 'unexpected capture', 'an unprepared capture must never fall back to the display under the cursor')
  await driver.webContents.executeJavaScript(`window.captureCheck.start(${JSON.stringify(source.id)})`, true)
  await wait(() => captured.filter(item => item.kind === 'spoken').length >= 3, 'real blue chart pixels')
  assert.ok(captured.every(item => item.kind === 'spoken'), 'capture must contain only the fictional chart before any AI request')
  assert.equal(invoke('screen-monitor:status').source.id, source.id)
  assert.equal(invoke('screen-monitor:status').imagesSent, 0)
  const scope = invoke('screen-monitor:status').id
  const reference = Date.now()
  invoke('dev:transcript', 'them', 'As you can see on my screen, these are the team results.')
  await delay(650)
  await chart.webContents.executeJavaScript(`document.body.outerHTML=${JSON.stringify(html(true).match(/<body[\s\S]*<\/body>/)[0])}`)
  await wait(() => captured.filter(item => item.kind === 'later').length >= 3, 'real changed red chart pixels')
  let answer, used
  if (live) {
    await evaluate('window.captureEvents=[];window.togle.assist({kind:"ask",question:"When they said as you can see on my screen, which team had the larger value and what was that value? Read the chart at that spoken time."})')
    await wait(() => evaluate('window.captureEvents.some(event=>event.type==="done"&&event.part==="main"||event.type==="error")'), 'live historical screen answer', 100_000)
    const events = await evaluate('window.captureEvents')
    assert.deepEqual(events.filter(event => event.type === 'error'), [])
    answer = events.filter(event => event.type === 'delta' && event.part === 'main').map(event => event.text).join('')
    used = invoke('screen-monitor:status').lastLook
    assert.ok(used && !used.unavailable, 'AI must actually read the captured historical screen')
    assert.match(answer, /Beta/i)
    assert.match(answer, /35/)
    assert.ok(used.capturedAt.every(at => at <= reference && captured.some(item => item.at === at && item.kind === 'spoken')), 'every image must come from the original blue chart at or before the spoken reference')
  }
  await invoke('screen-monitor:stop', scope)
  await wait(() => driver.webContents.executeJavaScript('!window.captureCheck.active()'), 'pause releases actual media track')
  const stoppedCount = captured.length
  await delay(700)
  assert.equal(captured.length, stoppedCount, 'capture stops saving when paused')
  assert.equal(await invoke('screen-monitor:frame', scope, Date.now(), Buffer.from('old scope')), false)
  await driver.webContents.executeJavaScript(`window.captureCheck.start(${JSON.stringify(source.id)})`, true)
  await wait(() => captured.length > stoppedCount, 'resume captures a new source scope')
  const resumed = invoke('screen-monitor:status').id
  assert.notEqual(resumed, scope)
  await invoke('session:listening', false)
  await wait(() => driver.webContents.executeJavaScript('!window.captureCheck.active()'), 'ending call releases actual media track')
  assert.equal(invoke('screen-monitor:status').state, 'off')
  await invoke('session:listening', true)
  await driver.webContents.executeJavaScript(`window.captureCheck.start(${JSON.stringify(source.id)})`, true)
  const beforeClose = captured.length
  await wait(() => captured.length > beforeClose, 'reopened call captures its explicitly selected window')
  chart.destroy()
  await wait(() => driver.webContents.executeJavaScript('window.captureCheck.ended()&&!window.captureCheck.active()'), 'closing selected window ends capture')
  await wait(() => invoke('screen-monitor:status').state === 'paused', 'closed source pauses monitoring')
  await invoke('session:listening', false)
  const report = { at: new Date().toISOString(), pass: true, live, source: source.name, samples: captured, reference, answer, used }
  fs.writeFileSync(path.join(artifacts, live ? 'live-result.json' : 'result.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(`Actual Windows screen capture passed: ${captured.length} timestamped JPEG samples, correct selected window, changed chart, pause/resume and call end.${live ? ' Live Claude retrieved Beta = 35 from the earlier chart.' : ' No AI request.'}`)
}
run().then(() => { clearTimeout(timeout); chart?.destroy(); driver?.destroy(); app.exit(0) }).catch(error => {
  console.error(error.stack); clearTimeout(timeout); chart?.destroy(); driver?.destroy(); app.exit(1)
})
