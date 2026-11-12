import { execFile } from 'node:child_process'
import { CALL_APPS, callSitesIn, type CallApp } from '@shared/call-apps'
import { readMacMicrophoneUse } from './mac-audio-processes'

const MICROPHONE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
// Windows counts time from 1601, in tenths of a microsecond.
const FILETIME_EPOCH_MS = 11_644_473_600_000
const POLL_MS = 5_000
// A program seen using the microphone as Togle started, longer ago than this, is a leftover and not a call just begun.
const STALE_MS = 6 * 3600_000

export interface MicrophoneUse {
  /**
   * The program: on Windows its path with # for \ or its package name, as Windows keeps it; on Linux its file name; on a
   * Mac its bundle id.
   */
  name: string
  /** When it began using the microphone (epoch ms); on Linux and a Mac, when it was seen, as nothing says when it began. */
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

/**
 * The programs recording from a microphone now on Linux, from `pactl list source-outputs` (run in the C locale, so its
 * words are English): each stream's program by its file name (application.process.binary), else by the name it gives
 * itself. PulseAudio and PipeWire's PulseAudio service list them the same way.
 */
export function parseSourceOutputs(text: string, now: number): MicrophoneUse[] {
  const using: MicrophoneUse[] = []
  for (const block of text.split(/^Source Output #/m).slice(1)) {
    const property = (name: string): string | undefined => new RegExp(`^\\s*${name.replace(/\./g, '\\.')} = "(.*)"\\s*$`, 'm').exec(block)?.[1]
    const name = property('application.process.binary') || property('application.name')
    if (name) using.push({ name, since: now })
  }
  return using
}

/** The call apps among the programs using the microphone, once each, with the earliest start. */
export function callAppsIn(using: MicrophoneUse[]): { app: CallApp; since: number }[] {
  const found = new Map<CallApp, number>()
  for (const entry of using) {
    // Windows names end in .exe or are packages, Linux names are bare file names, a Mac's are bundle ids: one never
    // matches another's pattern.
    const app = CALL_APPS.find(candidate => candidate.match.test(entry.name) || !!candidate.linux?.test(entry.name) || !!candidate.mac?.test(entry.name))
    if (app) found.set(app.id, Math.min(found.get(app.id) ?? Infinity, entry.since))
  }
  return [...found].map(([app, since]) => ({ app, since }))
}

/** `reg query` of the microphone's consent store: empty if it cannot be read. */
function readRegistry(): Promise<MicrophoneUse[]> {
  return new Promise(resolve => {
    execFile('reg.exe', ['query', MICROPHONE_KEY, '/s'], { windowsHide: true, timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parseMicrophoneUse(stdout)))
  })
}

/** `pactl list source-outputs`: none if there is no pactl or no sound service. */
function readSourceOutputs(): Promise<MicrophoneUse[]> {
  return new Promise(resolve => {
    execFile('pactl', ['list', 'source-outputs'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout) => resolve(error ? [] : parseSourceOutputs(stdout, Date.now())))
  })
}

/** The programs using the microphone now, as this system tells it. */
export function readMicrophoneUse(): Promise<MicrophoneUse[]> {
  if (process.platform === 'win32') return readRegistry()
  if (process.platform === 'linux') return readSourceOutputs()
  if (process.platform === 'darwin') return Promise.resolve(readMacMicrophoneUse())
  return Promise.resolve([])
}

// The browsers a call can be in: Meet, and the web versions of the other apps. On Windows by the name of their program,
// on Linux by their file name, on a Mac by the bundle id of the browser or of its helper that records (Safari's is
// WebKit's).
const BROWSER = /(?:^|[#\\])((?:chrome|msedge|firefox|brave|opera|vivaldi)\.exe)$/i
const LINUX_BROWSER = /^(?:chrome|google-chrome(?:-stable|-beta|-unstable)?|chromium(?:-browser)?|brave(?:-browser)?|msedge|microsoft-edge(?:-stable|-beta|-dev)?|opera|vivaldi(?:-bin|-stable)?|firefox(?:-bin|-esr)?)$/i
const MAC_BROWSERS: [RegExp, string][] = [
  [/^com\.google\.chrome/i, 'chrome'], [/^org\.chromium\.chromium/i, 'chromium'], [/^com\.microsoft\.edgemac/i, 'edge'],
  [/^org\.mozilla\.(?:firefox|plugincontainer)/i, 'firefox'], [/^com\.brave\.browser/i, 'brave'], [/^com\.operasoftware\.opera/i, 'opera'],
  [/^com\.vivaldi\.vivaldi/i, 'vivaldi'], [/^company\.thebrowser\.browser/i, 'arc'], [/^com\.apple\.(?:safari|webkit)/i, 'safari']
]
/** The browser a Mac bundle id belongs to, by a short name, or undefined. */
export const macBrowserOf = (bundle: string): string | undefined => MAC_BROWSERS.find(([pattern]) => pattern.test(bundle))?.[1]

/** The browsers among the programs using the microphone, by their file name, with the earliest start. */
export function browsersIn(using: MicrophoneUse[]): { program: string; since: number }[] {
  const found = new Map<string, number>()
  for (const entry of using) {
    const program = (BROWSER.exec(entry.name)?.[1] ?? (LINUX_BROWSER.test(entry.name) ? entry.name : undefined) ?? macBrowserOf(entry.name))?.toLowerCase()
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

// A browser's window, by its window class as `wmctrl -lx` gives it (google-chrome.Google-chrome, Navigator.firefox).
const BROWSER_WINDOW = /chrom|firefox|brave|edge|opera|vivaldi/i

/**
 * The titles of the browsers' windows in `wmctrl -lx` (X11, and the windows of programs under XWayland): each line is the
 * window's id, its desktop, its class, the computer and its title.
 */
export function parseBrowserWindows(text: string): string[] {
  const titles: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^0x[0-9a-f]+\s+-?\d+\s+(\S+)\s+\S+\s+(.*)$/i.exec(line.trim())
    if (match && BROWSER_WINDOW.test(match[1]) && match[2].trim()) titles.push(match[2].trim())
  }
  return titles
}

/**
 * The titles of a browser's windows, to tell a call in it from anything else that uses the microphone (one title a
 * process on Windows: the window in front of each). Read only while that browser uses the microphone; matched, never
 * kept. On Linux, through wmctrl when it is installed: on Wayland it sees only the programs running under XWayland.
 */
export function readWindowTitles(program: string): Promise<string[]> {
  if (process.platform === 'linux') {
    if (!LINUX_BROWSER.test(program)) return Promise.resolve([])
    return new Promise(resolve => {
      execFile('wmctrl', ['-lx'], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parseBrowserWindows(stdout)))
    })
  }
  if (!BROWSER.test(program)) return Promise.resolve([])
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/V', '/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${program}`], { windowsHide: true, timeout: 6000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? [] : parseWindowTitles(stdout)))
  })
}

/**
 * Whether one of the app's programs is running, so a leftover from one that crashed does not count as a call. Linux
 * lists only the programs recording now, so there is no leftover to check.
 */
export function appRunning(app: CallApp): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(true)
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
  /** The programs using the microphone now. */
  read: () => Promise<MicrophoneUse[]>
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
      const using = await this.options.read()
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
