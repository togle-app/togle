/**
 * How Togle and Togle Microphone find and talk to each other on one computer. This file is the same in both apps.
 *
 * Togle Microphone writes `link.json` into its own user-data folder each time it starts: where its local socket is
 * (a named pipe on Windows, a Unix socket elsewhere), a token that changes on every start, and how to start the app
 * again. Togle reads the file, connects, sends the token in `hello`, and can then read the microphone's state, watch
 * it change, or ask the microphone to start, stop or show its window. Only the state travels over the link, never
 * audio. A process that can read the file runs as the same user, which is the boundary this relies on.
 *
 * Messages are single-line JSON objects, one per line (UTF-8, `\n`-terminated), at most MICROPHONE_LINK_MAX_LINE bytes.
 */

export const MICROPHONE_LINK_API = 1
/** The app's product name. Electron names its user-data folder after it. */
export const MICROPHONE_PRODUCT = 'Togle Microphone'
/** The input that call apps list once Togle Microphone is installed. */
export const MICROPHONE_DEVICE = 'Togle Microphone'
export const MICROPHONE_LINK_FILE = 'link.json'
/** `togle-microphone://open`, `togle-microphone://start`, `togle-microphone://stop`. */
export const MICROPHONE_PROTOCOL = 'togle-microphone'
export const MICROPHONE_LINK_MAX_LINE = 64 * 1024

/** Labels of the Togle Microphone input as Chromium lists them on Windows, macOS and Linux. */
export function isTogleMicrophoneLabel(label: string | undefined): boolean {
  return !!label && /\bTogle Microphone\b(?! Feed)/i.test(label)
}

export interface MicrophoneLaunch {
  /** Absolute path of the program to run. */
  command: string
  args: string[]
}

export interface MicrophoneLinkFile {
  api: number
  product: string
  version: string
  pid: number
  /** Named pipe (`\\.\pipe\...`) on Windows, Unix socket path elsewhere. */
  socket: string
  /** 64 hex characters, new on every start. */
  token: string
  /** Starts Togle Microphone when it isn't running. */
  launch?: MicrophoneLaunch
  startedAt: number
}

export type MicrophoneLinkPhase = 'off' | 'starting' | 'on' | 'error'

export interface MicrophoneLinkState {
  phase: MicrophoneLinkPhase
  /** Why it stopped or can't start, in words for the user. */
  error?: string
  /** The input call apps should use: `Togle Microphone`. */
  device: string
  /** The physical microphone being cleaned. */
  input?: string
  /** The system's default input is Togle Microphone right now, so calls on the default microphone get clean audio. */
  systemDefault: boolean
  /** Which noise model is heard: DeepFilterNet 3, RNNoise, or none (passing the microphone through). */
  engine?: 'deepfilter' | 'rnnoise' | 'bypass'
  /** A calibration or voice profile for this microphone is in use. */
  personalized: boolean
  /** Processing delay of the cleaned audio in milliseconds, so dictation can wait for the last words. */
  bufferMs?: number
  /** Whether the audio driver is installed: `restart` means the computer must restart first. */
  setup?: 'ready' | 'missing' | 'restart'
  version: string
}

export type MicrophoneLinkMethod = 'hello' | 'state' | 'watch' | 'start' | 'stop' | 'show'
export type MicrophoneLinkPage = 'settings' | 'calibrate'

export type MicrophoneLinkRequest =
  | { id: number; method: 'hello'; params: { token: string; client: string; version: string } }
  | { id: number; method: 'state' | 'watch' }
  | { id: number; method: 'start' | 'stop'; params?: { reason?: 'call' | 'user' } }
  | { id: number; method: 'show'; params?: { page?: MicrophoneLinkPage } }

export interface MicrophoneLinkHello { product: string; version: string; api: number }

export type MicrophoneLinkMessage =
  | { id: number; result: unknown }
  | { id: number; error: string }
  | { event: 'state'; data: MicrophoneLinkState }

