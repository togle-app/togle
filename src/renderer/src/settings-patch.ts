import type { SettingsPatch } from '@shared/api'
import type { Settings } from '@shared/types'

/**
 * A change laid over the settings the way Togle's main process merges it, for the window to show before main has saved it: a
 * group of settings takes the values given and keeps the rest, and anything else (a value, a list, the AI choice, `null`) is
 * replaced. Main's answer, which comes a moment later, is what stays.
 */
export function withPatch(settings: Settings, patch: SettingsPatch): Settings {
  const next = { ...settings } as Record<string, unknown>
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue
    const was = next[key]
    const group = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item)
    next[key] = key !== 'ai' && group(value) && group(was) ? { ...was, ...value } : value
  }
  return next as unknown as Settings
}
