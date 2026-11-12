import { execFile } from 'node:child_process'
import { CALL_APPS, callSitesIn, type CallApp } from '@shared/call-apps'

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

// The browsers a call can be in: Meet, and the web versions of the other apps.
const BROWSER = /(?:^|[#\\])((?:chrome|msedge|firefox|brave|opera|vivaldi)\.exe)$/i

/** The browsers among the programs using the microphone, by their file name, with the earliest start. */
export function browsersIn(using: MicrophoneUse[]): { program: string; since: number }[] {
  const found = new Map<string, number>()
  for (const entry of using) {
    const program = BROWSER.exec(entry.name)?.[1]?.toLowerCase()
    if (program) found.set(program, Math.min(found.get(program) ?? Infinity, entry.since))
  }
  return [...found].map(([program, since]) => ({ program, since }))
}

/** The window titles in `tasklist /v /fo csv /nh`: the last field of each line, when a window has one. */
export function parseWindowTitles(csv: string): string[] {
  const titles: string[] = []
  for (const line of csv.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(match => match[1].replace(/""/g, '"'))
    const title = fields.at(-1)
    if (fields.length >= 9 && title && title !== 'N/A') titles.push(title)
  }
  return titles
}

/**
 * The titles of a browser's windows, to tell a call in it from anything else that uses the microphone (one title a
 * process: the window in front of each). Read only while that browser uses the microphone; matched, never kept.
 */
export function readWindowTitles(program: string): Promise<string[]> {
  if (!BROWSER.test(program)) return Promise.resolve([])
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/V', '/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${program}`], { windowsHide: true, timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parseWindowTitles(stdout)))
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
  /** The window titles of a browser using the microphone, to tell a call in it (Meet, or another app on the web). */
  titles?: (program: string) => Promise<string[]>
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
  // Not looking for a while (a call was written down, or the notice was off): when it looks again, what is on the
  // microphone is a call that was already going, not a new one.
  private resumed = false
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
    if (!this.options.active()) { this.seen.clear(); this.resumed = true; return }
    this.busy = true
    try {
      const now = (this.options.now ?? Date.now)()
      const using = parseMicrophoneUse(await this.options.read())
      const found: { app: CallApp; since: number; web?: boolean }[] = callAppsIn(using)
      // A browser using the microphone: a call in it is told by its window's title.
      for (const { program, since } of this.options.titles ? browsersIn(using) : []) {
        for (const app of callSitesIn(await this.options.titles!(program))) if (!found.some(item => item.app === app)) found.push({ app, since, web: true })
      }
      const here = new Set(found.map(item => item.app))
      for (const app of new Set([...this.seen.keys(), ...this.announced])) {
        if (here.has(app)) continue
        this.seen.delete(app)
        if (this.announced.delete(app)) this.options.onEnd?.(app)
      }
      if (this.resumed) {
        for (const { app } of found) this.announced.add(app)
        this.resumed = false
        this.first = false
        return
      }
      for (const { app, since, web } of found) {
        const looks = (this.seen.get(app) ?? 0) + 1
        this.seen.set(app, looks)
        if (this.announced.has(app)) continue
        // Using the microphone before Togle started, for a long time: a leftover, not a call just begun.
        if (this.first && now - since > STALE_MS) { this.announced.add(app); continue }
        if (looks < 2) continue
        this.announced.add(app)
        // A call seen in a browser's window is in a running browser; a program's leftover entry needs checking.
        if (web || await this.options.running(app)) this.options.onStart(app)
      }
      this.first = false
    } finally {
      this.busy = false
    }
  }
}
