import assert from 'node:assert/strict'
import { test } from 'node:test'
const { normalizeVoice, cleanVoiceAudio, refineVoiceRegions, VoiceClusters } = await import('./.build/togle.mjs')
const pcm = (seconds = 4, level = .01, offset = 0) => Float32Array.from({ length: seconds * 16000 }, (_, index) => Math.sin(index * .1) * level + offset)

test('disconnected short replies recheck acoustics without splitting matching voices or inventing an identity', () => {
  const regions = [{ start: 0, end: 4, speaker: 0 }, { start: 4.2, end: 5, speaker: 0 }]
  const same = () => new Float32Array([1, 0])
  assert.deepEqual(refineVoiceRegions(pcm(5), regions, same), regions)
  assert.deepEqual(refineVoiceRegions(pcm(5), regions, () => undefined), regions)
  let n = 0
  const different = refineVoiceRegions(pcm(5), regions, () => new Float32Array(++n === 1 ? [1, 0] : [0, 1]))
  assert.equal(different[0].speaker, 0)
  assert.equal(different[1].speaker, 1)
  assert.deepEqual(regions.map(region => region.speaker), [0, 0], 'provider regions remain immutable')
})

test('quiet and loud versions of a voice normalize consistently without preserving DC offset', () => {
  const quiet = normalizeVoice(pcm(4, .002)), loud = normalizeVoice(pcm(4, .04, .1))
  assert.ok(quiet && loud)
  assert.ok(quiet.every((value, index) => Math.abs(value - loud[index]) < .00001))
  assert.equal(normalizeVoice(new Float32Array(48000)), undefined)
  assert.equal(normalizeVoice(new Float32Array(48000).fill(.1)), undefined)
  const corrupt = pcm(); corrupt[100] = NaN
  assert.equal(normalizeVoice(corrupt), undefined)
  assert.equal(normalizeVoice(pcm(.3)), undefined)
  assert.ok(normalizeVoice(pcm(4, 20)).every(value => Math.abs(value) <= .951), 'normalization never clips')
  assert.ok(normalizeVoice(pcm(4, .001)).every(value => Math.abs(value) <= .041), 'extreme quiet input has a bounded gain')
})

test('speaker-aware speech selection removes silence, deduplicates windows and preserves exact speech samples', () => {
  const samples = pcm(), result = cleanVoiceAudio(samples, [
    { speaker: 4, start: .5, end: 1.5 }, { speaker: 4, start: 1, end: 2 }, { speaker: 4, start: 3, end: 3.5 },
    { speaker: 4, start: NaN, end: 10 }, { speaker: 4, start: 8, end: 10 }
  ])
  assert.equal(result.seconds, 2)
  assert.equal(result.clean, true); assert.equal(result.mixed, false)
  assert.deepEqual(result.samples.subarray(0, 24000), samples.subarray(8000, 32000))
  assert.deepEqual(result.samples.subarray(24000), samples.subarray(48000, 56000))
})

test('sequential handoffs, overlap and A-B-A interruptions cannot be enrolled as one person', () => {
  for (const regions of [
    [{ speaker: 1, start: 0, end: 2 }, { speaker: 2, start: 2, end: 4 }],
    [{ speaker: 1, start: 0, end: 4 }, { speaker: 2, start: 1, end: 2 }],
    [{ speaker: 1, start: 0, end: 1 }, { speaker: 2, start: 1, end: 2 }, { speaker: 1, start: 2, end: 4 }]
  ]) {
    const result = cleanVoiceAudio(pcm(), regions)
    assert.equal(result.samples, undefined); assert.equal(result.mixed, true); assert.equal(result.clean, false)
  }
  const brief = cleanVoiceAudio(pcm(), [{ speaker: 1, start: 0, end: 4 }, { speaker: 2, start: 2, end: 2.3 }])
  assert.ok(brief.samples); assert.equal(brief.clean, false, 'a very short backchannel still prevents enrollment')
})

test('another remembered voice can veto a local match before that person has spoken in this call', () => {
  const voices = new VoiceClusters(), embedding = Float32Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0)
  const existing = voices.observe({ id: 'b', at: 0, end: 4000, seconds: 4, embedding, identity: 'person-b' })[0].voice
  const evidence = [{ identity: 'person-a', score: .69 }, { identity: 'person-b', score: .56 }]
  assert.equal(voices.preview(embedding, undefined, evidence), undefined)
  assert.deepEqual(voices.observe({ id: 'a-short', at: 4200, end: 5400, seconds: 1.2, embedding, identities: evidence }), [])
  const returning = voices.observe({ id: 'a-clear', at: 5600, end: 8600, seconds: 3, embedding, identity: 'person-a' }).at(-1).voice
  assert.notEqual(returning, existing, 'a familiar newcomer receives their own call identity')
})

test('brief interruptions and marginal matches cannot gradually overwrite a clean voice', () => {
  const voices = new VoiceClusters(), original = Float32Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0)
  const voice = voices.observe({ id: 'start', at: 0, end: 7000, seconds: 7, evidence: 2, embedding: original })[0].voice
  const before = voices.profile(voice)
  for (let n = 0; n < 20; n++) {
    const drift = Float32Array.from(original, (value, i) => value * .64 + (i === n + 1 ? Math.sqrt(1 - .64 ** 2) : 0))
    assert.equal(voices.observe({ id: 'weak-' + n, at: 8000 + n * 4000, end: 11000 + n * 4000, seconds: 3, embedding: drift }).at(-1)?.voice, voice)
  }
  voices.observe({ id: 'interruption', at: 90000, end: 95000, seconds: 5, clean: false, embedding: original })
  assert.deepEqual(voices.profile(voice), before)
})

test('a later clear turn can identify an earlier short reply without using that reply for training', () => {
  const voices = new VoiceClusters(), a = Float32Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0)
  assert.deepEqual(voices.observe({ id: 'yes', at: 0, end: 1000, seconds: 1, embedding: a }), [])
  assert.equal(voices.size, 0)
  const answers = voices.observe({ id: 'longer', at: 1200, end: 8200, seconds: 7, evidence: 2, embedding: a })
  assert.deepEqual(new Set(answers.map(answer => answer.id)), new Set(['yes', 'longer']))
  assert.equal(voices.profile(answers[0].voice).samples.length, 1)
  assert.equal(voices.profile(answers[0].voice).seconds, 7)
  const expired = new VoiceClusters()
  expired.observe({ id: 'old', at: 0, end: 1000, seconds: 1, embedding: a })
  assert.deepEqual(new Set(expired.observe({ id: 'late', at: 100000, end: 107000, seconds: 7, evidence: 2, embedding: a }).map(answer => answer.id)), new Set(['late', 'old']), 'a short reply remains eligible for confident backfill later in the same call')
})

test('an interrupted first sample can wait for confirmation but never becomes an enrollment reference', () => {
  const voices = new VoiceClusters(), a = Float32Array.from({ length: 64 }, (_, i) => i === 0 ? 1 : 0)
  assert.deepEqual(voices.observe({ id: 'uncertain', at: 0, end: 4000, seconds: 4, embedding: a, clean: false }), [])
  const answer = voices.observe({ id: 'clear', at: 5000, end: 8000, seconds: 3, embedding: a })
  assert.equal(answer.length, 2)
  const profile = voices.profile(answer[0].voice)
  assert.equal(profile.count, 1); assert.equal(profile.seconds, 3); assert.equal(profile.samples.length, 1)
})
