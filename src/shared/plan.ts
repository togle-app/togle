import type { PlanWindow } from './types'

/** ChatGPT's settings → Usage: what each app uses of the plan, and its limits there. */
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage'

/** Past this share of a limit, the window says so once. */
export const WARN_AT = 75
/**
 * Past this share of a limit, every job uses the quick answers' model to make the rest last: Codex offers to
 * switch to Luna at the same point.
 */
export const SAVE_AT = 90

/** How a limit reads in "your weekly limit": the length of its window. */
export function limitName(minutes: number): string {
  if (minutes === 7 * 24 * 60) return 'weekly'
  if (minutes === 24 * 60) return 'daily'
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`
  if (minutes % 60 === 0) return `${minutes / 60}-hour`
  return `${minutes}-minute`
}

/** The window closest to its limit: the one that runs out first. */
export function nearestLimit(windows: PlanWindow[]): PlanWindow | undefined {
  return windows.reduce<PlanWindow | undefined>((max, w) => (!max || w.usedPercent > max.usedPercent ? w : max), undefined)
}

/** "at 4:34 PM" today, "Thu at 4:34 PM" this week, "Oct 29 at 4:34 PM" further off. */
export function whenReset(at: number, now = Date.now()): string {
  const date = new Date(at)
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (date.toDateString() === new Date(now).toDateString()) return `at ${time}`
  if (at - now < 6 * 86_400_000) return `${date.toLocaleDateString([], { weekday: 'short' })} at ${time}`
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`
}
