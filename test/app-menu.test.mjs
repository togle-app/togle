// An installed Togle has no Electron menu on Windows and Linux. Electron's own gives the window the browser's keys: Ctrl+R reloads the whole
// window (back to To-do), Ctrl+Shift+R too, Ctrl+W hides it, Ctrl+Plus zooms it, and none of those keys reaches the screen of a task, where
// Claude Code uses Ctrl+R and Ctrl+W itself. macOS has the menu of its own (Edit shortcuts), and a run from the source keeps Electron's
// (Reload and Developer Tools for whoever works on Togle).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const main = fs.readFileSync(path.join(import.meta.dirname, '../src/main/index.ts'), 'utf8')

test('an installed Togle sets no menu off macOS, and the macOS menu is kept', () => {
  assert.match(main, /if \(process\.platform === 'darwin'\) Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(/, 'macOS keeps its menu')
  assert.match(main, /\]\)\)\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*else if \(app\.isPackaged\) Menu\.setApplicationMenu\(null\)/, 'another system, installed: no menu')
  assert.equal((main.match(/Menu\.setApplicationMenu\(/g) ?? []).length, 2, 'and no other place sets it')
})

test('the main window\'s page loading again, or going, is written to the performance log', () => {
  assert.match(main, /perf\.page\('gone', details\.reason\)/)
  assert.match(main, /if \(pageLoads\+\+\) \{\s*restoredFrom = undefined\s*perf\.page\('load'\)/)
})
