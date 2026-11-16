// Where Togle Studio is installed, asked of the computer: the program its installer puts there. A fake file system stands
// in for each system, so every one is tried here.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { installedStudio } = await import('./.build/togle.mjs')

const there = (...files) => file => files.includes(file)

test('Windows: the program its installer puts in Program Files, or in the person’s Programs folder, and nothing else', () => {
  const env = { ProgramW6432: 'C:\\Program Files', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\Ann\\AppData\\Local' }
  const everyone = 'C:\\Program Files\\Togle Studio\\Togle Studio.exe'
  const person = 'C:\\Users\\Ann\\AppData\\Local\\Programs\\Togle Studio\\Togle Studio.exe'
  const look = exists => installedStudio({ platform: 'win32', env, home: 'C:\\Users\\Ann', exists })
  assert.deepEqual(look(there(everyone)), { command: everyone, args: ['--hidden'] })
  assert.deepEqual(look(there(person)), { command: person, args: ['--hidden'] })
  assert.equal(look(there(everyone, person)).command, everyone, 'the one for every user first')
  assert.equal(look(there('C:\\Users\\Ann\\togle\\app\\dist\\win-unpacked\\Togle Studio.exe')), undefined, 'a copy somewhere else is not an install')
  assert.equal(look(there('C:\\Program Files\\Togle Studio\\Togle.exe')), undefined, 'a folder with another program in it is not an install')
  assert.equal(look(there()), undefined)
  assert.equal(installedStudio({ platform: 'win32', env: {}, home: 'C:\\Users\\Ann', exists: () => true }), undefined, 'with no folder to look in, nothing is found')
  assert.equal(installedStudio({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files (x86)' }, home: '', exists: there('C:\\Program Files\\Togle Studio\\Togle Studio.exe') }), undefined, 'only the folders the system names')
})

test('macOS: the app in Applications, or in the person’s own, started by its bundle identifier', () => {
  const start = { command: '/usr/bin/open', args: ['-b', 'io.togle.studio', '--args', '--hidden'] }
  const look = exists => installedStudio({ platform: 'darwin', env: {}, home: '/Users/ann', exists })
  assert.deepEqual(look(there('/Applications/Togle Studio.app/Contents/MacOS')), start)
  assert.deepEqual(look(there('/Users/ann/Applications/Togle Studio.app/Contents/MacOS')), start)
  assert.equal(look(there('/Applications/Togle Studio.app')), undefined, 'an empty folder is not the app')
  assert.equal(look(there('/Applications/Togle.app/Contents/MacOS')), undefined, 'another app is not it')
  assert.equal(look(there()), undefined)
})

test('Linux: where its .deb puts it', () => {
  const look = exists => installedStudio({ platform: 'linux', env: {}, home: '/home/ann', exists })
  assert.deepEqual(look(there('/opt/Togle Studio/togle-studio')), { command: '/opt/Togle Studio/togle-studio', args: ['--hidden'] })
  assert.deepEqual(look(there('/usr/bin/togle-studio')), { command: '/usr/bin/togle-studio', args: ['--hidden'] })
  assert.equal(look(there('/home/ann/Downloads/Togle-Studio.AppImage')), undefined, 'an AppImage lives wherever it was put: only its link file knows it')
  assert.equal(look(there()), undefined)
})
