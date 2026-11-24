// Noticing a call that starts in another app: which programs use the microphone, and when to say so.
import assert from 'node:assert/strict'
import { test } from 'node:test'
const { parseMicrophoneUse, parseSourceOutputs, parseBrowserWindows, callAppsIn, CallDetector, browsersIn, parseWindowTitles, callSitesIn } = await import('./.build/togle.mjs')

const EPOCH = 11_644_473_600_000
const filetime = ms => '0x' + BigInt(Math.round((ms + EPOCH) * 10_000)).toString(16)
const KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
const block = (kind, name, start, stop) => `${KEY}\\${kind}\\${name}\r\n    Value    REG_SZ    Allow\r\n    LastUsedTimeStart    REG_QWORD    ${start}\r\n    LastUsedTimeStop    REG_QWORD    ${stop}\r\n\r\n`
const header = `${KEY}\r\n    Value    REG_SZ    Allow\r\n\r\n${KEY}\\NonPackaged\r\n    Value    REG_SZ    Allow\r\n\r\n`
const now = Date.UTC(2026, 10, 12, 10, 30)
const { DesktopMeetings } = await import('./.build/togle.mjs')
test('a desktop meeting starts once when joined muted, stays open across unknown controls and ends on departure', async () => {
  let at = 1000
  const starts = [], ends = [], updates = []
  const meet = new DesktopMeetings(id => starts.push(id), () => ends.push(at), state => updates.push(state), () => at)
  const id = 'a'.repeat(32), observe = state => meet.observe({ id, app: 'meet', state })
  observe('muted'); observe('muted')
  assert.deepEqual(starts, [id])
  assert.equal(meet.follow(id).mic, 'muted')
  assert.equal(await meet.allowsClip(1000, 1010), false)
  at = 1100; observe('open')
  const spoken = meet.allowsClip(1101, 1400)
  at = 1450; observe('open')
  assert.equal(await spoken, true)
  const straddlesMute = meet.allowsClip(1300, 1500)
  at = 1510; observe('muted')
  assert.equal(await straddlesMute, false)
  at = 1700; meet.uncertain()
  assert.equal(meet.capture.mic, 'unknown')
  assert.deepEqual(ends, [])
  at = 2000; observe('open')
  assert.equal(await meet.allowsClip(1400, 2100), false, 'preroll cannot reintroduce muted speech')
  at = 6000; meet.checkFresh()
  assert.equal(meet.capture.mic, 'unknown', 'a lost reader fails closed')
  observe('left'); observe('left')
  assert.equal(ends.length, 1)
  assert.equal(updates.filter(s => s.ended).length, 1)
  assert.throws(() => meet.follow(id), /ended/)
  observe('open')
  assert.equal(starts.length, 2, 'rejoining is offered again')
  assert.equal(meet.follow(false), null, 'a meeting in another app owns its own notes')
  assert.equal(await meet.allowsClip(1, 10), true)
})

test('manual notes can follow a newly discovered desktop call, and choosing a manual mic keeps that choice', () => {
  let at = 1000
  const starts = [], changes = [], ends = []
  const meet = new DesktopMeetings((_id, app) => starts.push(app), app => ends.push(app), state => changes.push(state), () => at)
  const first = '1'.repeat(32), second = '2'.repeat(32)
  meet.follow()
  assert.equal(meet.needsReader, true)
  at += 2400
  meet.observe({ id: first, app: 'other', state: 'muted' })
  assert.deepEqual(starts, [])
  assert.equal(changes.at(-1).mic, 'muted')
  meet.observe({ id: second, state: 'gap' })
  assert.equal(meet.capture.mic, 'muted', 'a different window has no say over this one')
  meet.observe({ id: first, state: 'left' })
  meet.observe({ id: first, state: 'gap' })
  assert.equal(meet.capture.ended, true)
  meet.follow(); meet.cancelPending()
  meet.observe({ id: second, app: 'teams', state: 'open' })
  assert.deepEqual(starts, ['teams'])
  assert.equal(meet.capture, undefined)
  meet.disabled()
  assert.equal(meet.app, undefined, 'disabling discovery withdraws the old call')
  assert.deepEqual(ends, ['other', 'teams'])
  assert.throws(() => meet.follow(second), /ended/)
})
const using = (name, since = now - 60_000, kind = 'NonPackaged') => block(kind, name, filetime(since), '0x0')
const stopped = (name, kind = 'NonPackaged') => block(kind, name, filetime(now - 3_600_000), filetime(now - 3_000_000))

