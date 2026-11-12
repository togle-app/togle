import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { workDir } from './helpers.mjs'

const directory = workDir('subscription-accounts')
const { SubscriptionAccounts, accountChoice, ChatGPTAuth, ChatGPTProvider, ClaudeCodeAuth, ClaudeSubscriptionProvider, AgentStore, getSettings } = await import('./.build/togle.mjs')
const fixture = () => {
  const openai = new ChatGPTAuth(), claude = new ClaudeCodeAuth()
  claude.status = async () => ({ available: true, signedIn: false })
  return new SubscriptionAccounts(openai, new ChatGPTProvider(openai), claude, new ClaudeSubscriptionProvider(claude))
}

test('global default and agent overrides route explicitly, including missing profiles', async () => {
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.claude.auth = 'subscription'
  assert.equal(accountChoice(settings), 'claude-default')
  settings.subscriptionAccountId = 'personal'
  assert.equal(accountChoice(settings), 'personal'); assert.equal(accountChoice(settings, 'work'), 'work')
  settings.provider = 'compat'
  assert.equal(accountChoice(settings), undefined); assert.equal(accountChoice(settings, 'work'), 'work')
  assert.throws(() => fixture().get('missing-work-account'), /unavailable/)
})

test('personal and work ChatGPT profiles keep encrypted credentials, identity and sign-out independent', async () => {
  const accounts = fixture()
  const first = await accounts.add('chatgpt', 'Personal'), second = await accounts.add('chatgpt', 'Work')
  const jwt = value => `h.${Buffer.from(JSON.stringify(value)).toString('base64url')}.s`
  for (const [account, name] of [[first, 'Luka Personal'], [second, 'Luka Work']]) {
    const file = path.join(directory, 'accounts', account.id, 'chatgpt-auth.bin')
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, 'ENC:' + JSON.stringify({ version: 2, registration: { clientId: `oaiapp_${account.id}`, subject: account.id, email: `${account.label}@test.example` }, session: { idToken: jwt({ name }), name, accessToken: account.id, refreshToken: 'test-refresh', scopes: ['chatgpt.tokens.use.direct'], expiresAt: Date.now() + 3600000, savedAt: Date.now() } }))
    await accounts.get(account.id).auth.load()
  }
  assert.equal(accounts.identity(second.id).name, 'Luka Work')
  assert.equal((await accounts.get(first.id).auth.getAccess()).accountId, first.id)
  assert.equal((await accounts.get(second.id).auth.getAccess()).accountId, second.id)
  await accounts.signOut(first.id)
  assert.equal(accounts.identity(first.id).signedIn, false)
  assert.equal(accounts.identity(second.id).signedIn, true)
  const reloaded = fixture(); await reloaded.load()
  assert.equal(reloaded.identity(second.id).email, 'Work@test.example')
  assert.equal(reloaded.identity(first.id).signedIn, false)
  const metadata = await fs.readFile(path.join(directory, 'accounts/index.json'), 'utf8')
  assert.ok(!metadata.includes('accessToken') && !metadata.includes('refreshToken'))
})

test('each Claude account has its own official runtime and secure-storage namespace', async () => {
  const accounts = fixture(), work = await accounts.add('claude', 'Work'), personal = await accounts.add('claude', 'Personal')
  const workAuth = accounts.get(work.id).auth, personalAuth = accounts.get(personal.id).auth
  workAuth.status = async () => workAuth.cachedStatus(); personalAuth.status = async () => personalAuth.cachedStatus()
  assert.notEqual(workAuth.environment().CLAUDE_CONFIG_DIR, personalAuth.environment().CLAUDE_CONFIG_DIR)
  assert.equal(workAuth.environment().CLAUDE_CONFIG_DIR, workAuth.environment().CLAUDE_SECURESTORAGE_CONFIG_DIR)
  assert.equal(await workAuth.directory(), path.join(directory, 'accounts', work.id, 'claude/runtime'))
  assert.ok(!(await accounts.list()).some(account => 'accessToken' in account || 'configDirectory' in account))
})

