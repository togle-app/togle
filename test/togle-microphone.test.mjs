// Togle's side of Togle Microphone: finding it over its local link, turning it on around calls, and the noise check that
// shows a noisy microphone after a call. A fake Togle Microphone serves the link; nothing real is started or heard.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { workDir, wait } from './helpers.mjs'

const work = workDir('togle-microphone')
const {
  MicrophoneLink, encodeLinkMessage, LinkLineReader, readLinkFile, readLinkState, isTogleMicrophoneLabel, microphonePage, TOGLE_SITE,
  describeNoise, isMicrophoneOn, microphoneNeedsSignIn, noiseVerdict, readNoiseReport, shouldSuggest, MICROPHONE_DEFAULTS, MICROPHONE_SIGN_IN, NoiseCheck, noisyThreshold,
  getSettings, loadSettings, updateSettings
} = await import('./.build/togle.mjs')

let folders = 0
const folder = () => { const dir = path.join(work, 'Togle Microphone ' + ++folders); fs.mkdirSync(dir, { recursive: true }); return dir }
const offState = { phase: 'off', device: 'Togle Microphone', input: 'USB Headset', systemDefault: false, personalized: true, engine: 'deepfilter', bufferMs: 128, setup: 'ready', version: '0.1.0' }

/** A Togle Microphone that serves the link the way the real one does. */
function fakeMicrophone(dir, { token = crypto.randomBytes(32).toString('hex'), expect = token, state = offState, launch } = {}) {
  const socket = process.platform === 'win32' ? `\\\\.\\pipe\\togle-microphone-${crypto.randomBytes(8).toString('hex')}` : path.join(dir, 'link.sock')
  const watchers = new Set(), connections = new Set(), requests = []
  const set = patch => { state = { ...state, ...patch }; for (const c of watchers) c.write(encodeLinkMessage({ event: 'state', data: state })) }
  const server = net.createServer(connection => {
    connections.add(connection)
    let hello = false
    const reader = new LinkLineReader()
    connection.setEncoding('utf8')
    connection.on('close', () => { watchers.delete(connection); connections.delete(connection) })
    connection.on('error', () => undefined)
    connection.on('data', chunk => {
      for (const message of reader.push(chunk)) {
        requests.push(message)
        const reply = value => connection.write(encodeLinkMessage({ id: message.id, ...value }))
        if (!hello) {
          if (message.method !== 'hello' || message.params?.token !== expect) { reply({ error: 'Not allowed' }); connection.destroy(); return }
          hello = true
          reply({ result: { product: 'Togle Microphone', version: '0.1.0', api: 1 } })
        } else if (message.method === 'state') reply({ result: state })
        else if (message.method === 'watch') { watchers.add(connection); reply({ result: true }); connection.write(encodeLinkMessage({ event: 'state', data: state })) }
        else if (message.method === 'start') { set({ phase: 'on', systemDefault: true }); reply({ result: state }) }
        else if (message.method === 'stop') { set({ phase: 'off', systemDefault: false }); reply({ result: state }) }
        else if (message.method === 'show') reply({ result: true })
        else reply({ error: 'Unknown method' })
      }
    })
  })
  return {
    socket, token, requests, set,
    methods: () => requests.map(r => r.method),
    writeFile: (extra = {}) => fs.writeFileSync(path.join(dir, 'link.json'), JSON.stringify({ api: 1, product: 'Togle Microphone', version: '0.1.0', pid: process.pid, socket, token, launch, startedAt: Date.now(), ...extra })),
    listen: () => new Promise((resolve, reject) => { if (process.platform !== 'win32') fs.rmSync(socket, { force: true }); server.once('error', reject); server.listen(socket, resolve) }),
    close: () => new Promise(resolve => { for (const c of connections) c.destroy(); server.close(() => resolve()) })
  }
}