test('the programs using the microphone are read from the registry listing', () => {
  const text = header
    + using('C:#Users#demo#AppData#Roaming#Zoom#bin#Zoom.exe', now - 90_000)
    + stopped('C:#Program Files#Google#Chrome#Application#chrome.exe')
    + using('MSTeams_8wekyb3d8bbwe', now - 30_000, 'Packaged')
    + block('NonPackaged', 'C:#Tools#never-used.exe', '0x0', '0x0')
  const found = parseMicrophoneUse(text)
  assert.deepEqual(found.map(item => item.name), ['C:#Users#demo#AppData#Roaming#Zoom#bin#Zoom.exe', 'MSTeams_8wekyb3d8bbwe'])
  assert.ok(Math.abs(found[0].since - (now - 90_000)) < 1, 'when it began, in epoch milliseconds')
  assert.deepEqual(parseMicrophoneUse(''), [])
  assert.deepEqual(parseMicrophoneUse('ERROR: The system was unable to find the specified registry key or value.'), [])
})

test('only call apps count, once each, and a browser or Togle itself does not', () => {
  const found = callAppsIn(parseMicrophoneUse(header
    + using('C:#Program Files#Zoom#bin#Zoom.exe', now - 50_000)
    + using('C:#Program Files#Zoom#bin#Zoom.exe', now - 80_000)
    + using('MSTeams_8wekyb3d8bbwe', now - 20_000, 'Packaged')
    + using('C:#Users#demo#AppData#Local#slack#slack.exe')
    + using('C:#Program Files#Google#Chrome#Application#chrome.exe')
    + using('C:#Users#demo#AppData#Local#Programs#Togle#Togle.exe')
    + using('C:#Program Files#Discord#Discord.exe')
    + using('C:#Program Files#Cisco Spark#CiscoCollabHost.exe')
    + using('Microsoft.SkypeApp_kzf8qxf38zg5c', now - 10_000, 'Packaged')))
  assert.deepEqual(found.map(item => item.app).sort(), ['discord', 'skype', 'slack', 'teams', 'webex', 'zoom'])
  assert.ok(Math.abs(found.find(item => item.app === 'zoom').since - (now - 80_000)) < 1, 'the earliest start')
  assert.deepEqual(callAppsIn([]), [])
})

function detector(listing, running = () => true, active = () => true) {
  const calls = { started: [], ended: [] }
  const state = { listing, now }
  const subject = new CallDetector({
    read: async () => parseMicrophoneUse(state.listing),
    running: async app => running(app),
    active,
    onStart: app => calls.started.push(app),
    onEnd: app => calls.ended.push(app),
    now: () => state.now
  })
  return { subject, calls, state }
}

test('a call is said once when its app keeps using the microphone, and again for the next call', async () => {
  const zoom = header + using('C:#Program Files#Zoom#bin#Zoom.exe')
  const { subject, calls, state } = detector(zoom)
  await subject.poll()
  assert.deepEqual(calls.started, [], 'one look is a mute or a test of the microphone')
  await subject.poll()
  assert.deepEqual(calls.started, ['zoom'])
  await subject.poll(); await subject.poll()
  assert.deepEqual(calls.started, ['zoom'], 'once for the call')
  state.listing = header + stopped('C:#Program Files#Zoom#bin#Zoom.exe')
  await subject.poll()
  assert.deepEqual(calls.ended, ['zoom'])
  state.listing = zoom
  await subject.poll(); await subject.poll()
  assert.deepEqual(calls.started, ['zoom', 'zoom'], 'the next call is said too')
})

