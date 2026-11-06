import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { finished } from 'node:stream/promises'
const require = createRequire(import.meta.url)
const T = require('../scripts/build-tools.cjs')
const asar = require('@electron/asar')

test('installers carry no audio driver and need no administrator', () => {
  const config = require('js-yaml').load(fs.readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'))
  const targets = config.mac.target.map(target => typeof target === 'string' ? target : target.target)
  assert.deepEqual(targets, ['dmg', 'zip'], 'macOS ships the app alone: Togle Microphone brings its own driver')
  assert.equal(config.pkg, undefined)
  assert.equal(config.nsis.include, undefined, 'the Windows installer runs no driver setup')
  assert.equal(config.nsis.perMachine, false, 'Windows installs for the user, without administrator rights')
  const resources = JSON.stringify(config.extraResources)
  for (const driver of ['audio-prepared', 'audio-source', 'vb-cable', 'voice-isolation']) assert.ok(!resources.includes(driver), driver)
  assert.ok(!config.deb.depends.includes('pulseaudio-utils'), 'capture goes through Chromium, not pactl')
})

function fixture(t) {
  const prefix = path.join(fs.realpathSync(os.tmpdir()), 'togle-build-check-')
  const root = fs.mkdtempSync(prefix)
  const write = (name, value = name) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
  t.after(() => {
    assert.ok(root.startsWith(prefix) && fs.realpathSync(root) === root)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })
  write('package.json', JSON.stringify({ name: 'togle', version: '0.1.0' }))
  for (const name of ['src/main.ts', 'build/icon.png', 'build/icon.ico', 'resources/dictation-windows.ps1', 'resources/licenses/test.txt', 'hub-template/index.json']) write(name)
  for (const name of ['main/index.js', 'main/reader-worker.js', 'main/parakeet-worker.js', 'main/whisper-worker.js', 'main/voice-worker.js', 'preload/index.js', 'renderer/index.html', 'renderer/pcm-tap.js', 'renderer/assets/current.js']) write('out/' + name)
  return { root, write }
}

test('clean build removes old compiled output and installers while preserving source and app data', t => {
  const { root, write } = fixture(t)
  write('out/main/removed-worker.js'); write('dist/Old Setup.exe'); write('dist/latest.yml'); write('profile/settings.json', 'kept')
  T.cleanDirectory(path.join(root, 'out'), root); T.cleanDirectory(path.join(root, 'dist'), root)
  assert.equal(fs.existsSync(path.join(root, 'out')), false); assert.equal(fs.existsSync(path.join(root, 'dist')), false)
  assert.equal(fs.readFileSync(path.join(root, 'profile/settings.json'), 'utf8'), 'kept')
  assert.equal(fs.readFileSync(path.join(root, 'src/main.ts'), 'utf8'), 'src/main.ts')
})

test('cleanup refuses the project, unowned folders and symlinks instead of deleting their targets', t => {
  const { root, write } = fixture(t)
  write('unrelated/keep.txt', 'kept')
  assert.throws(() => T.cleanDirectory(root, root), /unsafe/)
  assert.throws(() => T.cleanDirectory(path.dirname(root), root), /unsafe/)
  assert.throws(() => T.cleanDirectory(path.join(root, 'unrelated'), root), /not owned/)
  const link = path.join(root, 'dist')
  fs.symlinkSync(path.join(root, 'unrelated'), link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => T.cleanDirectory(link, root), /symlink/)
  assert.equal(fs.readFileSync(path.join(root, 'unrelated/keep.txt'), 'utf8'), 'kept')
})

test('a custom output can be cleaned only after this checkout has marked ownership', t => {
  const { root, write } = fixture(t), output = path.join(root, 'custom-output')
  write('custom-output/old-installer.exe')
  assert.throws(() => T.cleanDirectory(output, root), /not owned/)
  T.markOutput(output, root); T.cleanDirectory(output, root)
  assert.equal(fs.existsSync(output), false)
})

test('provenance rejects source/resource edits, altered chunks and added stale files', t => {
  const { root, write } = fixture(t), manifest = T.writeManifest(root)
  assert.equal(T.checkBuild(root).id, manifest.id)
  write('out/main/removed-worker.js')
  assert.throws(() => T.checkBuild(root), /added or missing/)
  fs.unlinkSync(path.join(root, 'out/main/removed-worker.js'))
  write('out/renderer/assets/current.js', 'changed')
  assert.throws(() => T.checkBuild(root), /output changed/)
  write('out/renderer/assets/current.js', 'out/renderer/assets/current.js')
  write('resources/dictation-windows.ps1', 'new insertion helper')
  assert.throws(() => T.checkBuild(root), /stale/)
  write('resources/dictation-windows.ps1', 'resources/dictation-windows.ps1')
  write('src/main.ts', 'new source')
  assert.throws(() => T.checkBuild(root), /stale/)
})

test('downloaded speech models do not invalidate or enter the build manifest', t => {
  const { root, write } = fixture(t), before = T.sourceHash(root)
  write('resources/whisper/model.bin', 'downloaded model')
  assert.equal(T.sourceHash(root), before)
  const manifest = T.writeManifest(root)
  assert.ok(!Object.keys(manifest.resources).some(name => name.includes('whisper')))
})

test('build replacement detects an active app using that output', t => {
  const { root } = fixture(t), output = path.join(root, 'dist')
  assert.throws(() => T.assertNotRunning(output, [{ pid: 123, file: path.join(output, 'win-unpacked/Togle.exe') }]), /Quit it from the tray/)
  assert.doesNotThrow(() => T.assertNotRunning(output, [{ pid: 123, file: path.join(root, 'other/Togle.exe') }]))
})

test('package verification rejects development artifacts, stale files and an outdated helper', async t => {
  const { root, write } = fixture(t), manifest = T.writeManifest(root)
  const stage = path.join(root, 'package-input'), resources = path.join(root, 'package/resources')
  fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(resources, { recursive: true })
  fs.cpSync(path.join(root, 'out'), path.join(stage, 'out'), { recursive: true })
  for (const [source, target] of [['build/icon.png', 'icon.png'], ['build/icon.ico', 'icon.ico'], ['resources/dictation-windows.ps1', 'dictation-windows.ps1'], ['resources/licenses/test.txt', 'licenses/test.txt'], ['hub-template/index.json', 'hub-template/index.json']]) {
    fs.mkdirSync(path.dirname(path.join(resources, target)), { recursive: true }); fs.copyFileSync(path.join(root, source), path.join(resources, target))
  }
  const runtime = path.join('package/resources/app.asar.unpacked/node_modules')
  write(path.join(runtime, '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude'), 'fixture only')
  write(path.join(runtime, `sherpa-onnx-${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`, 'sherpa-onnx.node'), 'fixture only')
  const archive = path.join(resources, 'app.asar')
  // asar 3 returns its WriteStream before the last writes finish. Reading it immediately races on macOS.
  const pack = async () => { await finished(await asar.createPackage(stage, archive)); asar.uncache(archive) }
  await pack()
  assert.equal(T.verifyPackage(resources, root).id, manifest.id)
  write('package-input/test/calibration-fixture.txt', 'development fixture')
  await pack()
  assert.throws(() => T.verifyPackage(resources, root), /development artifact/)
  fs.unlinkSync(path.join(stage, 'test/calibration-fixture.txt'))
  fs.rmdirSync(path.join(stage, 'test'))
  write('package-input/out/main/obsolete-worker.js', 'stale code')
  await pack()
  assert.throws(() => T.verifyPackage(resources, root), /stale compiled files/)
  fs.unlinkSync(path.join(stage, 'out/main/obsolete-worker.js'))
  await pack()
  write('package/resources/dictation-windows.ps1', 'old helper')
  assert.throws(() => T.verifyPackage(resources, root), /resource differs/)
})
