// Ensure packaging did not ship an older main/preload/renderer than the code just tested.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { extractFile } = require('@electron/asar')
const root = path.resolve(__dirname, '..')
const executable = process.argv[2]
if (!executable) throw new Error('Pass the packaged Togle.exe path.')
const resources = path.join(path.dirname(path.resolve(executable)), 'resources')
const archive = path.join(resources, 'app.asar')
require('../scripts/build-tools.cjs').verifyPackage(resources)
assert.equal(JSON.parse(extractFile(archive, path.normalize('node_modules/ws/package.json')).toString()).name, 'ws', 'Claude dictation must ship its WebSocket transport.')
const files = [...fs.readdirSync(path.join(root, 'out/main'), { recursive: true }).filter(file => file.endsWith('.js')).map(file => 'out/main/' + file), 'out/preload/index.js', 'out/renderer/index.html', 'out/renderer/pcm-tap.js',
  ...fs.readdirSync(path.join(root, 'out/renderer/assets')).map(file => 'out/renderer/assets/' + file)]
for (const file of files) assert.ok(extractFile(archive, path.normalize(file)).equals(fs.readFileSync(path.join(root, file))), 'Packaged code differs from tested code: ' + file)
const cli = path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe')
assert.ok(fs.statSync(cli).size > 0, 'The official Claude CLI must be unpacked for subscription login.')
const voices = path.join(resources, 'app.asar.unpacked/node_modules/sherpa-onnx-win-x64/sherpa-onnx.node')
assert.ok(fs.statSync(voices).size > 0, 'The native speaker recognition addon must be unpacked.')
assert.ok(fs.readFileSync(path.join(resources, 'dictation-windows.ps1')).equals(fs.readFileSync(path.join(root, 'resources/dictation-windows.ps1'))), 'Windows dictation must ship its tested insertion helper.')
console.log(`Packaged main, preload and renderer match all ${files.length} tested build files; the official Claude CLI is unpacked.`)
