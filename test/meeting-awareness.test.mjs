import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotWith, workDir } from './helpers.mjs'
workDir('meeting-awareness')
const { groupCue, introducedName, calendarMeetings, dueMeeting, CalendarReminders, VoiceClusters, voiceSimilarity, Copilot, AgentStore } = await import('./.build/togle.mjs')

test('group cues offer help without treating an ordinary one-to-one question as a group', () => {
  assert.equal(groupCue([{ text: 'Hi everyone, thanks for joining.' }]), true)
  assert.equal(groupCue([{ text: 'Let’s go around the room.' }]), true)
  assert.equal(groupCue([{ text: 'What do you think about this?' }]), false)
})

test('names come from introductions, not questions addressed to someone else', () => {
  assert.equal(introducedName('Hi, my name is Luka.'), 'Luka')
  assert.equal(introducedName("I'm Diana, from engineering."), 'Diana')
  assert.equal(introducedName('Luka, what do you think?'), undefined)
  assert.equal(introducedName("I'm Ready to show the demo."), undefined)
  assert.equal(introducedName("I'm tired after the release."), undefined)
  assert.equal(introducedName('My name is luka.'), 'Luka')
  assert.equal(introducedName('We spoke to Dana yesterday.'), undefined)
})

test('voice matching separates dissimilar voices and leaves ambiguous or invalid embeddings unknown', () => {
  const voices = new VoiceClusters()
  let at = 0
  const hear = vector => { at += 10000; return voices.observe({ id: String(at), at, end: at + 6500, embedding: new Float32Array(vector), seconds: 6.5, evidence: 2 }).at(-1)?.voice }
  assert.equal(hear([1, 0, 0]), 1)
  assert.equal(hear([0.98, 0.1, 0]), 1)
  assert.equal(hear([0, 1, 0]), 2)
  assert.equal(hear([0.7, 0.7, 0]), undefined)
  assert.equal(hear([0, 0, 0]), undefined)
  assert.equal(hear([NaN, 0, 0]), undefined)
  assert.equal(voiceSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0)
})

test('speaker names can arrive after transcription, be corrected, and survive restoration', async () => {
  const store = new AgentStore(async () => '')
  await store.load()
  const { copilot } = copilotWith(Copilot, store, store.list()[0].id, [])
  const now = Date.now()
  copilot.add('them', 'My name is Dana.', now, now + 2000, 'intro')
  copilot.identifyVoice('intro', 'voice:1')
  assert.equal(copilot.currentCall().transcript[0].voiceName, 'Dana')
  assert.equal(copilot.currentCall().transcript[0].voiceNamedBy, 'suggested')
  copilot.renameVoice('voice:1', 'Diana')
  copilot.identifyVoice('reply', 'voice:1')
  copilot.add('them', 'I will review the PR.', now + 3000, now + 4000, 'reply')
  assert.ok(copilot.currentCall().transcript.every(line => line.voiceName === 'Diana' && line.voiceNamedBy === 'user'))
  const restored = copilotWith(Copilot, store, store.list()[0].id, []).copilot
  restored.restore(copilot.callState())
  restored.identifyVoice('later', 'voice:1')
  restored.add('them', 'We can release tomorrow.', now + 5000, now + 6000, 'later')
  assert.equal(restored.currentCall().transcript.at(-1).voiceName, 'Diana')
  await restored.clear()
  assert.throws(() => restored.renameVoice('voice:1', 'Someone else'), /speaker/)
})

test('automatic changed-screen snapshots do not start background vision requests', async () => {
  const store = new AgentStore(async () => '')
  await store.load()
  const { copilot, inputs } = copilotWith(Copilot, store, store.list()[0].id, [])
  copilot.addFrame({ id: 'change', n: 1, at: Date.now(), kind: 'recorded', imageUrl: 'local:image', thumbUrl: 'local:thumb' }, false)
  assert.equal(copilot.currentCall().frames.length, 1)
  assert.deepEqual(copilot.callState().undescribed, [])
  assert.equal(inputs.length, 0)
})