export function encodeLinkMessage(message: MicrophoneLinkRequest | MicrophoneLinkMessage): string {
  return JSON.stringify(message) + '\n'
}

/** Splits a byte stream into JSON messages. Throws on a line that is too long or isn't a JSON object. */
export class LinkLineReader {
  private buffered = ''
  push(chunk: string): unknown[] {
    this.buffered += chunk
    const messages: unknown[] = []
    let newline: number
    while ((newline = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, newline).trim()
      this.buffered = this.buffered.slice(newline + 1)
      if (!line) continue
      if (line.length > MICROPHONE_LINK_MAX_LINE) throw new Error('Link message too long')
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Link message is not an object')
      messages.push(value)
    }
    if (this.buffered.length > MICROPHONE_LINK_MAX_LINE) throw new Error('Link message too long')
    return messages
  }
}

const text = (value: unknown, max = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/** The link file's contents, or undefined when it's missing a field or comes from an API this app doesn't speak. */
export function readLinkFile(value: unknown): MicrophoneLinkFile | undefined {
  if (!value || typeof value !== 'object') return
  const file = value as Partial<MicrophoneLinkFile>
  if (file.api !== MICROPHONE_LINK_API || file.product !== MICROPHONE_PRODUCT || !text(file.version, 64)) return
  if (!Number.isSafeInteger(file.pid) || file.pid! <= 0 || !text(file.socket) || !/^[0-9a-f]{64}$/.test(file.token ?? '')) return
  if (!Number.isFinite(file.startedAt)) return
  const launch = file.launch && text(file.launch.command) && Array.isArray(file.launch.args) && file.launch.args.length <= 8 &&
    file.launch.args.every(arg => typeof arg === 'string' && arg.length <= 256) ? { command: file.launch.command, args: [...file.launch.args] } : undefined
  return { api: file.api, product: file.product, version: file.version!, pid: file.pid!, socket: file.socket!, token: file.token!, launch, startedAt: file.startedAt! }
}

const PHASES: readonly MicrophoneLinkPhase[] = ['off', 'starting', 'on', 'error']
const ENGINES = ['deepfilter', 'rnnoise', 'bypass'] as const
const SETUPS = ['ready', 'missing', 'restart'] as const

/** A state received over the link, with anything unexpected dropped. */
export function readLinkState(value: unknown): MicrophoneLinkState | undefined {
  if (!value || typeof value !== 'object') return
  const state = value as Partial<MicrophoneLinkState>
  if (!PHASES.includes(state.phase as MicrophoneLinkPhase) || !text(state.device, 256) || !text(state.version, 64)) return
  // Optional fields only when they're there, so a state compares and travels (IPC, JSON) the same way.
  return {
    phase: state.phase!,
    ...(text(state.error, 1000) ? { error: state.error } : {}),
    device: state.device!,
    ...(text(state.input, 256) ? { input: state.input } : {}),
    systemDefault: state.systemDefault === true,
    ...(ENGINES.includes(state.engine as typeof ENGINES[number]) ? { engine: state.engine } : {}),
    personalized: state.personalized === true,
    ...(typeof state.bufferMs === 'number' && Number.isFinite(state.bufferMs) && state.bufferMs >= 0 && state.bufferMs < 5000 ? { bufferMs: state.bufferMs } : {}),
    ...(SETUPS.includes(state.setup as typeof SETUPS[number]) ? { setup: state.setup } : {}),
    version: state.version!
  }
}

/**
 * The website. A placeholder until Togle has a domain: change it here, in both apps, before a release.
 * Pages: `/` (Togle), `/microphone/` (Togle Microphone).
 */
export const TOGLE_SITE = 'https://example.com'

/** Togle Microphone's page, tagged with where in the app the visit came from. */
export function microphonePage(from: 'after-call' | 'settings' | 'call-strip' | 'microphone-check'): string {
  const url = new URL('/microphone/', TOGLE_SITE)
  url.search = new URLSearchParams({ utm_source: 'togle', utm_medium: 'app', utm_campaign: 'microphone', utm_content: from }).toString()
  return url.toString()
}
