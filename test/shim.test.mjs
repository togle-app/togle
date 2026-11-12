// The togle command ships with the app, and can be run from a copy of the source.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const root = path.resolve(import.meta.dirname, '..')
const read = name => fs.readFileSync(path.join(root, name), 'utf8')

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
  assert.match(read('scripts/after-pack.cjs'), /chmodSync\(command, 0o755\)/, 'and made executable on Mac and Linux')
})

test('from a copy of the source the command is the package\'s bin', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.equal(pkg.bin.togle, 'bin/togle.cjs')
  const launcher = read('bin/togle.cjs')
  assert.ok(launcher.startsWith('#!/usr/bin/env node\n'))
  assert.match(launcher, /ELECTRON_RUN_AS_NODE: '1'/)
  assert.match(launcher, /out', 'main', 'cli\.js'/)
})
