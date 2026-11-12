// The key Togle's releases are signed with, as the design asks: every update is signed with a key kept off every server,
// the app checks it before installing, and the public half is published so anyone can check a download.
//
// RSA-3072 with SHA-256 (PKCS #1 v1.5): Windows PowerShell 5.1, openssl and Node check it with nothing to install.
//   node scripts/release-key.mjs keygen <folder>            togle-release.key (keep it offline) and togle-release.pub
//   node scripts/release-key.mjs sign <key> <file>...       writes <file>.sig beside each file
//   node scripts/release-key.mjs verify <pub> <file>        checks <file>.sig
//   node scripts/release-key.mjs installers <pub> <folder>  install.ps1 and install.sh with the key written in
// Copy the .pub file to build/release-key.pub before packaging: the app carries it to check its updates.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

export function generate() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 })
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    pub: publicKey.export({ type: 'spki', format: 'pem' })
  }
}

export const sign = (key, data) => crypto.sign('sha256', data, key)
export const verify = (pub, data, signature) => crypto.verify('sha256', data, pub, signature)

/** The public key as PowerShell 5.1 imports it: the modulus and exponent, in base64. */
export function rsaParameters(pub) {
  const jwk = crypto.createPublicKey(pub).export({ format: 'jwk' })
  const b64 = (value) => Buffer.from(value, 'base64url').toString('base64')
  return { modulus: b64(jwk.n), exponent: b64(jwk.e) }
}

/** The two install scripts with the public key written in. */
export function installers(pub) {
  const { modulus, exponent } = rsaParameters(pub)
  const ps1 = fs.readFileSync(path.join(here, '..', 'install', 'install.ps1'), 'utf8')
    .replace('__TOGLE_RELEASE_MODULUS__', modulus).replace('__TOGLE_RELEASE_EXPONENT__', exponent)
  // A shell script must end its lines with LF alone, even when this runs on a Windows checkout.
  const sh = fs.readFileSync(path.join(here, '..', 'install', 'install.sh'), 'utf8').replace(/\r\n/g, '\n')
    .replace('__TOGLE_RELEASE_PUBLIC_KEY__', pub.trim())
  return { ps1, sh }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === 'keygen') {
    const folder = path.resolve(rest[0] ?? '.')
    const { key, pub } = generate()
    fs.writeFileSync(path.join(folder, 'togle-release.key'), key, { mode: 0o600, flag: 'wx' })
    fs.writeFileSync(path.join(folder, 'togle-release.pub'), pub, { flag: 'wx' })
    console.log(`Wrote togle-release.key (keep it off every server and computer that builds) and togle-release.pub in ${folder}`)
  } else if (command === 'sign') {
    const key = fs.readFileSync(rest[0], 'utf8')
    for (const file of rest.slice(1)) {
      fs.writeFileSync(file + '.sig', sign(key, fs.readFileSync(file)))
      console.log('signed', file)
    }
  } else if (command === 'verify') {
    const ok = verify(fs.readFileSync(rest[0], 'utf8'), fs.readFileSync(rest[1]), fs.readFileSync(rest[1] + '.sig'))
    console.log(ok ? 'good signature' : 'BAD SIGNATURE')
    process.exitCode = ok ? 0 : 1
  } else if (command === 'installers') {
    const { ps1, sh } = installers(fs.readFileSync(rest[0], 'utf8'))
    fs.mkdirSync(rest[1], { recursive: true })
    fs.writeFileSync(path.join(rest[1], 'install.ps1'), ps1)
    fs.writeFileSync(path.join(rest[1], 'install.sh'), sh, { mode: 0o755 })
    console.log('Wrote install.ps1 and install.sh in', rest[1])
  } else {
    console.error('Usage: node scripts/release-key.mjs keygen|sign|verify|installers …')
    process.exitCode = 2
  }
}
