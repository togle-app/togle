export interface AccountConfig { url: string; publicKey: string }

/** Validate before a public key is embedded in the desktop application. */
export function accountConfig(address: string | undefined, key: string | undefined, development = false): AccountConfig | undefined {
  if (!address && !key) return undefined
  if (!address || !key) throw new Error('Set both the Togle account URL and its publishable key.')
  const url = new URL(address)
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(development && local && url.protocol === 'http:')) ||
      (!development && local) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Use the HTTPS origin of the shared Togle account service. Local development also accepts HTTP on loopback.')
  }
  let publicKey = /^sb_publishable_[\w-]+$/.test(key)
  if (!publicKey) {
    try {
      const parts = key.split('.')
      publicKey = parts.length === 3 && parts.every(part => /^[A-Za-z0-9_-]+$/.test(part)) &&
        JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role === 'anon'
    } catch { /* Only a legacy anon JWT or a publishable key belongs in a build. */ }
  }
  if (!publicKey) throw new Error('Togle account builds require a Supabase publishable key or legacy anon key.')
  return { url: url.origin, publicKey: key }
}
