const { spawn } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [path.join(__dirname, 'ui-flow.cjs'), ...process.argv.slice(2)], {
  env, windowsHide: true, stdio: 'inherit', cwd: path.resolve(__dirname, '..')
})
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
child.on('exit', (code, signal) => { if (signal) console.error('Electron UI test process exited with ' + signal); process.exitCode = code ?? 1 })
