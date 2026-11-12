// Install by command: install.ps1 (Windows PowerShell) and install.sh (a POSIX shell with openssl) read the latest release,
// download the build for the system and its signature, and install only what Togle's release key signed. Here they run
// against a stand-in release served on this computer, checking without installing (TOGLE_INSTALL_DRY_RUN).
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { generate, sign, verify, installers, rsaParameters } from '../scripts/release-key.mjs'

const { key, pub } = generate()
const other = generate()
const files = {
  'Togle.Setup.0.2.0.exe': Buffer.from('a Windows installer, made up'),
  'Togle-0.2.0.AppImage': Buffer.from('a Linux AppImage, made up'),
  'Togle-0.2.0-arm64-mac.zip': Buffer.from('a Mac zip, made up')
}

async function serve(signer = key) {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1))
    if (name === 'release.json') {
      const { port } = server.address()
      const assets = Object.keys(files).flatMap((file) => [file, file + '.sig']).map((file) => ({ name: file, browser_download_url: `http://127.0.0.1:${port}/${file}` }))
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tag_name: 'v0.2.0', assets }, null, 2)); return
    }
    const base = name.replace(/\.sig$/, '')
    if (!files[base]) { res.writeHead(404); res.end(); return }
    res.writeHead(200); res.end(name.endsWith('.sig') ? sign(signer, files[base]) : files[base])
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/release.json`, close: () => server.close() }
}

const run = (command, args, env) => new Promise((resolve) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('close', (code) => resolve({ code, out }))
})

test('the release key signs and checks a file, and the scripts get the key written in', () => {
  const data = Buffer.from('Togle Setup')
  assert.equal(verify(pub, data, sign(key, data)), true)
  assert.equal(verify(pub, Buffer.from('Togle Setup!'), sign(key, data)), false, 'a changed file fails')
  assert.equal(verify(other.pub, data, sign(key, data)), false, 'another key fails')
  const { modulus, exponent } = rsaParameters(pub)
  assert.equal(Buffer.from(modulus, 'base64').length, 384, 'RSA-3072')
  assert.equal(exponent, 'AQAB')
  const { ps1, sh } = installers(pub)
  assert.ok(ps1.includes(modulus) && !ps1.includes('__TOGLE_RELEASE_MODULUS__'))
  assert.ok(sh.includes('-----BEGIN PUBLIC KEY-----') && !sh.includes('__TOGLE_RELEASE_PUBLIC_KEY__'))
})

const powershell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0
test('install.ps1 installs only what the release key signed', { skip: !powershell && 'needs Windows PowerShell' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-install-'))
  const script = path.join(folder, 'install.ps1')
  fs.writeFileSync(script, installers(pub).ps1)
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
  const good = await serve()
  try {
    const result = await run('powershell.exe', args, { TOGLE_INSTALL_RELEASES: good.url, TOGLE_INSTALL_DRY_RUN: '1' })
    assert.equal(result.code, 0, result.out)
    assert.match(result.out, /Downloading Togle v0\.2\.0/)
    assert.match(result.out, /Signature checked\./)
    assert.match(result.out, /Checked, not installed: Togle\.Setup\.0\.2\.0\.exe/)
  } finally { good.close() }
  const forged = await serve(other.key)
  try {
    const result = await run('powershell.exe', args, { TOGLE_INSTALL_RELEASES: forged.url, TOGLE_INSTALL_DRY_RUN: '1' })
    assert.notEqual(result.code, 0)
    assert.match(result.out, /does not match Togle's release key, so nothing was installed/)
  } finally { forged.close() }
  // A script published without its key refuses to run.
  fs.copyFileSync(new URL('../install/install.ps1', import.meta.url), script)
  const bare = await run('powershell.exe', args, { TOGLE_INSTALL_RELEASES: 'http://127.0.0.1:9/never' })
  assert.notEqual(bare.code, 0)
  assert.match(bare.out, /no release key written in/)
})

const shell = ['sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((candidate) => spawnSync(candidate, ['-c', 'command -v openssl && command -v curl'], { windowsHide: true }).status === 0)
test('install.sh installs only what the release key signed, and has no connector yet', { skip: !shell && 'needs a POSIX shell with curl and openssl' }, async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-install-'))
  const script = path.join(folder, 'install.sh')
  fs.writeFileSync(script, installers(pub).sh)
  const good = await serve()
  try {
    const linux = await run(shell, [script], { TOGLE_INSTALL_RELEASES: good.url, TOGLE_INSTALL_DRY_RUN: '1', TOGLE_INSTALL_PLATFORM: 'linux-x64' })
    assert.equal(linux.code, 0, linux.out)
    assert.match(linux.out, /Signature checked\.\nChecked, not installed: Togle-0\.2\.0\.AppImage/)
    const mac = await run(shell, [script], { TOGLE_INSTALL_RELEASES: good.url, TOGLE_INSTALL_DRY_RUN: '1', TOGLE_INSTALL_PLATFORM: 'darwin-arm64' })
    assert.match(mac.out, /Checked, not installed: Togle-0\.2\.0-arm64-mac\.zip/)
    const intel = await run(shell, [script], { TOGLE_INSTALL_RELEASES: good.url, TOGLE_INSTALL_DRY_RUN: '1', TOGLE_INSTALL_PLATFORM: 'darwin-x64' })
    assert.match(intel.out, /has no build for darwin-x64/, 'an Intel Mac never gets the Apple silicon build')
  } finally { good.close() }
  const forged = await serve(other.key)
  try {
    const result = await run(shell, [script], { TOGLE_INSTALL_RELEASES: forged.url, TOGLE_INSTALL_DRY_RUN: '1', TOGLE_INSTALL_PLATFORM: 'linux-x64' })
    assert.notEqual(result.code, 0)
    assert.match(result.out, /does not match Togle's release key, so nothing was installed/)
  } finally { forged.close() }
  const connector = await run(shell, [script, '--connector'], {})
  assert.notEqual(connector.code, 0)
  assert.match(connector.out, /connector, Togle for a server, is not released yet/)
})
