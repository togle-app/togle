import assert from 'node:assert/strict'
import { test } from 'node:test'
const T = await import('./.build/togle.mjs')

// Where agents are looked for: what the person's terminal would have, added to the PATH Togle started with.

test('the PATH saved in the registry is read with its %NAMES% filled in, and a name that is not set leaves its folder out', () => {
  const output = '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\Tools;;%NOT_SET%\\bin;C:\\Users\\Someone\\AppData\\Roaming\\npm\r\n\r\n'
  assert.deepEqual(T.registryPath(output, { USERPROFILE: 'C:\\Users\\Someone' }), ['C:\\Users\\Someone\\.local\\bin', 'C:\\Tools', 'C:\\Users\\Someone\\AppData\\Roaming\\npm'])
  assert.deepEqual(T.registryPath('    Path    REG_SZ    C:\\One;C:\\Two\r\n', {}), ['C:\\One', 'C:\\Two'])
  assert.deepEqual(T.registryPath('ERROR: The system was unable to find the specified registry key or value.\r\n'), [])
  assert.deepEqual(T.registryPath(''), [])
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
