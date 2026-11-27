// Exercise Windows Notification Center and its COM activation contract against a separately named packaged host.
const assert = require('node:assert/strict')
const { execFileSync, spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { setTimeout: wait } = require('node:timers/promises')
const root = path.resolve(__dirname, '..')

async function run() {
  if (process.platform !== 'win32') return
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'togle-notice-check-'))
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const name = 'Togle Notification Test ' + suffix
  const id = 'io.togle.noticecheck.' + suffix, clsid = '{' + randomUUID() + '}'
  const shortcut = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', name + '.lnk')
  const exe = path.join(folder, name + '.exe')
  const ps = (action, argument = '') => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', path.join(__dirname, 'windows-notice-native.ps1'), action, id, clsid, argument], { encoding: 'utf8', windowsHide: true, timeout: 50000 }).trim()
  const until = async (read, label) => {
    for (let i = 0; i < 75; i++) { const value = read(); if (value) return value; await wait(200) }
    throw new Error('Timed out waiting for ' + label)
  }
  const readEvent = name => fs.existsSync(path.join(folder, name)) && fs.readFileSync(path.join(folder, name), 'utf8')
  const stop = () => fs.writeFileSync(path.join(folder, 'stop'), '')
  const history = () => JSON.parse(ps('history'))
  let child
  try {
    const runtime = path.dirname(require('electron'))
    fs.cpSync(runtime, folder, { recursive: true })
    fs.renameSync(path.join(folder, 'electron.exe'), exe)
    execFileSync(require.resolve('electron-winstaller/vendor/rcedit.exe'), [exe, '--set-version-string', 'ProductName', name, '--set-version-string', 'FileDescription', name], { windowsHide: true })
    const fixture = path.join(folder, 'resources', 'app')
    fs.mkdirSync(fixture, { recursive: true })
    const bundler = await import('rolldown')
    const bundle = await bundler.rolldown({ input: path.join(root, 'src/main/windows-notices.ts'), platform: 'node', external: ['electron'], resolve: { alias: { '@shared': path.join(root, 'src/shared') } } })
    await bundle.write({ file: path.join(fixture, 'notices.cjs'), format: 'cjs' })
    await bundle.close()
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'togle-notice-test', main: 'main.cjs' }))
    fs.writeFileSync(path.join(fixture, 'identity.json'), JSON.stringify({ name, id, clsid, folder }))
    fs.copyFileSync(path.join(__dirname, 'windows-notice-host.cjs'), path.join(fixture, 'main.cjs'))
    const liveBanner = process.argv.includes('--live-banner')
    ps('prepare', liveBanner ? 'live-banner' : '')
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    child = spawn(exe, ['--post'], { env, windowsHide: true, stdio: 'ignore' })
    const exited = new Promise(resolve => child.once('exit', resolve))
    await until(() => readEvent('ready'), 'packaged app')
    const posted = await until(() => { const items = history(); return items.length === 4 && items }, 'four native notifications')
    const summary = posted.find(item => item.xml.includes('2 tasks finished'))
    const call = posted.find(item => item.xml.includes('Take notes'))
    const request = posted.find(item => item.xml.includes('Review request'))
    assert.ok(summary && call && request)
    assert.deepEqual(request.text, ['Codex needs input · Build & verify', 'Approve running npm test?'])
    const result = posted.find(item => item.text[0] === 'Codex · Draft handoff')
    assert.ok(result && result.text[1].includes('working copy') && result.text[1].includes('design.html'), 'the collapsed single-task alert has the outcome')
    assert.match(summary.text[1], /Check <installer> — All 12 checks passed/)
    assert.ok(posted.every(item => !/fixture-secret|The agent wrote a reply/i.test(item.xml)))
    assert.ok(fs.existsSync(shortcut), 'Windows created the named shortcut')
    assert.equal(new URLSearchParams(request.launch).get('type'), 'action', 'the live WinRT event uses Electron’s structured activation path')
    ps('activate', request.launch)
    await until(() => readEvent('destination') === JSON.stringify({ keys: ['codex:request'] }), 'warm task activation')
    ps('activate', call.launch)
    await until(() => readEvent('destination') === JSON.stringify({ page: 'meetings' }), 'meeting body opens Meetings')
    assert.equal(readEvent('calls'), false, 'opening an invitation does not start notes')
    const start = call.actions.find(value => new URLSearchParams(value).get('route')?.endsWith('.start'))
    assert.ok(start)
    const clicked = liveBanner && ps('button') === 'invoked'
    if (!clicked) ps('activate', start)
    await until(() => readEvent('calls') === 'zoom:false\n', 'explicit start action')
    if (liveBanner) console.log(clicked ? 'Invoked the actual Windows banner button through UI Automation.' : 'The desktop did not expose the test banner; exercised the Windows activation callback.')
    ps('activate', start)
    assert.equal(readEvent('calls'), 'zoom:false\n')
    stop()
    await exited
    fs.unlinkSync(path.join(folder, 'stop'))
    const missed = history().find(item => item.tag === summary.tag)
    assert.ok(missed, 'summary remains after the original process exits')
    ps('activate', missed.launch)
    await until(() => readEvent('cold') && readEvent('destination') === JSON.stringify({ keys: ['codex:a', 'codex:b'] }), 'cold-start summary opens both results')
    console.log('WINDOWS NATIVE PASS: OS history, shortcut registration, warm task click, one-shot call action, retained notification and cold COM launch into both results')
  } finally {
    stop()
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    // The COM-started instance also watches the stop file. Remove only this run's identity and files.
    await wait(700)
    try { ps('cleanup') } finally {
      fs.rmSync(shortcut, { force: true })
      if (path.dirname(folder) === os.tmpdir() && path.basename(folder).startsWith('togle-notice-check-')) fs.rmSync(folder, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
