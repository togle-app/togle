import { net, shell } from 'electron'
import { EventEmitter } from 'node:events'
import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto'
import http from 'node:http'
import type { AuthStatus } from '@shared/types'
import { readJson, readSecret, writeJson, writeSecret } from '../storage'
import { MANAGE_USAGE_URL } from '@shared/plan'

/**
 * Sign in with ChatGPT, with ChatGPT plan usage: OpenAI's own sign-in for open-source apps
 * (developers.openai.com/siwc). The first sign-in registers Togle for the account (client_id=dynamic_agent_client, with
 * this computer's host ID); later sign-ins reuse the client ID it was issued. Answers then go to the public Responses
 * API with the access token, and count against the user's ChatGPT plan.
 */
export const ISSUER = 'https://auth.openai.com'
const AUTHORIZE_URL = `${ISSUER}/api/accounts/authorize`
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`
export const RESOURCE = 'https://api.openai.com/v1'
const REGISTER_CLIENT = 'dynamic_agent_client'
/** Togle's name for the registration: the user sees it, and may edit it, before allowing it. */
const AGENT_NAME = 'Togle'
const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPE = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`
/** The address the browser comes back to; only its port may change between sign-ins. */
const CALLBACK_PATH = '/auth/callback'
const CALLBACK_PORTS = [1455, 1457]
const TOKEN_FILE = 'chatgpt-auth.bin'
const HOST_FILE = 'chatgpt-host.json'
const REFRESH_WINDOW_MS = 5 * 60_000
// A token request is small; one taking longer than this is stuck (on a lossy connection it can hang).
const TOKEN_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 10 * 60_000
const KEYS_FRESH_MS = 60 * 60_000
const CLOCK_SKEW_S = 300
// Said the same way for each AI that isn't set up yet: what to do, and where (the window links it).
const NOT_SIGNED_IN = 'Sign in with ChatGPT first, in Settings.'
export { MANAGE_USAGE_URL }
/** Refresh errors after which the tokens are no good: sign in again (with the same registration). */
const DEAD_SESSION = /^(?:invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused)$/

/** The client OpenAI issued this account's registration, kept across sign-outs. */
interface Registration {
  clientId: string
  subject?: string
  email?: string
}

interface Session {
  idToken: string
  accessToken: string
  refreshToken: string
  scopes: string[]
  expiresAt: number
  savedAt: number
  name?: string
  plan?: string
}

interface Stored {
  version: 2
  registration?: Registration
  session?: Session
}

interface TokenResponse {
  id_token?: string
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

const base64url = (buf: Buffer): string => buf.toString('base64url')

function decodeJwt(token: string): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
  } catch {
    return {}
  }
}

/** An OAuth error's code and words, from a JSON body (or the body itself). */
function oauthError(text: string): { code?: string; message: string } {
  try {
    const body = JSON.parse(text) as { error?: unknown; error_description?: unknown; detail?: unknown }
    const code = typeof body.error === 'string' ? body.error : typeof (body.error as { code?: unknown })?.code === 'string' ? (body.error as { code: string }).code : undefined
    const description = typeof body.error_description === 'string' ? body.error_description : typeof body.detail === 'string' ? body.detail : undefined
    return { code, message: description || code || text.slice(0, 300) }
  } catch {
    return { message: text.slice(0, 300) }
  }
}

class TokenError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message) }
}

async function postForm(url: string, body: Record<string, string>): Promise<Response> {
  try {
    return await net.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
  } catch (err) {
    // Worded like the answers' own connection errors, so an answer waiting on a token refresh retries.
    throw new Error("Can't reach ChatGPT's sign-in service. Check your internet connection.", { cause: err })
  }
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const res = await postForm(TOKEN_URL, body)
  const text = await res.text()
  if (!res.ok) {
    const error = oauthError(text)
    throw new TokenError(`Token request failed (${res.status}): ${error.message}`, res.status, error.code)
  }
  const data = JSON.parse(text) as TokenResponse
  if (!data.access_token) throw new TokenError('The sign-in service sent no access token.', res.status)
  return data
}

