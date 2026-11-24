import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { utilityProcess } from 'electron'
import { desktopCallApps, isCallApp, type CallApp, type MeetingCaptureState, type MeetingMic } from '@shared/call-apps'
import type { MeetingObservation } from './meeting-accessibility'

const STALE_MS = 2500

/** Follows one confirmed meeting. Only an explicit departure can finish the notes. */
export class DesktopMeetings {
  private room?: { id: string; app: CallApp; mic: MeetingMic }
  private bound?: MeetingCaptureState
  private revision = 0
  private lastRead = 0
  private openSince = Infinity
  private endedAt = 0
  private followUntil = 0
  private waiting = new Set<(valid: boolean) => void>()

  constructor(private started: (id: string, app: CallApp) => void, private left: (app: CallApp, id: string) => void, private changed: (state: MeetingCaptureState) => void, private now: () => number = Date.now) {}

  get id(): string | undefined { return this.room?.id }
  get app(): CallApp | undefined { return this.room?.app }
  get capture(): MeetingCaptureState | undefined { return this.bound }
  get departureTime(): number { return this.endedAt }
  get needsReader(): boolean { return !!this.bound || this.followUntil > this.now() }

  /** Manual notes can follow the detected meeting. An offer must still refer to the same call. */
  follow(request?: string | false): MeetingCaptureState | null {
    if (typeof request === 'string' && this.room?.id !== request) throw new Error('This call has ended.')
    this.checkFresh()
    this.release()
    if (request !== false && this.room) this.bound = { ...this.room, ended: false, revision: ++this.revision }
    else if (request === undefined) this.followUntil = this.now() + 15_000
    return this.bound ?? null
  }

  release(): void {
    this.settle(false)
    this.bound = undefined
    this.endedAt = 0
    this.followUntil = 0
  }

  cancelPending(): void { this.followUntil = 0 }

  disabled(): void {
    if (!this.bound && this.room) this.observe({ id: this.room.id, state: 'left' })
  }

  observe(value: MeetingObservation): void {
    if (!value || !/^[a-f0-9]{32}$/.test(value.id) || !['open', 'muted', 'unknown', 'gap', 'left'].includes(value.state)) return
    if (value.state === 'gap') { if (this.room?.id === value.id) this.uncertain(); return }
    const now = this.now()
    if (value.state === 'left') {
      if (this.room?.id !== value.id) return
      const app = this.room.app
      this.room = undefined
      this.openSince = Infinity
      this.settle(false)
      this.update(value.id, 'unknown', true)
      this.left(app, value.id)
      return
    }
    if (this.room?.id !== value.id && !isCallApp(value.app)) return
    if (this.room && this.room.id !== value.id) {
      // A restarted reader can see a different call. Losing the old window's identity cannot end an active recording.
      if (this.bound?.id === this.room.id) { this.uncertain(); return }
      this.observe({ id: this.room.id, state: 'left' })
    }
    const fresh = !this.room
    const app = this.room?.app ?? value.app
    if (!isCallApp(app)) return
    if (value.state !== 'open' || this.room?.mic !== 'open' || now - this.lastRead > STALE_MS) {
      this.openSince = value.state === 'open' ? now : Infinity
      this.settle(false)
    }
    this.lastRead = now
    this.room = { id: value.id, app, mic: value.state }
    this.update(value.id, value.state, false)
    this.settle(value.state === 'open')
    if (fresh && this.followUntil && now <= this.followUntil) {
      this.followUntil = 0
      this.bound = { ...this.room, ended: false, revision: ++this.revision }
      this.changed(this.bound)
    } else if (fresh) this.started(value.id, app)
  }

  /** Missing accessibility information closes the microphone gate and preserves the meeting. */
  uncertain(): void {
    if (this.room) this.observe({ id: this.room.id, state: 'unknown' })
  }

  checkFresh(): void { if (this.now() - this.lastRead > STALE_MS && this.room?.mic === 'open') this.uncertain() }

  /** Hold a completed microphone clip until a subsequent observation confirms the mic stayed open. */
  async allowsClip(start: number, end: number): Promise<boolean> {
    const bound = this.bound
    if (!bound) return true
    this.checkFresh()
    if (bound.ended || this.bound?.mic !== 'open' || start < this.openSince) return false
    if (end <= this.lastRead) return true
    return new Promise(resolve => {
      const done = (valid: boolean) => {
        if (valid && this.lastRead < end) return
        clearTimeout(timer)
        this.waiting.delete(done)
        resolve(valid && this.bound?.id === bound.id && this.bound.revision === bound.revision && start >= this.openSince)
      }
      const timer = setTimeout(() => done(false), STALE_MS)
      this.waiting.add(done)
    })
  }

