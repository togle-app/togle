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

async function serve(signer = key, builds = files, tag, intercept) {
  const metadataPath = tag ? 'releases/tags/' + tag : 'release.json'
  const scriptPath = tag ? 'releases/download/' + tag + '/install.ps1' : 'install.ps1'
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1))
    const origin = `http://127.0.0.1:${server.address().port}`
    if (intercept?.(name, req, res)) return
    if (name === scriptPath) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(installers(pub, tag).ps1.replace('https://api.github.com/repos/togle-app/togle', origin))
      return
    }
    if (name === metadataPath) {
      const assets = Object.entries(builds).flatMap(([file, bytes]) => [
        { name: file, size: bytes.length, browser_download_url: origin + '/' + file },
        { name: file + '.sig', size: sign(signer, bytes).length, browser_download_url: origin + '/' + file + '.sig' }
      ])
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
    assert.ok(!script.includes('https://api.github.com/repos/togle-app/togle/releases/latest'))
  }
  assert.match(installers(pub, 'v0.1.0-beta.4').sh, /\[ 'default' = beta \]/)
  assert.match(installers(pub, 'v0.1.0-beta.5').sh, /\[ 'beta' = beta \]/)
})

const powershell = process.platform === 'win32' && spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { windowsHide: true }).status === 0
test('the Windows beta recovers from interrupted downloads and verifies the complete file', { skip: !powershell }, async t => {
  const file = 'Togle.Setup.exe', bytes = Buffer.alloc(192 * 1024, 42), cut = 32768
  const systemCurl = fs.existsSync(path.join(process.env.SystemRoot, 'System32', 'curl.exe'))
  for (const acceptsRange of [true, false]) {
    await t.test(acceptsRange ? 'resume' : 'restart when the server ignores Range', async t => {
      const requests = []
      const tag = 'v0.2.0-beta.1'
      const release = await serve(key, { [file]: bytes }, tag, (name, req, res) => {
        if (name !== file) return false
        const range = req.headers.range
        requests.push(range)
        if (requests.length === 1) {
          res.writeHead(200, { 'Content-Length': bytes.length })
          res.write(bytes.subarray(0, cut), () => setTimeout(() => res.destroy(), 60))
        } else if (range && acceptsRange) {
          res.writeHead(206, { 'Content-Range': 'bytes ' + cut + '-' + (bytes.length - 1) + '/' + bytes.length, 'Content-Length': bytes.length - cut })
          res.end(bytes.subarray(cut))
        } else {
          res.writeHead(200, { 'Content-Length': bytes.length }); res.end(bytes)
        }
        return true
      })
      t.after(release.close)
      const url = release.origin + '/releases/download/' + tag + '/install.ps1'
      const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "iex (irm '" + url + "' -ErrorAction Stop)"],
        { TOGLE_INSTALL_RELEASES: release.url, TOGLE_INSTALL_DRY_RUN: '1' })
      assert.equal(result.code, 0, result.out)
      assert.match(result.out, /Signature checked\./)
      assert.ok(requests.length >= 2)
      assert.equal(requests[0], undefined)
      assert.equal(requests[1], systemCurl ? 'bytes=' + cut + '-' : undefined)
    })
  }
})

test('the stable command explains an empty channel and never installs a prerelease', { skip: !powershell }, async t => {
  const release = await serve(key, files, undefined, (name, req, res) => {
    if (name !== 'prerelease') return false
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ tag_name: 'v0.2.0-beta.1', prerelease: true, assets: [] }))
    return true
  })
  t.after(release.close)
  for (const endpoint of ['missing', 'prerelease']) {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "iex (irm '" + release.origin + "/install.ps1' -ErrorAction Stop)"],
      { TOGLE_INSTALL_RELEASES: release.origin + '/' + endpoint, TOGLE_INSTALL_DRY_RUN: '1' })
    assert.notEqual(result.code, 0)
    assert.match(result.out, /No stable Windows release/)
    assert.doesNotMatch(result.out, /Downloading Togle|Signature checked/)
  }
})

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
  const stableUrl = 'https://togle.app/stable/install.ps1'
  const command = readme.split(/\r?\n/).find(line => line.startsWith('powershell ') && line.includes(stableUrl))
  assert.ok(command, 'a Command Prompt install command in the user guide')
  const fromCmd = (release, script) => run('cmd.exe', ['/d', '/s', '/c', command.replace(stableUrl, new URL(script, release.url).href)],
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

test('the shell installer reports an empty stable channel', { skip: !shell }, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-install-'))
  const script = path.join(folder, 'install.sh')
  fs.writeFileSync(script, installers(pub).sh)
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const release = await serve()
  t.after(() => release.close())
  const result = await run(shell, [script], {
    TOGLE_INSTALL_RELEASES: release.origin + '/missing', TOGLE_INSTALL_PLATFORM: 'linux-x64'
  })
  assert.equal(result.code, 1, result.out)
  assert.match(result.out, /No stable release of Togle Free is available yet/)
})

