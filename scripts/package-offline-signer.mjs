// Package the Windows release signing tool for a maintainer's offline PC.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import JSZip from 'jszip'

if (process.platform !== 'win32') throw new Error('Build the kit on Windows to include the Windows Node executable.')
const scripts = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(scripts)
const zip = new JSZip()
const launcher = await fs.readFile(path.join(scripts, 'offline-signing.cmd'), 'utf8')
zip.file('Togle release signing.cmd', launcher.replace(/\r?\n/g, '\r\n'))
zip.file('tools/release-key.mjs', await fs.readFile(path.join(scripts, 'release-key.mjs')))
zip.file('tools/Togle-LICENSE.txt', await fs.readFile(path.join(root, 'LICENSE')))
const license = await fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`, { signal: AbortSignal.timeout(20000) })
if (!license.ok) throw new Error(`Could not get the license for Node ${process.version} (HTTP ${license.status}).`)
zip.file('tools/Node-LICENSE.txt', await license.text())
zip.file('tools/node.exe', await fs.readFile(process.execPath))
zip.file('Read me.txt', [
  'Togle Windows release signing',
  '',
  'Extract the entire ZIP into a writable folder on a separate Windows PC that stays offline.',
  'Double-click Togle release signing.cmd. Return only togle-release.pub beside the launcher.',
  'The private key stays in your Windows profile, in %LOCALAPPDATA%\\Togle Release Signing.',
  'Keep a separate backup of that key folder offline.',
  '',
  'When the Windows installer is built, take it to the same offline PC.',
  'Drag the installer onto Togle release signing.cmd. Wait for good signature.',
  'Return the .sig file with the exact installer. Customers download the installer and its signature.',
  '', `This maintainer kit includes Node ${process.version} for Windows ${process.arch}.`, ''
].join('\r\n'))

const output = path.join(root, 'dist-release-tools', `Togle-Offline-Signing-Windows-${process.arch}.zip`)
await fs.mkdir(path.dirname(output), { recursive: true })
const temporary = output + '.' + randomUUID() + '.tmp'
try {
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 4 } })
  await fs.writeFile(temporary, bytes, { flag: 'wx' })
  await fs.rename(temporary, output)
  console.log(output)
} finally {
  await fs.rm(temporary, { force: true })
}
