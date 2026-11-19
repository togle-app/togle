// The theme: dark until the person chooses, a word that is not a theme is put right, a window opens in its theme's colors, and both
// palettes keep their text readable (4.5:1) and their symbols visible (3:1) on what they sit on.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-theme-'))
process.env.TOGLE_TEST_USER_DATA = data
const { DEFAULT_THEME, THEME_CHOICES, THEME_COLORS, getSettings, isThemeChoice, loadSettings, updateSettings } = await import('./.build/togle.mjs')
const css = fs.readFileSync(path.join(import.meta.dirname, '../src/renderer/src/design.css'), 'utf8')

test('the window is dark until the person chooses, and a word that is not a theme is put right', async () => {
  assert.equal(DEFAULT_THEME, 'dark')
  assert.deepEqual([...THEME_CHOICES], ['light', 'dark', 'system'])
  // Settings saved before there was a choice (no `appearance`) load as dark.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ tasks: { view: 'cards' } }))
  await loadSettings()
  assert.equal(getSettings().appearance.theme, 'dark')
  for (const theme of ['light', 'system', 'dark']) {
    await updateSettings({ appearance: { theme } })
    assert.equal(getSettings().appearance.theme, theme)
  }
  await updateSettings({ appearance: { theme: 'light' } })
  await updateSettings({ appearance: { theme: 'purple' } })
  assert.equal(getSettings().appearance.theme, 'dark', 'a word that is not one of them is the default')
  assert.equal(isThemeChoice('light') && isThemeChoice('system') && !isThemeChoice('purple') && !isThemeChoice(undefined), true)
  // A hand-edited file with a theme that is not one loads as dark, and one with a good choice keeps it.
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ appearance: { theme: 'solarized' } }))
  await loadSettings()
  assert.equal(getSettings().appearance.theme, 'dark')
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ appearance: { theme: 'light' } }))
  await loadSettings()
  assert.equal(getSettings().appearance.theme, 'light')
})

// The tokens of a palette: the root's (dark), and the ones in the light window's media query.
const tokensIn = (block) => Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((match) => [match[1], match[2].toLowerCase()]))
const darkBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')))
const lightStart = css.indexOf('@media (prefers-color-scheme: light)')
const lightBlock = css.slice(css.indexOf(':root:not([data-hud]) {', lightStart), css.indexOf('}', css.indexOf(':root:not([data-hud]) {', lightStart)))
const dark = tokensIn(darkBlock)
const light = { ...dark, ...tokensIn(lightBlock) }

test('a window opens in the colors of its theme: the page background and the panel, as the stylesheet has them', () => {
  assert.equal(THEME_COLORS.dark.bg, dark.bg)
  assert.equal(THEME_COLORS.dark.surface, dark.surface)
  assert.equal(THEME_COLORS.light.bg, light.bg)
  assert.equal(THEME_COLORS.light.surface, light.surface)
  assert.notEqual(light.bg, dark.bg, 'the light block is the light palette')
})

const luminance = (hex) => {
  const channel = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)))
  return 0.2126 * channel[0] + 0.7152 * channel[1] + 0.0722 * channel[2]
}
const ratio = (a, b) => {
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

test('each palette keeps its text readable (4.5:1) and its symbols visible (3:1) on what they sit on', () => {
  const text = [
    ['ink', 'surface'], ['ink', 'bg'], ['ink', 'raised'], ['ink', 'togle-soft'],
    ['muted', 'surface'], ['muted', 'bg'], ['muted', 'raised'],
    ['togle', 'surface'], ['togle', 'bg'], ['togle', 'togle-soft'],
    ['wait', 'surface'], ['wait', 'bg'], ['wait', 'wait-soft'],
    ['ok', 'surface'], ['ok', 'bg'], ['ok', 'ok-soft'],
    ['danger', 'surface'], ['danger', 'bg'], ['danger', 'danger-soft']
  ]
  for (const [name, palette] of [['dark', dark], ['light', light]]) {
    for (const [front, back] of text) assert.ok(ratio(palette[front], palette[back]) >= 4.5, `${name}: ${front} on ${back} is ${ratio(palette[front], palette[back]).toFixed(2)}:1`)
    // The colors a line, a ring or a dot is drawn in must show against the panel it is on.
    for (const front of ['muted', 'togle', 'wait', 'ok', 'danger']) assert.ok(ratio(palette[front], palette.surface) >= 3, `${name}: a ${front} symbol on the panel`)
  }
  assert.ok(ratio(light.line, light.surface) >= 1.2 && ratio(dark.line, dark.surface) >= 1.2, 'a line can be seen')
})