test('the Linux installer retries a partial download and installs Beta alongside Togle', {
  skip: !shell || process.platform !== 'linux'
}, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-install-'))
  const script = path.join(folder, 'install.sh')
  const dataHome = path.join(folder, 'user data')
  const tag = 'v0.2.0-beta.1'
  const filename = 'Togle-0.2.0-beta.1.AppImage'
  const bytes = Buffer.from('#!/bin/sh\nprintf "app started\\n"\n')
  let attempts = 0
  const stableApp = path.join(dataHome, 'togle', 'Togle.AppImage')
  const stableShortcut = path.join(dataHome, 'applications', 'togle.desktop')
  for (const file of [stableApp, stableShortcut]) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'existing Togle')
  }
  fs.writeFileSync(script, installers(pub, tag).sh)
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))
  const release = await serve(key, { 'Togle-0.2.0-beta.1-arm64.AppImage': bytes, [filename]: bytes }, tag, (name, req, res) => {
    if (name !== filename || ++attempts !== 1) return false
    res.writeHead(200, { 'Content-Length': bytes.length })
    res.write(bytes.subarray(0, 8), () => setTimeout(() => res.destroy(), 60))
    return true
  })
  t.after(() => release.close())
  const result = await run(shell, [script], {
    TOGLE_INSTALL_RELEASES: release.url, TOGLE_INSTALL_PLATFORM: 'linux-x64', XDG_DATA_HOME: dataHome, HOME: folder
  })
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /Togle Beta is installed/)
  assert.equal(attempts, 2)
  assert.deepEqual(fs.readFileSync(path.join(dataHome, 'togle-beta', 'Togle.AppImage')), bytes)
  const launch = path.join(dataHome, 'togle-beta', 'togle-beta')
  assert.ok(fs.readFileSync(path.join(dataHome, 'applications', 'togle-beta.desktop'), 'utf8').includes(`Exec="${launch}"`))
  for (const file of [stableApp, stableShortcut]) assert.equal(fs.readFileSync(file, 'utf8'), 'existing Togle')
  assert.deepEqual(await run(launch, [], {}), { code: 0, out: 'app started\n' })
})

test('the Mac installer verifies the staged app before replacing the existing installation', {
  skip: !shell || process.platform === 'win32'
}, async t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-install-'))
  const script = path.join(folder, 'install.sh')
  const app = path.join(folder, 'Applications', 'Togle.app')
  const commands = path.join(folder, 'bin')
  fs.mkdirSync(app, { recursive: true })
  fs.mkdirSync(commands)
  fs.writeFileSync(path.join(app, 'version.txt'), 'previous')
  fs.writeFileSync(script, installers(pub).sh)
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }))

  // Stand-ins exercise the installer's replacement logic on the Linux test runner.
  fs.writeFileSync(path.join(commands, 'ditto'), '#!/bin/sh\nmkdir "$4/Togle.app"\nprintf "new" > "$4/Togle.app/version.txt"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(commands, 'syspolicy_check'), '#!/bin/sh\nexit "$QA_GATEKEEPER_STATUS"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(commands, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const release = await serve()
  t.after(() => release.close())
  const env = {
    HOME: folder, PATH: commands + path.delimiter + process.env.PATH,
    TOGLE_INSTALL_RELEASES: release.url, TOGLE_INSTALL_PLATFORM: 'darwin-arm64'
  }
  const rejected = await run(shell, [script], { ...env, QA_GATEKEEPER_STATUS: '1' })
  assert.equal(rejected.code, 1, rejected.out)
  assert.match(rejected.out, /macOS could not verify the Togle Free app/)
  assert.equal(fs.readFileSync(path.join(app, 'version.txt'), 'utf8'), 'previous')

  const installed = await run(shell, [script], { ...env, QA_GATEKEEPER_STATUS: '0' })
  assert.equal(installed.code, 0, installed.out)
  assert.equal(fs.readFileSync(path.join(app, 'version.txt'), 'utf8'), 'new')
  assert.deepEqual(fs.readdirSync(path.dirname(app)), ['Togle.app'])
})
