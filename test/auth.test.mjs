// Sign in with ChatGPT (OpenAI's sign-in for open-source apps): registration, the ID token's checks, consent, and a
// token refresh that must never undo a sign-out or a newer sign-in.
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, promises as fs, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import electron from './electron.mjs'
import { wait, workDir } from './helpers.mjs'

const work = workDir('auth')
const { ChatGPTAuth, forgetSigningKeys, verifyIdToken } = await import('./.build/togle.mjs')

const settle = () => wait(50)
const tokenFile = path.join(work, 'chatgpt-auth.bin')
const saveStored = (stored) => writeFileSync(tokenFile, `ENC:${JSON.stringify(stored)}`)
const savedStored = () => (existsSync(tokenFile) ? JSON.parse(readFileSync(tokenFile, 'utf8').slice(4)) : null)
const jwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const noRevoke = async () => {}

/** What a finished sign-in saves: the registration OpenAI issued, and the session's tokens. */
const stored = (account, expiresIn) => ({
  version: 2,
  registration: { clientId: `oaiapp_${account}`, subject: account, email: `${account}@example.com` },
  session: {
    idToken: jwt({ email: `${account}@example.com`, sub: account }),
    accessToken: `access-${account}-1`,
    refreshToken: `refresh-${account}`,
    scopes: ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'],
    expiresAt: Date.now() + expiresIn,
    savedAt: Date.now()
  }
})

const refreshed = (account) =>
  new Response(
    JSON.stringify({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: account }), refresh_token: `refresh-${account}-2`, expires_in: 3600, token_type: 'Bearer' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  )

/** The token endpoint answers only when the test says so. */
function heldTokenEndpoint() {
  let answer, sent
  electron.net.fetch = (url, init) => { sent = { url, body: new URLSearchParams(init.body) }; return new Promise((resolve) => (answer = resolve)) }
  return { respond: (response) => answer(response), sent: () => sent }
}

/** Signed in with a token that expires in a minute, so the next getAccess() refreshes it. */
async function signedIn(account) {
  saveStored(stored(account, 60_000))
  const auth = new ChatGPTAuth(undefined, undefined, noRevoke)
  await auth.load()
  return auth
}

test('a normal refresh saves the new tokens, with its client ID and resource', async () => {
  const auth = await signedIn('A')
  const endpoint = heldTokenEndpoint()
  const access = auth.getAccess()
  await settle()
  endpoint.respond(refreshed('A'))
  const { accountId, accessToken } = await access
  assert.equal(accountId, 'A')
  assert.notEqual(accessToken, 'access-A-1')
  const { url, body } = endpoint.sent()
  assert.equal(url, 'https://auth.openai.com/api/accounts/oauth/token')
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('client_id'), 'oaiapp_A', 'the issued client ID, never dynamic_agent_client')
  assert.equal(body.get('refresh_token'), 'refresh-A')
  assert.equal(body.get('resource'), 'https://api.openai.com/v1')
  assert.equal(body.get('scope'), null, 'a refresh keeps the grant')
  await settle()
  assert.equal(savedStored().session.accessToken, accessToken)
  assert.equal(savedStored().session.refreshToken, 'refresh-A-2', 'the rotated refresh token replaces the old one')
})

test('signing out while a refresh waits for the server stays signed out', async () => {
  const auth = await signedIn('A')
  const endpoint = heldTokenEndpoint()
  const access = auth.getAccess()
  await auth.signOut()
  await settle()
  endpoint.respond(refreshed('A'))
  await assert.rejects(access, /Sign in with ChatGPT first, in Settings/)
  await settle()
  assert.equal(auth.status().signedIn, false, 'signed back in after signing out')
  assert.equal(savedStored().session, undefined, 'tokens are back on disk after signing out')
  assert.equal(savedStored().registration.clientId, 'oaiapp_A', 'the registration stays for the next sign-in')
})

