import { limitName, nearestLimit, SAVE_AT, whenReset } from '@shared/plan'
import type { PlanUsage, PlanWindow } from '@shared/types'
import type { PlanLimits } from './providers/types'

// The backend turned requests down without saying until when: try again after this long.
const UNKNOWN_RESET_MS = 5 * 60_000
// A limit found reached again within this long of its (estimated) end, with nothing answered in between, is the
// same limit: its end was only estimated again.
const SAME_LIMIT_MS = 30 * 60_000

interface Headers {
  get(name: string): string | null
}

const number = (value: string | null | undefined): number => (value == null || !value.trim() ? NaN : Number(value))

/** The limits an answer's headers report (x-codex-primary-*, x-codex-secondary-*), shortest window first. */
export function windowsFromHeaders(headers: Headers): PlanWindow[] {
  const windows: PlanWindow[] = []
  for (const which of ['primary', 'secondary']) {
    const usedPercent = number(headers.get(`x-codex-${which}-used-percent`))
    const minutes = number(headers.get(`x-codex-${which}-window-minutes`))
    // A window the plan doesn't have comes as zeros.
    if (!Number.isFinite(usedPercent) || !(minutes > 0)) continue
    const resetAt = number(headers.get(`x-codex-${which}-reset-at`))
    windows.push({ usedPercent, minutes, ...(resetAt > 0 ? { resetsAt: resetAt * 1000 } : {}) })
  }
  return windows.sort((a, b) => a.minutes - b.minutes)
}

interface StatusWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

/** The usage status the backend gives Codex's /status (GET /wham/usage), as far as Togle reads it. */
export interface UsageStatus {
  rate_limit?: { allowed?: boolean; primary_window?: StatusWindow | null; secondary_window?: StatusWindow | null } | null
  credits?: { has_credits?: boolean; overage_limit_reached?: boolean } | null
}

/** When the windows that are full start over: the latest of them, since every one needs room again. */
function resetOfFull(windows: PlanWindow[]): number | undefined {
  const full = windows.filter((w) => w.usedPercent >= 100 && w.resetsAt)
  return full.length ? Math.max(...full.map((w) => w.resetsAt!)) : undefined
}

/** The limits in the usage status, and until when requests are turned down, if they are. */
export function readStatus(status: UsageStatus, now = Date.now()): { windows: PlanWindow[]; limitedUntil?: number } {
  const windows: PlanWindow[] = []
  for (const w of [status.rate_limit?.primary_window, status.rate_limit?.secondary_window]) {
    if (!w || typeof w.used_percent !== 'number' || !w.limit_window_seconds) continue
    windows.push({ usedPercent: w.used_percent, minutes: Math.round(w.limit_window_seconds / 60), ...(w.reset_at ? { resetsAt: w.reset_at * 1000 } : {}) })
  }
  windows.sort((a, b) => a.minutes - b.minutes)
  // Credits keep answers coming past the limit.
  const credits = !!status.credits?.has_credits && !status.credits.overage_limit_reached
  if (status.rate_limit?.allowed !== false || credits) return { windows }
  return { windows, limitedUntil: resetOfFull(windows) ?? now + UNKNOWN_RESET_MS }
}

/** A request the backend turned down (HTTP 429): what to tell the user, and until when, if the plan's limit is reached. */
export function readRefusal(body: string, windows: PlanWindow[], now = Date.now()): { message: string; limitedUntil?: number } {
  let error: { type?: string; code?: string; resets_at?: number; resets_in_seconds?: number; limit_window_minutes?: number } = {}
  try {
    error = JSON.parse(body).error ?? {}
  } catch {
    // Not JSON: a plain "too many requests".
  }
  const kind = error.type ?? error.code
  // Sign in with ChatGPT: the plan's limit, or one set for Togle in ChatGPT's settings. It says nothing of when it
  // ends, so automatic answers pause a few minutes, then try again.
  if (kind === 'subscription_sharing_usage_limit_exceeded') {
    return { message: "Usage limit reached on your ChatGPT plan. Review your plan, or Togle's limit, in ChatGPT settings.", limitedUntil: now + UNKNOWN_RESET_MS }
  }
  if (kind === 'usage_limit_reached') {
    const limitedUntil =
      (error.resets_at ? error.resets_at * 1000 : undefined) ??
      (error.resets_in_seconds ? now + error.resets_in_seconds * 1000 : undefined) ??
      resetOfFull(windows) ??
      now + UNKNOWN_RESET_MS
    const minutes = error.limit_window_minutes ?? windows.find((w) => w.usedPercent >= 100)?.minutes
    return {
      message: `You've reached your ChatGPT plan's ${minutes ? `${limitName(minutes)} ` : ''}limit. It starts over ${whenReset(limitedUntil, now)}.`,
      limitedUntil
    }
  }
  if (kind === 'usage_not_included') return { message: "Your ChatGPT plan doesn't include use in other apps like Togle." }
  return { message: 'ChatGPT is getting too many requests at once. Try again in a moment.' }
}

