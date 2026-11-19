const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('builder-util')
const T = require('./build-tools.cjs')

exports.default = async context => {
  const target = { platform: context.electronPlatformName, arch: Arch[context.arch] }
  const resources = target.platform === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app/Contents/Resources')
    : path.join(context.appOutDir, 'resources')
  // The togle command is a shell script on Mac and Linux: it must be able to run.
  const command = path.join(resources, 'bin', 'togle')
  if (target.platform !== 'win32' && fs.existsSync(command)) fs.chmodSync(command, 0o755)
  // node-pty's package stores the helper that starts every terminal on a Mac without the execute bit (scripts/allow-spawn-helper.cjs).
  if (target.platform === 'darwin') require('./allow-spawn-helper.cjs').allowSpawnHelper(path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'))
  T.verifyPackage(resources, context.packager.projectDir, target)
  if (target.platform === 'darwin') require('./verify-macos.cjs').verifyMacPackage(path.dirname(path.dirname(resources)), target.arch)
  fs.writeFileSync(path.join(resources, 'build-target.json'), JSON.stringify(target, null, 2) + '\n')
}