test('signing out while the refreshed tokens are being written leaves no tokens in the file', async () => {
  const auth = await signedIn('A')
  electron.net.fetch = async () => refreshed('A')
  // Hold the refresh's file write until the sign-out has started.
  const realOpen = fs.open
  let release, writing
  const gate = new Promise((resolve) => (release = resolve))
  const started = new Promise((resolve) => (writing = resolve))
  fs.open = async (...args) => {
    fs.open = realOpen
    writing()
    await gate
    return realOpen.apply(fs, args)
  }
  try {
    const access = auth.getAccess().catch((err) => err)
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('the refresh never wrote its tokens')), 2000))])
    const out = auth.signOut()
    await settle()
    release()
    await Promise.all([access, out])
    await settle()
    assert.equal(auth.status().signedIn, false)
    assert.equal(savedStored().session, undefined, 'the refreshed tokens landed on disk after the sign-out removed them')
  } finally {
    fs.open = realOpen
  }
})

test('signing in to another account during a refresh keeps the new account', async () => {
  const auth = await signedIn('A')
  const endpoint = heldTokenEndpoint()
  const access = auth.getAccess()
  await settle()
  await auth.save(stored('B', 3_600_000)) // what a finished sign-in does
  endpoint.respond(refreshed('A'))
  assert.equal((await access).accountId, 'B')
  await settle()
  assert.equal(savedStored().registration.subject, 'B', 'the old account overwrote the new one on disk')
})

test('a rejected refresh of a replaced session leaves the new one signed in', async () => {
  const auth = await signedIn('A')
  const endpoint = heldTokenEndpoint()
  const access = auth.getAccess()
  await settle()
  await auth.save(stored('B', 3_600_000))
  endpoint.respond(new Response('{"error":"invalid_grant"}', { status: 400 }))
  await assert.rejects(access)
  await settle()
  assert.equal(auth.status().signedIn, true, 'the new session was wiped')
  assert.equal(auth.status().error, undefined)
  assert.equal(savedStored()?.registration.subject, 'B')
})

