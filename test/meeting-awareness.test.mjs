import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ongoingCall, workDir } from './helpers.mjs'
workDir('meeting-awareness')
const { introducedName, VoiceClusters, voiceSimilarity, OngoingCall, AgentStore } = await import('./.build/togle.mjs')

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
  const { ongoing } = ongoingCall(OngoingCall)
  const now = Date.now()
  ongoing.add('them', 'My name is Dana.', now, now + 2000, 'intro')
  ongoing.identifyVoice('intro', 'voice:1')
  assert.equal(ongoing.current().transcript[0].voiceName, 'Dana')
  assert.equal(ongoing.current().transcript[0].voiceNamedBy, 'suggested')
  ongoing.renameVoice('voice:1', 'Diana')
  ongoing.identifyVoice('reply', 'voice:1')
  ongoing.add('them', 'I will review the PR.', now + 3000, now + 4000, 'reply')
  assert.ok(ongoing.current().transcript.every(line => line.voiceName === 'Diana' && line.voiceNamedBy === 'user'))
  const restored = ongoingCall(OngoingCall).ongoing
  restored.restore(ongoing.callState())
  restored.identifyVoice('later', 'voice:1')
  restored.add('them', 'We can release tomorrow.', now + 5000, now + 6000, 'later')
  assert.equal(restored.current().transcript.at(-1).voiceName, 'Diana')
  await restored.clear()
  assert.throws(() => restored.renameVoice('voice:1', 'Someone else'), /speaker/)
})
