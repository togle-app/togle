// The id Windows knows Togle by: the installed app has the builder's appId (its Start menu shortcut carries it), a run from the source has
// another, and the main process takes it from app-id.ts. An id written out in index.ts would give a source run the installed app's id
// again, and a Start menu entry for Electron's exe could take the installed Togle's name and icon (it did).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const { APP_ID, appUserModelId } = await import('./.build/togle.mjs')
const root = path.join(import.meta.dirname, '..')

test("the installed app has the builder's appId, and a run from the source has an id of its own", () => {
  const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8')
  const appId = /^appId:\s*(\S+)\s*$/m.exec(builder)?.[1]
  assert.ok(appId, 'the builder names an appId')
  assert.equal(APP_ID, appId)
  assert.equal(appUserModelId(true), appId, 'the installed app has the id its shortcut carries')
  assert.notEqual(appUserModelId(false), appUserModelId(true), 'a run from the source has another')
  // What Windows accepts as an id: no spaces, at most 128 characters.
  for (const id of [appUserModelId(true), appUserModelId(false)]) assert.ok(/^[A-Za-z0-9.-]+$/.test(id) && id.length <= 128, id + ' is a valid id')
})

test('the main process takes its id from app-id.ts and writes none out', () => {
  const main = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
  assert.equal(/setAppUserModelId\(appUserModelId\(app\.isPackaged\)\)/.test(main), true, 'it asks for the id of this run')
  assert.equal(/setAppUserModelId\(\s*['"`]/.test(main), false, 'and has no id of its own in index.ts')
})
