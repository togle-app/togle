import { createHash } from 'node:crypto'
import type { ScreenLookEvidence, ScreenTimeRequest } from '@shared/types'
import { SCREEN_HISTORY_MS, SCREEN_SAMPLE_MS } from '@shared/screen-time'

const MAX_SAMPLES = 256
const MAX_BYTES = 64 * 1024 * 1024
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const UPLOAD_BYTES = 6 * 1024 * 1024
const UPLOAD_FRAMES = 6
const MAX_OFFSET_MS = 1000
export interface ScreenSample { at: number; image: Buffer; hash: string }
export interface ScreenSelection { evidence: ScreenLookEvidence; frames: ScreenSample[] }

/** Time-indexed samples. Identical images share bytes while every observation retains its timestamp. */
export class ScreenBuffer {
  private frames: ScreenSample[] = []
  private images = new Map<string, { image: Buffer; uses: number }>()
  private bytes = 0

  clear(): void { this.frames = []; this.images.clear(); this.bytes = 0 }
  bounds(now?: number): { from?: number; to?: number } { if (now !== undefined) this.prune(now); return { from: this.frames[0]?.at, to: this.frames.at(-1)?.at } }

  private evict(): void {
    const old = this.frames.shift()!
    const entry = this.images.get(old.hash)!
    if (--entry.uses === 0) { this.bytes -= entry.image.byteLength; this.images.delete(old.hash) }
  }

  private prune(now: number): void {
    while (this.frames.length && this.frames[0].at < now - SCREEN_HISTORY_MS) this.evict()
  }

  add(at: number, image: Uint8Array, now: number): boolean {
    this.prune(now)
    if (!Number.isFinite(at) || at < now - SCREEN_HISTORY_MS || at > now + 2000 || !image?.byteLength || image.byteLength > MAX_FRAME_BYTES || (this.frames.length && at < this.frames.at(-1)!.at)) return false
    const hash = createHash('sha256').update(image).digest('hex')
    let stored = this.images.get(hash)
    if (!stored) { stored = { image: Buffer.from(image), uses: 0 }; this.images.set(hash, stored); this.bytes += image.byteLength }
    stored.uses++
    this.frames.push({ at, hash, image: stored.image })
    while (this.frames.length > MAX_SAMPLES || this.bytes > MAX_BYTES) this.evict()
    return true
  }

  select(requested: ScreenTimeRequest, now: number): ScreenSelection {
    this.prune(now)
    const evidence: ScreenLookEvidence = { requested: { ...requested }, capturedAt: [], gaps: [] }
    const missing = (message: string): ScreenSelection => { evidence.unavailable = message; return { evidence, frames: [] } }
    if (!['frame', 'range', 'live'].includes(requested.mode) || !Number.isFinite(new Date(requested.from).getTime()) || !Number.isFinite(new Date(requested.to).getTime()) || requested.from > requested.to || (requested.mode === 'frame' && requested.from !== requested.to)) return missing('Specify a valid recorded moment, or an interval with start before end.')
    const frames = this.frames.filter(frame => frame.at >= now - SCREEN_HISTORY_MS)
    const first = frames[0], latest = frames.at(-1)
    if (!first || !latest) return missing('No recorded screen samples are available for this source.')
    if (requested.mode === 'live') {
      if (latest.at < requested.from || now - latest.at > MAX_OFFSET_MS) return missing('No fresh screen sample arrived. Recorded history was not substituted for a live view.')
      evidence.capturedAt = [latest.at]
      evidence.availableSamples = 1
      return { evidence, frames: [latest] }
    }
    const bounds = `Available samples: ${new Date(first.at).toISOString()}–${new Date(latest.at).toISOString()}.`
    if (requested.from < first.at || requested.to > latest.at + MAX_OFFSET_MS || requested.to > now) return missing(`The requested time was not recorded or is outside the retained history. ${bounds} A current screenshot cannot replace it.`)
    const before = frames.findLast(frame => frame.at <= requested.from)
    if (!before || requested.from - before.at > MAX_OFFSET_MS) return missing(`No sample close enough to the requested start exists. ${bounds}`)
    const interval = [before, ...frames.filter(frame => frame.at > before.at && frame.at <= requested.to)]
    evidence.availableSamples = interval.length
    for (let index = 1; index < interval.length; index++) if (interval[index].at - interval[index - 1].at > SCREEN_SAMPLE_MS * 1.5) evidence.gaps.push({ from: interval[index - 1].at, to: interval[index].at })
    const last = interval.at(-1)!
    if (requested.to - last.at > SCREEN_SAMPLE_MS) evidence.gaps.push({ from: last.at, to: requested.to })
    if (requested.mode === 'frame') {
      evidence.capturedAt = [before.at]
      return { evidence, frames: [before] }
    }
    // Preserve both ends of the requested range and samples spread through it, never frames after its end.
    const selected = new Set<ScreenSample>()
    for (let index = 0; index < Math.min(UPLOAD_FRAMES, interval.length); index++) selected.add(interval[Math.round(index * (interval.length - 1) / Math.max(1, Math.min(UPLOAD_FRAMES, interval.length) - 1))])
    let bytes = 0
    const hashes = new Set<string>()
    const kept: ScreenSample[] = []
    // Prioritize endpoints if a large image exhausts the upload budget.
    for (const frame of [interval[0], last, ...selected]) {
      if (kept.includes(frame)) continue
      if (!hashes.has(frame.hash) && bytes + frame.image.byteLength > UPLOAD_BYTES) continue
      if (!hashes.has(frame.hash)) { bytes += frame.image.byteLength; hashes.add(frame.hash) }
      kept.push(frame)
    }
    kept.sort((a, b) => a.at - b.at)
    evidence.capturedAt = kept.map(frame => frame.at)
    if (!kept.includes(last)) evidence.gaps.push({ from: kept.at(-1)!.at, to: requested.to })
    return { evidence, frames: kept }
  }
}