test('pinned calls keep their account and fail closed after reauthentication; user name follows the account', async () => {
  const accounts = fixture(), account = await accounts.add('claude', 'Work'), entry = accounts.get(account.id)
  let status = { available: true, signedIn: true, email: 'work@test.example', name: 'Luka' }
  let identity = 'work-organization'
  entry.auth.identity = () => identity
  entry.auth.status = async () => status; entry.auth.cachedStatus = () => status
  const requests = []; entry.provider.stream = async input => { requests.push(input) }
  const pinned = accounts.pinned(account.id), input = { lane: 'quick', user: 'Private work call', system: 'Help the meeting.' }, options = { signal: new AbortController().signal, onDelta: () => {} }
  await accounts.add('chatgpt', 'Other profile')
  await pinned.stream(input, options)
  assert.equal(requests.length, 1); assert.match(requests[0].system, /Luka/)
  identity = 'other-organization'
  await assert.rejects(pinned.stream(input, options), /identity changed/, 'Same email in another organization is still a different account context')
  identity = 'work-organization'
  status = { ...status, email: 'personal@test.example' }
  await assert.rejects(pinned.stream(input, options), /identity changed/)
  assert.equal(requests.length, 1)
  status = { ...status, signedIn: false }
  await assert.rejects(pinned.stream(input, options), /Sign in to Work/)
})

test('a Claude account pinned before its sign-in is read (Togle reads it in the background as it starts) is pinned as it is read', async () => {
  const accounts = fixture(), account = await accounts.add('claude', 'Startup'), entry = accounts.get(account.id)
  let email = 'work@test.example', runs = 0
  // The official runtime's status, without starting it.
  entry.auth.run = async () => { runs++; await new Promise(resolve => setTimeout(resolve, 20)); return { code: 0, output: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email, configDirectory: entry.auth.environment().CLAUDE_CONFIG_DIR }) } }
  const requests = []; entry.provider.stream = async input => { requests.push(input) }
  const input = { lane: 'quick', user: 'First call after start', system: 'Help.' }, options = { signal: new AbortController().signal, onDelta: () => {} }
  assert.equal(entry.auth.read, false)
  const pinned = accounts.pinned(account.id)
  await pinned.stream(input, options)
  assert.equal(requests.length, 1, 'a sign-in not read yet is not taken for a signed-out one')
  assert.equal(entry.auth.read, true); assert.equal(runs, 1)
  email = 'someone-else@test.example'
  await entry.auth.status(true)
  await assert.rejects(pinned.stream(input, options), /identity changed/, 'pinned to the sign-in it read first')
  assert.equal(requests.length, 1)
  // Read before pinning, it's pinned at once, as before.
  const now = accounts.pinned(account.id)
  await now.stream(input, options)
  assert.equal(requests.length, 2)
})

test("an agent's account choice survives a restart, and an empty one goes back to the general account", async () => {
  const store = new AgentStore(); await store.load()
  const agent = store.list()[0]
  await store.update(agent.id, { subscriptionAccountId: 'work-account-id' })
  const restored = new AgentStore(); await restored.load()
  assert.equal(restored.get(agent.id).subscriptionAccountId, 'work-account-id')
  assert.equal((await restored.update(agent.id, { subscriptionAccountId: '' })).subscriptionAccountId, undefined)
})

test('prepared dictation rechecks the pinned account before delivering any text', async () => {
  const accounts = fixture(), account = await accounts.add('claude', 'Prepared work'), entry = accounts.get(account.id)
  const status = { available: true, signedIn: true, email: 'work@test.example' }
  let identity = 'work-organization', closed = 0
  entry.auth.identity = () => identity
  entry.auth.status = async () => status; entry.auth.cachedStatus = () => status
  const sent = []
  entry.provider.prepareText = async () => ({ send: async text => { sent.push(text) }, close: () => { closed++ } })
  const pinned = accounts.pinned(account.id, false)
  const prepared = await pinned.prepareText({ lane: 'quick', system: 'Edit.', user: '' }, { signal: new AbortController().signal, onDelta: () => {} })
  identity = 'personal-organization'
  await assert.rejects(prepared.send('Private work dictation'), /identity changed/)
  assert.deepEqual(sent, []); assert.equal(closed, 1)
})
