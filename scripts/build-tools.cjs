const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const MANIFEST = 'build-info.json'
const OWNER = '.togle-output.json'
const APP_ID = 'io.togle.app'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const slash = value => value.replaceAll('\\', '/')
const inside = (directory, file) => { const relative = path.relative(directory, file); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }

function files(directory, accept = () => true, base = directory) {
  if (!fs.existsSync(directory)) return []
  const result = []
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name), stat = fs.lstatSync(file)
    if (!accept(slash(path.relative(base, file)))) continue
    if (stat.isSymbolicLink()) throw new Error('Build input must not be a symlink: ' + file)
    if (stat.isDirectory()) for (const child of files(file, accept, base)) result.push(name + '/' + child)
    else if (stat.isFile()) result.push(name)
  }
  return result
}

function sourceHash(root = ROOT) {
  const input = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'electron-builder.yml', 'src', 'scripts', 'build', 'hub-template', 'resources']
  const hash = createHash('sha256')
  for (const name of input.sort()) {
    const file = path.join(root, name)
    if (!fs.existsSync(file)) continue
    const entries = fs.statSync(file).isDirectory() ? files(file, child => name !== 'resources' || !/^whisper(?:\/|$)/.test(child)).map(child => name + '/' + child) : [name]
    for (const entry of entries) {
      // Downloaded models and engines are runtime data, never package inputs.
      if (entry.startsWith('resources/whisper/')) continue
      hash.update(entry + '\0'); hash.update(digest(fs.readFileSync(path.join(root, entry))) + '\n')
    }
  }
  return hash.digest('hex')
}

function extraResources(root) {
  const result = {}
  const add = (source, target) => { result[target] = digest(fs.readFileSync(path.join(root, source))) }
  for (const name of ['icon.png', 'icon.ico']) add('build/' + name, name)
  add('resources/dictation-windows.ps1', 'dictation-windows.ps1')
  for (const name of files(path.join(root, 'resources/licenses'))) add('resources/licenses/' + name, 'licenses/' + name)
  for (const name of files(path.join(root, 'hub-template'))) {
    if (name === 'index.json' || name.startsWith('agents/')) add('hub-template/' + name, 'hub-template/' + name)
  }
  return result
}

function writeManifest(root = ROOT, expectedSource = sourceHash(root)) {
  if (sourceHash(root) !== expectedSource) throw new Error('Source changed during the build. Run npm run build again.')
  const out = path.join(root, 'out'), entries = files(out).filter(name => name !== MANIFEST)
  const required = ['main/index.js', 'main/reader-worker.js', 'main/parakeet-worker.js', 'main/whisper-worker.js', 'main/voice-worker.js', 'preload/index.js', 'renderer/index.html', 'renderer/pcm-tap.js']
  for (const name of required) if (!entries.includes(name)) throw new Error('Build is missing ' + name)
  const hashes = Object.fromEntries(entries.map(name => [name, digest(fs.readFileSync(path.join(out, name)))]))
  let commit, dirty
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  } catch { /* Source archives do not always include Git metadata. */ }
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
  const manifest = { schema: 1, appId: APP_ID, version, id: version + '-' + expectedSource.slice(0, 12), builtAt: new Date().toISOString(), commit, dirty, sourceHash: expectedSource, files: hashes, resources: extraResources(root) }
  fs.writeFileSync(path.join(out, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

function checkBuild(root = ROOT) {
  const out = path.join(root, 'out'), file = path.join(out, MANIFEST)
  if (!fs.existsSync(file)) throw new Error('Build provenance is missing. Run npm run build before packaging.')
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (manifest.schema !== 1 || manifest.appId !== APP_ID || manifest.sourceHash !== sourceHash(root)) throw new Error('Build is stale: source or packaging inputs changed. Run npm run build again.')
  const actual = files(out).filter(name => name !== MANIFEST)
  if (JSON.stringify(actual.sort()) !== JSON.stringify(Object.keys(manifest.files).sort())) throw new Error('Build contains added or missing output files. Run npm run build again.')
  for (const name of actual) if (digest(fs.readFileSync(path.join(out, name))) !== manifest.files[name]) throw new Error('Build output changed: ' + name)
  if (JSON.stringify(extraResources(root)) !== JSON.stringify(manifest.resources)) throw new Error('Packaged resources changed. Run npm run build again.')
  return manifest
}

function runningApps() {
  if (process.platform === 'win32') {
    const command = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'Togle.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"
    const output = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim()
    const items = output ? JSON.parse(output) : []
    return (Array.isArray(items) ? items : [items]).filter(item => item.ExecutablePath).map(item => ({ pid: item.ProcessId, file: item.ExecutablePath }))
  }
  return execFileSync('ps', ['-axo', 'pid=,comm='], { encoding: 'utf8' }).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match || !/(?:^|\/)[Tt]ogle(?:\.app\/|$)/.test(match[2])) return []
    let file = match[2]
    if (process.platform === 'linux') { try { file = fs.readlinkSync('/proc/' + match[1] + '/exe') } catch { return [] } }
    return [{ pid: Number(match[1]), file }]
  })
}

