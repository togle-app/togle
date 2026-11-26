const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('builder-util')
const T = require('./build-tools.cjs')

exports.default = async context => {
  const target = { platform: context.electronPlatformName, arch: Arch[context.arch] }
  const resources = target.platform === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app/Contents/Resources')
    : path.join(context.appOutDir, 'resources')
  const beta = context.packager.appInfo.id === 'io.togle.app.beta'
  const bin = path.join(resources, 'bin')
  // Give the installed command its own name on Beta, including on Windows PATH.
  if (beta) {
    for (const extension of ['', '.cmd']) fs.renameSync(path.join(bin, 'togle' + extension), path.join(bin, 'togle-beta' + extension))
  }
  if (target.platform !== 'win32') fs.chmodSync(path.join(bin, beta ? 'togle-beta' : 'togle'), 0o755)
  // node-pty's package stores the helper that starts every terminal on a Mac without the execute bit (scripts/allow-spawn-helper.cjs).
  if (target.platform === 'darwin') require('./allow-spawn-helper.cjs').allowSpawnHelper(path.join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty'))
  T.verifyPackage(resources, context.packager.projectDir, target)
  if (target.platform === 'darwin') require('./verify-macos.cjs').verifyMacPackage(path.dirname(path.dirname(resources)), target.arch, context.packager.appInfo.id)
  fs.writeFileSync(path.join(resources, 'build-target.json'), JSON.stringify(target, null, 2) + '\n')
}
