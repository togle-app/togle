// Install by command: install.ps1 (Windows PowerShell) and install.sh (a POSIX shell with openssl) read the latest release,
// download the build for the system and its signature, and install only what Togle's release key signed. Here they run
// against a stand-in release served on this computer. The cmd.exe test runs a signed fixture that only records its arguments.
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

async function serve(signer = key, builds = files, tag) {
  const metadataPath = tag ? 'releases/tags/' + tag : 'release.json'
  const scriptPath = tag ? 'releases/download/' + tag + '/install.ps1' : 'install.ps1'
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1))
    const origin = `http://127.0.0.1:${server.address().port}`
    if (name === scriptPath) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(installers(pub, tag).ps1.replace('https://api.github.com/repos/togle-app/togle', origin))
      return
    }
    if (name === metadataPath) {
      const assets = Object.keys(builds).flatMap((file) => [file, file + '.sig']).map((file) => ({ name: file, browser_download_url: origin + '/' + file }))
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ tag_name: tag ?? 'v0.2.0', assets }, null, 2)); return
    }
    const base = name.replace(/\.sig$/, '')
    if (!builds[base]) { res.writeHead(404); res.end(); return }
    res.writeHead(200); res.end(name.endsWith('.sig') ? sign(signer, builds[base]) : builds[base])
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  return { origin, url: origin + '/' + metadataPath, close: () => server.close() }
}

const run = (command, args, env, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env: { ...process.env, ...env }, windowsHide: true, ...options })
  let out = ''
  child.stdout.on('data', (chunk) => { out += chunk })
  child.stderr.on('data', (chunk) => { out += chunk })
  child.on('error', reject)
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
  assert.throws(() => installers(key), /use the public release key/i)
  for (const script of [ps1, sh]) assert.ok(script.includes('https://api.github.com/repos/togle-app/togle/releases/latest'))
  const pinned = installers(pub, "beta/test'1")
  for (const script of Object.values(pinned)) {
    assert.ok(script.includes('https://api.github.com/repos/togle-app/togle/releases/tags/beta%2Ftest%271'))
    assert.ok(!script.includes('/releases/latest'))
  }
})

const powershell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0
async function windowsSetupFixture(t) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle cmd test '))
  const setup = path.join(folder, 'fixture.exe')
  const marker = path.join(folder, 'arguments.txt')
  t.after(() => {
    for (const file of [setup, marker]) fs.rmSync(file, { force: true })
    fs.rmdirSync(folder)
  })
  const env = { TOGLE_TEST_SETUP: setup, TOGLE_TEST_MARKER: marker, TOGLE_INSTALL_DRY_RUN: '' }
  const fixture = 'public class Setup { public static void Main(string[] args) { System.IO.File.WriteAllLines(System.Environment.GetEnvironmentVariable("TOGLE_TEST_MARKER"), args); } }'
  const compile = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -TypeDefinition '${fixture}' -OutputAssembly $env:TOGLE_TEST_SETUP -OutputType ConsoleApplication -ErrorAction Stop`], env)
  assert.equal(compile.code, 0, compile.out)
  return { env, marker, builds: { 'Togle.Setup.exe': fs.readFileSync(setup) } }
}

test('the GitHub beta command installs its tag when no stable release or website exists', { skip: !powershell && 'needs Windows Command Prompt' }, async (t) => {
  const tag = 'v0.1.0-beta.1'
  const github = 'https://github.com/togle-app/togle'
  const guide = fs.readFileSync(new URL('../docs/releasing.md', import.meta.url), 'utf8')
  const command = guide.split(/\r?\n/).map(line => line.trim()).find(line => line.startsWith('powershell ') && line.includes(github + '/releases/download/' + tag))
  assert.ok(command, 'the Windows command testers get in the release notes')
  const { env, marker, builds } = await windowsSetupFixture(t)
  const beta = await serve(key, builds, tag)
  t.after(beta.close)
  const result = await run('cmd.exe', ['/d', '/s', '/c', command.replace(github, beta.origin)],
    { ...env, TOGLE_INSTALL_RELEASES: '' }, { windowsVerbatimArguments: true })
  assert.equal(result.code, 0, result.out)
  assert.ok(result.out.includes('Downloading Togle ' + tag))
  assert.match(result.out, /Signature checked\./)
  assert.match(result.out, /Togle is installed/)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '/S')
})

test('the documented Command Prompt command runs a signed setup silently and propagates failures', { skip: !powershell && 'needs Windows Command Prompt' }, async (t) => {
  const { env, marker, builds } = await windowsSetupFixture(t)
  const readme = fs.readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const command = readme.split(/\r?\n/).find(line => line.startsWith('powershell ') && line.includes('https://togle.app/install.ps1'))
  assert.ok(command, 'a Command Prompt install command in the user guide')
  const fromCmd = (release, script) => run('cmd.exe', ['/d', '/s', '/c', command.replace('https://togle.app/install.ps1', new URL(script, release.url).href)],
    { ...env, TOGLE_INSTALL_RELEASES: release.url }, { windowsVerbatimArguments: true })

  const good = await serve(key, builds)
  t.after(good.close)
  const installed = await fromCmd(good, 'install.ps1')
  assert.equal(installed.code, 0, installed.out)
  assert.match(installed.out, /Togle is installed/)
  assert.equal(fs.readFileSync(marker, 'utf8').trim(), '/S')
  fs.unlinkSync(marker)

  const forged = await serve(other.key, builds)
  t.after(forged.close)
  const rejected = await fromCmd(forged, 'install.ps1')
  assert.notEqual(rejected.code, 0, rejected.out)
  assert.match(rejected.out, /does not match Togle's release key/)
  assert.equal(fs.existsSync(marker), false)
  const missing = await fromCmd(good, 'missing.ps1')
  assert.notEqual(missing.code, 0, missing.out)
  assert.equal(fs.existsSync(marker), false)
})

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
