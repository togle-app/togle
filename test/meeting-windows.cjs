// Exercise the shipped Windows accessibility reader against a separate desktop Chrome/Edge profile.
// Every fixture document is supplied locally. The browser cannot resolve external hosts.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const { setTimeout: wait } = require('node:timers/promises')
const WebSocket = require('ws')
const services = [
  ['teams.microsoft.com', 'teams', 'Teams call', 'Unmute (Ctrl+Shift+M)', 'Leave'],
  ['app.zoom.us', 'zoom', 'Zoom meeting', 'Unmute My Audio (Alt+A)', 'End meeting'],
  ['example.webex.com', 'webex', 'Webex meeting', 'Unmute microphone', 'Leave meeting'],
  ['app.slack.com', 'slack', 'Slack huddle', 'Unmute myself', 'Leave huddle'],
  ['discord.com', 'discord', 'Discord voice', 'Unmute', 'Disconnect'],
  ['meet.jit.si', 'jitsi', 'Jitsi meeting', 'Unmute microphone', 'Hang up'],
  ['whereby.com', 'whereby', 'Whereby meeting', 'Turn on microphone', 'Leave room'],
  ['rooms.example.test', 'other', 'Planning', 'Unmute my microphone', 'End call']
]

async function until(fn, label, ms = 16000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { const result = await fn(); if (result) return result; await wait(100) }
  throw new Error('Timed out waiting for ' + label)
}
async function connect(url) {
  const socket = new WebSocket(url), replies = new Map()
  let sequence = 0
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    replies.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const meeting = (title, mic, leave) => '<title>' + title + '</title><div role="toolbar" aria-label="Call controls"><button id="mic">' + mic + '</button><button id="call">' + leave + '</button></div><aside aria-label="Participants"><button>Mute</button></aside>'
  const html = meeting('Meet - abc-defg-hij', 'Turn on microphone (CTRL + D)', 'Join now')
  socket.on('message', raw => {
    const message = JSON.parse(raw)
    const pending = replies.get(message.id)
    if (pending) { replies.delete(message.id); if (message.error) pending.reject(Error(message.error.message)); else pending.resolve(message.result) }
    if (message.method === 'Fetch.requestPaused') {
      const host = new URL(message.params.request.url).host
      const provider = services.find(row => row[0] === host)
      const fixture = host === 'meet.google.com' ? html : provider ? meeting(provider[2], provider[3], provider[4]) : '<title>Other tab</title>'
      void send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }], body: Buffer.from(fixture).toString('base64') }, message.sessionId).catch(() => {})
    }
  })
  return { send, socket }
}
async function nativeWindows(folder, platforms) {
  const fixture = path.join(folder, 'call-fixture.exe')
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
  execFileSync(compiler, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/out:' + fixture, path.resolve(__dirname, 'meeting-window-fixture.cs')], { windowsHide: true })
  for (const [program, app] of [['Zoom', 'zoom'], ['ms-teams', 'teams'], ['CiscoCollabHost', 'webex'], ['slack', 'slack'], ['Signal', 'signal'], ['UnlistedCall', 'other']]) {
    const exe = path.join(folder, program + '.exe'), control = path.join(folder, 'native-state')
    fs.copyFileSync(fixture, exe); fs.writeFileSync(control, 'muted')
    const window = spawn(exe, [control], { stdio: 'ignore' })
    const helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.resolve(__dirname, '../resources/meeting-windows.ps1'), '-ProcessId', String(window.pid)], { windowsHide: true })
    helper.stdin.end(JSON.stringify(platforms) + '\n')
    const events = []
    createInterface({ input: helper.stdout }).on('line', line => { if (line !== '.') events.push(JSON.parse(line)) })
    const seen = state => until(() => events.find(e => e.state === state && e.app === app), program + ' ' + state)
    try {
      await seen('muted')
      fs.writeFileSync(control, 'open')
      await seen('open')
      fs.writeFileSync(control, app === 'other' ? 'exit' : 'ended')
      await seen('left')
    } finally { helper.kill(); window.kill() }
  }
  console.log('WINDOWS NATIVE CALLS PASS: Zoom, Teams, Webex, Slack, Signal and an unlisted program through Windows UI Automation.')
}
async function run() {
  if (process.platform !== 'win32') return
  const exe = [path.join(process.env.ProgramFiles, 'Google/Chrome/Application/chrome.exe'), path.join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe')].find(p => fs.existsSync(p))
  assert.ok(exe, 'Install Chrome or Edge on the test computer')
  const { desktopCallApps } = await import('./.build/togle.mjs')
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-meet-test-'))
  const browser = spawn(exe, ['--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-sync', '--disable-extensions', '--remote-debugging-port=0', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost',
    '--disable-backgrounding-occluded-windows', '--window-position=-12000,20', '--window-size=730,520', 'about:blank'], { stdio: 'ignore' })
  let client, helper
  try {
    const portFile = path.join(profile, 'DevToolsActivePort')
    const info = await until(() => fs.existsSync(portFile) && fs.readFileSync(portFile, 'utf8').trim().split(/\r?\n/), 'isolated browser')
    client = await connect('ws://127.0.0.1:' + info[0] + info[1])
    const { send } = client
    const { targetInfos } = await send('Target.getTargets')
    const home = targetInfos.find(t => t.type === 'page').targetId
    const { sessionId } = await send('Target.attachToTarget', { targetId: home, flatten: true })
    await send('Fetch.enable', {}, sessionId)
    await send('Page.navigate', { url: 'https://meet.google.com/abc-defg-hij' }, sessionId)
    const evaluate = expression => send('Runtime.evaluate', { expression, returnByValue: true }, sessionId)
    await until(async () => (await evaluate("document.querySelector('#mic')?.textContent")).result.value, 'pre-join screen')
    await send('Page.bringToFront', {}, sessionId)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 90, y: 17, button: 'left', clickCount: 1 }, sessionId)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 90, y: 17, button: 'left' }, sessionId)
    helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.resolve(__dirname, '../resources/meeting-windows.ps1'), '-ProcessId', String(browser.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    helper.stdin.end(JSON.stringify(desktopCallApps) + '\n')
    const observations = []; let pulses = 0, stderr = ''
    helper.stderr.on('data', chunk => { stderr += chunk })
    createInterface({ input: helper.stdout }).on('line', line => { if (line === '.') pulses++; else observations.push(JSON.parse(line)) })
    const seen = (state, from) => until(() => observations.slice(from).find(s => s.state === state), state + ' in Windows accessibility')
    await until(() => pulses >= 2, 'two reads of the pre-join screen' + (stderr ? ': ' + stderr : ''))
    assert.deepEqual(observations, [], 'the microphone check before joining produces no meeting')
    await evaluate("document.querySelector('#call').textContent='Leave call'")
    const first = await seen('muted', 0)
    assert.equal(first.app, 'meet')
    await evaluate("document.querySelector('#mic').textContent='Turn off microphone (CTRL + D)'")
    await seen('open', observations.length)
    const quick = observations.length
    await evaluate("document.querySelector('#mic').textContent='Turn on microphone (CTRL + D)'; setTimeout(() => { document.querySelector('#mic').textContent='Turn off microphone (CTRL + D)' }, 100)")
    await seen('gap', quick)
    await seen('open', quick)
    let at = observations.length
    const other = (await send('Target.createTarget', { url: 'about:blank' })).targetId
    await send('Target.activateTarget', { targetId: other })
    await seen('unknown', at)
    await send('Target.activateTarget', { targetId: home })
    await seen('open', observations.length)
    assert.ok(!observations.slice(at).some(s => s.state === 'left'), 'switching tabs preserves one meeting')
    await evaluate("document.querySelector('#mic').remove(); document.querySelector('#call').textContent='Rejoin'")
    assert.equal((await seen('left', observations.length)).id, first.id, 'the host ended the meeting')
    await evaluate("document.body.innerHTML='<button>Turn on microphone (CTRL + D)</button><button>Leave call</button>'")
    await seen('muted', observations.length)
    at = observations.length
    await send('Target.activateTarget', { targetId: other })
    await seen('unknown', at)
    await send('Target.closeTarget', { targetId: home })
    await seen('left', at)
    const nextSession = (await send('Target.attachToTarget', { targetId: other, flatten: true })).sessionId
    await send('Fetch.enable', {}, nextSession)
    for (const [domain, app] of services) {
      at = observations.length
      await send('Page.navigate', { url: 'https://' + domain + '/room/desktop-test' }, nextSession)
      await until(async () => (await send('Runtime.evaluate', { expression: "location.host === " + JSON.stringify(domain) + " && !!document.querySelector('#call')", returnByValue: true }, nextSession)).result.value, domain)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 20, y: 15, button: 'left', clickCount: 1 }, nextSession)
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 20, y: 15, button: 'left' }, nextSession)
      const joined = await seen('muted', at)
      assert.equal(joined.app, app, 'recognized ' + domain)
      if (app === 'discord') {
        const unknown = observations.length
        await send('Runtime.evaluate', { expression: "document.querySelector('#mic').textContent='Device options'" }, nextSession)
        await seen('unknown', unknown)
        assert.ok(!observations.slice(unknown).some(e => e.state === 'open'), 'a participant mute button cannot open the local mic')
      }
      await send('Runtime.evaluate', { expression: "document.querySelector('#mic').textContent='Mute my microphone'" }, nextSession)
      assert.equal((await seen('open', at)).app, app)
      if (app === 'slack') {
        const beforeNavigation = observations.length
        await send('Runtime.evaluate', { expression: "history.pushState({}, '', '/client/another-channel')" }, nextSession)
        await until(() => observations.slice(beforeNavigation).filter(event => event.state === 'open' && event.id === joined.id).length >= 2, 'continued huddle after changing channels')
        assert.ok(!observations.slice(beforeNavigation).some(event => event.state === 'left'))
      }
      const endAction = app === 'slack' ? 'Start a huddle' : 'Call again'
      await send('Runtime.evaluate', { expression: "document.body.innerHTML='<button>" + endAction + "</button>'" }, nextSession)
      assert.equal((await seen('left', at)).app, app)
    }
    console.log('WINDOWS MEETINGS PASS: Google Meet lobby, quick mute, hidden tab, leave and rejoin, plus join/mute/leave for ' + services.map(row => row[1]).join(', '))
    helper.kill()
    await nativeWindows(profile, desktopCallApps)
  } finally {
    helper?.kill()
    if (client) { await Promise.race([client.send('Browser.close').catch(() => {}), wait(900)]); client.socket.close() }
    if (browser.exitCode === null) browser.kill()
    await wait(500)
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('togle-meet-test-')) fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 })
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