/**
 * The ChatGPT plan's usage as the backend reports it: in every answer's headers, when it turns a request down,
 * and in the usage status Togle asks for (which costs nothing). It decides when to spend less (near the limit)
 * and when automatic requests wait (the limit is reached).
 */
export class PlanWatch implements PlanLimits {
  private windows: PlanWindow[] = []
  private limitedUntil?: number
  private limitedSince?: number
  /** The window closest to its limit as the call started; 'pending' until the first figures come in. */
  private callStart?: PlanWindow | 'pending'
  private shown = ''
  /** Told whenever what the window shows changes. */
  onChange?: (usage: PlanUsage) => void

  /** `savingModel`: the name of the model every job uses near the limit, or nothing when saving is turned off. */
  constructor(private savingModel: () => string | undefined) {}

  /** An answer's headers: the windows as they stand. One that was answered means the limit isn't reached (any more). */
  seen(headers: Headers, answered: boolean): void {
    const windows = windowsFromHeaders(headers)
    if (windows.length) this.fresh(windows)
    if (answered) this.limit(undefined)
    this.update()
  }

  /** The usage status the backend gave when asked. */
  status(status: UsageStatus, now = Date.now()): void {
    const read = readStatus(status, now)
    if (read.windows.length) this.fresh(read.windows)
    this.limit(read.limitedUntil, now)
    this.update()
  }

  /** A request turned down (HTTP 429): what to tell the user. A reached limit holds until it starts over. */
  refused(body: string, now = Date.now()): string {
    const refusal = readRefusal(body, this.windows, now)
    if (refusal.limitedUntil) this.limit(refusal.limitedUntil, now)
    this.update()
    return refusal.message
  }

  /** A call started: its share counts from the next figures (asked for now: the last ones may be hours old). */
  callStarted(): void {
    this.callStart = 'pending'
    this.update()
  }

  /** Signed out: nothing is known about the next plan. */
  clear(): void {
    this.windows = []
    this.limit(undefined)
    this.callStart = undefined
    this.update()
  }

  limited(now = Date.now()): number | undefined {
    return this.limitedUntil && this.limitedUntil > now ? this.limitedUntil : undefined
  }

  saving(): string | undefined {
    return (nearestLimit(this.windows)?.usedPercent ?? 0) >= SAVE_AT ? this.savingModel() : undefined
  }

  usage(now = Date.now()): PlanUsage {
    const limitedUntil = this.limited(now)
    return { windows: this.windows, limitedUntil, limitedSince: limitedUntil && this.limitedSince, saving: this.saving(), call: this.callShare() }
  }

  /**
   * The limit is reached until then, or isn't (undefined: an answer came through, or the status says so). Found
   * reached again after that, or long after its end, it's a new one.
   */
  private limit(until: number | undefined, now = Date.now()): void {
    const ended = this.limitedUntil
    if (until && (ended === undefined || now - ended > SAME_LIMIT_MS)) this.limitedSince = now
    this.limitedUntil = until
  }

  /** Figures that just came in: a call that started waits for the first of them to count its share from. */
  private fresh(windows: PlanWindow[]): void {
    this.windows = windows
    if (this.callStart === 'pending') this.callStart = nearestLimit(windows) ?? 'pending'
  }

  /** Tells the window when what it shows changed (also after a setting it depends on changed). */
  update(): void {
    const usage = this.usage()
    const shown = JSON.stringify(usage)
    if (shown === this.shown) return
    this.shown = shown
    this.onChange?.(usage)
  }

  /** How many percentage points of its window the call has used: since the window started over, if it did meanwhile. */
  private callShare(): number | undefined {
    const start = this.callStart
    if (!start || start === 'pending') return undefined
    const now = this.windows.find((w) => w.minutes === start.minutes)
    if (!now) return undefined
    return now.resetsAt === start.resetsAt ? Math.max(0, now.usedPercent - start.usedPercent) : now.usedPercent
  }
}
