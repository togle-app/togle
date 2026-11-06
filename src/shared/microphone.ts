import type { MicrophoneLinkState } from './microphone-link'

/**
 * Togle's side of Togle Microphone, the separate app that removes background noise from the user's voice in every
 * call app. Togle measures what the microphone picks up during calls, and when it's noisy it can show the user, with
 * a link to Togle Microphone. Both are optional and off with one setting.
 */

/** What Togle knows about Togle Microphone on this computer. */
export interface TogleMicrophoneStatus {
  /** Togle Microphone has run on this computer: it left its link file. */
  installed: boolean
  /** It's running and Togle is connected to it. */
  running: boolean
  /** Its state while running. */
  state?: MicrophoneLinkState
  /** Togle turned it on for the call that's going on, and turns it off again when the call ends. */
  forCall?: boolean
}

export interface MicrophoneSettings {
  /** After a call, show what the microphone picked up when it was noisy, with a link to Togle Microphone. */
  suggestions: boolean
  /** Turn Togle Microphone on when a call starts, when it's installed, and off again after the call. */
  autoStart: boolean
  /** When a suggestion was last shown. */
  suggestedAt?: number
  /** Suggestions closed with "Not now" since the user last opened Togle Microphone's page. */
  dismissals?: number
}

export const MICROPHONE_DEFAULTS: MicrophoneSettings = { suggestions: true, autoStart: true }

export function isMicrophoneOn(status: TogleMicrophoneStatus | undefined): boolean {
  return !!status?.running && (status.state?.phase === 'on' || status.state?.phase === 'starting')
}

/** `unknown`: not enough of the call was measured to say. */
export type NoiseVerdict = 'quiet' | 'some' | 'noisy' | 'unknown'

/** What the microphone picked up during a call. Levels in dBFS; no audio. */
export interface NoiseReport {
  /** Audio measured, in milliseconds. */
  analyzedMs: number
  /** Of which the user was speaking. */
  speechMs: number
  /** Of which nobody was speaking: the background is all the microphone heard. */
  quietMs: number
  /** Of the quiet time, how long the background was loud enough to hear in a call. */
  noisyMs: number
  /** Short loud sounds while nobody spoke: typing, clicks, knocks, a cough. */
  bursts: number
  /** The steady background (fan, hum, traffic) while quiet. */
  floorDb?: number
  /** How loud the background got while quiet (95th percentile). */
  peakDb?: number
  /** The user's voice (median while speaking). */
  speechDb?: number
  /** How far the voice is above the steady background. */
  snrDb?: number
  verdict: NoiseVerdict
}

/** Enough to judge: a minute of call, 20 seconds of it quiet. */
const MIN_ANALYZED_MS = 60_000
const MIN_QUIET_MS = 20_000
/** A shorter microphone check judges on less. */
export const CHECK_MIN_QUIET_MS = 3_000

export function noiseVerdict(report: Omit<NoiseReport, 'verdict'>, check = false): NoiseVerdict {
  if (report.quietMs < (check ? CHECK_MIN_QUIET_MS : MIN_QUIET_MS) || (!check && report.analyzedMs < MIN_ANALYZED_MS)) return 'unknown'
  const noisyShare = report.noisyMs / report.quietMs
  const burstsPerMinute = report.bursts / (report.quietMs / 60_000)
  if (noisyShare >= 0.3 || (report.snrDb !== undefined && report.snrDb < 20) || burstsPerMinute >= 12) return 'noisy'
  if (noisyShare >= 0.1 || (report.snrDb !== undefined && report.snrDb < 28) || burstsPerMinute >= 4) return 'some'
  return 'quiet'
}

const DURATION_MAX = 24 * 60 * 60_000

/** A report sent from the window, with its verdict worked out again here. Undefined when it isn't one. */
export function readNoiseReport(value: unknown): NoiseReport | undefined {
  if (!value || typeof value !== 'object') return
  const r = value as Partial<Record<keyof NoiseReport, unknown>>
  const duration = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= DURATION_MAX
  const level = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= -200 && v <= 200 ? v : undefined
  if (!duration(r.analyzedMs) || !duration(r.speechMs) || !duration(r.quietMs) || !duration(r.noisyMs)) return
  if (typeof r.bursts !== 'number' || !Number.isInteger(r.bursts) || r.bursts < 0 || r.bursts > 1e6) return
  if (r.quietMs + r.speechMs > r.analyzedMs + 1000 || r.noisyMs > r.quietMs) return
  const report = { analyzedMs: r.analyzedMs, speechMs: r.speechMs, quietMs: r.quietMs, noisyMs: r.noisyMs, bursts: r.bursts,
    floorDb: level(r.floorDb), peakDb: level(r.peakDb), speechDb: level(r.speechDb), snrDb: level(r.snrDb) }
  return { ...report, verdict: noiseVerdict(report) }
}

/** Days between two suggestions after calls. */
const SUGGEST_EVERY_MS = 3 * 24 * 60 * 60_000
/** After this many "Not now", suggestions stay in Settings only. */
const MAX_DISMISSALS = 3

/** Whether to show the microphone suggestion after a call. Never during one, never once Togle Microphone is on. */
export function shouldSuggest(settings: MicrophoneSettings, status: TogleMicrophoneStatus | undefined, report: NoiseReport, now = Date.now()): boolean {
  if (!settings.suggestions || report.verdict !== 'noisy' || isMicrophoneOn(status)) return false
  if ((settings.dismissals ?? 0) >= MAX_DISMISSALS) return false
  return !settings.suggestedAt || now - settings.suggestedAt >= SUGGEST_EVERY_MS || settings.suggestedAt > now
}

const minutes = (ms: number): string => {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const m = Math.floor(seconds / 60), s = seconds % 60
  return s ? `${m} min ${s} s` : `${m} min`
}

/** The measurement in words, for the suggestion and the microphone check. */
export function describeNoise(report: NoiseReport): string {
  const parts: string[] = []
  if (report.quietMs > 0 && report.noisyMs >= 1000) {
    parts.push(`While nobody was speaking, background noise was loud enough to hear for ${minutes(report.noisyMs)} (${Math.round((report.noisyMs / report.quietMs) * 100)}% of the quiet time).`)
  }
  if (report.bursts >= 3) parts.push(`It also picked up ${report.bursts} short sounds, like typing or clicks.`)
  if (report.snrDb !== undefined && report.snrDb < 28) parts.push(`Your voice was only ${Math.max(0, Math.round(report.snrDb))} dB above the background; a quiet room gives 35 dB or more.`)
  if (!parts.length) parts.push(report.verdict === 'unknown' ? 'There was too little quiet time to measure the background.' : 'The background was quiet.')
  return parts.join(' ')
}