const page = (title: string, body: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;background:#0f1115;color:#e6e8ee;display:grid;place-items:center;height:100vh;margin:0">` +
  `<div style="text-align:center"><h2>${title}</h2><p style="color:#9aa3b2">${body}</p></div>`

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

function listen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = (): void => resolve(false)
    server.once('error', onError)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError)
      resolve(true)
    })
  })
}

/** OpenAI's published signing keys and sign-in endpoints, kept for an hour. */
interface Discovery { issuer: string; jwks_uri: string; revocation_endpoint?: string }
let discovery: { value: Discovery; at: number } | undefined
let keys: { value: (JsonWebKey & { kid?: string })[]; at: number } | undefined

async function fetchJson<T>(url: string): Promise<T> {
  const res = await net.fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  return (await res.json()) as T
}

async function openIdConfiguration(): Promise<Discovery> {
  if (discovery && Date.now() - discovery.at < KEYS_FRESH_MS) return discovery.value
  const value = await fetchJson<Discovery>(DISCOVERY_URL)
  if (typeof value.jwks_uri !== 'string' || !value.jwks_uri.startsWith('https://')) throw new Error("ChatGPT's sign-in service sent no signing keys.")
  discovery = { value, at: Date.now() }
  return value
}

async function signingKey(kid: string | undefined, fresh = false): Promise<JsonWebKey | undefined> {
  if (fresh || !keys || Date.now() - keys.at >= KEYS_FRESH_MS) {
    const { jwks_uri } = await openIdConfiguration()
    keys = { value: (await fetchJson<{ keys?: (JsonWebKey & { kid?: string })[] }>(jwks_uri)).keys ?? [], at: Date.now() }
  }
  const found = keys.value.find(key => !kid || key.kid === kid)
  if (!found && !fresh) return signingKey(kid, true)
  return found
}

/** For tests: forget the cached keys and endpoints. */
export function forgetSigningKeys(): void { discovery = undefined; keys = undefined }

/**
 * The ID token's claims once it's verified: signed by one of OpenAI's published keys, from OpenAI's issuer, for this
 * registration's client ID, unexpired, and with this attempt's nonce (when there is one).
 */
export async function verifyIdToken(token: string, clientId: string, nonce?: string, now = Date.now()): Promise<Record<string, any>> {
  const [head, body, signature] = token.split('.')
  if (!head || !body || !signature) throw new Error('ChatGPT sent a malformed sign-in token.')
  let header: { alg?: string; kid?: string }
  try { header = JSON.parse(Buffer.from(head, 'base64url').toString('utf8')) } catch { throw new Error('ChatGPT sent a malformed sign-in token.') }
  if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error('ChatGPT signed its sign-in token in a way Togle does not accept.')
  const jwk = await signingKey(header.kid)
  if (!jwk) throw new Error("ChatGPT's sign-in token was signed with an unknown key.")
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  const data = Buffer.from(`${head}.${body}`)
  const valid = header.alg === 'RS256'
    ? verify('RSA-SHA256', data, key, Buffer.from(signature, 'base64url'))
    : verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  if (!valid) throw new Error("ChatGPT's sign-in token isn't signed by OpenAI.")
  const claims = decodeJwt(token)
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== ISSUER) throw new Error('The sign-in token comes from another issuer.')
  if (!audience.includes(clientId)) throw new Error('The sign-in token is for another app.')
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_S < now / 1000) throw new Error('The sign-in token has expired. Sign in again.')
  if (nonce !== undefined && claims.nonce !== nonce) throw new Error("The sign-in token doesn't belong to this sign-in. Try again.")
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('The sign-in token names no account.')
  return claims
}

function planOf(claims: Record<string, any>): string | undefined {
  const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type
  return typeof plan === 'string' ? plan : undefined
}

