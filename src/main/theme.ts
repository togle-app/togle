import { nativeTheme } from 'electron'
import { THEME_COLORS } from '@shared/theme'
import type { ThemeChoice } from '@shared/theme'

/** The colors a window shows until its page has painted, for the theme the windows have now (what Settings chose, or the system's). */
export const themeColors = (): (typeof THEME_COLORS)[keyof typeof THEME_COLORS] => (nativeTheme.shouldUseDarkColors ? THEME_COLORS.dark : THEME_COLORS.light)

/**
 * Tells every page which theme it has: their `prefers-color-scheme` follows it, and design.css draws the light or the dark window from
 * that, the moment it changes. Called before any window exists, so none opens in the wrong one, and again when Settings change it.
 */
export function applyTheme(choice: ThemeChoice): void {
  nativeTheme.themeSource = choice
}
