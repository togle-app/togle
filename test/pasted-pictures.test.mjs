// A picture pasted into an agent's screen (pasted-pictures.ts): kept as a file in Togle's own folder, with a name of no
// spaces, as a kind the agents take; anything else refused; deleted after a week.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { workDir } from './helpers.mjs'

const home = workDir('pasted-pictures')
const T = await import('./.build/togle.mjs')
const electron = globalThis.__togleTestElectron
const folder = path.join(home, 'pasted')
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])

test('a pasted picture is kept as a file of its kind, named with no space, and its path comes back', async () => {
  const at = Date.parse('2026-11-18T12:00:00Z')
  const file = await T.savePastedPicture(PNG, 'image/png', at)
  assert.equal(path.dirname(file), folder)
  assert.match(path.basename(file), /^paste-20261118-120000\.png$/)
  assert.deepEqual(new Uint8Array(fs.readFileSync(file)), PNG)
  const again = await T.savePastedPicture(PNG, 'image/png', at)
  assert.notEqual(again, file, 'two in the same second are two files')
  assert.match(path.basename(await T.savePastedPicture(PNG, 'IMAGE/JPEG', at)), /\.jpg$/)
})

test('a bitmap is kept as a PNG; what is no picture, nothing, or too big is refused', async () => {
  electron.nativeImage.createFromBuffer = (data) => ({ isEmpty: () => data[0] !== 66, toPNG: () => Buffer.from(PNG) })
  const file = await T.savePastedPicture(new Uint8Array([66, 77, 1, 2]), 'image/bmp')
  assert.ok(file.endsWith('.png'))
  assert.deepEqual(new Uint8Array(fs.readFileSync(file)), PNG)
  await assert.rejects(T.savePastedPicture(new Uint8Array([1, 2, 3]), 'text/plain'), /not a picture/)
  await assert.rejects(T.savePastedPicture(new Uint8Array(), 'image/png'), /no picture/)
  await assert.rejects(T.savePastedPicture(new Uint8Array(26 * 1024 * 1024), 'image/png'), /too big/)
})

test('a kept picture is read back for the window by its file, and no other file is', async () => {
  const kept = await T.savePastedPicture(PNG, 'image/png', Date.parse('2026-11-18T13:00:00Z'))
  assert.equal(await T.readPastedPicture(kept), 'data:image/png;base64,' + Buffer.from(PNG).toString('base64'))
  assert.equal(await T.readPastedPicture(path.join(folder, 'paste-20990101-000000.png')), null, 'one that is gone is nothing')
  const secret = path.join(home, 'secret.png')
  fs.writeFileSync(secret, PNG)
  assert.equal(await T.readPastedPicture(secret), null, 'a picture elsewhere is not read')
  assert.equal(await T.readPastedPicture(path.join(folder, '..', 'secret.png')), null, 'nor one reached from the folder')
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'x')
  assert.equal(await T.readPastedPicture(path.join(folder, 'notes.txt')), null, 'nor a file of another name')
  assert.equal(await T.readPastedPicture(''), null)
})

test('pictures pasted more than a week ago are deleted; newer ones and other files stay', async () => {
  const now = Date.now()
  fs.mkdirSync(folder, { recursive: true })
  const old = path.join(folder, 'paste-20261101-080000.png')
  const fresh = path.join(folder, 'paste-20261117-080000.png')
  const other = path.join(folder, 'notes.txt')
  for (const file of [old, fresh, other]) fs.writeFileSync(file, 'x')
  const longAgo = new Date(now - T.PASTED_KEEP_MS - 60_000)
  fs.utimesSync(old, longAgo, longAgo)
  fs.utimesSync(other, longAgo, longAgo)
  await T.prunePastedPictures(now)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(fresh), true)
  assert.equal(fs.existsSync(other), true, 'only pictures Togle kept are deleted')
})
