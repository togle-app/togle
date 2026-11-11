import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('changes')
const T = await import('./.build/togle.mjs')

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-changes-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const git = (folder, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.test', '-c', 'commit.gpgsign=false', '-C', folder, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const repo = () => {
  const dir = scratch()
  git(dir, 'init', '-q', '-b', 'main')
  return dir
}

test('git status in its machine form is read into states and paths, and a rename has its old path after', () => {
  const raw = ' M src/a.ts\0A  src/b.ts\0?? notes with spaces.md\0R  new-name.ts\0old-name.ts\0 D gone.ts\0'
  assert.deepEqual(T.parseStatus(raw), [
    { code: ' M', path: 'src/a.ts' }, { code: 'A ', path: 'src/b.ts' }, { code: '??', path: 'notes with spaces.md' }, { code: 'R ', path: 'new-name.ts' }, { code: ' D', path: 'gone.ts' }
  ])
  assert.deepEqual(T.parseStatus(''), [])
})

test('a long diff is cut at the end of a file, and says so', () => {
  const file = (name, size) => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n${'+x'.repeat(size)}\n`
  const diff = file('one.txt', 40) + file('two.txt', 40) + file('three.txt', 40)
  assert.deepEqual(T.cutDiff(diff, 100000), { diff, truncated: false })
  // Whole files are kept while they fit; the one that goes past the limit is left out.
  const cut = T.cutDiff(diff, diff.indexOf('diff --git a/three.txt') + 10)
  assert.equal(cut.truncated, true)
  assert.ok(cut.diff.endsWith('\n') && cut.diff.includes('one.txt') && cut.diff.includes('two.txt') && !cut.diff.includes('three.txt'), cut.diff)
  assert.ok(T.cutDiff(diff, diff.indexOf('diff --git a/two.txt') + 10).diff.includes('one.txt') && !T.cutDiff(diff, diff.indexOf('diff --git a/two.txt') + 10).diff.includes('two.txt'))
  assert.equal(T.cutDiff('x'.repeat(500), 100).diff.length, 100, 'one long file is cut where it stands')
})

test('a folder that is not in a repository says so in words', { skip: !hasGit && 'git is not installed' }, async () => {
  const none = await T.changesIn(scratch())
  assert.equal(none.git, false)
  assert.match(none.problem, /not in a git repository/)
  assert.deepEqual([none.files, none.diff, none.truncated], [[], '', false])
})

test('what differs from the last commit is listed with its lines, and shown as a diff', { skip: !hasGit && 'git is not installed' }, async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'keep.txt'), 'one\ntwo\nthree\n')
  writeFileSync(path.join(dir, 'edit.txt'), 'a\nb\nc\nd\n')
  writeFileSync(path.join(dir, 'remove.txt'), 'x\ny\n')
  writeFileSync(path.join(dir, 'move.txt'), 'this file keeps its words\nand a second line\nand a third\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  assert.deepEqual((await T.changesIn(dir)).files, [], 'nothing changed yet')
  assert.equal((await T.changesIn(dir)).branch, 'main')

  writeFileSync(path.join(dir, 'edit.txt'), 'a\nB\nc\nd\ne\n')
  rmSync(path.join(dir, 'remove.txt'))
  git(dir, 'mv', 'move.txt', 'moved.txt')
  mkdirSync(path.join(dir, 'sub dir'))
  writeFileSync(path.join(dir, 'sub dir', 'new file.txt'), 'brand new\nsecond\n')
  writeFileSync(path.join(dir, 'binary.bin'), Buffer.from([1, 2, 0, 3, 0, 4]))
  writeFileSync(path.join(dir, 'staged.txt'), 'staged\n')
  git(dir, 'add', 'staged.txt')

  const result = await T.changesIn(dir)
  assert.equal(result.git, true)
  assert.equal(result.truncated, false)
  const by = Object.fromEntries(result.files.map((f) => [f.path, f]))
  assert.deepEqual(Object.keys(by).sort(), ['binary.bin', 'edit.txt', 'moved.txt', 'remove.txt', 'staged.txt', 'sub dir/new file.txt'])
  assert.deepEqual([by['edit.txt'].status, by['edit.txt'].added, by['edit.txt'].removed], ['modified', 2, 1])
  assert.deepEqual([by['remove.txt'].status, by['remove.txt'].added, by['remove.txt'].removed], ['deleted', 0, 2])
  assert.equal(by['moved.txt'].status, 'renamed')
  assert.deepEqual([by['sub dir/new file.txt'].status, by['sub dir/new file.txt'].added, by['sub dir/new file.txt'].removed], ['new', 2, 0])
  assert.deepEqual([by['binary.bin'].status, by['binary.bin'].added, by['binary.bin'].removed], ['new', null, null], 'a file that is not text has no lines to count')
  assert.deepEqual([by['staged.txt'].status, by['staged.txt'].added], ['added', 1], 'a file added to git but never committed')
  assert.ok(result.diff.includes('diff --git a/edit.txt b/edit.txt'))
  assert.ok(result.diff.includes('-b\n+B'), 'the change itself')
  assert.ok(result.diff.includes('diff --git a/sub dir/new file.txt b/sub dir/new file.txt\nnew file\n--- /dev/null\n+++ b/sub dir/new file.txt\n@@ -0,0 +1,2 @@\n+brand new\n+second'), 'a new file is shown as all added')
  assert.ok(result.diff.includes('Binary file binary.bin'))
  assert.ok(result.diff.includes('-x\n-y'), 'what was deleted')
})

test('a repository with no commit yet lists its files as new', { skip: !hasGit && 'git is not installed' }, async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'first.txt'), 'hello\n')
  const result = await T.changesIn(dir)
  assert.equal(result.git, true)
  assert.deepEqual(result.files, [{ path: 'first.txt', status: 'new', added: 1, removed: 0 }])
  assert.ok(result.diff.includes('+hello'))
})

test('a big new file is shown only in part, and a big diff is cut', { skip: !hasGit && 'git is not installed' }, async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'start.txt'), 'x\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  writeFileSync(path.join(dir, 'big.txt'), 'line of text\n'.repeat(5000))
  const result = await T.changesIn(dir)
  assert.deepEqual(result.files, [{ path: 'big.txt', status: 'new', added: 5000, removed: 0 }], 'its lines are counted in all of it')
  assert.ok(result.diff.includes('the rest of the file is not shown'))
  assert.ok(result.diff.length < 30000, 'but only the first part is shown: ' + result.diff.length)
  const shown = /@@ -0,0 \+1,(\d+) @@/.exec(result.diff)
  assert.ok(shown && Number(shown[1]) < 5000 && result.diff.split('\n+line of text').length - 1 === Number(shown[1]), 'the header counts what is shown')
  assert.ok(!result.diff.includes('+line of tex\n'), 'a line cut in the middle is left out')
})

test('what a repository\'s own settings could start is not started', { skip: !hasGit && 'git is not installed' }, async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  const outside = scratch()
  const marker = path.join(outside, 'RAN.txt')
  const script = path.join(outside, 'hook.cjs')
  writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('\\0')`)
  // The three ways a repository can make git start a program when it only reads.
  git(dir, 'config', 'core.fsmonitor', `node "${script.replace(/\\/g, '/')}"`)
  git(dir, 'config', 'diff.external', `node "${script.replace(/\\/g, '/')}"`)
  git(dir, 'config', 'core.pager', `node "${script.replace(/\\/g, '/')}"`)
  writeFileSync(path.join(dir, 'a.txt'), 'a\nchanged\n')
  const result = await T.changesIn(dir)
  assert.equal(result.git, true)
  assert.equal(result.files.length, 1)
  assert.equal(existsSync(marker), false, 'nothing the repository asked for was run')
})

test('the window can ask what a task changed, by its key, and an unknown task is refused', async () => {
  const dir = repo()
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  class Backend {
    constructor() { this.runner = 'claude' }
    async detect() { return { installed: true, version: '1' } }
    async list() { return [{ id: 'listed', runner: 'claude', title: 'Listed', folder: dir, state: 'idle', updatedAt: 1 }] }
    async close() {}
  }
  const hub = new T.RunnerHub({ backends: [new Backend()], changed() {}, cacheMs: 60000 })
  try {
    assert.equal((await hub.changes('claude:listed')).files[0].path, 'a.txt')
    await assert.rejects(hub.changes('claude:nope'), /gone/)
  } finally {
    await hub.dispose()
  }
})
