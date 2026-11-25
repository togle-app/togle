// Exercise the real settings, preload, account service and encrypted storage with a local Supabase and Mailpit.
const { app, BrowserWindow } = require('electron')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')

function localUrl(name) {
  const url = new URL(process.env[name])
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), name + ' should point at the local test service.')
  return url.origin
}
const inbox = localUrl('TOGLE_ACCOUNT_MAILPIT_URL')
localUrl('TOGLE_ACCOUNT_SUPABASE_URL')
assert.ok(process.env.TOGLE_ACCOUNT_SUPABASE_KEY, 'Set the local public key.')
delete process.env.TOGLE_COURIER
const work = path.join(__dirname, '.work')
fs.mkdirSync(work, { recursive: true })
const profile = fs.mkdtempSync(path.join(work, 'account-local-'))
app.setPath('userData', profile)
app.setAppPath(path.resolve(__dirname, '..'))
app.disableHardwareAcceleration()
process.env.TOGLE_HEADLESS = '1'
process.env.TOGLE_SILENT_AUDIO = '1'
process.env.TOGLE_SPEECH_HOME = path.join(profile, 'speech')
process.env.TOGLE_SPEECH_SEEDS = ''
require('../out/main/index.js')

async function until(read, label) {
  const deadline = Date.now() + 30000
  do {
    const result = await read()
    if (result) return result
    await delay(120)
  } while (Date.now() < deadline)
  throw new Error('Timed out waiting for ' + label)
}

async function run() {
  const main = await until(() => BrowserWindow.getAllWindows().find(win => {
    const url = win.webContents.getURL()
    return url.includes('index.html') && !url.includes('surface=')
  }), 'the Togle window')
  const js = code => main.webContents.executeJavaScript(code)
  const expr = code => until(() => js(code), code)
  const click = (selector, words) => expr("Array.from(document.querySelectorAll(" + JSON.stringify(selector) + ")).some(b=>!b.disabled && b.textContent.trim()===" + JSON.stringify(words) + " && (b.click(),true))")
  const fill = (label, value) => js("(()=>{const input=document.querySelector('form input[aria-label=" + JSON.stringify(label) + "]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input," + JSON.stringify(value) + "); input.dispatchEvent(new Event('input',{bubbles:true}))})()")
  const account = () => js('window.togle.togleAccountState()')
  const readNote = text => expr("document.querySelector('#settings-accounts')?.innerText.includes(" + JSON.stringify(text) + ")")
  const email = 'togle-desktop-' + Date.now() + '@example.test'

  await expr("!!document.querySelector('.shell-settings')")
  assert.deepEqual(await account(), { available: true })
  assert.equal((await js('window.togle.reachState()')).available, false)
  await js("document.querySelector('.shell-settings').click()")
  await click('button[aria-label="Sign in to your Togle account"]', 'Sign in')
  await fill('Email address', email)
  await click('form button', 'Email me a code')
  await expr("!!document.querySelector('form input[aria-label=\"Code from the email\"]')")
  const code = await until(async () => {
    const list = await (await fetch(inbox + '/api/v1/messages')).json()
    const message = list.messages.find(item => item.To.some(to => to.Address === email))
    if (!message) return
    const detail = await (await fetch(inbox + '/api/v1/message/' + message.ID)).json()
    return /\b(\d{6,10})\b/.exec(detail.Text)?.[1]
  }, 'the sign-in email code')
  await fill('Code from the email', code)
  await click('form button', 'Sign in')
  await expr("!!document.querySelector('#settings-accounts button[aria-label=\"Togle account\"]')")
  const { user } = await account()
  assert.equal(user.email, email)
  await click('#settings-accounts button', 'Join waitlist')
  await readNote('You’re on the waitlist.')
  assert.equal(await js("window.togle.proWaitlist(" + JSON.stringify(user.id) + ", 'status')"), true)
  const saved = fs.readFileSync(path.join(profile, 'studio-account.bin'))
  assert.ok(saved.length && !saved.includes(email), 'session file is encrypted')
  await js('location.reload()')
  await expr("!!document.querySelector('.shell-settings')")
  await js("document.querySelector('.shell-settings').click()")
  await readNote('You’re on the waitlist.')
  await click('#settings-accounts button', 'Leave waitlist')
  await readNote('Join waitlist')
  await click('#settings-accounts button[aria-label="Togle account"]', email)
  await click('[role="menuitem"]', 'Sign out')
  await expr("!!document.querySelector('#settings-accounts button[aria-label=\"Sign in to your Togle account\"]')")
  assert.deepEqual(await account(), { available: true })
  assert.equal(fs.existsSync(path.join(profile, 'studio-account.bin')), false)
  console.log('Passed desktop email sign-in, persisted waitlist membership, leave and local sign-out with Reach off.')
}
run().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
