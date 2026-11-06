import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'
const directory = workDir('speaker-handoffs')
globalThis.__dirname = import.meta.dirname
const { splitVoiceTurns, VoiceTracker, VoiceClusters } = await import('./.build/togle.mjs')
const basis = n => Float32Array.from({ length: 64 }, (_, i) => i === n ? 1 : 0)

test('twenty words followed by four words keep separate contiguous audio and exact timing', () => {
  const turns = splitVoiceTurns(7 * 16000, [{ speaker: 0, start: .1, end: 6 }, { speaker: 1, start: 6, end: 6.95 }])
  assert.deepEqual(turns, [{ from: 0, to: 96000, speaker: 0, overlap: false }, { from: 96000, to: 112000, speaker: 1, overlap: false }])
  assert.equal(turns.reduce((n, turn) => n + turn.to - turn.from, 0), 7 * 16000, 'no syllables are dropped or duplicated')
})

test('overlapping voices stay uncertain and A-B-A interruptions never become one speaker', () => {
  const turns = splitVoiceTurns(6 * 16000, [{ speaker: 1, start: 0, end: 6 }, { speaker: 2, start: 2, end: 3 }])
  assert.deepEqual(turns.map(turn => [turn.from / 16000, turn.to / 16000, turn.speaker, turn.overlap]), [[0, 2, 1, false], [2, 3, undefined, true], [3, 6, 1, false]])
  const sequential = splitVoiceTurns(6 * 16000, [{ speaker: 1, start: 0, end: 2 }, { speaker: 2, start: 2, end: 3 }, { speaker: 1, start: 3, end: 6 }])
  assert.deepEqual(sequential.map(turn => turn.speaker), [1, 2, 1])
  assert.deepEqual(splitVoiceTurns(6 * 16000, [{ speaker: 1, start: 0, end: 2 }, { speaker: 1, start: 2.2, end: 6 }]).map(turn => turn.speaker), [1], 'a pause in continuous speech is not another person')
})

test('a brief ambiguous reply cannot borrow the previous person’s label through continuity', () => {
  const voices = new VoiceClusters()
  voices.observe({ id: 'denis', at: 0, end: 7000, seconds: 7, evidence: 2, embedding: basis(0), clean: true })
  const uncertain = Float32Array.from({ length: 64 }, (_, i) => i === 0 ? .5 : i === 1 ? Math.sqrt(.75) : 0)
  assert.deepEqual(voices.observe({ id: 'roman-short', at: 7001, end: 8001, seconds: 1, embedding: uncertain, clean: true }), [])
})

test('the production tracker returns short handoff slices with their own known identities', async () => {
  process.env.TOGLE_SPEECH_HOME = path.join(directory, 'speech')
  const voices = path.join(process.env.TOGLE_SPEECH_HOME, 'voices'); fs.mkdirSync(voices, { recursive: true })
  for (const name of ['campplus-zh-en.onnx', 'segmentation-3.onnx']) fs.writeFileSync(path.join(voices, name), '')
  const original = electron.utilityProcess.fork, assignments = []
  const child = new EventEmitter(); child.postMessage = job => { child.latest = job }; child.kill = () => {}
  electron.utilityProcess.fork = () => child
  const tracker = new VoiceTracker((id, voice) => assignments.push({ id, voice }), () => {})
  const pcm = Float32Array.from({ length: 7 * 16000 }, (_, n) => Math.sin(n / 10) * .1)
  try {
    await tracker.start(); child.emit('message', { type: 'ready' })
    for (let person = 0; person < 4; person++) {
      const id = 'person-' + person
      tracker.hear(id, pcm, person * 8000)
      assert.ok(child.latest, JSON.stringify(tracker.status()))
      child.emit('message', { type: 'result', id, request: child.latest.request, embedding: basis(person), seconds: 7, evidence: 2, clean: true })
    }
    const known = assignments.slice()
    const pending = tracker.split('denis-then-roman', pcm, 40000)
    child.emit('message', { type: 'result', id: 'denis-then-roman', request: child.latest.request, turns: [
      { from: 0, to: 96000, embedding: basis(0), seconds: 6, evidence: 2, clean: true },
      { from: 96000, to: 112000, embedding: basis(1), seconds: 1, clean: true }
    ] })
    const slices = await pending
    assert.equal(slices.length, 2)
    assert.equal(assignments.find(item => item.id === slices[0].id).voice, known[0].voice)
    assert.equal(assignments.find(item => item.id === slices[1].id).voice, known[1].voice)
    assert.equal(new Set(assignments.map(item => item.voice)).size, 4)
    assert.ok(!assignments.some(item => item.id === 'denis-then-roman'))
    const late = tracker.split('cancelled', pcm, 50000)
    tracker.stop()
    assert.deepEqual(await late, [], 'stopping or muting releases waiting transcription immediately')
  } finally { tracker.stop(); electron.utilityProcess.fork = original; delete process.env.TOGLE_SPEECH_HOME }
})
