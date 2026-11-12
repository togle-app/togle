#!/usr/bin/env node
// The `togle` command from a copy of the source: starts a task in the running Togle, and lists the tasks. (An installed
// Togle has the same command beside the app, in resources/bin.) Run `npm run build` first, so out/main/cli.js is there.
'use strict'
const { spawnSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const cli = path.join(__dirname, '..', 'out', 'main', 'cli.js')
if (!existsSync(cli)) {
  console.error('Togle is not built yet. Run "npm run build" in the Togle folder, then try again.')
  process.exit(1)
}
let electron
try {
  electron = require('electron')
} catch {
  console.error('Togle needs its dependencies. Run "npm install" in the Togle folder, then try again.')
  process.exit(1)
}
// Electron runs the command as plain Node: no window, and it ends when the command does.
const result = spawnSync(electron, [cli, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
process.exit(result.status ?? 1)