test('nothing is said while a call is being written down or when the person turned it off, or for a program that is gone', async () => {
  const zoom = header + using('C:#Program Files#Zoom#bin#Zoom.exe')
  let active = false
  const off = detector(zoom, () => true, () => active)
  await off.subject.poll(); await off.subject.poll(); await off.subject.poll()
  assert.deepEqual(off.calls.started, [], 'not active')
  active = true
  await off.subject.poll(); await off.subject.poll(); await off.subject.poll()
  assert.deepEqual(off.calls.started, [], 'a call that was already going when it looks again is not a new call')
  off.state.listing = header + stopped('C:#Program Files#Zoom#bin#Zoom.exe')
  await off.subject.poll()
  off.state.listing = zoom
  await off.subject.poll(); await off.subject.poll()
  assert.deepEqual(off.calls.started, ['zoom'], 'the next call is')
  const gone = detector(zoom, () => false)
  await gone.subject.poll(); await gone.subject.poll(); await gone.subject.poll()
  assert.deepEqual(gone.calls.started, [], 'a leftover of a program that crashed is not a call')
})

test('a call written down is not announced again when it ends, and the next call in the same app is', async () => {
  const zoom = header + using('C:#Program Files#Zoom#bin#Zoom.exe')
  let writing = false
  const { subject, calls, state } = detector(zoom, () => true, () => !writing)
  await subject.poll(); await subject.poll()
  assert.deepEqual(calls.started, ['zoom'])
  // The call is written down; the person hangs up in Zoom first, and then presses Stop.
  writing = true
  await subject.poll()
  state.listing = header + stopped('C:#Program Files#Zoom#bin#Zoom.exe')
  await subject.poll()
  writing = false
  await subject.poll()
  assert.deepEqual(calls.ended, ['zoom'], 'the end of the call is seen')
  state.listing = zoom
  await subject.poll(); await subject.poll()
  assert.deepEqual(calls.started, ['zoom', 'zoom'], 'the second call is noticed')
  // Stop pressed while the app still holds the microphone: that call is not announced as a new one.
  const held = detector(zoom, () => true, () => !held.writing)
  held.writing = false
  await held.subject.poll(); await held.subject.poll()
  assert.deepEqual(held.calls.started, ['zoom'])
  held.writing = true
  await held.subject.poll()
  held.writing = false
  await held.subject.poll(); await held.subject.poll(); await held.subject.poll()
  assert.deepEqual(held.calls.started, ['zoom'], 'pressing Stop does not start another call while the app is still in the call')
})

test('a call in a browser is told by its window title: Meet, and the web versions of the other apps', async () => {
  // tasklist /v /fo csv /nh: the last field is the title of the process's window, or N/A.
  const csv = [
    '"chrome.exe","4120","Console","1","312,000 K","Running","PC\\demo","0:02:10","Meet - abc-defg-hij - Google Chrome"',
    '"chrome.exe","4188","Console","1","51,000 K","Unknown","PC\\demo","0:00:01","N/A"',
    '"chrome.exe","5000","Console","1","90,000 K","Running","PC\\demo","0:00:03","Notes ""draft"" - Google Docs - Google Chrome"'
  ].join('\r\n')
  assert.deepEqual(parseWindowTitles(csv), ['Meet - abc-defg-hij - Google Chrome', 'Notes "draft" - Google Docs - Google Chrome'])
  assert.deepEqual(parseWindowTitles(''), [])
  assert.deepEqual(callSitesIn(['Meet – Weekly sync - Google Chrome']), ['meet'])
  assert.deepEqual(callSitesIn(['Google Meet - Microsoft Edge']), ['meet'])
  assert.deepEqual(callSitesIn(['Calendar | Microsoft Teams - Google Chrome']), ['teams'])
  assert.deepEqual(callSitesIn(['Zoom Meeting - Google Chrome']), ['zoom'])
  assert.deepEqual(callSitesIn(['Meeting notes - Google Docs', 'How to zoom in on a photo', 'Inbox - Gmail', 'Meetup events']), [], 'words that only look alike are not calls')
  assert.deepEqual(browsersIn(parseMicrophoneUse(header + using('C:#Program Files#Google#Chrome#Application#chrome.exe') + using('C:#Program Files#Zoom#bin#Zoom.exe'))).map(item => item.program), ['chrome.exe'])

  // The detector reads a browser's titles only while it uses the microphone.
  const asked = [], started = []
  const state = { listing: header + using('C:#Program Files#Google#Chrome#Application#chrome.exe'), titles: ['Meet - abc-defg-hij - Google Chrome'] }
  const subject = new CallDetector({ read: async () => parseMicrophoneUse(state.listing), running: async () => false, titles: async program => { asked.push(program); return state.titles }, active: () => true, onStart: app => started.push(app), now: () => now })
  await subject.poll(); await subject.poll()
  assert.deepEqual(started, ['meet'], 'a browser window with a call in it is a call: there is no program of its own to check')
  assert.deepEqual(asked, ['chrome.exe', 'chrome.exe'])
  state.titles = ['Inbox - Gmail - Google Chrome']
  await subject.poll()
  state.titles = ['Meet - abc-defg-hij - Google Chrome']
  await subject.poll(); await subject.poll()
  assert.deepEqual(started, ['meet', 'meet'], 'leaving the call and joining another is a new call')
  state.listing = header + stopped('C:#Program Files#Google#Chrome#Application#chrome.exe')
  asked.length = 0
  await subject.poll()
  assert.deepEqual(asked, [], 'a browser that does not use the microphone is not looked at')
})

