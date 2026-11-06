// Run by electron-builder before it packs Togle (electron-builder.yml): what goes in beside the app has to be there,
// or the build would quietly make a Togle with no market. (Speech recognition isn't packed: Togle downloads it.)
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function beforePack(context) {
  const root = context?.packager?.projectDir ?? process.cwd()
  require('./build-tools.cjs').checkBuild(root)
  for (const name of ['icon.svg', 'icon.png', 'icon.ico']) {
    if (!fs.existsSync(path.join(root, 'build', name))) throw new Error('Missing app icon: run npm run icons.')
  }
  if (!fs.existsSync(path.join(root, 'hub-template', 'index.json'))) {
    throw new Error("The market's index is missing: run node hub-template/scripts/build-index.mjs.")
  }
}
