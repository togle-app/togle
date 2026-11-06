// The renderer's voice activity detection, fed synthetic audio frame by frame (32 ms each).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { Segmenter } = await import('./.build/capture.mjs')

const FRAME = 512
const FRAME_MS = 32
const tone = (amplitude) => Float32Array.from({ length: FRAME }, (_, i) => amplitude * Math.sin(i / 3))
const SOUND = {
  speech: () => tone(0.1),
  // Speech keeps dipping a little between syllables (a level that never dips is a fan, not a voice).
  dip: () => tone(0.007),
  silence: () => new Float32Array(FRAME)
}

/** Feeds [kind, frames] steps; returns what the segmenter reported and at which frame. */
function feed(steps) {
  const events = []
  let frame = 0
  const segmenter = new Segmenter((_pcm, _at, _id, kind) => events.push({ kind, frame }), true)
  for (const [kind, count] of steps) {
    for (let i = 0; i < count; i++) {
      frame++
      segmenter.push(SOUND[kind]())
    }
  }
  return events
}

const speech = (seconds) =>
  Array.from({ length: Math.round((seconds * 1000) / FRAME_MS / 16) }, () => [
    ['speech', 15],
    ['dip', 1]
  ]).flat()

test('a pause is reported 256 ms after they stop, the end of the utterance at 608 ms', () => {
  const events = feed([
    ['silence', 20],
    ['speech', 40],
    ['silence', 30]
  ])
  assert.deepEqual(
    events.map((e) => e.kind),
    ['pause', 'final']
  )
  const lastSpeech = 60
  assert.equal((events[0].frame - lastSpeech) * FRAME_MS, 256)
  assert.equal((events[1].frame - lastSpeech) * FRAME_MS, 608)
})

test('talking again after a pause sends a caption at once; the next pause and the end follow', () => {
  const events = feed([
    ['silence', 20],
    ['speech', 40],
    ['silence', 10],
    ['speech', 20],
    ['silence', 30]
  ])
  assert.deepEqual(
    events.map((e) => e.kind),
    ['pause', 'partial', 'pause', 'final']
  )
  assert.equal(events[1].frame, 71, 'on the first frame of speech after the pause')
})

test('past 15 seconds the utterance ends at 256 ms of quiet, with no separate pause', () => {
  const events = feed([['silence', 20], ...speech(16), ['silence', 30]])
  assert.deepEqual(
    events.map((e) => e.kind),
    ['final']
  )
})

test('my own voice gets no pauses or captions, only finished utterances', () => {
  const events = []
  const segmenter = new Segmenter((_pcm, _at, _id, kind) => events.push(kind), false)
  for (const [kind, count] of [
    ['silence', 20],
    ['speech', 40],
    ['silence', 10],
    ['speech', 20],
    ['silence', 30]
  ]) {
    for (let i = 0; i < count; i++) segmenter.push(SOUND[kind]())
  }
  assert.deepEqual(events, ['final'])
})
