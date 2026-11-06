import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('claude-auth')
const { ClaudeCodeAuth, claudeSubscriptionEnv } = await import('./.build/togle.mjs')
const signedIn = (email = 'test@example.com') => ({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email, subscriptionType: 'max' })
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function respond(child, status, code = 0) {
  child.stdout.emit('data', Buffer.from(JSON.stringify(status)))
  child.emit('close', code)
}

function scripted(answers) {
  const calls = []
  const auth = new ClaudeCodeAuth(() => 'official-claude.exe', (file, args, env, cwd) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true }
    calls.push({ file, args, env, cwd, child })
    queueMicrotask(() => {
      const next = answers.shift()
      if (typeof next === 'function') next(child)
      else respond(child, next, next?.loggedIn === false ? 1 : 0)
    })
    return child
  })
  return { auth, calls }
}

test('Claude auth reads only the official CLI status, caches it, and can refresh it', async () => {
  const { auth, calls } = scripted([signedIn(), signedIn('other@example.com')])
  assert.deepEqual(await auth.status(), { available: true, signedIn: true, email: 'test@example.com', plan: 'max' })
  assert.equal((await auth.status()).email, 'test@example.com')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['auth', 'status'])
  assert.equal((await auth.status(true)).email, 'other@example.com')
  assert.equal(calls.length, 2)
})

test('an API-key or cloud-provider CLI login is not accepted as a Claude subscription', async () => {
  for (const status of [
    { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' },
    { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' },
    { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }
  ]) {
    const { auth } = scripted([status])
    const result = await auth.status()
    assert.equal(result.signedIn, false)
    assert.match(result.error, /another billing method/)
  }
})

test('Claude speech profile comes from the official account status and rejects missing metadata or sign-out', async () => {
  const directory = process.platform === 'win32' ? 'C:\\accounts\\claude' : '/accounts/claude'
  const { auth } = scripted([{ ...signedIn(), configDirectory: directory, orgId: 'team-one' }, { loggedIn: false }])
  assert.deepEqual(await auth.speechProfile(), { directory, email: 'test@example.com', organization: 'team-one', keychainService: 'Claude Code-credentials' })
  await assert.rejects(auth.speechProfile(), /Sign in/)
  const missing = scripted([signedIn()])
  await assert.rejects(missing.auth.speechProfile(), /Sign in/)
})

test('subscription processes cannot inherit API keys, gateway routing or exported tokens', (t) => {
  const values = {
    ANTHROPIC_API_KEY: 'foreign-key', ANTHROPIC_AUTH_TOKEN: 'foreign-token', ANTHROPIC_BASE_URL: 'https://foreign.test',
    ANTHROPIC_CUSTOM_HEADERS: 'Authorization: foreign', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_OAUTH_TOKEN: 'foreign-oauth',
    CLAUDE_CODE_SESSION_ACCESS_TOKEN: 'foreign-session', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: 'chosen-config'
  }
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  t.after(() => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  Object.assign(process.env, values)
  const env = claudeSubscriptionEnv()
  for (const key of Object.keys(values).filter((key) => key !== 'CLAUDE_CONFIG_DIR')) assert.equal(env[key], undefined, key)
  assert.equal(env.CLAUDE_CONFIG_DIR, 'chosen-config', 'the account folder is still the one the user chose')
  assert.equal(process.env.ANTHROPIC_API_KEY, 'foreign-key', 'the parent environment stays intact')
})

test('browser sign-in is owned by the official CLI; only its URL and account status reach the window', async () => {
  const started = deferred()
  const url = 'https://claude.ai/oauth/authorize?client_id=official&state=test'
  const { auth, calls } = scripted([
    (child) => { child.stdout.emit('data', Buffer.from(`Open ${url}\n`)); started.resolve(child) },
    signedIn()
  ])
  const seen = []
  auth.onChange = (status) => seen.push(status)
  const login = auth.signIn()
  const child = await started.promise
  assert.equal(seen.at(-1).url, url)
  assert.equal(seen.at(-1).signingIn, true)
  respond(child, {})
  assert.equal((await login).signedIn, true)
  assert.deepEqual(calls.map((call) => call.args), [['auth', 'login'], ['auth', 'status']])
  assert.equal(seen.at(-1).url, undefined)
})

test('signing out cancels a login first; its late browser output cannot sign the user back in', async () => {
  const started = deferred()
  const { auth, calls } = scripted([(child) => started.resolve(child), {}, { loggedIn: false }])
  const login = auth.signIn()
  const child = await started.promise
  const logout = auth.signOut()
  child.stdout.emit('data', Buffer.from('https://claude.ai/oauth/authorize?state=old'))
  assert.equal((await logout).signedIn, false)
  assert.equal((await login).signedIn, false)
  assert.deepEqual(calls.map((call) => call.args), [['auth', 'login'], ['auth', 'logout']])
  assert.equal((await auth.status()).url, undefined)
})

test('a status read started before sign-out cannot replace the signed-out status', async () => {
  const started = deferred()
  const { auth } = scripted([(child) => started.resolve(child), {}])
  const reading = auth.status()
  const child = await started.promise
  await auth.signOut()
  respond(child, signedIn())
  assert.equal((await reading).signedIn, false)
})

test('logout waits until a cancelled native login has actually exited', async () => {
  const started = deferred()
  const killed = deferred()
  const { auth, calls } = scripted([(child) => {
    child.kill = () => { killed.resolve(); return true }
    started.resolve(child)
  }, {}])
  const login = auth.signIn()
  const child = await started.promise
  const logout = auth.signOut()
  await killed.promise
  assert.equal(calls.length, 1, 'logout cannot overtake a still-running login')
  child.emit('close', 1)
  await Promise.all([login, logout])
  assert.deepEqual(calls[1].args, ['auth', 'logout'])
})

test('a missing runtime and a runtime that cannot start report a useful problem', async () => {
  const absent = new ClaudeCodeAuth(() => { throw new Error('The Claude subscription runtime is missing. Reinstall Togle.') })
  assert.deepEqual(await absent.status(), { available: false, signedIn: false, error: 'The Claude subscription runtime is missing. Reinstall Togle.' })
  const { auth } = scripted([(child) => child.emit('error', new Error('ENOENT'))])
  assert.match((await auth.status()).error, /could not start/)
})