/** Ends the renewable session at OpenAI: the refresh token is revoked at the endpoint its configuration names. */
async function revokeSession(clientId: string, refreshToken: string): Promise<void> {
  const { revocation_endpoint } = await openIdConfiguration()
  if (!revocation_endpoint?.startsWith('https://')) return
  // Retried a couple of times on a network failure or a server error while the token is still at hand.
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await postForm(revocation_endpoint, { token: refreshToken, token_type_hint: 'refresh_token', client_id: clientId })
      if (res.ok) return
      if (res.status < 500 || attempt >= 3) throw new Error(`revocation answered ${res.status}`)
    } catch (err) {
      if (attempt >= 3) throw err
    }
    await new Promise(resolve => setTimeout(resolve, 1000 * attempt))
  }
}

export class ChatGPTAuth extends EventEmitter {
  constructor(private tokenFile = TOKEN_FILE, private hostFile = HOST_FILE, private revoke: (clientId: string, refreshToken: string) => Promise<void> = revokeSession) { super() }
  private stored: Stored = { version: 2 }
  private refreshing: Promise<void> | null = null
  /** Chain of token-file writes, so they land in order (a sign-out wins over a refresh's write still under way). */
  private saving: Promise<void> = Promise.resolve()
  private lastError: string | undefined
  private cancelLogin: (() => void) | null = null
  /** The user declined ChatGPT plan use: the next sign-in asks for it again explicitly. */
  private askConsent = false

  async load(): Promise<void> {
    const value = await readSecret<Stored | Record<string, unknown>>(this.tokenFile)
    // A sign-in from before Togle used OpenAI's own sign-in for open-source apps can't be used: start afresh.
    this.stored = value && (value as Stored).version === 2 ? value as Stored : { version: 2 }
  }

  private get session(): Session | undefined { return this.stored.session }

  status(): AuthStatus {
    const session = this.session
    return {
      signedIn: !!session,
      email: session ? this.stored.registration?.email : undefined,
      name: session?.name,
      plan: session?.plan,
      error: this.lastError
    }
  }

  identity(): string | undefined {
    return this.session ? JSON.stringify([this.stored.registration?.subject, this.stored.registration?.email]) : undefined
  }

  private changed(): void {
    this.emit('changed', this.status())
  }

  private save(stored: Stored): Promise<void> {
    this.stored = stored
    const write = this.saving.then(() => writeSecret(this.tokenFile, stored.registration || stored.session ? stored : null))
    this.saving = write.catch(() => undefined)
    return write
  }

  /** This computer's ID for OpenAI: chosen once, before the first sign-in, and the same for every account. */
  private async hostId(): Promise<string> {
    const saved = await readJson<{ hostId?: string }>(this.hostFile, {})
    if (typeof saved.hostId === 'string' && /^urn:uuid:[0-9a-f-]{36}$/.test(saved.hostId)) return saved.hostId
    const hostId = `urn:uuid:${randomUUID()}`
    await writeJson(this.hostFile, { hostId })
    return hostId
  }

