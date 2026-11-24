import assert from 'node:assert/strict'
import { test } from 'node:test'
const { AccessibleMeetings, meetingControls, DesktopMeetings } = await import('./.build/togle.mjs')

const button = (ref, name, ...groups) => ({ ref: BigInt(ref), name, groups: groups.map(BigInt) })
test('a participant mute button cannot verify the local microphone', () => {
  const leave = button(1, 'Leave meeting', 5)
  const participant = button(2, 'Mute', 6)
  assert.equal(meetingControls([leave, participant]).mic, 'unknown')
  assert.deepEqual(meetingControls([leave, participant, button(3, 'Unmute', 5)]), { joined: true, ended: false, mic: 'muted', toggle: 3n })
  assert.equal(meetingControls([leave, button(4, 'Mute my microphone'), button(5, 'Unmute my microphone')]).mic, 'unknown')
  assert.equal(meetingControls([leave, button(4, 'Mute (⌘⇧A)')]).mic, 'open')
  assert.equal(meetingControls([button(0, 'Join now'), button(4, 'Mute my microphone')]).joined, false)
})

function browser(os) {
  const nodes = new Map()
  const node = (ref, values) => { nodes.set(BigInt(ref), values); return BigInt(ref) }
  let watch, available = true
  const events = []
  const empty = () => {}
  const refs = new Map()
  const program = os === 'darwin' ? 'com.google.Chrome' : 'chromium'
  const ui = {
    applications: () => available ? [{ pid: 17133, program }] : undefined,
    windows: () => [1n],
    children: ref => nodes.get(ref).children ?? [],
    role: ref => nodes.get(ref).role,
    name: ref => nodes.get(ref).name ?? '',
    help: () => '',
    active: () => true,
    showing: () => true,
    selected: ref => nodes.get(ref).selected ?? false,
    enabled: () => true,
    address: ref => nodes.get(ref).address ?? '',
    same: (a, b) => a === b,
    retain: ref => refs.set(ref, (refs.get(ref) ?? 0) + 1),
    release: ref => refs.set(ref, refs.get(ref) - 1),
    clear: empty,
    unwatch: () => { watch = undefined },
    watch: (_app, _ref, changed) => { watch = changed; return true },
    pump: empty,
    dispose: empty
  }
  const read = new AccessibleMeetings(ui, os, observation => events.push(observation))
  const mic = node(9, { role: 'push button', name: 'Turn on microphone' })
  const leave = node(8, { role: 'push button', name: 'Join now' })
  const controls = node(7, { role: 'tool bar', children: [mic, leave] })
  const page = node(6, { role: 'document web', address: 'https://meet.google.com/abc-defg-hij?secret=token', children: [controls] })
  const selected = node(5, { role: 'page tab', selected: true, name: 'Private meeting' })
  const other = node(4, { role: 'page tab', selected: false, name: 'Other tab' })
  node(1, { role: 'frame', children: [selected, other, page] })
  return { read, events, refs, nodes, mic, leave, page, selected, other, unavailable: () => { available = false }, restored: () => { available = true }, change: () => watch?.() }
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform} observations keep the call through a tab switch or access loss, then end on departure`, () => {
    const { read, events, refs, nodes, mic, leave, page, selected, other, unavailable, restored, change } = browser(platform)
    read.read()
    assert.deepEqual(events, [], 'the lobby is not a call')
    nodes.get(leave).name = 'Leave call'
    read.read()
    assert.equal(events.at(-1).state, 'muted')
    assert.equal(events.at(-1).app, 'meet')
    const id = events.at(-1).id
    assert.match(id, /^[a-f0-9]{32}$/)
    assert.deepEqual(Object.keys(events[0]).sort(), ['app', 'id', 'state'])
    nodes.get(mic).name = 'Turn off microphone'
    change()
    assert.equal(events.at(-1).state, 'gap')
    read.read()
    assert.equal(events.at(-1).state, 'open')
    nodes.get(page).address = 'https://example.test/'
    nodes.get(selected).selected = false
    nodes.get(other).selected = true
    read.read()
    assert.equal(events.at(-1).state, 'unknown')
    unavailable()
    read.read()
    assert.equal(events.at(-1).state, 'unknown')
    restored()
    nodes.get(page).address = 'https://meet.google.com/abc-defg-hij?other=entry'
    nodes.get(selected).selected = true
    nodes.get(other).selected = false
    read.read()
    assert.equal(events.at(-1).state, 'open')
    nodes.get(leave).name = 'Rejoin'
    read.read()
    assert.deepEqual(events.at(-1), { id, app: 'meet', state: 'left' })
    assert.ok([...refs.values()].every(count => count === 0), 'retained accessibility elements are released')
  })
}

test('an accessibility worker restart seeing a different call does not end the active notes', () => {
  const updates = []
  const subject = new DesktopMeetings(() => {}, () => {}, state => updates.push(state))
  const id = 'a'.repeat(32)
  subject.observe({ id, app: 'teams', state: 'open' })
  subject.follow(id)
  subject.observe({ id: 'b'.repeat(32), app: 'zoom', state: 'open' })
  assert.equal(subject.capture.id, id)
  assert.equal(updates.at(-1).mic, 'unknown')
  assert.equal(updates.at(-1).ended, false)
})
