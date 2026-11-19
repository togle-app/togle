// node-pty's helper program for a Mac comes in its package without the execute bit; scripts/allow-spawn-helper.cjs gives it back (after an
// install and on a packaged app), and that is all it does.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const { allowSpawnHelper, helpersOf } = createRequire(import.meta.url)('../scripts/allow-spawn-helper.cjs')
const work = workDir('spawn-helper')
const only = { skip: process.platform === 'win32' && 'Windows has no execute bit' }
const executable = (file) => (statSync(file).mode & 0o111) === 0o111

function ptyFolder(name) {
  const root = path.join(work, name)
  for (const system of ['darwin-arm64', 'darwin-x64']) {
    mkdirSync(path.join(root, 'prebuilds', system), { recursive: true })
    writeFileSync(path.join(root, 'prebuilds', system, 'spawn-helper'), 'a program')
    chmodSync(path.join(root, 'prebuilds', system, 'spawn-helper'), 0o644)
    writeFileSync(path.join(root, 'prebuilds', system, 'pty.node'), 'a module')
    chmodSync(path.join(root, 'prebuilds', system, 'pty.node'), 0o644)
  }
  return root
}

test('every helper program in a node-pty folder can run afterwards, and nothing else is changed', only, () => {
  const root = ptyFolder('package')
  mkdirSync(path.join(root, 'build', 'Release'), { recursive: true })
  writeFileSync(path.join(root, 'build', 'Release', 'spawn-helper'), 'built here')
  chmodSync(path.join(root, 'build', 'Release', 'spawn-helper'), 0o644)
  assert.equal(helpersOf(root).length, 3, 'two prebuilt, one built from source')
  const changed = allowSpawnHelper(root)
  assert.equal(changed.length, 3)
  for (const file of helpersOf(root)) assert.equal(executable(file), true, file)
  assert.equal(executable(path.join(root, 'prebuilds', 'darwin-arm64', 'pty.node')), false, 'a module is not a program')
  assert.deepEqual(allowSpawnHelper(root), [], 'the second time there is nothing left to change')
})

test('a folder with no helper, or no folder at all, is left alone without a word', only, () => {
  assert.deepEqual(allowSpawnHelper(path.join(work, 'never made')), [])
  const bare = path.join(work, 'bare')
  mkdirSync(path.join(bare, 'prebuilds', 'win32-x64'), { recursive: true })
  writeFileSync(path.join(bare, 'prebuilds', 'win32-x64', 'conpty.node'), 'a module')
  assert.deepEqual(allowSpawnHelper(bare), [])
})

test('on Windows nothing is changed', () => {
  const root = ptyFolder('windows')
  assert.deepEqual(allowSpawnHelper(root, 'win32'), [])
})
