// Verify the executable's real primary icon resources, not just the builder config.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')

;(async () => {
  const file = process.argv[2]
  if (!file) throw new Error('Pass the packaged Togle.exe path.')
  const fromBuilder = createRequire(require.resolve('app-builder-lib/package.json'))
  const R = await import(pathToFileURL(fromBuilder.resolve('resedit')).href)
  const root = path.resolve(__dirname, '..')
  const source = R.Data.IconFile.from(fs.readFileSync(path.join(root, 'build/icon.ico')))
  const executable = R.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true })
  const resources = R.NtExecutableResource.from(executable)
  const group = R.Resource.IconGroupEntry.fromEntries(resources.entries).find(g => g.id === 1)
  assert.ok(group, 'The primary Windows app icon must exist')
  const embedded = group.getIconItemsFromEntries(resources.entries)
  for (const item of source.icons) {
    const expected = item.data
    // The one-byte Windows group dimensions encode 256 as zero.
    assert.ok(embedded.some(icon => (icon.width || 256) === expected.width && (icon.height || 256) === expected.height && icon.isRaw() && Buffer.from(icon.bin).equals(Buffer.from(expected.bin))), 'Missing Togle image at ' + expected.width + 'px')
  }
  const runtime = path.join(path.dirname(path.resolve(file)), 'resources')
  for (const name of ['icon.png', 'icon.ico']) {
    assert.ok(fs.readFileSync(path.join(runtime, name)).equals(fs.readFileSync(path.join(root, 'build', name))), 'Wrong runtime ' + name)
  }
  console.log('Primary executable icon verified at ' + source.icons.map(i => i.data.width).join(', ') + 'px; runtime assets match.')
})().catch(error => { console.error(error.message); process.exitCode = 1 })
