import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('claude-settings')
const T = await import('./.build/togle.mjs')

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-settings-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const command = { command: 'C:\\Program Files\\Togle\\Togle.exe', args: ['--togle-hook', 'claude-permission', '--data', 'C:\\Users\\Someone\\AppData\\Roaming\\Togle'] }
const settingsOf = () => {
  const folder = scratch()
  const file = path.join(folder, 'settings.json')
  return { folder, file, settings: new T.ClaudeSettings(file, () => command) }
}
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const ours = { type: 'command', command: command.command, args: command.args, timeout: 600 }

test('the settings file is where Claude Code keeps it, and a version is compared as numbers', () => {
  assert.equal(T.claudeSettingsFile({}, '/home/someone'), path.join('/home/someone', '.claude', 'settings.json'))
  assert.equal(T.claudeSettingsFile({ CLAUDE_CONFIG_DIR: '/elsewhere' }, '/home/someone'), path.join('/elsewhere', 'settings.json'))
  assert.equal(T.claudeSettingsFile({ CLAUDE_CONFIG_DIR: '  ' }, '/home/someone'), path.join('/home/someone', '.claude', 'settings.json'), 'a blank folder is no folder')
  for (const [version, expected] of [['2.1.322 (Claude Code)', true], ['2.1.139', true], ['2.1.138', false], ['2.2.0', true], ['3.0.0', true], ['2.0.999', false], ['2.1.1000', true], ['', false], ['no version', false], [undefined, false]]) {
    assert.equal(T.versionAtLeast(version), expected, String(version))
  }
  assert.equal(T.MIN_CLAUDE_VERSION, '2.1.139')
})

test('with no settings file yet, connecting makes it with only Togle\'s entry, and taking it out leaves an empty file', async () => {
  const { file, settings } = settingsOf()
  assert.deepEqual(await settings.status(), { installed: false, current: false, file })
  const connected = await settings.connect()
  assert.deepEqual(connected, { installed: true, current: true, file })
  assert.deepEqual(read(file), { hooks: { PermissionRequest: [{ hooks: [ours] }] } })
  assert.equal(existsSync(`${file}.togle-backup`), false, 'there was nothing to keep a copy of')
  assert.deepEqual(await settings.disconnect(), { installed: false, current: false, file })
  assert.deepEqual(read(file), {}, 'nothing of Togle\'s is left')
})

test('everything else in the file is kept, in its indentation, and the first change keeps a copy of the file', async () => {
  const { file, settings } = settingsOf()
  const before = `{
    "model": "opus",
    "permissions": { "allow": ["Bash(npm test)"], "deny": ["Read(./.env)"] },
    "hooks": {
        "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "echo pre" }] }],
        "PermissionRequest": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node", "args": ["mine.js"] }] }]
    },
    "env": { "SOMETHING": "1" }
}
`
  writeFileSync(file, before)
  await settings.connect()
  const after = read(file)
  assert.deepEqual(after.permissions, { allow: ['Bash(npm test)'], deny: ['Read(./.env)'] })
  assert.equal(after.model, 'opus')
  assert.deepEqual(after.env, { SOMETHING: '1' })
  assert.deepEqual(after.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }])
  assert.deepEqual(after.hooks.PermissionRequest, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['mine.js'] }] }, { hooks: [ours] }], 'their own hook is first and untouched')
  assert.ok(readFileSync(file, 'utf8').includes('\n    "model"'), 'four spaces stay four spaces')
  assert.equal(readFileSync(`${file}.togle-backup`, 'utf8'), before, 'a copy of the file as it was')
  // A second connect does not stack a second entry, and does not replace the copy with a later file.
  await settings.connect()
  assert.equal(read(file).hooks.PermissionRequest.length, 2)
  assert.equal(readFileSync(`${file}.togle-backup`, 'utf8'), before)
  // Taking it out leaves their hook and everything else.
  await settings.disconnect()
  const removed = read(file)
  assert.deepEqual(removed.hooks.PermissionRequest, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['mine.js'] }] }])
  assert.deepEqual(removed.hooks.PreToolUse, after.hooks.PreToolUse)
  assert.deepEqual(removed.permissions, after.permissions)
  assert.equal(read(file).env.SOMETHING, '1')
})

test('an entry of Togle\'s that points at an old place is told, and connecting again puts the right one', async () => {
  const { file, settings } = settingsOf()
  writeFileSync(file, JSON.stringify({ hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'C:\\Old\\Togle.exe', args: ['--togle-hook', 'claude-permission', '--data', 'C:\\Old'], timeout: 600 }] }] } }))
  assert.deepEqual(await settings.status(), { installed: true, current: false, file })
  await settings.connect()
  assert.deepEqual(read(file).hooks.PermissionRequest, [{ hooks: [ours] }], 'the old entry is replaced, not kept beside')
  assert.deepEqual(await settings.status(), { installed: true, current: true, file })
})

test('a file that is not valid, or not what is expected, is left alone and said so', async () => {
  for (const [text, words] of [
    ['{ not json', /not valid JSON/],
    ['[1, 2]', /not what Togle expects/],
    ['{ "hooks": [] }', /hooks .* not what Togle expects/],
    ['{ "hooks": { "PermissionRequest": { "a": 1 } } }', /PermissionRequest hooks .* not what Togle expects/]
  ]) {
    const { file, settings } = settingsOf()
    writeFileSync(file, text)
    const status = await settings.status()
    assert.equal(status.installed, false)
    assert.match(status.problem, words)
    await assert.rejects(settings.connect(), words)
    await assert.rejects(settings.disconnect(), words)
    assert.equal(readFileSync(file, 'utf8'), text, 'not one byte changed')
    assert.equal(existsSync(`${file}.togle-backup`), false)
  }
})

test('an empty file is the same as none, and a file that has no entry of Togle\'s is not written by disconnecting', async () => {
  const { file, settings } = settingsOf()
  writeFileSync(file, '')
  assert.equal((await settings.connect()).installed, true)
  const other = settingsOf()
  writeFileSync(other.file, '{"model":"haiku"}')
  const stamp = statSync(other.file).mtimeMs
  assert.equal((await other.settings.disconnect()).installed, false)
  assert.equal(readFileSync(other.file, 'utf8'), '{"model":"haiku"}', 'unchanged')
  assert.equal(statSync(other.file).mtimeMs, stamp, 'not even written')
  const missing = settingsOf()
  assert.equal((await missing.settings.disconnect()).installed, false)
  assert.equal(existsSync(missing.file), false, 'disconnecting does not make a file')
})

test('the file keeps its permissions, and no temporary file is left', { skip: process.platform === 'win32' && 'file modes are not used on Windows' }, async () => {
  const { folder, file, settings } = settingsOf()
  writeFileSync(file, '{"env":{"TOKEN":"secret"}}')
  chmodSync(file, 0o600)
  await settings.connect()
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(readdirSync(folder).sort(), ['settings.json', 'settings.json.togle-backup'])
})

test('no temporary file is left behind a change', async () => {
  const { folder, settings } = settingsOf()
  await settings.connect()
  await settings.disconnect()
  assert.deepEqual(readdirSync(folder), ['settings.json'])
})
