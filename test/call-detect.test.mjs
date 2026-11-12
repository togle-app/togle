// Noticing a call that starts in another app: which programs use the microphone, and when to say so.
import assert from 'node:assert/strict'
import { test } from 'node:test'
const { parseMicrophoneUse, callAppsIn, CallDetector } = await import('./.build/togle.mjs')

const EPOCH = 11_644_473_600_000
const filetime = ms => '0x' + BigInt(Math.round((ms + EPOCH) * 10_000)).toString(16)
const KEY = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
const block = (kind, name, start, stop) => `${KEY}\\${kind}\\${name}\r\n    Value    REG_SZ    Allow\r\n    LastUsedTimeStart    REG_QWORD    ${start}\r\n    LastUsedTimeStop    REG_QWORD    ${stop}\r\n\r\n`
const header = `${KEY}\r\n    Value    REG_SZ    Allow\r\n\r\n${KEY}\\NonPackaged\r\n    Value    REG_SZ    Allow\r\n\r\n`
const now = Date.UTC(2026, 10, 12, 10, 30)
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
  assert.deepEqual(found.map(item => item.app).sort(), ['skype', 'slack', 'teams', 'webex', 'zoom'])
  assert.ok(Math.abs(found.find(item => item.app === 'zoom').since - (now - 80_000)) < 1, 'the earliest start')
  assert.deepEqual(callAppsIn([]), [])
})

function detector(listing, running = () => true, active = () => true) {
  const calls = { started: [], ended: [] }
  const state = { listing, now }
  const subject = new CallDetector({
    read: async () => state.listing,
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
  await off.subject.poll()
  assert.deepEqual(off.calls.started, [], 'the looks start again when it is active again')
  await off.subject.poll()
  assert.deepEqual(off.calls.started, ['zoom'])
  const gone = detector(zoom, () => false)
  await gone.subject.poll(); await gone.subject.poll(); await gone.subject.poll()
  assert.deepEqual(gone.calls.started, [], 'a leftover of a program that crashed is not a call')
})

test('a program that has used the microphone for hours before Togle looked is a leftover, one that began just now is a call', async () => {
  const old = detector(header + using('C:#Program Files#Zoom#bin#Zoom.exe', now - 7 * 3_600_000))
  await old.subject.poll(); await old.subject.poll(); await old.subject.poll()
  assert.deepEqual(old.calls.started, [])
  const recent = detector(header + using('C:#Program Files#Zoom#bin#Zoom.exe', now - 20 * 60_000))
  await recent.subject.poll(); await recent.subject.poll()
  assert.deepEqual(recent.calls.started, ['zoom'], 'a call under way as Togle started is said')
})
