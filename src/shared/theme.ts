/** What the person chose in Settings → Appearance: a light window, a dark one, or whichever the system has. */
export type ThemeChoice = 'dark' | 'light' | 'system'

/** In the order Settings shows them. */
export const THEME_CHOICES: readonly ThemeChoice[] = ['light', 'dark', 'system']

/** Dark until the person chooses: it is the look the product is drawn in. */
export const DEFAULT_THEME: ThemeChoice = 'dark'

export const isThemeChoice = (value: unknown): value is ThemeChoice => value === 'dark' || value === 'light' || value === 'system'

/**
 * What a window shows before its page has painted: the page's background and its panel color, as design.css has them (--bg and
 * --surface of each palette; a test keeps the two in step). Without them a window opens on one color and flashes to the other.
 */
export const THEME_COLORS = {
  dark: { bg: '#0f1115', surface: '#171b23' },
  light: { bg: '#eef0f5', surface: '#ffffff' }
} as const
