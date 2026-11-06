import { voiceSimilarity } from './voice-clusters'

export interface VoiceRegion { start: number; end: number; speaker: number }
export interface VoiceTurn { from: number; to: number; speaker?: number; overlap: boolean }
const RATE = 16000

/** Short, disconnected replies can be merged by clip-level clustering. Recheck their actual acoustics. */
export function refineVoiceRegions(audio: Float32Array, regions: VoiceRegion[], embed: (samples: Float32Array) => Float32Array | undefined): VoiceRegion[] {
  const assigned = new Map<VoiceRegion, number>()
  let next = Math.max(0, ...regions.map(region => region.speaker)) + 1
  for (const speaker of new Set(regions.map(region => region.speaker))) {
    const islands = regions.filter(region => region.speaker === speaker && region.end - region.start >= .7).sort((a, b) => b.end - b.start - (a.end - a.start))
    if (islands.length < 2) continue
    const references: { speaker: number; embedding: Float32Array }[] = []
    for (const region of islands) {
      const from = Math.max(0, Math.round(region.start * RATE)), to = Math.min(audio.length, Math.round(region.end * RATE))
      const vector = embed(audio.subarray(from, to))
      if (!vector) continue
      const ranked = references.map(reference => ({ ...reference, score: voiceSimilarity(reference.embedding, vector) })).sort((a, b) => b.score - a.score)
      const label = !ranked.length ? speaker : ranked[0].score < .45 ? next++ : ranked[0].speaker
      assigned.set(region, label)
      references.push({ speaker: label, embedding: vector })
    }
  }
  return regions.map(region => assigned.has(region) ? { ...region, speaker: assigned.get(region)! } : region)
}

/** Diarization timestamps become lossless audio slices, not a majority-speaker label for the whole clip. */
export function splitVoiceTurns(samples: number, regions: VoiceRegion[]): VoiceTurn[] {
  const events = new Map<number, { speaker: number; delta: number }[]>()
  for (const region of regions) {
    if (!Number.isFinite(region.start) || !Number.isFinite(region.end) || !Number.isInteger(region.speaker)) continue
    const from = Math.max(0, Math.min(samples, Math.round(region.start * RATE))), to = Math.max(0, Math.min(samples, Math.round(region.end * RATE)))
    if (to <= from) continue
    events.set(from, [...events.get(from) ?? [], { speaker: region.speaker, delta: 1 }])
    events.set(to, [...events.get(to) ?? [], { speaker: region.speaker, delta: -1 }])
  }
  const points = [...new Set([0, samples, ...events.keys()])].sort((a, b) => a - b), active = new Map<number, number>(), spans: VoiceTurn[] = []
  for (let n = 0; n < points.length - 1; n++) {
    for (const event of events.get(points[n]) ?? []) active.set(event.speaker, (active.get(event.speaker) ?? 0) + event.delta)
    const speakers = [...active].filter(([, count]) => count > 0).map(([speaker]) => speaker)
    spans.push({ from: points[n], to: points[n + 1], speaker: speakers.length === 1 ? speakers[0] : undefined, overlap: speakers.length > 1 })
  }
  const filled: VoiceTurn[] = []
  for (let n = 0; n < spans.length; n++) {
    const span = spans[n]
    if (span.speaker !== undefined || span.overlap) { filled.push(span); continue }
    const previous = spans.slice(0, n).findLast(item => item.speaker !== undefined), next = spans.slice(n + 1).find(item => item.speaker !== undefined)
    if (previous && next && previous.speaker !== next.speaker) {
      const middle = Math.max(span.from, span.to - Math.round(.08 * RATE))
      filled.push({ ...span, to: middle, speaker: previous.speaker }, { ...span, from: middle, speaker: next.speaker })
    } else filled.push({ ...span, speaker: previous?.speaker ?? next?.speaker })
  }
  const turns: VoiceTurn[] = []
  for (const span of filled) {
    if (span.to <= span.from) continue
    const previous = turns.at(-1)
    if (previous && previous.to === span.from && previous.speaker === span.speaker && previous.overlap === span.overlap) previous.to = span.to
    else turns.push({ ...span })
  }
  return turns
}

/** Remove DC offset and lift quiet voices without amplifying digital silence or clipping. */
export function normalizeVoice(pcm: Float32Array): Float32Array | undefined {
  if (pcm.length < .7 * RATE || pcm.length > 30 * RATE) return
  let sum = 0
  for (const sample of pcm) { if (!Number.isFinite(sample)) return; sum += sample }
  const mean = sum / pcm.length
  let energy = 0, peak = 0
  for (const sample of pcm) { const value = sample - mean; energy += value * value; peak = Math.max(peak, Math.abs(value)) }
  const rms = Math.sqrt(energy / pcm.length)
  if (rms < .00015) return
  const gain = Math.min(40, .04 / rms, .95 / peak)
  return Float32Array.from(pcm, sample => (sample - mean) * gain)
}

/** Use speech from one actual voice, not room noise or a mean of different people's voices. */
export function cleanVoiceAudio(pcm: Float32Array, regions: VoiceRegion[]): { samples?: Float32Array; seconds: number; clean: boolean; mixed: boolean } {
  const valid = regions.filter(region => Number.isFinite(region.start) && Number.isFinite(region.end) && Number.isInteger(region.speaker) && region.end > region.start && region.end > 0 && region.start < pcm.length / RATE)
    .map(region => ({ ...region, start: Math.max(0, Math.floor(region.start * RATE)), end: Math.min(pcm.length, Math.ceil(region.end * RATE)) })).sort((a, b) => a.start - b.start)
  const by = new Map<number, { start: number; end: number }[]>()
  for (const region of valid) {
    const spans = by.get(region.speaker) ?? [], previous = spans.at(-1)
    if (previous && region.start <= previous.end) previous.end = Math.max(previous.end, region.end)
    else spans.push({ start: region.start, end: region.end })
    by.set(region.speaker, spans)
  }
  const ranked = [...by].map(([speaker, spans]) => ({ speaker, spans, count: spans.reduce((total, span) => total + span.end - span.start, 0) })).sort((a, b) => b.count - a.count)
  const best = ranked[0], seconds = (best?.count ?? 0) / RATE, mixed = (ranked[1]?.count ?? 0) / RATE >= .45
  const clean = ranked.length === 1
  if (!best || seconds < .7 || mixed) return { seconds, clean: false, mixed }
  const samples = new Float32Array(best.count)
  let at = 0
  for (const span of best.spans) { samples.set(pcm.subarray(span.start, span.end), at); at += span.end - span.start }
  return { samples, seconds, clean, mixed }
}
