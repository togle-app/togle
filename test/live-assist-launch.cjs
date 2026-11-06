// Isolated recorded-audio benchmark. --live opts into up to three native Claude requests.
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const work = path.join(__dirname, '.work', 'live-assist')
fs.mkdirSync(work, { recursive: true })
const env = { ...process.env, TOGLE_LATENCY_DATA: fs.mkdtempSync(path.join(work, 'profile-')), TOGLE_EVAL_ARGS: JSON.stringify(process.argv.slice(2)) }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [path.join(root, 'eval', 'live-assist.cjs')], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