  /**
   * Continue with ChatGPT: the browser signs in and asks to allow Togle to use the ChatGPT plan, then comes back to a
   * loopback address here with a code, exchanged (with PKCE) for the tokens.
   */
  async signInWithBrowser(): Promise<AuthStatus> {
    this.cancel()
    this.lastError = undefined
    const registration = this.stored.registration
    const verifier = base64url(randomBytes(64))
    const challenge = base64url(createHash('sha256').update(verifier).digest())
    const state = base64url(randomBytes(32))
    const nonce = base64url(randomBytes(32))
    const hostId = await this.hostId()

    const server = http.createServer()
    let port = 0
    for (const candidate of [...CALLBACK_PORTS, 0]) {
      if (await listen(server, candidate)) {
        port = (server.address() as { port: number }).port
        break
      }
    }
    if (!port) {
      this.lastError = "Togle couldn't open a local address for the sign-in to come back to. Try again."
      this.changed()
      return this.status()
    }
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sign-in timed out')), LOGIN_TIMEOUT_MS)
      this.cancelLogin = () => { clearTimeout(timer); reject(new Error('Sign-in cancelled')) }
      server.on('request', async (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        if (url.pathname !== CALLBACK_PATH) { res.writeHead(404).end(); return }
        const fail = (title: string, message: string, err: Error): void => {
          res.writeHead(400, { 'Content-Type': 'text/html' }).end(page(title, escapeHtml(message)))
          clearTimeout(timer)
          reject(err)
        }
        if (url.searchParams.get('state') !== state) { res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Sign-in failed', 'This page is from another sign-in. Start again from Togle.')); return }
        const error = url.searchParams.get('error')
        if (error === 'access_denied') {
          this.askConsent = true
          return fail('Not connected', 'Togle uses your ChatGPT plan only when you allow it. You can try again from Togle.', new Error("You didn't allow Togle to use your ChatGPT plan."))
        }
        if (error) return fail('Sign-in failed', url.searchParams.get('error_description') ?? error, new Error(url.searchParams.get('error_description') ?? error))
        const code = url.searchParams.get('code')
        const issued = url.searchParams.get('client_id') ?? undefined
        if (!code) return fail('Sign-in failed', 'ChatGPT sent no sign-in code.', new Error('ChatGPT sent no sign-in code.'))
        // A first sign-in is handed the client ID OpenAI issued for it; a returning one keeps its own.
        if (registration && issued && issued !== registration.clientId) return fail('Sign-in failed', 'ChatGPT answered for another registration.', new Error('ChatGPT answered for another registration of Togle. Try again.'))
        const clientId = registration?.clientId ?? issued
        if (!clientId || clientId === REGISTER_CLIENT) return fail('Sign-in failed', 'Registration did not finish.', new Error("ChatGPT didn't finish registering Togle. Try again."))
        try {
          const tokens = await postToken({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE })
          if (!tokens.id_token) throw new Error('ChatGPT sent no sign-in token.')
          const claims = await verifyIdToken(tokens.id_token, clientId, nonce)
          if (registration?.subject && claims.sub !== registration.subject) throw new Error('You signed in to a different ChatGPT account. Add it as another account instead.')
          const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean)
          const email = typeof claims.email === 'string' ? claims.email : registration?.email
          const next: Registration = { clientId, subject: claims.sub, email }
          if (!scopes.includes(PLAN_SCOPE)) {
            // Signed in, but not allowed to use the plan: nothing to answer with. The registration stays for next time.
            this.askConsent = true
            await this.save({ version: 2, registration: next })
            throw new Error('Togle can use your ChatGPT plan only if you allow it. Sign in again and allow it.')
          }
          this.askConsent = false
          await this.save({ version: 2, registration: next, session: this.sessionFrom(tokens, claims) })
          res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Togle is connected', 'You can close this tab.'))
          clearTimeout(timer)
          resolve()
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/html' }).end(page('Sign-in failed', escapeHtml((err as Error).message)))
          clearTimeout(timer)
          reject(err)
        }
      })
    })

    const params: Record<string, string> = {
      client_id: registration?.clientId ?? REGISTER_CLIENT,
      ...(registration ? {} : { agent_name_hint: AGENT_NAME }),
      ext_agent_host_id: hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      ...(registration?.email ? { login_hint: registration.email } : {}),
      ...(registration && this.session?.idToken ? { id_token_hint: this.session.idToken } : {}),
      ...(this.askConsent ? { prompt: 'consent' } : {})
    }
    const authorize = new URL(AUTHORIZE_URL)
    authorize.search = new URLSearchParams(params).toString()
    await shell.openExternal(authorize.toString())

    try {
      await done
    } catch (err) {
      this.lastError = (err as Error).message
    } finally {
      this.cancelLogin = null
      server.close()
      this.changed()
    }
    return this.status()
  }

  /** Sign-in through a code typed on another device isn't part of OpenAI's sign-in for open-source apps. */
  async signInWithDeviceCode(): Promise<AuthStatus> {
    this.lastError = 'Continue with ChatGPT opens your browser to sign in. Sign-in with a device code is not available.'
    this.changed()
    return this.status()
  }

  private sessionFrom(tokens: TokenResponse, claims: Record<string, any>, previous?: Session): Session {
    const access = decodeJwt(tokens.access_token)
    const expiresAt = typeof tokens.expires_in === 'number' ? Date.now() + tokens.expires_in * 1000 : typeof access.exp === 'number' ? access.exp * 1000 : Date.now() + 60 * 60_000
    return {
      idToken: tokens.id_token ?? previous?.idToken ?? '',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? previous?.refreshToken ?? '',
      scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [],
      expiresAt,
      savedAt: Date.now(),
      name: typeof claims.name === 'string' ? claims.name : previous?.name,
      plan: planOf(claims) ?? previous?.plan
    }
  }

  cancel(): void {
    this.cancelLogin?.()
    this.cancelLogin = null
  }

  /**
   * Forgets the tokens here at once, and ends the renewable session at OpenAI meanwhile (with the refresh token kept in
   * memory for it). The registration and host ID stay for the next sign-in.
   */
  async signOut(): Promise<AuthStatus> {
    this.cancel()
    this.lastError = undefined
    const { registration, session } = this.stored
    await this.save({ version: 2, registration })
    this.changed()
    if (session?.refreshToken && registration) {
      void this.revoke(registration.clientId, session.refreshToken).catch(err => {
        // Signed out here either way; the user can disconnect Togle in ChatGPT's settings.
        console.warn('[chatgpt] signed out here; OpenAI did not confirm ending the session:', (err as Error).message)
      })
    }
    return this.status()
  }

  /** Returns a valid access token, refreshing it shortly before expiry. */
  async getAccess(forceRefresh = false): Promise<{ accessToken: string; accountId: string }> {
    if (!this.session) throw new Error(NOT_SIGNED_IN)
    if (forceRefresh || this.session.expiresAt - Date.now() < REFRESH_WINDOW_MS) {
      // A test run on a copy of the sign-in: refreshing it would sign the real Togle out.
      if (process.env.TOGLE_NO_REFRESH) throw new Error('This run may not refresh the ChatGPT sign-in.')
      this.refreshing ??= this.refresh().finally(() => {
        this.refreshing = null
      })
      await this.refreshing
    }
    // Signed out while it refreshed.
    if (!this.session) throw new Error(NOT_SIGNED_IN)
    return { accessToken: this.session.accessToken, accountId: this.stored.registration?.subject ?? '' }
  }

  private async refresh(): Promise<void> {
    const before = this.stored
    const { registration, session } = before
    if (!registration || !session) throw new Error(NOT_SIGNED_IN)
    try {
      const res = await postToken({ grant_type: 'refresh_token', client_id: registration.clientId, refresh_token: session.refreshToken, resource: RESOURCE })
      // Signed out (or into another account) meanwhile: keep it that way, don't bring the old session back.
      if (this.stored !== before) return
      await this.save({ ...before, session: this.sessionFrom(res, res.id_token ? decodeJwt(res.id_token) : {}, session) })
    } catch (err) {
      // A refresh token that's no good (expired, reused, revoked) means the session is gone for good, unless it was
      // already left (signed out, or in again) while this was under way. A network failure keeps it.
      const dead = err instanceof TokenError && (DEAD_SESSION.test(err.code ?? '') || err.code === 'invalid_client' || (err.status === 401 && !err.code))
      if (this.stored === before && dead) {
        // A client OpenAI no longer knows can't sign in again: the next sign-in registers Togle anew.
        await this.save({ version: 2, registration: (err as TokenError).code === 'invalid_client' ? undefined : registration })
        this.lastError = 'Your ChatGPT session expired. Please sign in again.'
        this.changed()
      }
      throw err
    }
  }
}
