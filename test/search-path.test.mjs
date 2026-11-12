import assert from 'node:assert/strict'
import { test } from 'node:test'
const T = await import('./.build/togle.mjs')

// Where agents are looked for: what the person's terminal would have, added to the PATH Togle started with.

test('a saved PATH is read with its %NAMES% filled in, and a name that is not set leaves its folder out', () => {
  assert.deepEqual(T.pathFolders('%USERPROFILE%\\.local\\bin;C:\\Tools;;%NOT_SET%\\bin;C:\\Users\\Željko\\AppData\\Roaming\\npm', { USERPROFILE: 'C:\\Users\\Željko' }), ['C:\\Users\\Željko\\.local\\bin', 'C:\\Tools', 'C:\\Users\\Željko\\AppData\\Roaming\\npm'])
  assert.deepEqual(T.pathFolders('', {}), [])
})

test('the PATH a login shell prints is read between its marks, whatever else the shell says when it starts', () => {
  assert.deepEqual(T.shellPath('Welcome back!\nLast login: today\n__TOGLE_PATH__/opt/homebrew/bin:/Users/someone/.local/bin:/usr/bin__TOGLE_PATH__'), ['/opt/homebrew/bin', '/Users/someone/.local/bin', '/usr/bin'])
  assert.deepEqual(T.shellPath('zsh: no such option'), [])
  assert.deepEqual(T.shellPath(''), [])
})

test('folders are added after the ones there are, once each; Windows compares without case or a last slash', () => {
  assert.deepEqual(
    T.mergedPath(['C:\\Windows', 'C:\\Users\\A\\.local\\bin\\'], ['c:\\windows', 'C:\\Users\\A\\.local\\bin', 'C:\\Users\\A\\AppData\\Roaming\\npm', 'C:\\Users\\A\\AppData\\Roaming\\npm'], true),
    ['C:\\Windows', 'C:\\Users\\A\\.local\\bin\\', 'C:\\Users\\A\\AppData\\Roaming\\npm']
  )
  assert.deepEqual(T.mergedPath(['/usr/bin'], ['/usr/bin/', '/USR/BIN', '/opt/homebrew/bin', ''], false), ['/usr/bin', '/USR/BIN', '/opt/homebrew/bin'], 'elsewhere, case counts')
})

// A login shell can run start-up files that wait for ever: what it prints is read, and it never holds Togle up.
const node = (script) => [process.execPath, ['-e', script]]
const gone = (pid) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

test('what a program prints is read to its end, or until what is needed is there', async () => {
  const [file, args] = node("process.stdout.write('__TOGLE_PATH__/a:/b__TOGLE_PATH__')")
  assert.equal(await T.outputOf(file, args, 10_000), '__TOGLE_PATH__/a:/b__TOGLE_PATH__')
  // It prints what is needed, then waits: that is enough, without waiting for it.
  const [waits, waitsArgs] = node("process.stdout.write('__TOGLE_PATH__/c__TOGLE_PATH__'); setInterval(() => {}, 1000)")
  const began = Date.now()
  const output = await T.outputOf(waits, waitsArgs, 10_000, (printed) => T.shellPath(printed).length > 0)
  assert.deepEqual(T.shellPath(output), ['/c'])
  assert.ok(Date.now() - began < 5_000, `read as soon as it was there (${Date.now() - began} ms)`)
})

test('a program that prints nothing and never ends is given up on in time, and stopped', async () => {
  const [file, args] = node("process.stdout.write(String(process.pid) + '\\n'); setInterval(() => {}, 1000)")
  const began = Date.now()
  const output = await T.outputOf(file, args, 1_500)
  const took = Date.now() - began
  assert.ok(took >= 1_400 && took < 4_000, `gave up on time (${took} ms)`)
  const pid = Number(output.trim())
  assert.ok(pid > 0, output)
  for (let n = 0; n < 50 && !gone(pid); n++) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.ok(gone(pid), 'and it was stopped')
  assert.equal(await T.outputOf('this-program-is-not-there-togle', [], 2_000), '', 'one that cannot start gives nothing')
})