function assertNotRunning(directory, apps = runningApps()) {
  const active = apps.filter(app => inside(directory, path.resolve(app.file)))
  if (active.length) throw new Error('Togle is running from ' + directory + '. Quit it from the tray before replacing this build (process ' + active[0].pid + ').')
}

/** Only generated out/dist, or a custom output previously owned by this checkout. */
function cleanDirectory(directory, root = ROOT) {
  root = fs.realpathSync(root); directory = path.resolve(directory)
  if (directory === path.parse(directory).root || directory === root || inside(directory, root)) throw new Error('Refusing unsafe build cleanup: ' + directory)
  const standard = ['out', 'dist'].some(name => path.join(root, name) === directory)
  const parent = fs.realpathSync(path.dirname(directory))
  if (path.relative(path.join(parent, path.basename(directory)), directory)) throw new Error('Refusing cleanup through a symlink: ' + directory)
  if (!fs.existsSync(directory)) {
    if (!standard) fs.mkdirSync(directory)
    return
  }
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Refusing to clean a symlink: ' + directory)
  if (!standard && fs.readdirSync(directory).length) {
    let owner
    try { owner = JSON.parse(fs.readFileSync(path.join(directory, OWNER), 'utf8')) } catch {}
    if (owner?.appId !== APP_ID || owner.project !== root) throw new Error('Custom output is not owned by this checkout: ' + directory + '. Choose an empty build directory.')
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
}

function markOutput(directory, root = ROOT) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(path.join(directory, OWNER), JSON.stringify({ appId: APP_ID, project: fs.realpathSync(root) }, null, 2) + '\n')
}

function verifyPackage(resources, root = ROOT, target = { platform: process.platform, arch: process.arch }) {
  const { extractFile, listPackage, statFile } = require('@electron/asar')
  const manifest = checkBuild(root), archive = path.join(resources, 'app.asar')
  const roots = new Set(listPackage(archive).map(name => slash(name).replace(/^\//, '').split('/')[0]))
  for (const name of roots) if (!['out', 'node_modules', 'package.json'].includes(name)) throw new Error('Packaged app includes a development artifact: ' + name)
  const packaged = JSON.parse(extractFile(archive, path.join('out', MANIFEST)).toString())
  if (JSON.stringify(packaged) !== JSON.stringify(manifest)) throw new Error('Packaged build provenance does not match the current build.')
  const names = listPackage(archive).map(name => slash(name).replace(/^\//, '')).filter(name => name.startsWith('out/') && !statFile(archive, path.normalize(name)).files)
  const expected = [...Object.keys(manifest.files).map(name => 'out/' + name), 'out/' + MANIFEST].sort()
  if (JSON.stringify(names.sort()) !== JSON.stringify(expected)) throw new Error('Packaged app contains missing or stale compiled files.')
  for (const [name, hash] of Object.entries(manifest.files)) if (digest(extractFile(archive, path.join('out', name))) !== hash) throw new Error('Packaged output differs: ' + name)
  for (const [name, hash] of Object.entries(manifest.resources)) if (digest(fs.readFileSync(path.join(resources, name))) !== hash) throw new Error('Packaged resource differs: ' + name)
  const cli = path.join(resources, 'app.asar.unpacked/node_modules/@anthropic-ai', `claude-agent-sdk-${target.platform}-${target.arch}`, target.platform === 'win32' ? 'claude.exe' : 'claude')
  if (!fs.statSync(cli).size) throw new Error('The official Claude runtime is missing from the package.')
  const voices = path.join(resources, 'app.asar.unpacked/node_modules', `sherpa-onnx-${target.platform === 'win32' ? 'win' : target.platform}-${target.arch}`, 'sherpa-onnx.node')
  if (!fs.statSync(voices).size) throw new Error('The native speech addon is missing from the package.')
  console.log('Verified build ' + manifest.id + ': exact compiled files, resources and provenance.')
  return manifest
}

module.exports = { ROOT, MANIFEST, APP_ID, files, digest, sourceHash, writeManifest, checkBuild, runningApps, assertNotRunning, cleanDirectory, markOutput, verifyPackage }
