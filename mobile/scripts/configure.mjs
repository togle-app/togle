import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { rolldown } from 'rolldown'

const root = path.resolve(import.meta.dirname, '..')
const core = path.join(root, 'device-core')
const development = process.argv.includes('--development')
let local = false
function address(value, secure, plain, service) {
  if (!value) return ''
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash) throw new Error('Enter a plain Togle service address.')
  if (url.protocol === plain && development && url.hostname === '127.0.0.1') local = true
  else if (url.protocol !== secure) throw new Error('Togle service addresses require TLS.')
  if (service === 'account' && url.pathname !== '/') throw new Error('Use the account service origin.')
  if (service === 'relay' && (url.pathname !== '/v1' || (url.protocol === secure && !url.hostname.endsWith('.togle.app')))) {
    throw new Error('Use the Togle relay endpoint.')
  }
  return service === 'account' ? url.origin : url.href
}
const relay = address(process.env.TOGLE_MOBILE_RELAY, 'wss:', 'ws:', 'relay')
const accountUrl = address(process.env.TOGLE_ACCOUNT_SUPABASE_URL, 'https:', 'http:', 'account')
const publishableKey = (process.env.TOGLE_ACCOUNT_SUPABASE_KEY || '').trim()
if (!!accountUrl !== !!publishableKey) throw new Error('Set both account settings.')
let publicKey = /^sb_publishable_[a-zA-Z0-9_-]+$/.test(publishableKey)
if (!publicKey && publishableKey.split('.').length === 3) {
  try { publicKey = JSON.parse(Buffer.from(publishableKey.split('.')[1], 'base64url')).role === 'anon' } catch {}
}
if (publishableKey && !publicKey) throw new Error('Use the account publishable key.')

const outputDir = process.argv.find(arg => arg.startsWith('--output-dir='))?.slice('--output-dir='.length)
const output = outputDir ? path.resolve(outputDir) : path.join(root, 'src')
await mkdir(output, { recursive: true })
const aliases = {
  '@shared/courier-protocol': path.join(root, '../src/shared/courier-protocol.ts'),
  'node:crypto': path.join(core, 'native-crypto.mjs'),
  'node:events': path.join(core, 'platform.mjs'),
  'node:path': path.join(core, 'phone-path.mjs'),
  ws: path.join(core, 'platform.mjs'),
  buffer: path.join(root, 'node_modules/buffer/index.js')
}
const build = await rolldown({
  input: path.join(core, 'native-client.mjs'),
  platform: 'browser',
  resolve: { alias: aliases },
  transform: { target: 'es2020', define: { __TOGLE_COURIER__: JSON.stringify(relay) }, inject: { Buffer: [path.join(core, 'bytes.mjs'), 'Bytes'] } },
  onwarn(warning, fallback) {
    if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message)
    fallback(warning)
  }
})
try { await build.write({ file: path.join(output, 'device-client.js'), format: 'esm' }) }
finally { await build.close() }
await writeFile(path.join(output, 'config.generated.ts'), 'export const config = ' + JSON.stringify({ relay, accountUrl, publishableKey, local }) + ';\n')
