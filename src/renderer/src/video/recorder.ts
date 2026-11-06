import { ChangeDetector, PROBE_HEIGHT, PROBE_WIDTH } from './changes'
import { SCREEN_SAMPLE_MS } from '@shared/screen-time'

const api = window.togle

// Look 10× per second.
const TICK_MS = 100
// Wide enough to read code on a 4K screen exactly; smaller sources (a 1080p screen share) stay as they are.
const FULL_WIDTH = 2560
const THUMB_WIDTH = 320

/**
 * Records a screen or window as a series of frames, one per visible change, each saved with its time.
 * Frames go to the main process, which stores them and adds them to the call timeline.
 */
export class ScreenRecorder {
  private stream: MediaStream | null = null
  private readonly video = document.createElement('video')
  private readonly probe = document.createElement('canvas')
  private readonly fullCanvas = document.createElement('canvas')
  private readonly changes = new ChangeDetector()
  private timer: number | null = null
  private busy = false
  private refreshPending = false
  private monitorId: string | null = null
  private automatic = false
  private lastSent = -Infinity
  private lastSnapshot = -Infinity
  // A stop also cancels capture still opening and frames still being encoded.
  private generation = 0
  /** Called when capture ends on its own (the recorded window was closed). */
  onEnded?: () => void

  constructor() {
    this.probe.width = PROBE_WIDTH
    this.probe.height = PROBE_HEIGHT
    this.video.muted = true
  }

  get active(): boolean {
    return this.stream !== null
  }

  /** Starts recording `sourceId` (a screen or window id, or "cursor" for the screen under the mouse). */
  async start(sourceId: string, automatic = false): Promise<void> {
    const generation = ++this.generation
    this.automatic = automatic
    this.lastSent = -Infinity
    this.lastSnapshot = -Infinity
    await api.prepareRecording(sourceId)
    if (generation !== this.generation) return
    try {
      if (automatic) {
        const status = await api.startScreenMonitor(sourceId)
        if (generation !== this.generation) { if (status.id) void api.stopScreenMonitor(status.id); return }
        if (!status.id) throw new Error('Screen context could not start.')
        this.monitorId = status.id
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: automatic ? 2 : 10 }, audio: false })
      if (generation !== this.generation) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      this.stream = stream
      this.video.srcObject = stream
      await this.video.play()
      if (generation !== this.generation) return
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        if (generation !== this.generation) return
        this.stop()
        this.onEnded?.()
      })
      await api.setRecording(true)
      if (generation !== this.generation) return
    } catch (err) {
      if (generation !== this.generation) return
      // Don't leave the capture running behind a Record button that says it isn't.
      this.stop()
      throw err
    }
    this.timer = window.setInterval(() => void this.tick(), automatic ? SCREEN_SAMPLE_MS : TICK_MS)
  }

  stop(): void {
    this.generation++
    this.busy = false
    this.refreshPending = false
    if (this.timer !== null) window.clearInterval(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.video.srcObject = null
    this.changes.reset()
    const id = this.monitorId
    this.monitorId = null
    if (id) void api.stopScreenMonitor(id)
    void api.setRecording(false)
  }

  /** A model requested a fresh picture; an old source's request can never capture its replacement. */
  captureNow(id: string): void {
    if (id !== this.monitorId) return
    if (this.busy) this.refreshPending = true
    else void this.tick(true)
  }

  private luminance(): Uint8Array {
    const ctx = this.probe.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(this.video, 0, 0, PROBE_WIDTH, PROBE_HEIGHT)
    const rgba = ctx.getImageData(0, 0, PROBE_WIDTH, PROBE_HEIGHT).data
    const lum = new Uint8Array(PROBE_WIDTH * PROBE_HEIGHT)
    for (let i = 0; i < lum.length; i++) lum[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8
    return lum
  }

  private async tick(force = false): Promise<void> {
    if (!this.stream || this.busy || this.video.readyState < 2 || !this.video.videoWidth) return
    const now = performance.now()
    if (!force && this.automatic && now - this.lastSent < SCREEN_SAMPLE_MS - 50) return
    // Every automatic sample gets a timestamp, including unchanged views. The main process shares identical bytes.
    const changed = this.changes.see(this.luminance(), now)
    if (!this.automatic && !force && !changed) return
    // Kept once the picture settled, but it stands for the moment it changed: words said in between are about it.
    const at = this.automatic || force ? Date.now() : Date.now() - (now - this.changes.changedAt)
    // Read now: stopping while the picture is encoded resets it.
    const content = this.changes.content
    this.busy = true
    this.lastSent = now
    const generation = this.generation
    const monitorId = this.monitorId
    try {
      if (monitorId) {
        const image = await this.encode(FULL_WIDTH, 0.8)
        if (generation !== this.generation) return
        const snapshot = changed && now - this.lastSnapshot >= 2000
        const thumb = snapshot ? await this.encode(THUMB_WIDTH, 0.7) : undefined
        if (generation === this.generation) {
          const accepted = await api.addScreenMonitorFrame(monitorId, Math.round(at), image, thumb ? { thumb, content } : undefined)
          if (accepted && thumb) this.lastSnapshot = now
        }
        return
      }
      const [image, thumb] = await Promise.all([this.encode(FULL_WIDTH, 0.8), this.encode(THUMB_WIDTH, 0.7)])
      if (generation !== this.generation) return
      await api.addRecordedFrame(Math.round(at), image, thumb, content)
    } catch (err) {
      console.warn('[recorder]', (err as Error).message)
    } finally {
      if (generation === this.generation) {
        this.busy = false
        if (this.refreshPending) { this.refreshPending = false; void this.tick(true) }
      }
    }
  }

  private async encode(width: number, quality: number): Promise<Uint8Array> {
    const scale = Math.min(1, width / this.video.videoWidth)
    const canvas = this.automatic ? this.fullCanvas : document.createElement('canvas')
    const height = Math.round(this.video.videoHeight * scale)
    const scaledWidth = Math.round(this.video.videoWidth * scale)
    if (canvas.width !== scaledWidth) canvas.width = scaledWidth
    if (canvas.height !== height) canvas.height = height
    canvas.getContext('2d')!.drawImage(this.video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('could not encode frame'))), 'image/jpeg', quality)
    )
    return new Uint8Array(await blob.arrayBuffer())
  }
}