test('calendar reminders normalize timezones, ignore cancelled/all-day/expired events and respect dismissal', () => {
  const now = Date.parse('2026-10-30T11:56:00+01:00')
  const valid = { id: 'team', title: 'Team meeting', start: '2026-10-30T12:00:00+01:00', end: '2026-10-30T13:00:00+01:00', attendees: 5 }
  const events = calendarMeetings([valid, { ...valid, id: 'cancelled', cancelled: true }, { ...valid, id: 'declined', declined: true }, { ...valid, id: 'all', allDay: true }, { ...valid, id: 'invalid', start: 'tomorrow' }], now)
  assert.equal(events.length, 1)
  assert.equal(events[0].start, Date.parse('2026-10-30T11:00:00Z'))
  assert.equal(dueMeeting(events, now, new Set()).id, 'team')
  assert.equal(dueMeeting(events, now, new Set(['team'])), undefined)
  assert.equal(dueMeeting(events, now - 10 * 60_000, new Set()), undefined)
  assert.equal(dueMeeting(events, Date.parse(valid.end), new Set()), undefined)
})

test('calendar access requires a calendar connector and does not call other work apps', async () => {
  let called = false
  const calendar = new CalendarReminders({ connections: async () => ({ account: 'work@example.test', apps: [{ name: 'claude.ai Slack', label: 'Slack', status: 'connected', readTools: 8 }] }), stream: async () => { called = true } }, () => true, () => false, () => {}, () => {})
  assert.equal((await calendar.refresh()).state, 'needs-connection')
  assert.equal(called, false)
  calendar.stop()
})

test('calendar reads stop at call start; a late response cannot resurrect cancelled reminders', async () => {
  let release, started, inCall = false
  const waiting = new Promise(resolve => { release = resolve })
  const ready = new Promise(resolve => { started = resolve })
  const calendar = new CalendarReminders({ connections: async () => ({ account: 'work@example.test', apps: [{ name: 'claude.ai Google Calendar', label: 'Google Calendar', status: 'connected', readTools: 3 }] }), stream: async (_input, output) => { started(); await waiting; output.onToolCall('claude_connection'); output.onDelta('[]') } }, () => true, () => inCall, () => {}, () => {})
  const read = calendar.refresh(); await ready
  inCall = true; calendar.clear(); release(); await read
  assert.equal(calendar.status().state, 'off')
  assert.deepEqual(calendar.status().events, [])
  await calendar.refresh()
  assert.equal(calendar.status().state, 'off')
  calendar.stop()
})

test('calendar never accepts a model-only answer without a real connector lookup', async () => {
  const calendar = new CalendarReminders({ connections: async () => ({ account: 'work@example.test', apps: [{ name: 'cal', label: 'Calendar', status: 'connected', readTools: 2 }] }), stream: async (_input, output) => output.onDelta('[]') }, () => true, () => false, () => {}, () => {})
  assert.equal((await calendar.refresh()).state, 'error')
  assert.match(calendar.status().error, /did not read/)
  calendar.stop()
})

test('calendar refresh rediscovers new authentication and parses only the final answer after tool commentary', async () => {
  const now = Date.parse('2026-10-30T11:56:00+01:00')
  const event = { id: 'team', title: 'Team meeting', start: '2026-10-30T12:00:00+01:00', end: '2026-10-30T13:00:00+01:00', attendees: 5 }
  let connected = false
  const alerts = []
  const refreshes = []
  const calendar = new CalendarReminders({
    connections: async refresh => {
      refreshes.push(refresh)
      return { account: 'work@example.test', apps: [{ name: 'claude.ai Google Calendar', label: 'Google Calendar', status: connected ? 'connected' : 'needs-auth', readTools: connected ? 5 : 0 }] }
    },
    stream: async (_input, output) => {
      output.onDelta('User gave a time range. I will check it. [not JSON]')
      output.onToolCall('claude_connection', { app: 'Google Calendar' })
      output.onDelta('```json\n' + JSON.stringify([event]) + '\n```')
      output.onFinal('```json\n' + JSON.stringify([event]) + '\n```')
    }
  }, () => true, () => false, () => {}, event => alerts.push(event), () => now)
  assert.equal((await calendar.refresh()).state, 'needs-connection')
  connected = true
  const status = await calendar.refresh()
  assert.equal(status.state, 'ready')
  assert.equal(status.events[0].title, 'Team meeting')
  assert.equal(status.events[0].start, Date.parse(event.start))
  assert.deepEqual(refreshes, [true, true])
  assert.deepEqual(alerts.map(event => event.id), ['team'])
  calendar.stop()
})