const link = (dir, options = {}) => new MicrophoneLink({ folder: dir, client: { name: 'togle', version: '0.0.0-test' }, ...options })
const until = async (check, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await wait(20) } assert.fail('timed out') }

test('Togle works the same without Togle Microphone', async () => {
  const microphone = link(path.join(work, 'never installed'))
  assert.deepEqual(await microphone.refresh(), { installed: false, running: false })
  assert.deepEqual(await microphone.prepareCall(MICROPHONE_DEFAULTS), { installed: false, running: false })
  await assert.rejects(microphone.turnOn('user'), /isn't installed/)
  await microphone.endCall()
  microphone.stop()
})

test('finds a running Togle Microphone, proves the token and follows its state', async t => {
  const dir = folder(), fake = fakeMicrophone(dir)
  await fake.listen(); fake.writeFile()
  const microphone = link(dir)
  t.after(async () => { microphone.stop(); await fake.close() })
  const status = await microphone.refresh()
  assert.equal(status.installed, true)
  assert.equal(status.running, true)
  assert.deepEqual(status.state, offState)
  assert.deepEqual(fake.methods(), ['hello', 'state', 'watch'])
  assert.equal(fake.requests[0].params.token, fake.token)
  const seen = []
  microphone.on('changed', s => seen.push(s.state?.phase))
  fake.set({ phase: 'on', systemDefault: true })
  await until(() => microphone.status().state?.phase === 'on')
  assert.ok(seen.includes('on'))
  assert.equal(isMicrophoneOn(microphone.status()), true)
})

test('a link that does not prove the token, or points somewhere else, shows nothing running', async t => {
  const dir = folder(), fake = fakeMicrophone(dir, { expect: 'f'.repeat(64) })
  await fake.listen(); fake.writeFile()
  const refused = link(dir)
  t.after(async () => { refused.stop(); await fake.close() })
  assert.deepEqual(await refused.refresh(), { installed: true, running: false })
  const elsewhere = folder()
  fs.writeFileSync(path.join(elsewhere, 'link.json'), JSON.stringify({ api: 1, product: 'Togle Microphone', version: '0.1.0', pid: 1, socket: process.platform === 'win32' ? '\\\\.\\pipe\\someone-else' : '/tmp/someone-else.sock', token: 'a'.repeat(64), startedAt: 1 }))
  const other = link(elsewhere)
  assert.deepEqual(await other.refresh(), { installed: true, running: false })
  other.stop()
  for (const broken of [{}, { api: 2 }, { api: 1, product: 'Other' }]) {
    fs.writeFileSync(path.join(elsewhere, 'link.json'), JSON.stringify(broken))
    assert.equal((await link(elsewhere).refresh()).installed, false)
  }
})

test('turns it on before a call and off after it, and leaves it alone when it was already on', async t => {
  const dir = folder(), fake = fakeMicrophone(dir)
  await fake.listen(); fake.writeFile()
  const microphone = link(dir)
  t.after(async () => { microphone.stop(); await fake.close() })
  const before = await microphone.prepareCall(MICROPHONE_DEFAULTS)
  assert.equal(before.state.phase, 'on')
  assert.equal(before.forCall, true)
  assert.deepEqual(fake.requests.find(r => r.method === 'start').params, { reason: 'call' })
  await microphone.endCall()
  await until(() => microphone.status().state?.phase === 'off')
  assert.deepEqual(fake.requests.find(r => r.method === 'stop').params, { reason: 'call' })
  assert.equal(microphone.status().forCall, undefined)
  // On already (the user turned it on): the call doesn't turn it off afterwards.
  fake.set({ phase: 'on' })
  await until(() => microphone.status().state?.phase === 'on')
  const count = fake.requests.length
  await microphone.prepareCall(MICROPHONE_DEFAULTS)
  await microphone.endCall()
  assert.deepEqual(fake.requests.slice(count).map(r => r.method), [], 'nothing asked of it')
  // The setting off: a call never touches it.
  fake.set({ phase: 'off' })
  await until(() => microphone.status().state?.phase === 'off')
  const off = await microphone.prepareCall({ ...MICROPHONE_DEFAULTS, autoStart: false })
  assert.equal(off.state.phase, 'off')
  assert.ok(!fake.requests.slice(count).some(r => r.method === 'start'))
})

test('signed out of Togle Microphone: a call leaves it alone, and asking for it opens its sign-in', async t => {
  const dir = folder(), fake = fakeMicrophone(dir, { state: { ...offState, account: 'signed-out' } })
  await fake.listen(); fake.writeFile()
  const microphone = link(dir)
  t.after(async () => { microphone.stop(); await fake.close() })
  const before = await microphone.prepareCall(MICROPHONE_DEFAULTS)
  assert.equal(before.state.account, 'signed-out')
  assert.equal(microphoneNeedsSignIn(before), true)
  assert.equal(before.forCall, undefined)
  assert.ok(!fake.methods().includes('start') && !fake.methods().includes('show'), 'a call neither starts it nor opens its window')
  await assert.rejects(microphone.turnOn('call'), { message: MICROPHONE_SIGN_IN })
  assert.ok(!fake.methods().includes('show'))
  await assert.rejects(microphone.turnOn('user'), { message: MICROPHONE_SIGN_IN })
  assert.deepEqual(fake.requests.filter(r => r.method === 'show').map(r => r.params), [{ page: 'settings' }], 'asked by the user, its sign-in opens')
  assert.ok(!fake.methods().includes('start'))
  // Signed in there: the next call turns it on, and off after.
  fake.set({ account: 'signed-in' })
  await until(() => microphone.status().state?.account === 'signed-in')
  assert.equal(microphoneNeedsSignIn(microphone.status()), false)
  assert.equal((await microphone.prepareCall(MICROPHONE_DEFAULTS)).state.phase, 'on')
  await microphone.endCall()
  await until(() => microphone.status().state?.phase === 'off')
  assert.equal(microphoneNeedsSignIn({ installed: true, running: false }), false, 'not running: nothing known about its account')
})

test('starts an installed Togle Microphone that is not running, only through its own program', async t => {
  const dir = folder(), fake = fakeMicrophone(dir, { state: { ...offState, phase: 'on', systemDefault: true } })
  const program = process.platform === 'win32' ? path.join(dir, 'Togle Microphone.exe') : process.platform === 'darwin' ? '/usr/bin/open' : path.join(dir, 'togle-microphone')
  if (process.platform !== 'darwin') fs.writeFileSync(program, '')
  const args = process.platform === 'darwin' ? ['-b', 'io.togle.microphone', '--args', '--hidden'] : ['--hidden']
  const runs = [], opened = []
  fake.writeFile({ launch: { command: program, args } })
  const microphone = link(dir, { run: launch => { runs.push(launch); void fake.listen().then(() => fake.writeFile({ launch: { command: program, args } })) }, open: async url => { opened.push(url) } })
  t.after(async () => { microphone.stop(); await fake.close() })
  assert.deepEqual(await microphone.refresh(), { installed: true, running: false })
  const status = await microphone.turnOn('user')
  assert.equal(status.running, true)
  assert.equal(status.state.phase, 'on')
  assert.equal(runs.length, 1)
  assert.equal(runs[0].command, program)
  assert.deepEqual(runs[0].args, [...args, '--start'])
  assert.deepEqual(opened, [])
  // Showing its window starts it without --hidden.
  await fake.close()
  await until(() => !microphone.status().running)
  const shown = link(dir, { run: launch => runs.push(launch), open: async url => { opened.push(url) } })
  await shown.show()
  assert.deepEqual(runs.at(-1).args, args.filter(arg => arg !== '--hidden'))
  shown.stop()
})

test('a launch that is not Togle Microphone is never run: its address asks the system instead', async () => {
  const dir = folder(), runs = [], opened = []
  fs.writeFileSync(path.join(dir, 'link.json'), JSON.stringify({ api: 1, product: 'Togle Microphone', version: '0.1.0', pid: 1, socket: process.platform === 'win32' ? '\\\\.\\pipe\\togle-microphone-00000000' : path.join(dir, 'link.sock'), token: 'b'.repeat(64), startedAt: 1,
    launch: { command: process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh', args: ['-c', 'echo'] } }))
  const microphone = link(dir, { run: launch => runs.push(launch), open: async url => { opened.push(url) } })
  await assert.rejects(microphone.turnOn('user', 300), /didn't start/)
  assert.deepEqual(runs, [])
  assert.deepEqual(opened, ['togle-microphone://start'])
  microphone.stop()
})

test('follows Togle Microphone when it starts again with a new token', async t => {
  const dir = folder(), first = fakeMicrophone(dir)
  await first.listen(); first.writeFile()
  const microphone = link(dir)
  microphone.start()
  t.after(() => microphone.stop())
  await until(() => microphone.status().running)
  await first.close()
  await until(() => !microphone.status().running)
  const second = fakeMicrophone(dir, { state: { ...offState, phase: 'on' } })
  t.after(() => second.close())
  await second.listen(); second.writeFile()
  // The folder watcher sees the new link file.
  await until(() => microphone.status().state?.phase === 'on', 8000)
  assert.equal(second.requests[0].params.token, second.token)
})

test('link messages and files: only what the protocol allows', () => {
  const reader = new LinkLineReader()
  assert.deepEqual(reader.push('{"id":1,"result":true}\n{"event":"st'), [{ id: 1, result: true }])
  assert.deepEqual(reader.push('ate","data":{}}\n'), [{ event: 'state', data: {} }])
  assert.throws(() => new LinkLineReader().push('[1]\n'), /not an object/)
  assert.throws(() => new LinkLineReader().push('x'.repeat(70 * 1024)), /too long/)
  assert.equal(readLinkFile({ api: 1, product: 'Togle Microphone', version: '1', pid: 1, socket: 's', token: 'short', startedAt: 1 }), undefined)
  assert.equal(readLinkState({ ...offState, phase: 'sideways' }), undefined)
  const { bufferMs, engine, ...rest } = offState
  assert.deepEqual(readLinkState({ ...offState, bufferMs: -5, engine: 'magic', extra: 1 }), rest)
  assert.equal(isTogleMicrophoneLabel('Togle Microphone (VB-Audio Virtual Cable)'), true)
  assert.equal(isTogleMicrophoneLabel('Togle Microphone Feed (VB-Audio Virtual Cable)'), false)
  assert.equal(isTogleMicrophoneLabel('Microphone (USB Headset)'), false)
  const page = new URL(microphonePage('after-call'))
  assert.equal(page.origin, new URL(TOGLE_SITE).origin)
  assert.equal(page.pathname, '/microphone/')
  assert.equal(page.searchParams.get('utm_content'), 'after-call')
  assert.equal(page.searchParams.get('utm_source'), 'togle')
})

// ---- The noise check, on synthetic 16 kHz frames (32 ms each) ----

const FRAME = 512, FRAME_MS = 32
let seed = 1
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 * 2 - 1 }
/** A frame at a level in dBFS: white noise for background, a tone for a voice. */
function frame(db, kind = 'noise') {
  const out = new Float32Array(FRAME), rms = 10 ** (db / 20)
  for (let i = 0; i < FRAME; i++) out[i] = kind === 'noise' ? random() * rms * Math.sqrt(3) : Math.sin(i * 2 * Math.PI * 200 / 16000) * rms * Math.SQRT2
  return out
}
const seconds = s => Math.round(s * 1000 / FRAME_MS)
/** A call: background at `floor`, the user speaking `talk` seconds at `voice` every `every` seconds, with `extra` frames mixed in. */
function call(check, { floor, voice = -22, minutes = 1.5, talk = 2, every = 8, burst } = {}) {
  const total = seconds(minutes * 60), cycle = seconds(every), speech = seconds(talk)
  for (let i = 0; i < total; i++) {
    const inCycle = i % cycle
    if (inCycle < speech) check.push(frame(voice, 'tone'))
    else if (burst && inCycle % seconds(1) === 0) check.push(frame(burst))
    else check.push(frame(floor))
  }
}

test('a quiet room is quiet: the voice far above the background, nothing to suggest', () => {
  const check = new NoiseCheck()
  call(check, { floor: -66 })
  const report = check.report()
  assert.equal(report.verdict, 'quiet')
  assert.equal(report.noisyMs, 0)
  assert.equal(report.bursts, 0)
  assert.ok(report.snrDb > 35, String(report.snrDb))
  assert.ok(Math.abs(report.speechDb - -22) <= 1)
  assert.ok(report.quietMs > 50_000 && report.speechMs > 18_000, JSON.stringify(report))
  assert.equal(report.sample, undefined, 'nothing to play back from a quiet room')
})

test('a fan close to the microphone is noisy, with a few seconds of it to play back', () => {
  const check = new NoiseCheck()
  call(check, { floor: -40 })
  const report = check.report()
  assert.equal(report.verdict, 'noisy')
  assert.ok(report.noisyMs / report.quietMs > 0.9)
  assert.ok(Math.abs(report.floorDb - -40) <= 1.5)
  assert.equal(report.sample.length, seconds(4) * FRAME, 'four seconds at 16 kHz')
  // Only background: the voice (a 200 Hz tone, far louder) is never in it.
  let peak = 0
  for (const value of report.sample) peak = Math.max(peak, Math.abs(value))
  assert.ok(20 * Math.log10(peak) < -30, 'the sample has no voice in it')
})

test('typing between sentences counts as short sounds, not speech', () => {
  const check = new NoiseCheck()
  call(check, { floor: -66, burst: -32 })
  const report = check.report()
  assert.ok(report.bursts >= 50, String(report.bursts))
  assert.equal(report.verdict, 'noisy')
  assert.ok(Math.abs(report.speechDb - -22) <= 1, 'the clicks did not become the voice')
})

test('the other side heard from the speakers, a muted microphone and a steady new sound are handled apart', () => {
  let remote = false
  const check = new NoiseCheck(() => remote)
  for (let i = 0; i < seconds(30); i++) check.push(frame(-66))
  remote = true
  for (let i = 0; i < seconds(20); i++) check.push(frame(-30, i % 40 < 30 ? 'tone' : 'noise'))
  remote = false
  for (let i = 0; i < seconds(10); i++) check.push(new Float32Array(FRAME))
  const before = check.report()
  assert.ok(Math.abs(before.quietMs - 30_000) < 1500, 'the other side is not the user background: ' + before.quietMs)
  assert.ok(before.analyzedMs < 52_000, 'muted seconds are not measured')
  // A fan starts and never stops: after a few seconds it is background, not speech.
  for (let i = 0; i < seconds(30); i++) check.push(frame(-38))
  const after = check.report()
  assert.ok(after.speechMs < 10_000, String(after.speechMs))
  assert.ok(after.noisyMs >= 20_000, String(after.noisyMs))
})

test('the microphone check judges on a few seconds', () => {
  const check = new NoiseCheck()
  for (let i = 0; i < seconds(4); i++) check.push(frame(-42))
  for (let i = 0; i < seconds(5); i++) check.push(frame(i % 20 < 16 ? -20 : -42, i % 20 < 16 ? 'tone' : 'noise'))
  assert.equal(check.report().verdict, 'unknown', 'a call needs a minute')
  assert.equal(check.report(true).verdict, 'noisy')
  assert.equal(noisyThreshold(undefined), -50)
  assert.equal(noisyThreshold(-10), -45)
  assert.equal(noisyThreshold(-50), -60)
})

const noisy = { analyzedMs: 600_000, speechMs: 180_000, quietMs: 360_000, noisyMs: 162_000, bursts: 41, floorDb: -47, peakDb: -38, speechDb: -24, snrDb: 23 }

test('suggestions: only after noisy calls, never with Togle Microphone on, every few days, and never after "Don’t show"', () => {
  const report = { ...noisy, verdict: noiseVerdict(noisy) }
  assert.equal(report.verdict, 'noisy')
  const none = { installed: false, running: false }
  const now = Date.now(), day = 24 * 60 * 60_000
  assert.equal(shouldSuggest(MICROPHONE_DEFAULTS, none, report, now), true)
  assert.equal(shouldSuggest({ ...MICROPHONE_DEFAULTS, suggestions: false }, none, report, now), false)
  assert.equal(shouldSuggest(MICROPHONE_DEFAULTS, { installed: true, running: true, state: { ...offState, phase: 'on' } }, report, now), false)
  assert.equal(shouldSuggest(MICROPHONE_DEFAULTS, { installed: true, running: true, state: offState }, report, now), true, 'installed but off: it says so')
  assert.equal(shouldSuggest(MICROPHONE_DEFAULTS, none, { ...report, verdict: 'some' }, now), false)
  assert.equal(shouldSuggest({ ...MICROPHONE_DEFAULTS, suggestedAt: now - day }, none, report, now), false)
  assert.equal(shouldSuggest({ ...MICROPHONE_DEFAULTS, suggestedAt: now - 3 * day }, none, report, now), true)
  assert.equal(shouldSuggest({ ...MICROPHONE_DEFAULTS, dismissals: 3 }, none, report, now), false)
  assert.equal(shouldSuggest({ ...MICROPHONE_DEFAULTS, suggestedAt: now + day }, none, report, now), true, 'a clock set back does not silence it forever')
})

test('a report from the window is checked, and its verdict worked out again', () => {
  assert.equal(readNoiseReport(null), undefined)
  assert.equal(readNoiseReport({ ...noisy, bursts: -1 }), undefined)
  assert.equal(readNoiseReport({ ...noisy, noisyMs: noisy.quietMs + 1 }), undefined)
  assert.equal(readNoiseReport({ ...noisy, analyzedMs: 'long' }), undefined)
  assert.equal(readNoiseReport({ ...noisy, noisyMs: 0, bursts: 0, snrDb: 40, verdict: 'noisy' }).verdict, 'quiet', 'the window cannot claim a noisy call')
  assert.equal(readNoiseReport({ ...noisy, floorDb: 'loud' }).floorDb, undefined)
  const text = describeNoise({ ...noisy, verdict: 'noisy' })
  assert.match(text, /2 min 42 s \(45% of the quiet time\)/)
  assert.match(text, /41 short sounds/)
  assert.match(text, /only 23 dB above the background/)
})

test('settings: Togle Microphone’s choices are checked, and the clean microphone’s old settings stay in the file for it', async () => {
  const file = path.join(work, 'settings.json')
  fs.writeFileSync(file, JSON.stringify({ cleanMic: { enabled: true, inputId: 'usb', airGate: true }, microphone: { suggestions: false, dismissals: 2 } }))
  await loadSettings()
  assert.equal(getSettings().cleanMic, undefined)
  assert.deepEqual(getSettings().microphone, { ...MICROPHONE_DEFAULTS, suggestions: false, dismissals: 2 })
  await updateSettings({ microphone: { autoStart: false, suggestedAt: 'now', dismissals: -1 } })
  assert.deepEqual(getSettings().microphone, { suggestions: false, autoStart: false, dismissals: 2 })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.cleanMic, { enabled: true, inputId: 'usb', airGate: true }, 'Togle Microphone imports these the first time it runs')
  assert.equal(saved.microphone.autoStart, false)
})
