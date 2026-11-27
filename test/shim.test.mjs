// The togle command ships with the app, and can be run from a copy of the source.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')

test('Windows setup registers and removes its own CLI path across upgrades', { skip: process.platform !== 'win32' }, () => {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(root, 'test', 'windows-cli-path.ps1')], { windowsHide: true })
})

test('the togle command ships beside the app and runs the program inside it as plain Node', () => {
  const windows = read('resources/bin/togle.cmd')
  assert.match(windows, /ELECTRON_RUN_AS_NODE=1/)
  assert.match(windows, /Togle\.exe/)
  assert.match(windows, /app\.asar.out.main.cli\.js/)
  const unix = read('resources/bin/togle')
  assert.ok(unix.startsWith('#!/bin/sh\n'), 'a shell script with Unix line endings')
  assert.match(unix, /ELECTRON_RUN_AS_NODE=1/)
  assert.match(unix, /app\.asar\/out\/main\/cli\.js/)
  assert.match(read('electron-builder.yml'), /from: resources\/bin\r?\n\s+to: bin/, 'copied into the app, beside its resources')
  assert.match(read('.gitattributes'), /resources\/bin\/togle text eol=lf/, 'and kept with Unix line endings on every system')
  // A beta build gives the command its own name (togle-beta) before this, so the name is the one it has there.
  assert.match(read('scripts/after-pack.cjs'), /if \(target\.platform !== 'win32'\) fs\.chmodSync\(path\.join\(bin, beta \? 'togle-beta' : 'togle'\), 0o755\)/, 'and made executable on Mac and Linux')
})

test('from a copy of the source the command is the package\'s bin', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.bin.togle, 'bin/togle.cjs')
  const launcher = read('bin/togle.cjs')
  assert.ok(launcher.startsWith('#!/usr/bin/env node\n'))
  assert.match(launcher, /ELECTRON_RUN_AS_NODE: '1'/)
  assert.match(launcher, /out', 'main', 'cli\.js'/)
})
