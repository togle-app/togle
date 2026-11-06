import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { copilotWith, workDir } from './helpers.mjs'

const directory = workDir('subscription-accounts')
const { SubscriptionAccounts, accountChoice, ChatGPTAuth, ChatGPTProvider, ClaudeCodeAuth, ClaudeSubscriptionProvider, AgentStore, Copilot, getSettings, callReadiness } = await import('./.build/togle.mjs')
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
  const ready = callReadiness(settings, { chatgpt: false, claudeSubscription: false, claudeKey: false }, { state: 'ready' }, { id: 'work', provider: 'claude', label: 'Work', signedIn: true })
  assert.equal(ready.needsAI, false); assert.match(ready.answers, /Work/)
  assert.equal(callReadiness(settings, { chatgpt: true, claudeSubscription: true, claudeKey: true }, { state: 'ready' }, null).needsAI, true)
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

test('agent account overrides survive restart and are excluded from shared packages; study uses the owner', async () => {
  const requests = [], store = new AgentStore(async (...args) => { requests.push(args); return 'Useful document summary.' }); await store.load()
  const agent = await store.create('blank', { subscriptionAccountId: 'work-account-id' })
  await store.addText(agent.id, 'Meeting plan.txt', 'This meeting discusses the rollout and its launch checklist. '.repeat(1200))
  for (let n = 0; n < 100 && !requests.length; n++) await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requests.at(-1)?.[2], agent.id)
  const packageFiles = await store.pack(agent.id, { memory: [], docs: [] })
  assert.ok(!JSON.stringify(packageFiles).includes('work-account-id'))
  const restored = new AgentStore(async () => ''); await restored.load()
  assert.equal(restored.get(agent.id).subscriptionAccountId, 'work-account-id')
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

test('trying another agent uses its account while the live call keeps its own; corrected self names win', async () => {
  const store = new AgentStore(async () => ''); await store.load()
  const main = store.list()[0], work = await store.create('blank', { name: 'Work', subscriptionAccountId: 'work-profile' })
  const { copilot } = copilotWith(Copilot, store, main.id, [])
  const used = []
  const provider = label => ({ id: 'claude', supportsTools: true, stream: async (input, options) => { used.push(label); options.onDelta('LEVEL: quick\nHere is the next step.') } })
  copilot.provider = () => provider('current call')
  copilot.agentProvider = id => { assert.equal(id, work.id); return provider('work account') }
  copilot.ownName = () => 'Luka'
  await copilot.test(work.id, 'What is the next step?')
  assert.ok(used.length > 0 && used.every(label => label === 'work account'))
  used.length = 0
  await copilot.assist({ kind: 'ask', question: 'What is the next step?' })
  assert.ok(used.length > 0 && used.every(label => label === 'current call'))
  const now = Date.now()
  copilot.add('me', 'Let us plan our next step.', now, now + 2000, 'self-1')
  assert.equal(copilot.currentCall().transcript.at(-1).voiceName, 'Luka')
  copilot.renameVoice('me', 'Lucas')
  copilot.add('me', 'We can finish tomorrow.', now + 3000, now + 5000, 'self-2')
  assert.equal(copilot.currentCall().transcript.at(-1).voiceName, 'Lucas')
  await copilot.clear()
})
