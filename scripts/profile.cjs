// Togle from this folder's build, with a data folder of its own: a second Togle on one computer, to try Reach between
// two. Development only, and it never touches the data of the Togle you use.
//   TOGLE_PROFILE=<folder> TOGLE_COURIER=ws://127.0.0.1:8787/v1 npx electron scripts/profile.cjs
// Build first (npm run build). TOGLE_DEVICE_NAME gives this Togle its own name among your devices.
const { app } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const folder = process.env.TOGLE_PROFILE
if (!folder) {
  console.error('Set TOGLE_PROFILE to the folder this Togle keeps its data in.')
  process.exit(2)
}
const root = path.resolve(__dirname, '..')
if (!fs.existsSync(path.join(root, 'out', 'main', 'index.js'))) {
  console.error('Build Togle first: npm run build')
  process.exit(2)
}
fs.mkdirSync(folder, { recursive: true })
app.setPath('userData', path.resolve(folder))
app.setAppPath(root)
require(path.join(root, 'out', 'main', 'index.js'))