  private update(id: string, mic: MeetingMic, ended: boolean): void {
    if (this.bound?.id !== id || this.bound.ended || this.bound.mic === mic && !ended) return
    if (ended) this.endedAt = this.now()
    this.bound = { ...this.bound, mic, ended, revision: ++this.revision }
    this.changed(this.bound)
  }

  private settle(ok: boolean): void { for (const resolve of this.waiting) resolve(ok) }
}

/** Keep potentially slow accessibility requests off Electron's main thread. */
export class DesktopMeetingReader {
  private running?: { close(): void }
  private timer?: NodeJS.Timeout
  private lastBeat = 0
  private nextTry = 0
  private scans = new Set<() => void>()
  constructor(private script: string, private meet: DesktopMeetings, private enabled: () => boolean) {}

  /** Before opening a manual microphone, give the reader one look for an already joined, muted call. */
  afterScan(): Promise<void> {
    if (!this.timer || !this.enabled()) return Promise.resolve()
    return new Promise(resolve => {
      const finish = () => { clearTimeout(timeout); this.scans.delete(finish); resolve() }
      const timeout = setTimeout(finish, 4500)
      this.scans.add(finish)
    })
  }

  start(): void {
    if (this.timer) return
    const tick = () => {
      this.meet.checkFresh()
      if (!this.enabled()) { this.close(); this.meet.disabled(); return }
      if (this.running) { if (Date.now() - this.lastBeat > 12_000) this.close(); return }
      if (Date.now() < this.nextTry) return
      this.lastBeat = Date.now()
      try {
        this.running = process.platform === 'win32' ? this.windows() : process.platform === 'linux' ? this.linux() : this.mac()
      } catch { this.nextTry = Date.now() + 12_000; this.meet.uncertain() }
    }
    this.timer = setInterval(tick, 500)
    this.timer.unref()
    tick()
  }

  private observe(event: MeetingObservation | '.'): void {
    if (event !== '.') {
      this.meet.observe(event)
      if (event?.state === 'gap') return
    }
    this.lastBeat = Date.now()
    for (const finish of this.scans) finish()
  }

  private windows(): { close(): void } {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', this.script], { windowsHide: true })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(desktopCallApps) + '\n')
    const lines = createInterface({ input: child.stdout })
    const running = { close: () => { lines.close(); child.kill() } }
    lines.on('line', line => {
      if (this.running !== running || line.length > 180) return
      try { this.observe(line === '.' ? '.' : JSON.parse(line) as MeetingObservation) }
      catch { this.meet.uncertain() }
    })
    child.stderr.resume()
    const gone = () => { if (this.running === running) this.close() }
    child.once('exit', gone)
    child.once('error', gone)
    return running
  }

  private linux(): { close(): void } {
    // Give AT-SPI its own GLib loop. Electron's main process already uses GLib for the Linux desktop.
    const child = utilityProcess.fork(path.join(__dirname, 'meeting-worker.js'), [String(process.pid)], { serviceName: 'Togle call detection', stdio: 'ignore' })
    const running = { close: () => { child.kill() } }
    child.on('message', (event: MeetingObservation | '.') => { if (this.running === running) this.observe(event) })
    child.once('exit', () => { if (this.running === running) this.close(12_000) })
    return running
  }

  private mac(): { close(): void } {
    const worker = new Worker(path.join(__dirname, 'meeting-worker.js'))
    const running = {
      close: () => {
        if (worker.threadId === -1) return
        worker.postMessage('stop')
        const limit = setTimeout(() => void worker.terminate(), 1500)
        limit.unref()
        worker.once('exit', () => clearTimeout(limit))
      }
    }
    worker.on('message', (event: MeetingObservation | '.') => { if (this.running === running) this.observe(event) })
    const gone = () => { if (this.running === running) this.close(12_000) }
    worker.once('exit', gone)
    worker.once('error', gone)
    return running
  }

  private close(retry = 2000): void {
    const running = this.running
    if (!running) return
    this.running = undefined
    this.nextTry = Date.now() + retry
    this.meet.uncertain()
    running.close()
  }
  stop(): void { clearInterval(this.timer); this.timer = undefined; this.close() }
}