test('a refresh token that is no good signs out, keeping the registration; a network failure keeps the session', async () => {
  for (const code of ['invalid_grant', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']) {
    const auth = await signedIn('A')
    const endpoint = heldTokenEndpoint()
    const access = auth.getAccess()
    await settle()
    endpoint.respond(new Response(JSON.stringify({ error: code }), { status: 400 }))
    await assert.rejects(access, /Token request failed \(400\)/)
    await settle()
    assert.equal(auth.status().signedIn, false, code)
    assert.match(auth.status().error, /session expired/)
    assert.equal(savedStored().session, undefined)
    assert.equal(savedStored().registration.clientId, 'oaiapp_A', 'signing in again reuses the issued client ID')
  }
  const auth = await signedIn('A')
  electron.net.fetch = async () => { throw new TypeError('fetch failed') }
  await assert.rejects(auth.getAccess(), /Can't reach ChatGPT's sign-in service/)
  assert.equal(auth.status().signedIn, true, 'a dropped connection is not a sign-out')
  // A client OpenAI no longer knows: the next sign-in registers Togle anew.
  const unknown = await signedIn('A')
  const endpoint = heldTokenEndpoint()
  const access = unknown.getAccess()
  await settle()
  endpoint.respond(new Response('{"error":"invalid_client"}', { status: 401 }))
  await assert.rejects(access)
  await settle()
  assert.equal(savedStored(), null)
})

test('a sign-in from before Togle used OpenAI’s own sign-in starts afresh', async () => {
  saveStored({ idToken: jwt({}), accessToken: 'old', refreshToken: 'old', accountId: 'old-account', expiresAt: Date.now() + 3_600_000 })
  const auth = new ChatGPTAuth(undefined, undefined, noRevoke)
  await auth.load()
  assert.equal(auth.status().signedIn, false)
})

// ---- The browser sign-in, against a fake OpenAI ----

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }
const signed = (claims, key = privateKey, kid = 'test-key') => {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`
}
const idClaims = (over = {}) => ({ iss: 'https://auth.openai.com', aud: 'oaiapp_issued', sub: 'user-1', email: 'me@example.com', name: 'Me', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000), ...over })

/** OpenAI's endpoints: configuration, keys, token exchange and revocation, answering as the test says. */
function fakeOpenAI({ token = () => ({}), status = 200 } = {}) {
  const calls = []
  electron.net.fetch = async (url, init = {}) => {
    calls.push({ url, body: init.body ? new URLSearchParams(init.body) : undefined })
    if (url === 'https://auth.openai.com/.well-known/openid-configuration') return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' })
    if (url === 'https://auth.openai.com/.well-known/jwks.json') return Response.json({ keys: [jwk] })
    if (url === 'https://auth.openai.com/api/accounts/oauth/token') return new Response(JSON.stringify(token(calls.at(-1).body)), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === 'https://auth.openai.com/api/accounts/oauth/revoke') return new Response('', { status: 200 })
    throw new Error('unexpected request ' + url)
  }
  return calls
}

/** The browser: the authorize address Togle opens, and coming back to it with what OpenAI would add. */
function browser(back) {
  const opened = []
  electron.shell.openExternal = async (url) => {
    const params = new URL(url).searchParams
    opened.push(params)
    const callback = new URL(params.get('redirect_uri'))
    for (const [key, value] of Object.entries(back(params))) callback.searchParams.set(key, value)
    setTimeout(() => http.get(callback, (res) => res.resume()), 10)
  }
  return opened
}

const fresh = () => {
  rmSync(tokenFile, { force: true })
  forgetSigningKeys()
  return new ChatGPTAuth(undefined, undefined, noRevoke)
}

test('the first sign-in registers Togle for this host and keeps the client ID OpenAI issued', async () => {
  const auth = fresh()
  let nonce
  const calls = fakeOpenAI({ token: () => ({ access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), refresh_token: 'refresh-1', id_token: signed(idClaims({ nonce })), expires_in: 3600, scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke', token_type: 'Bearer' }) })
  const opened = browser((params) => { nonce = params.get('nonce'); return { code: 'code-1', state: params.get('state'), client_id: 'oaiapp_issued', scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke' } })
  const status = await auth.signInWithBrowser()
  assert.equal(status.error, undefined)
  assert.equal(status.signedIn, true)
  assert.equal(status.email, 'me@example.com')
  const first = opened[0]
  assert.equal(first.get('client_id'), 'dynamic_agent_client')
  assert.equal(first.get('agent_name_hint'), 'Togle')
  assert.match(first.get('ext_agent_host_id'), /^urn:uuid:[0-9a-f-]{36}$/)
  assert.equal(first.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
  assert.equal(first.get('resource'), 'https://api.openai.com/v1')
  assert.equal(first.get('response_type'), 'code')
  assert.equal(first.get('code_challenge_method'), 'S256')
  assert.match(first.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  assert.equal(first.get('id_token_hint'), null)
  const exchange = calls.find((call) => call.url.endsWith('/oauth/token')).body
  assert.equal(exchange.get('client_id'), 'oaiapp_issued')
  assert.equal(exchange.get('grant_type'), 'authorization_code')
  assert.equal(exchange.get('redirect_uri'), first.get('redirect_uri'))
  assert.equal(exchange.get('resource'), 'https://api.openai.com/v1')
  assert.ok(exchange.get('code_verifier')?.length >= 43)
  await settle()
  assert.equal(savedStored().registration.clientId, 'oaiapp_issued')
  assert.deepEqual(savedStored().session.scopes.sort(), ['chatgpt.tokens.use.direct', 'email', 'offline_access', 'openid', 'profile', 'resource.invoke'])

  // Again (reconnecting): the same client and host, the account's hints, no registration name.
  const hostId = first.get('ext_agent_host_id')
  const again = browser((params) => { nonce = params.get('nonce'); return { code: 'code-2', state: params.get('state') } })
  assert.equal((await auth.signInWithBrowser()).signedIn, true)
  assert.equal(again[0].get('client_id'), 'oaiapp_issued')
  assert.equal(again[0].get('agent_name_hint'), null)
  assert.equal(again[0].get('ext_agent_host_id'), hostId, 'one host ID for this computer')
  assert.equal(again[0].get('login_hint'), 'me@example.com')
  assert.ok(again[0].get('id_token_hint'))

  // Signed out: the registration and host stay, the ID token hint goes.
  await auth.signOut()
  const after = browser((params) => { nonce = params.get('nonce'); return { code: 'code-3', state: params.get('state') } })
  await auth.signInWithBrowser()
  assert.equal(after[0].get('client_id'), 'oaiapp_issued')
  assert.equal(after[0].get('id_token_hint'), null)
  assert.equal(after[0].get('ext_agent_host_id'), hostId)
})

test('declining ChatGPT plan use signs nobody in, and the next sign-in asks for it again', async () => {
  const auth = fresh()
  let nonce
  fakeOpenAI({ token: () => ({ access_token: jwt({}), refresh_token: 'r', id_token: signed(idClaims({ nonce })), scope: 'email openid profile offline_access' }) })
  browser((params) => ({ error: 'access_denied', state: params.get('state') }))
  const denied = await auth.signInWithBrowser()
  assert.equal(denied.signedIn, false)
  assert.match(denied.error, /didn't allow Togle to use your ChatGPT plan/)
  // Allowed sign-in, but without the plan permission: still no session.
  const opened = browser((params) => { nonce = params.get('nonce'); return { code: 'c', state: params.get('state'), client_id: 'oaiapp_issued' } })
  const partial = await auth.signInWithBrowser()
  assert.equal(opened[0].get('prompt'), 'consent', 'asked for again, explicitly')
  assert.equal(partial.signedIn, false)
  assert.match(partial.error, /only if you allow it/)
  assert.equal(savedStored().registration.clientId, 'oaiapp_issued', 'the registration is kept for the next attempt')
})

test('an ID token that is not OpenAI’s, for another app, expired, or from another attempt is refused', async () => {
  forgetSigningKeys()
  fakeOpenAI()
  const now = Date.now()
  assert.equal((await verifyIdToken(signed(idClaims({ nonce: 'n' })), 'oaiapp_issued', 'n', now)).sub, 'user-1')
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  await assert.rejects(verifyIdToken(signed(idClaims(), other), 'oaiapp_issued', undefined, now), /isn't signed by OpenAI/)
  await assert.rejects(verifyIdToken(signed(idClaims({ aud: 'oaiapp_other' })), 'oaiapp_issued', undefined, now), /another app/)
  await assert.rejects(verifyIdToken(signed(idClaims({ iss: 'https://example.com' })), 'oaiapp_issued', undefined, now), /another issuer/)
  await assert.rejects(verifyIdToken(signed(idClaims({ exp: Math.floor(now / 1000) - 3600 })), 'oaiapp_issued', undefined, now), /expired/)
  await assert.rejects(verifyIdToken(signed(idClaims({ nonce: 'old' })), 'oaiapp_issued', 'new', now), /doesn't belong to this sign-in/)
  await assert.rejects(verifyIdToken(signed(idClaims(), privateKey, 'unknown-key'), 'oaiapp_issued', undefined, now), /unknown key/)
  await assert.rejects(verifyIdToken(jwt(idClaims()), 'oaiapp_issued', undefined, now), /malformed|in a way Togle does not accept/)
})

test('reconnecting checks it is the same account, and a callback for another registration is refused', async () => {
  const auth = fresh()
  let nonce
  fakeOpenAI({ token: () => ({ access_token: jwt({}), refresh_token: 'r', id_token: signed(idClaims({ nonce })), scope: 'chatgpt.tokens.use.direct openid email profile offline_access resource.invoke' }) })
  browser((params) => { nonce = params.get('nonce'); return { code: 'c', state: params.get('state'), client_id: 'oaiapp_issued' } })
  assert.equal((await auth.signInWithBrowser()).signedIn, true)
  // Another ChatGPT account through this registration.
  fakeOpenAI({ token: () => ({ access_token: jwt({}), refresh_token: 'r', id_token: signed(idClaims({ nonce, sub: 'user-2' })), scope: 'chatgpt.tokens.use.direct openid' }) })
  browser((params) => { nonce = params.get('nonce'); return { code: 'c', state: params.get('state') } })
  const other = await auth.signInWithBrowser()
  assert.match(other.error, /different ChatGPT account/)
  assert.equal(savedStored().registration.subject, 'user-1')
  // A callback naming another client.
  browser((params) => ({ code: 'c', state: params.get('state'), client_id: 'oaiapp_someone_else' }))
  assert.match((await auth.signInWithBrowser()).error, /another registration/)
})
