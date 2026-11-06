const { spawn } = require('node:child_process')
const path = require('node:path')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [path.join(__dirname, 'dictation-native.cjs'), ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
const timer = setTimeout(() => { child.kill(); process.exitCode = 1 }, 60_000)
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1 })