test('a program that has used the microphone for hours before Togle looked is a leftover, one that began just now is a call', async () => {
  const old = detector(header + using('C:#Program Files#Zoom#bin#Zoom.exe', now - 7 * 3_600_000))
  await old.subject.poll(); await old.subject.poll(); await old.subject.poll()
  assert.deepEqual(old.calls.started, [])
  const recent = detector(header + using('C:#Program Files#Zoom#bin#Zoom.exe', now - 20 * 60_000))
  await recent.subject.poll(); await recent.subject.poll()
  assert.deepEqual(recent.calls.started, ['zoom'], 'a call under way as Togle started is said')
})

// ---- Linux: what PulseAudio or PipeWire lists as recording ----

/** One stream as `pactl list source-outputs` prints it in the C locale. */
const sourceOutput = (index, properties) => `Source Output #${index}
	Driver: protocol-native.c
	Owner Module: 10
	Client: ${index + 20}
	Source: 1
	Sample Specification: float32le 1ch 48000Hz
	Channel Map: mono
	Format: pcm, format.sample_format = "\\"float32le\\""  format.rate = "48000"  format.channels = "1"  format.channel_map = "\\"mono\\""
	Corked: no
	Mute: no
	Volume: mono: 65536 / 100% / 0.00 dB
	        balance 0.00
	Buffer Latency: 0 usec
	Source Latency: 0 usec
	Resample method: n/a
	Properties:
${Object.entries(properties).map(([key, value]) => `		${key} = "${value}"`).join('\n')}
		native-protocol.peer = "UNIX socket client"
		module-stream-restore.id = "source-output-by-application-name:${properties['application.name'] ?? ''}"

`

test('on Linux, the programs recording are read from what PulseAudio or PipeWire lists, by their file name', () => {
  const text = sourceOutput(42, { 'media.name': 'RecordStream', 'application.name': 'ZOOM VoiceEngine', 'application.process.id': '4242', 'application.process.binary': 'zoom' })
    + sourceOutput(43, { 'media.name': 'RecordStream', 'application.name': 'Google Chrome', 'application.process.binary': 'chrome' })
    + sourceOutput(44, { 'media.name': 'Togle', 'application.name': 'Togle', 'application.process.binary': 'togle' })
    + sourceOutput(45, { 'media.name': 'Capture', 'application.name': 'Slack' })
  const found = parseSourceOutputs(text, now)
  assert.deepEqual(found.map(item => item.name), ['zoom', 'chrome', 'togle', 'Slack'], 'by the file name, else by the name it gives itself')
  assert.ok(found.every(item => item.since === now), 'nothing says when a stream began: it counts from when it is seen')
  assert.deepEqual(parseSourceOutputs('', now), [])
  assert.deepEqual(parseSourceOutputs('Connection failure: Connection refused\npa_context_connect() failed: Connection refused', now), [])
  assert.deepEqual(callAppsIn(found).map(item => item.app).sort(), ['slack', 'zoom'])
  assert.deepEqual(browsersIn(found).map(item => item.program), ['chrome'])
})

