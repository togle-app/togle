// Live scenarios use a fresh workspace profile and the official CLI's existing sign-in.
// No conversations, credentials or settings are copied from the user's Togle profile.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const work = path.join(root, 'test', '.work')
fs.mkdirSync(work, { recursive: true })
const data = fs.mkdtempSync(path.join(work, 'live-scenarios-'))
const env = { ...process.env, TOGLE_SCENARIO_DATA: data, TOGLE_EVAL_ARGS: JSON.stringify(process.argv.slice(2)) }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [path.join(__dirname, 'live-scenarios.cjs')], {
  env, cwd: root, windowsHide: true, stdio: 'inherit'
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
