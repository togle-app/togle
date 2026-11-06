// Claude Code and Codex used with more than one account (CLAUDE_CONFIG_DIR=~/.claude-work, a second CODEX_HOME): each
// one's sessions are found and named apart, and an agent can have its own, when they say or pick them, with Undo.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { backend, call, say, workDir } from './helpers.mjs'

const dir = workDir('session-homes')
// Their home folder, here: never the real one of whoever runs the tests.
const home = path.join(dir, 'home')
process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude')
process.env.CODEX_HOME = path.join(home, '.codex')

const { AgentStore, ChatGPTProvider, findSessions, readSession, sessionHomes, sessionInfo, train } = await import('./.build/togle.mjs')

const write = (file, records, at) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, records.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n')
  if (at) utimesSync(file, new Date(at), new Date(at))
  return file
}
const claudeSession = (folder, id, cwd, asked, title, at) =>
  write(
    path.join(home, folder, 'projects', cwd.replace(/[:\\]/g, '-'), `${id}.jsonl`),
    [
      { type: 'user', message: { role: 'user', content: asked }, cwd, sessionId: id, timestamp: at, isSidechain: false, origin: { kind: 'human' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Done: ${asked}` }] }, cwd, sessionId: id, timestamp: at, isSidechain: false },
      { type: 'ai-title', aiTitle: title, sessionId: id }
    ],
    at
  )
const codexSession = (folder, id, cwd, asked, at) =>
  write(
    path.join(home, folder, 'sessions', ...at.slice(0, 10).split('-'), `rollout-${at.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`),
    [
      { timestamp: at, type: 'session_meta', payload: { id, timestamp: at, cwd, originator: 'codex_cli_rs' } },
      { timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: asked, images: [] } },
      { timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: `Done: ${asked}` } }
    ],
    at
  )

// One Claude Code for each account (the one in use, work, personal), and two Codex.
const SHOP = 'aaaa0000-0000-4000-8000-000000000001'
const SSO = 'aaaa0000-0000-4000-8000-000000000002'
const BLOG = 'aaaa0000-0000-4000-8000-000000000003'
const RETRY = '019e0000-0000-7000-8000-000000000004'
const INVOICES = '019e0000-0000-7000-8000-000000000005'
claudeSession('.claude', SHOP, 'C:\\work\\shop', 'The checkout crashes on Safari.', 'Checkout crash on Safari', '2026-10-20T10:00:00.000Z')
claudeSession('.claude-work', SSO, 'C:\\acme\\api', 'Add SSO login for Acme.', 'SSO login for Acme', '2026-10-24T10:00:00.000Z')
claudeSession('.claude_personal', BLOG, 'C:\\me\\blog', 'Redesign my blog.', 'Blog redesign', '2026-10-23T10:00:00.000Z')
codexSession('.codex', RETRY, 'D:\\work\\billing', 'Payments fail on retry with a 409.', '2026-10-22T09:00:00.000Z')
const invoices = codexSession('.codex-acme', INVOICES, 'C:\\acme\\invoices', 'Export the invoices as CSV.', '2026-10-25T09:00:00.000Z')
write(path.join(home, '.codex', 'session_index.jsonl'), [{ id: RETRY, thread_name: 'Payment retry 409' }])
// Each Codex names its own sessions.
write(path.join(home, '.codex-acme', 'session_index.jsonl'), [{ id: INVOICES, thread_name: 'Acme invoices export' }])
// Named like theirs, but not: another tool's folder, Claude Code's own settings file, a Codex folder with no sessions.
write(path.join(home, '.claude-server-commander', 'config.json'), ['{}'])
write(path.join(home, '.claude.json'), ['{}'])
mkdirSync(path.join(home, '.codex-empty', 'log'), { recursive: true })

const store = new AgentStore(async () => 'About: a session')
await store.load()
const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
const outputsOf = (requests) =>
  requests
    .at(-1)
    .input.filter((i) => i.type === 'function_call_output')
    .map((i) => i.output)
const talk = async (agentId, message, rounds) => {
  const requests = backend(rounds)
  const changes = []
  await train(store, provider, agentId, [], message, new AbortController().signal, { onDelta() {}, onChange: (c) => changes.push(c) })
  return { requests, outputs: outputsOf(requests), changes }
}

test('every Claude Code and Codex on this PC, one for each account, named apart', async () => {
  const homes = await sessionHomes()
  assert.deepEqual(
    homes.map((h) => [h.tool, h.name, path.basename(h.dir)]),
    [
      ['claude-code', 'Claude Code', '.claude'],
      ['claude-code', 'Claude Code (work)', '.claude-work'],
      ['claude-code', 'Claude Code (personal)', '.claude_personal'],
      ['codex', 'Codex', '.codex'],
      ['codex', 'Codex (acme)', '.codex-acme']
    ],
    "the one in use first; not another tool's folder, a file, or one with no sessions"
  )

  // One alone needs no more than its tool's name.
  const solo = path.join(dir, 'solo')
  write(path.join(solo, 'claude', 'projects', 'p', `${SHOP}.jsonl`), [{ type: 'user', message: { role: 'user', content: 'hi' }, sessionId: SHOP }])
  process.env.CLAUDE_CONFIG_DIR = path.join(solo, 'claude')
  try {
    assert.deepEqual(
      (await sessionHomes()).map((h) => h.name),
      ['Claude Code', 'Codex', 'Codex (acme)']
    )
  } finally {
    process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude')
  }
})

test('the sessions of all of them, or of some: each says which it is from', async () => {
  const all = await findSessions()
  assert.deepEqual(
    all.map((s) => [s.title, s.home]),
    [
      ['Acme invoices export', 'Codex (acme)'],
      ['SSO login for Acme', 'Claude Code (work)'],
      ['Blog redesign', 'Claude Code (personal)'],
      ['Payment retry 409', 'Codex'],
      ['Checkout crash on Safari', 'Claude Code']
    ],
    'newest first, over all of them; a Codex session named in its own folder of Codex'
  )
  const homes = await sessionHomes()
  const dirOf = (name) => homes.find((h) => h.name === name).dir
  assert.deepEqual(
    (await findSessions('', 30, [dirOf('Claude Code (work)'), dirOf('Codex (acme)')])).map((s) => s.id),
    [INVOICES, SSO]
  )
  assert.deepEqual((await findSessions('personal')).map((s) => s.id), [BLOG], 'by the name of the one it is from')

  const info = await sessionInfo(invoices)
  assert.equal(info.title, 'Acme invoices export')
  assert.equal(info.home, 'Codex (acme)')
  assert.match(await readSession(invoices), /^# Acme invoices export — a work session in Codex/)
  // Copied out of its folder (dropped in from elsewhere), it's still named.
  const copy = path.join(dir, 'elsewhere', path.basename(invoices))
  mkdirSync(path.dirname(copy), { recursive: true })
  copyFileSync(invoices, copy)
  const copied = await sessionInfo(copy)
  assert.equal(copied.title, 'Acme invoices export')
  assert.equal(copied.home, undefined)
})

test('told which are its own, the agent looks only there, and in another one when asked', async () => {
  const agent = await store.create('general')
  const { requests, outputs, changes } = await talk(agent.id, 'This agent is for my job at Acme: use my work Claude Code and the Acme Codex.', [
    call(1, 'set_session_sources', { sources: ['claude'] }),
    call(2, 'set_session_sources', { sources: ['work Claude', 'Codex (acme)'] }),
    call(3, 'find_work_sessions', {}),
    call(4, 'find_work_sessions', { query: 'blog', from: 'personal' }),
    say('It uses your work Claude Code and the Acme Codex now.')
  ])
  assert.equal(outputs[0], '"claude" could be Claude Code, Claude Code (work), Claude Code (personal): say which.')
  assert.equal(
    outputs[1],
    'Work sessions from: Claude Code (work), Codex (acme). find_work_sessions looks only there now, not in Claude Code, Claude Code (personal), Codex (unless asked, with "from").'
  )
  assert.match(
    outputs[2],
    /^Looked in this agent's own: Claude Code \(work\), Codex \(acme\)\. Also on this PC: Claude Code, Claude Code \(personal\), Codex\.\n- id 019e0000-0000-7000-8000-000000000005: "Acme invoices export" \(Codex \(acme\), in C:\\acme\\invoices\), last worked on [^\n]+\n- id aaaa0000-0000-4000-8000-000000000002: "SSO login for Acme" \(Claude Code \(work\), in C:\\acme\\api\)/
  )
  assert.doesNotMatch(outputs[2], /Blog redesign|Checkout crash|Payment retry/)
  assert.match(outputs[3], /^Looked in Claude Code \(personal\)\. Also on this PC: Claude Code, Claude Code \(work\), Codex, Codex \(acme\)\.\n- id aaaa0000-0000-4000-8000-000000000003: "Blog redesign" \(Claude Code \(personal\)/)
  assert.deepEqual(changes, ['Work sessions from: Claude Code (work), Codex (acme)'])
  assert.deepEqual(
    store.get(agent.id).workHomes.map((h) => h.name),
    ['Claude Code (work)', 'Codex (acme)']
  )
  assert.match(requests[0].input[0].content[0].text, /\nWork sessions from: all their Claude Code and Codex on this PC, and the chats they exported\n/)

  // Its setup says which are its own, the next time it's talked to.
  const next = await talk(agent.id, 'Which sessions do you look at?', [say('Your work Claude Code and the Acme Codex.')])
  assert.match(next.requests[0].input[0].content[0].text, /\nWork sessions from: Claude Code \(work\), Codex \(acme\)\n/)
  // Added, a session from another one of theirs (they asked for it) goes in as any does.
  const added = await talk(agent.id, 'Add my blog redesign session too.', [call(1, 'add_work_session', { id: BLOG }), say('Added it.')])
  assert.match(added.outputs[0], /^Added: "Blog redesign \(Claude Code session\)"/)
})

test('which are its own, undone; one changed since is not undone over', async () => {
  const agent = await store.create('general')
  const homes = await sessionHomes()
  await talk(agent.id, 'Use my personal Claude only.', [call(1, 'set_session_sources', { sources: ['personal'] }), say('Done.')])
  const entry = store.get(agent.id).history.findLast((h) => h.change.kind === 'homes')
  assert.equal(entry.text, 'Work sessions from: Claude Code (personal)')
  assert.equal(entry.origin, 'train')
  await store.undo(agent.id, entry.id)
  assert.deepEqual(store.get(agent.id).workHomes, [], 'all of them again')

  // Picked in the window (by hand), then picked again: the first can't be undone over the second.
  await store.update(agent.id, { workHomes: [homes[1]] }, 'manual')
  const picked = store.get(agent.id).history.at(-1)
  assert.equal(picked.text, 'Work sessions from: Claude Code (work)')
  await store.update(agent.id, { workHomes: [homes[1], homes[3]] }, 'manual')
  await assert.rejects(store.undo(agent.id, picked.id), /changed since/)
  // Set again to what it is, nothing changes.
  const same = await talk(agent.id, 'Use my work Claude and my Codex.', [call(1, 'set_session_sources', { sources: ['Codex', 'Claude Code (work)'] }), say('It does already.')])
  assert.equal(same.outputs[0], 'Work sessions from: Claude Code (work), Codex, already.')
  assert.deepEqual(same.changes, [])
})

test('its own gone from this PC: it says so, and finds nothing of the others', async () => {
  const agent = await store.create('general')
  await store.update(agent.id, { workHomes: [{ tool: 'claude-code', dir: path.join(home, '.claude-oldjob'), name: 'Claude Code (oldjob)' }] })
  const { outputs } = await talk(agent.id, 'Find my latest session.', [call(1, 'find_work_sessions', {}), say('That one is gone.')])
  assert.equal(
    outputs[0],
    'Its own (Claude Code (oldjob)) aren\'t on this PC any more. There are: Claude Code, Claude Code (work), Claude Code (personal), Codex, Codex (acme). Look in one with "from", or set its own again when they say.'
  )
  assert.deepEqual(await findSessions('', 30, [path.join(home, '.claude-oldjob')]), [])
})

test('an agent saved before it could have its own looks in all of them', async () => {
  const agent = await store.create('general')
  const file = path.join(dir, 'agents', `${agent.id}.json`)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  delete saved.workHomes
  writeFileSync(file, JSON.stringify(saved))
  const again = new AgentStore(async () => 'About: a session')
  await again.load()
  assert.deepEqual(again.get(agent.id).workHomes, [])
})
