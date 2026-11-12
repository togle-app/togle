import { app } from 'electron'
import { promises as fs, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { readSecret, writeSecret } from './storage'

const RATE = 16000
const FOLDER = 'confirm-sound'
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,100}$/.test(id) && id !== 'index'
const safeClip = (name: unknown): name is string => typeof name === 'string' && /^v\d{1,2}$/.test(name)

interface Stored { rate: number; pcm16: string }

/**
 * The one short clip kept of each voice of a call, so the person can hear who spoke when they confirm the names. It is
 * the only sound Togle keeps of a call: encrypted on this computer, and deleted when the names are confirmed, when the
 * person skips them, or the next day at the latest. A voice profile is never made from it.
 */
export class ConfirmSound {
  /** Keeps these clips of a call, in place of any kept before. */
  async save(callId: string, clips: { name: string; pcm: Float32Array }[]): Promise<void> {
    if (!safeId(callId)) throw new Error('No such call.')
    await this.remove(callId)
    for (const clip of clips) {
      if (!safeClip(clip.name)) continue
      const pcm = Buffer.alloc(clip.pcm.length * 2)
      for (let i = 0; i < clip.pcm.length; i++) {
        const sample = Math.max(-1, Math.min(1, clip.pcm[i]))
        pcm.writeInt16LE(Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), i * 2)
      }
      await writeSecret(`${FOLDER}/${callId}/${clip.name}.bin`, { rate: RATE, pcm16: pcm.toString('base64') } satisfies Stored)
    }
  }

  /** A kept clip as samples at 16 kHz, or null when there is none (never kept, or deleted). */
  async pcm(callId: string, name: string): Promise<Float32Array | null> {
    if (!safeId(callId) || !safeClip(name)) return null
    const stored = await readSecret<Stored>(`${FOLDER}/${callId}/${name}.bin`)
    if (!stored || typeof stored.pcm16 !== 'string' || stored.rate !== RATE) return null
    const bytes = Buffer.from(stored.pcm16, 'base64')
    const pcm = new Float32Array(bytes.length >> 1)
    for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2) / 0x8000
    return pcm
  }

  /** Deletes every clip of a call. */
  async remove(callId: string): Promise<void> {
    if (!safeId(callId)) return
    await writeSecret(`${FOLDER}/${callId}`, null)
  }

  /**
   * Deletes the clips of every call `keep` does not say to keep: ones that were answered, expired, or deleted. Clips
   * written within `grace` are left: the call's record may not say it keeps them yet.
   */
  async sweep(keep: (callId: string) => boolean, grace = 10 * 60_000): Promise<void> {
    const root = path.join(app.getPath('userData'), FOLDER)
    for (const id of await fs.readdir(root).catch(() => [] as string[])) {
      if (safeId(id) && keep(id)) continue
      const stat = await fs.stat(path.join(root, id)).catch(() => null)
      if (safeId(id) && stat && Date.now() - stat.mtimeMs < grace) continue
      await writeSecret(`${FOLDER}/${id}`, null).catch(() => undefined)
    }
  }

  /** Deletes at once, without waiting, the clips older than this: Togle is closing, and a day-old call's must not stay. */
  sweepOld(maxAgeMs: number): void {
    const root = path.join(app.getPath('userData'), FOLDER)
    try {
      for (const id of readdirSync(root)) {
        const folder = path.join(root, id)
        if (Date.now() - statSync(folder).mtimeMs > maxAgeMs) rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
      }
    } catch {
      // Nothing kept, or a folder another program holds: the hourly sweep tries again.
    }
  }
}
