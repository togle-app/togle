import { execFile } from 'node:child_process'
import { CALL_APPS, type CallApp } from '@shared/call-apps'

const MICROPHONE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
// Windows counts time from 1601, in tenths of a microsecond.
const FILETIME_EPOCH_MS = 11_644_473_600_000
const POLL_MS = 5_000
// A program seen using the microphone as Togle started, longer ago than this, is a leftover and not a call just begun.
const STALE_MS = 6 * 3600_000

export interface MicrophoneUse {
  /** What Windows calls the program: its path with # for \, or its package name. */
  name: string
  /** When it began using the microphone (epoch ms). */
  since: number
}

/**
 * The programs using the microphone now, from `reg query <consent store> /s`: each program has a block with when it
 * last started using the microphone and when it last stopped (zero while it still does).
 */
export function parseMicrophoneUse(text: string): MicrophoneUse[] {
  const using: MicrophoneUse[] = []
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const key = lines.find(line => /^HKEY_/i.test(line))
    if (!key) continue
    const read = (name: string): bigint | undefined => {
      const row = lines.find(line => line.toLowerCase().startsWith(name.toLowerCase() + ' '))
      const value = row?.match(/REG_QWORD\s+(0x[0-9a-f]+)/i)?.[1]
      return value ? BigInt(value) : undefined
    }
    const start = read('LastUsedTimeStart'), stop = read('LastUsedTimeStop')
    if (start === undefined || stop === undefined || start === 0n || stop !== 0n) continue
    const name = key.slice(key.lastIndexOf('\\') + 1)
    using.push({ name, since: Number(start / 10_000n) - FILETIME_EPOCH_MS })
  }
  return using
}

/** The call apps among the programs using the microphone, once each, with the earliest start. */
export function callAppsIn(using: MicrophoneUse[]): { app: CallApp; since: number }[] {
  const found = new Map<CallApp, number>()
  for (const entry of using) {
    const app = CALL_APPS.find(candidate => candidate.match.test(entry.name))
    if (app) found.set(app.id, Math.min(found.get(app.id) ?? Infinity, entry.since))
  }
  return [...found].map(([app, since]) => ({ app, since }))
}

/** `reg query` of the microphone's consent store: empty if it cannot be read. */
export function readMicrophoneUse(): Promise<string> {
  return new Promise(resolve => {
    execFile('reg.exe', ['query', MICROPHONE_KEY, '/s'], { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? '' : stdout))
  })
}

/** Whether one of the app's programs is running, so a leftover from one that crashed does not count as a call. */
export function appRunning(app: CallApp): Promise<boolean> {
  const programs = CALL_APPS.find(candidate => candidate.id === app)?.programs ?? []
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(true)
      const names = new Set(stdout.split(/\r?\n/).map(line => line.match(/^"([^"]+)"/)?.[1]?.toLowerCase()).filter((name): name is string => !!name))
      resolve(programs.some(program => names.has(program.toLowerCase())))
    })
  })
}

interface Options {
  read: () => Promise<string>
  running: (app: CallApp) => Promise<boolean>
  /** Whether to look now: not during a call being written down, and not when the person turned it off. */
  active: () => boolean
  onStart: (app: CallApp) => void
  onEnd?: (app: CallApp) => void
  now?: () => number
}

/**
 * Notices a call app starting a call: it begins using the microphone, and keeps on for two looks in a row, which a
 * mute or a test of the microphone does not. It says so once for each call, and again for the next one.
 */
export class CallDetector {
  private timer?: NodeJS.Timeout
  private seen = new Map<CallApp, number>()
  private announced = new Set<CallApp>()
  private first = true
  private busy = false

  constructor(private options: Options) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** One look. Exposed so a test can drive it. */
  async poll(): Promise<void> {
    if (this.busy) return
    if (!this.options.active()) { this.seen.clear(); this.first = true; return }
    this.busy = true
    try {
      const now = (this.options.now ?? Date.now)()
      const found = callAppsIn(parseMicrophoneUse(await this.options.read()))
      const here = new Set(found.map(item => item.app))
      for (const app of [...this.seen.keys()]) {
        if (here.has(app)) continue
        this.seen.delete(app)
        if (this.announced.delete(app)) this.options.onEnd?.(app)
      }
      for (const { app, since } of found) {
        const looks = (this.seen.get(app) ?? 0) + 1
        this.seen.set(app, looks)
        if (this.announced.has(app)) continue
        // Using the microphone before Togle started, for a long time: a leftover, not a call just begun.
        if (this.first && now - since > STALE_MS) { this.announced.add(app); continue }
        if (looks < 2) continue
        this.announced.add(app)
        if (await this.options.running(app)) this.options.onStart(app)
      }
      this.first = false
    } finally {
      this.busy = false
    }
  }
}
