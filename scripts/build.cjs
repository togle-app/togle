const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const T = require('./build-tools.cjs')

function run(name, args) {
  const pkg = require(name + '/package.json')
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin[name]
  const cli = path.resolve(path.dirname(require.resolve(name + '/package.json')), bin)
  execFileSync(process.execPath, [cli, ...args], { cwd: T.ROOT, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, ONNXRUNTIME_NODE_INSTALL: 'skip' } })
}

function outputDirectory(args) {
  let directory
  for (let i = 0; i < args.length; i++) {
    const match = /^(?:--config|-c)\.directories\.output(?:=(.*))?$/.exec(args[i])
    if (match) {
      if (directory) throw new Error('Specify the package output directory only once.')
      const value = match[1] ?? args[++i]
      if (!value || value.startsWith('-')) throw new Error('Specify a package output directory.')
      directory = path.resolve(T.ROOT, value)
    }
    if (args[i] === '--config' || args[i].startsWith('--config=')) throw new Error('Use electron-builder.yml and --config.directories.output for managed packaging.')
  }
  return directory ?? path.join(T.ROOT, 'dist')
}

function build() {
  T.cleanDirectory(path.join(T.ROOT, 'out'))
  const snapshot = T.sourceHash()
  run('electron-vite', ['build'])
  const manifest = T.writeManifest(T.ROOT, snapshot)
  console.log('Built ' + manifest.id + ' from clean output.')
}

async function main() {
  const [mode = 'build', ...args] = process.argv.slice(2)
  if (mode === 'clean') {
    if (args.includes('--all')) { T.assertNotRunning(path.join(T.ROOT, 'dist')); T.cleanDirectory(path.join(T.ROOT, 'dist')) }
    T.cleanDirectory(path.join(T.ROOT, 'out'))
    return
  }
  if (mode !== 'build' && mode !== 'package') throw new Error('Unknown build command: ' + mode)
  let output
  if (mode === 'package') {
    output = outputDirectory(args)
    T.assertNotRunning(output)
    T.cleanDirectory(output); T.markOutput(output)
  }
  build()
  if (mode !== 'package') return
  const options = []
  for (let i = 0; i < args.length; i++) {
    if (/^(?:--config|-c)\.directories\.output(?:=|$)/.test(args[i])) { if (!args[i].includes('=')) i++; continue }
    options.push(args[i])
  }
  options.push('--config.directories.output=' + output)
  if (!options.some(arg => /^--publish(?:=|$)/.test(arg))) options.push('--publish', 'never')
  // Reuse the exact installed Electron version on this platform. This also
  // avoids a network download merely to rebuild an unchanged local runtime.
  const target = options.some(arg => /^(?:--mac|-m)(?:=|$)/.test(arg)) ? 'darwin' : options.some(arg => /^(?:--linux|-l)(?:=|$)/.test(arg)) ? 'linux' : options.some(arg => /^(?:--win|-w)(?:=|$)/.test(arg)) ? 'win32' : process.platform
  const arch = options.includes('--arm64') ? 'arm64' : options.includes('--ia32') ? 'ia32' : options.includes('--x64') ? 'x64' : process.arch
  const runtime = path.join(path.dirname(require.resolve('electron/package.json')), 'dist')
  const archFlags = options.filter(arg => /^(?:--arm64|--ia32|--x64|--armv7l|--universal)$/.test(arg))
  const platformFlags = options.filter(arg => /^(?:--mac|--linux|--win|-m|-l|-w)(?:=|$)/.test(arg))
  if (target === process.platform && arch === process.arch && archFlags.length <= 1 && !options.includes('--universal') && platformFlags.length <= 1 && !options.some(arg => /electronDist|electronVersion/.test(arg)) && fs.existsSync(path.join(runtime, 'version'))) options.push('--config.electronDist=' + runtime)
  run('electron-builder', options)
  const resourceDirs = []
  for (const name of fs.readdirSync(output)) {
    const directory = path.join(output, name)
    if (!fs.statSync(directory).isDirectory()) continue
    if (fs.existsSync(path.join(directory, 'resources/app.asar'))) resourceDirs.push(path.join(directory, 'resources'))
    for (const app of fs.readdirSync(directory)) {
      const resources = path.join(directory, app, 'Contents/Resources')
      if (app.endsWith('.app') && fs.existsSync(path.join(resources, 'app.asar'))) resourceDirs.push(resources)
    }
  }
  if (!resourceDirs.length) throw new Error('Packaging produced no unpacked app to verify.')
  for (const resources of resourceDirs) T.verifyPackage(resources, T.ROOT, JSON.parse(fs.readFileSync(path.join(resources, 'build-target.json'), 'utf8')))
  fs.copyFileSync(path.join(T.ROOT, 'out', T.MANIFEST), path.join(output, T.MANIFEST))
  console.log('Verified package output: ' + output)
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
