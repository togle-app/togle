// Togle's own updates: only a newer release, only the build for this system, and only once it is signed by the release
// key; a forged one is never written to disk, and a file changed after the check never runs.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generate, sign } from '../scripts/release-key.mjs'

const { Updates, newer, assetFor } = await import('./.build/togle.mjs')

test('which version is newer, and which build is for this system', () => {
  assert.equal(newer('v0.2.0', '0.1.0'), true)
  assert.equal(newer('0.1.10', '0.1.9'), true)
  assert.equal(newer('v0.1.0', '0.1.0'), false)
  assert.equal(newer('0.1.0', '0.2.0'), false)
  assert.equal(newer('0.2.0', '0.2.0-beta.1'), true, 'a release is newer than its pre-release')
  assert.equal(newer('0.2.0-beta.1', '0.1.9'), true)
  const assets = ['Togle.Setup.0.2.0.exe', 'Togle.Setup.0.2.0.exe.sig', 'Togle-0.2.0-arm64-mac.zip', 'Togle-0.2.0-arm64-mac.zip.sig', 'Togle-0.2.0-mac.zip', 'Togle-0.2.0-mac.zip.sig', 'Togle-0.2.0.AppImage', 'Togle-0.2.0.AppImage.sig', 'togle_0.2.0_amd64.deb']
    .map((name) => ({ name, browser_download_url: 'https://example.test/' + name }))
  assert.equal(assetFor('win32', 'x64', assets).build.name, 'Togle.Setup.0.2.0.exe')
  assert.equal(assetFor('darwin', 'arm64', assets).build.name, 'Togle-0.2.0-arm64-mac.zip')
  assert.equal(assetFor('darwin', 'x64', assets).build.name, 'Togle-0.2.0-mac.zip', 'an Intel Mac never gets the Apple silicon build')
  assert.equal(assetFor('linux', 'x64', assets).signature.name, 'Togle-0.2.0.AppImage.sig')
  assert.equal(assetFor('linux', 'arm64', assets), undefined)
  assert.equal(assetFor('win32', 'x64', assets.filter((asset) => !asset.name.endsWith('.sig'))), undefined, 'no signature, no update')
})

function release(files, signer) {
  const assets = Object.keys(files).flatMap((name) => [name, name + '.sig']).map((name) => ({ name, browser_download_url: 'https://example.test/' + name }))
  const fetch = async (url) => {
    if (url === 'https://example.test/latest') return new Response(JSON.stringify({ tag_name: 'v0.2.0', assets }))
    const name = url.split('/').pop(), base = name.replace(/\.sig$/, '')
    if (!files[base]) return new Response('', { status: 404 })
    return new Response(name.endsWith('.sig') ? sign(signer, files[base]) : files[base])
  }
  return fetch
}

test('a signed update waits, checked; a forged one is refused and never saved; a changed file never runs', async () => {
  const { key, pub } = generate()
  const forger = generate()
  const files = { 'Togle.Setup.0.2.0.exe': Buffer.from('the next Togle, made up') }
  const states = []
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-updates-'))
  const make = (fetch, current = '0.1.0', keyPem = pub) => new Updates({ current, key: keyPem, folder, releases: 'https://example.test/latest', fetch, changed: (state) => states.push(state.phase), platform: 'win32', arch: 'x64' })

  const off = make(release(files, key), '0.1.0', '')
  await off.check()
  assert.equal(off.status().phase, 'off', 'no release key: Togle never looks')

  const current = make(release(files, key), '0.2.0')
  await current.check()
  assert.equal(current.status().phase, 'none', 'already the newest')

  const forged = make(release(files, forger.key))
  await forged.check()
  assert.equal(forged.status().phase, 'refused')
  assert.match(forged.status().message, /isn't signed by Togle's release key, so it was deleted and nothing was installed/)
  assert.deepEqual(fs.readdirSync(folder), [], 'nothing forged is written')
  await assert.rejects(forged.install(), /No checked update/)

  const good = make(release(files, key))
  await good.check()
  assert.deepEqual([good.status().phase, good.status().version], ['ready', '0.2.0'])
  const next = await good.install()
  assert.equal(next.after, 'quit-and-run')
  assert.deepEqual(next.args, ['/S', '--force-run'], 'quietly, and Togle opens again')
  assert.equal(fs.readFileSync(next.file, 'utf8'), 'the next Togle, made up')
  fs.writeFileSync(next.file, 'something else')
  await assert.rejects(good.install(), /changed after it was checked/)
  assert.deepEqual(states.filter((phase) => phase !== 'checking' && phase !== 'downloading'), ['none', 'refused', 'ready'])
})