test("Linux programs match only Linux names, and Windows names only Windows'", () => {
  const linux = ['zoom', 'ZoomWebviewHost', 'teams-for-linux', 'CiscoCollabHost', 'skypeforlinux', 'slack'].map(name => ({ name, since: now }))
  assert.deepEqual(callAppsIn(linux).map(item => item.app).sort(), ['skype', 'slack', 'teams', 'webex', 'zoom'])
  assert.deepEqual(callAppsIn(['zoomer', 'slack-helper', 'my-teams', 'discord-music'].map(name => ({ name, since: now }))), [], 'names that only start or end alike are not those apps')
  assert.deepEqual(browsersIn(['firefox', 'google-chrome-stable', 'chromium-browser', 'brave', 'firefoxish'].map(name => ({ name, since: now }))).map(item => item.program), ['firefox', 'google-chrome-stable', 'chromium-browser', 'brave'])
})

test("on Linux, a browser's windows are read from wmctrl: their titles tell a call in it", async () => {
  const listing = [
    '0x03c00003  0 Navigator.firefox     pc Meet - abc-defg-hij — Mozilla Firefox',
    '0x04400007  0 google-chrome.Google-chrome  pc Inbox - Gmail - Google Chrome',
    '0x02200004 -1 gnome-shell.Gnome-shell  pc gnome-shell',
    '0x05000001  1 org.gnome.Nautilus.Org.gnome.Nautilus  pc Meet - Files',
    'not a window line'
  ].join('\n')
  const titles = parseBrowserWindows(listing)
  assert.deepEqual(titles, ['Meet - abc-defg-hij — Mozilla Firefox', 'Inbox - Gmail - Google Chrome'], 'only the browsers\' windows')
  assert.deepEqual(callSitesIn(titles), ['meet'])
  // The detector with them: a browser recording, with a call in one of its windows.
  const started = []
  const subject = new CallDetector({ read: async () => [{ name: 'firefox', since: now }], running: async () => false, titles: async () => titles, active: () => true, onStart: app => started.push(app), now: () => now })
  await subject.poll(); await subject.poll()
  assert.deepEqual(started, ['meet'])
})

test('a Mac: call apps and browsers are told by the bundle id Core Audio gives the process that records', async () => {
  const { macBrowserOf, fourCharCode } = await import('./.build/togle.mjs')
  // The codes Core Audio's process list is asked by.
  assert.equal(fourCharCode('prs#'), 0x70727323)
  assert.equal(fourCharCode('piri'), 0x70697269)
  assert.equal(fourCharCode('glob'), 0x676c6f62)
  const seen = (name) => ({ name, since: now })
  assert.deepEqual(callAppsIn([seen('us.zoom.xos'), seen('com.microsoft.teams2'), seen('Cisco-Systems.Spark'), seen('com.tinyspeck.slackmacgap.helper')]).map(found => found.app),
    ['zoom', 'teams', 'webex', 'slack'])
  assert.deepEqual(callAppsIn([seen('com.apple.Music'), seen('com.google.Chrome.helper')]), [], 'neither is a call app')
  assert.equal(macBrowserOf('com.google.Chrome.helper'), 'chrome')
  assert.equal(macBrowserOf('com.apple.WebKit.GPU'), 'safari', "Safari records through WebKit's helper")
  assert.equal(macBrowserOf('company.thebrowser.Browser'), 'arc')
  assert.equal(macBrowserOf('com.microsoft.teams2'), undefined)
  assert.deepEqual(browsersIn([seen('com.google.Chrome.helper'), seen('us.zoom.xos')]), [{ program: 'chrome', since: now }])
})
