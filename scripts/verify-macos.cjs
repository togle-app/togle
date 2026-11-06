const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** Inspect the actual bundle, including the runtime architecture (not just its output directory name). */
function verifyMacPackage(bundle, arch = process.arch) {
  const cpu = { arm64: 'arm64', x64: 'x86_64' }[arch]
  assert.ok(cpu, 'Verify arm64 and x64 packages separately.')
  const contents = path.join(bundle, 'Contents')
  const resources = path.join(contents, 'Resources')
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(contents, 'Info.plist')], { encoding: 'utf8' }))
  assert.equal(info.CFBundleIdentifier, 'io.togle.app')
  assert.equal(info.LSMinimumSystemVersion, '14.2.0', 'System audio requires macOS 14.2 or later.')
  for (const key of ['NSMicrophoneUsageDescription', 'NSAudioCaptureUsageDescription']) {
    assert.ok(typeof info[key] === 'string' && info[key].trim(), 'Missing macOS permission description: ' + key)
  }
  assert.ok(info.CFBundleIconFile && !/^electron/i.test(info.CFBundleIconFile), 'The app must use the Togle icon.')
  const icon = fs.readFileSync(path.join(resources, info.CFBundleIconFile))
  assert.equal(icon.toString('ascii', 0, 4), 'icns', 'The native app icon must be ICNS.')
  assert.equal(icon.readUInt32BE(4), icon.length, 'The ICNS must not be truncated.')

  const native = path.join(resources, 'app.asar.unpacked', 'node_modules')
  const binaries = [
    path.join(contents, 'MacOS', info.CFBundleExecutable),
    path.join(contents, 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework'),
    path.join(native, '@anthropic-ai', `claude-agent-sdk-darwin-${arch}`, 'claude'),
    path.join(native, `sherpa-onnx-darwin-${arch}`, 'sherpa-onnx.node'),
    path.join(native, '@koromix', `koffi-darwin-${arch}`, `darwin_${arch}`, 'koffi.node')
  ]
  for (const binary of binaries) {
    const architectures = execFileSync('/usr/bin/lipo', ['-archs', binary], { encoding: 'utf8' }).trim().split(/\s+/)
    assert.ok(architectures.includes(cpu), `${path.relative(bundle, binary)} cannot run on ${arch}: found ${architectures.join(', ')}`)
  }
  console.log(`Verified macOS ${arch} bundle: Togle icon, permission descriptions, minimum OS and ${binaries.length} native binaries.`)
}

module.exports = { verifyMacPackage }

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error('Pass the Togle.app path and optional arm64 or x64 architecture.')
    verifyMacPackage(path.resolve(process.argv[2]), process.argv[3])
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
