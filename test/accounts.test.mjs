import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { workDir } from './helpers.mjs'

const directory = workDir('subscription-accounts')
const { SubscriptionAccounts, accountChoice, ChatGPTAuth, ChatGPTProvider, AgentStore, getSettings } = await import('./.build/togle.mjs')
const fixture = () => {
  const openai = new ChatGPTAuth()
  return new SubscriptionAccounts(openai, new ChatGPTProvider(openai))
}

test('global default and agent overrides route explicitly, including missing profiles', async () => {
  const settings = structuredClone(getSettings()); settings.provider = 'chatgpt'
  assert.equal(accountChoice(settings), 'chatgpt-default')
  settings.subscriptionAccountId = 'personal'
  assert.equal(accountChoice(settings), 'personal'); assert.equal(accountChoice(settings, 'work'), 'work')
  settings.provider = 'compat'
  assert.equal(accountChoice(settings), undefined); assert.equal(accountChoice(settings, 'work'), 'work')
  settings.provider = 'claude'
  assert.equal(accountChoice(settings), undefined, 'a Claude key is not a plan: there is no Claude sign-in')
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

test('there is no Claude sign-in: a Claude account cannot be added, and one an earlier Togle saved is skipped', async () => {
  const accounts = fixture()
  await assert.rejects(accounts.add('claude', 'Work'), /Enter an account label/)
  assert.deepEqual((await accounts.list()).map(account => account.provider), ['chatgpt'])
  // A saved file with a Claude account (from a Togle that had the sign-in) and a ChatGPT one: only the ChatGPT one is kept.
  const kept = '11111111-1111-4111-8111-111111111111', dropped = '22222222-2222-4222-8222-222222222222'
  await fs.mkdir(path.join(directory, 'accounts'), { recursive: true })
  await fs.writeFile(path.join(directory, 'accounts/index.json'), JSON.stringify([{ id: dropped, provider: 'claude', label: 'Old Claude' }, { id: kept, provider: 'chatgpt', label: 'Kept' }]))
  const reloaded = fixture(); await reloaded.load()
  assert.deepEqual((await reloaded.list()).map(account => account.id).sort(), ['chatgpt-default', kept].sort())
  assert.throws(() => reloaded.get(dropped), /unavailable/)
})

test('pinned calls keep their account and fail closed after reauthentication; user name follows the account', async () => {
  const accounts = fixture(), account = await accounts.add('chatgpt', 'Work'), entry = accounts.get(account.id)
  let status = { signedIn: true, email: 'work@test.example', name: 'Luka' }
  let identity = 'work-organization'
  entry.auth.identity = () => identity
  entry.auth.status = () => status
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

test("an agent's account choice survives a restart, and an empty one goes back to the general account", async () => {
  const store = new AgentStore(); await store.load()
  const agent = store.list()[0]
  await store.update(agent.id, { subscriptionAccountId: 'work-account-id' })
  const restored = new AgentStore(); await restored.load()
  assert.equal(restored.get(agent.id).subscriptionAccountId, 'work-account-id')
  assert.equal((await restored.update(agent.id, { subscriptionAccountId: '' })).subscriptionAccountId, undefined)
})

test('prepared dictation rechecks the pinned account before delivering any text', async () => {
  const accounts = fixture(), account = await accounts.add('chatgpt', 'Prepared work'), entry = accounts.get(account.id)
  const status = { signedIn: true, email: 'work@test.example' }
  let identity = 'work-organization', closed = 0
  entry.auth.identity = () => identity
  entry.auth.status = () => status
  const sent = []
  entry.provider.prepareText = async () => ({ send: async text => { sent.push(text) }, close: () => { closed++ } })
  const pinned = accounts.pinned(account.id, false)
  const prepared = await pinned.prepareText({ lane: 'quick', system: 'Edit.', user: '' }, { signal: new AbortController().signal, onDelta: () => {} })
  identity = 'personal-organization'
  await assert.rejects(prepared.send('Private work dictation'), /identity changed/)
  assert.deepEqual(sent, []); assert.equal(closed, 1)
})
