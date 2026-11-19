// Togle's window is left out of screenshots and screen sharing only when the person asks (Settings → Appearance): off by default, a
// word an earlier Togle saved (on, with no switch to turn it off) is not a choice, and what is not a yes or no is the default.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-capture-setting-'))
process.env.TOGLE_TEST_USER_DATA = data
const { getSettings, loadSettings, updateSettings } = await import('./.build/togle.mjs')
const file = path.join(data, 'settings.json')

test('Togle is in screenshots until the person says otherwise', async () => {
  fs.rmSync(file, { force: true })
  await loadSettings()
  assert.equal(getSettings().window.keepOutOfCaptures, false)
  await updateSettings({ window: { keepOutOfCaptures: true } })
  assert.equal(getSettings().window.keepOutOfCaptures, true, 'the switch turns it on')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).window.keepOutOfCaptures, true, 'and it is kept')
  await updateSettings({ window: { keepOutOfCaptures: false } })
  assert.equal(getSettings().window.keepOutOfCaptures, false)
  assert.equal(getSettings().window.alwaysOnTop, true, 'the rest of the window group is as it was')
})

test('what an earlier Togle saved was its default, not a choice: it is not read as one', async () => {
  fs.writeFileSync(file, JSON.stringify({ window: { alwaysOnTop: true, opacity: 1, hideFromCapture: true } }))
  await loadSettings()
  assert.deepEqual(getSettings().window, { alwaysOnTop: true, opacity: 1, keepOutOfCaptures: false }, 'the old word is gone, and Togle shows')
  await updateSettings({ window: { keepOutOfCaptures: 'yes' } })
  assert.equal(getSettings().window.keepOutOfCaptures, false, 'a word that is not a yes or no is the default')
  assert.equal('hideFromCapture' in JSON.parse(fs.readFileSync(file, 'utf8')).window, false, 'and the old word does not come back in the file')
})
