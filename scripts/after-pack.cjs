const fs = require('node:fs')
const path = require('node:path')
const { Arch } = require('builder-util')
const T = require('./build-tools.cjs')

exports.default = async context => {
  const target = { platform: context.electronPlatformName, arch: Arch[context.arch] }
  const resources = target.platform === 'darwin'
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + '.app/Contents/Resources')
    : path.join(context.appOutDir, 'resources')
  T.verifyPackage(resources, context.packager.projectDir, target)
  if (target.platform === 'darwin') require('./verify-macos.cjs').verifyMacPackage(path.dirname(path.dirname(resources)), target.arch)
  fs.writeFileSync(path.join(resources, 'build-target.json'), JSON.stringify(target, null, 2) + '\n')
}
