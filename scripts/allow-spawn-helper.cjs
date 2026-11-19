// node-pty (1.1.0) stores the helper program it starts every terminal through on a Mac, `spawn-helper`, without the execute bit. Without it each
// terminal Togle opens on a Mac fails with "posix_spawnp failed", and that error ends the whole process (libc++abi: terminating due to uncaught
// exception of type Napi::Error). This gives the helper its execute bit back. It runs after an install (package.json) and on a packaged app
// (scripts/after-pack.cjs): the copy inside the app is the one that runs, and scripts/verify-macos.cjs checks it.
const fs = require('node:fs')
const path = require('node:path')

/** The helper programs in one node-pty folder: the prebuilt one for each system, and the one a build from source makes. */
function helpersOf(root) {
  const found = [path.join(root, 'build', 'Release', 'spawn-helper')]
  try {
    for (const name of fs.readdirSync(path.join(root, 'prebuilds'))) found.push(path.join(root, 'prebuilds', name, 'spawn-helper'))
  } catch {
    // no prebuilt programs here
  }
  return found.filter(file => fs.existsSync(file))
}

/** Lets each helper in a node-pty folder run, and says which ones were changed. Windows has no execute bit: nothing to do there. */
function allowSpawnHelper(root, platform = process.platform) {
  const changed = []
  if (platform === 'win32') return changed
  for (const file of helpersOf(root)) {
    const mode = fs.statSync(file).mode
    if ((mode & 0o111) === 0o111) continue
    fs.chmodSync(file, mode | 0o755)
    changed.push(file)
  }
  return changed
}

module.exports = { allowSpawnHelper, helpersOf }

// As a script (after an install): the node-pty this project uses. An install is never failed over this.
if (require.main === module) {
  try {
    const changed = allowSpawnHelper(path.dirname(require.resolve('node-pty/package.json')))
    if (changed.length) console.log(`node-pty: ${changed.length} helper program(s) can run now (${changed.map(file => path.basename(path.dirname(file))).join(', ')}).`)
  } catch {
    // node-pty is not installed here (an install without optional packages, say): nothing to do
  }
}
