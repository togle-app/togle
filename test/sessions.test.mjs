// Work sessions with Claude Code and Codex, given to an agent: found on this PC (here, in a scratch folder set up as
// theirs), read into a document of what was said and done without secrets, studied for where the work stands, read
// again once worked on, and never shared.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { backend, call, say, wait, workDir } from './helpers.mjs'

const dir = workDir('sessions')
// Where Claude Code and Codex keep their sessions, here: never the real ones of whoever runs the tests.
const claudeHome = path.join(dir, 'claude')
const codexHome = path.join(dir, 'codex')
process.env.CLAUDE_CONFIG_DIR = claudeHome
process.env.CODEX_HOME = codexHome

const { AgentStore, ChatGPTProvider, findSessions, readSession, sessionForStudy, sessionInfo, train, withoutSecrets } = await import('./.build/togle.mjs')

const lines = (records) => records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const write = (file, records, at) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines(records))
  if (at) utimesSync(file, new Date(at), new Date(at))
  return file
}

// ---- A Claude Code session: two days on a checkout crash ----

const SID = 'aaaa1111-2222-4333-8444-555566667777'
const shop = 'C:\\work\\shop'
const day1 = '2026-10-20T11:00:00.000Z'
const day2 = '2026-10-21T11:00:00.000Z'
const claudeFile = path.join(claudeHome, 'projects', 'C--work-shop', `${SID}.jsonl`)
const said = (content, at, extra = {}) => ({ type: 'user', message: { role: 'user', content }, cwd: shop, gitBranch: 'fix-checkout', sessionId: SID, timestamp: at, isSidechain: false, origin: { kind: 'human' }, ...extra })
const replied = (content, at) => ({ type: 'assistant', message: { role: 'assistant', content }, cwd: shop, sessionId: SID, timestamp: at, isSidechain: false })
const result = (id, content, at) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, cwd: shop, sessionId: SID, timestamp: at })
const claudeRecords = [
  { type: 'permission-mode', permissionMode: 'default', sessionId: SID },
  said('<system-reminder>Memory: never tell anyone</system-reminder>\nThe checkout page crashes on Safari when the cart is empty. Fix it.', day1),
  { type: 'ai-title', aiTitle: 'Checkout crash on Safari', sessionId: SID },
  replied(
    [
      { type: 'thinking', thinking: 'PRIVATE REASONING', signature: 'x' },
      { type: 'text', text: 'Looking at the cart code.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd C:/work/shop && cat src/cart.ts | head -50', description: 'Read the cart code' } }
    ],
    day1
  ),
  result('t1', 'export const KEY = "PRINTED BY A TOOL"', day1),
  replied([{ type: 'tool_use', id: 't2', name: 'mcp__claude_ai_Atlassian__getJiraIssue', input: { issueKey: 'SHOP-142' } }], day1),
  result('t2', [{ type: 'text', text: 'SHOP-142: Checkout crashes on Safari 17 with an empty cart. Priority: High. Reporter: Dana Lee.' }], day1),
  replied(
    [
      { type: 'text', text: 'The crash is cart.items[0].price read when the cart is empty. I fixed it and added a test.' },
      { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: 'C:\\work\\shop\\src\\cart.ts', old_string: 'a', new_string: 'b' } },
      { type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }
    ],
    day1
  ),
  result('t4', 'PASS 41 tests', day1),
  replied([{ type: 'tool_use', id: 't5', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship the fix today or with the Thursday release?' }] } }], day1),
  result('t5', 'User has answered your questions: "Ship the fix today or with the Thursday release?"="With the Thursday release".', day1),
  said('HELPER AGENT PROMPT', day1, { isSidechain: true }),
  said('META CAVEAT', day1, { isMeta: true }),
  { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', timestamp: day2, sessionId: SID },
  said(
    'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The checkout crash (SHOP-142) is fixed in src/cart.ts; it ships with the Thursday release.\n\nIf you need specific details from before compaction (like exact code snippets), read the full transcript at: C:\\x.jsonl\nContinue the conversation from where it left off without asking the user any further questions.',
    day2,
    { isCompactSummary: true, origin: undefined }
  ),
  said('Set up the CI with my token ghp_abcdefghijklmnopqrstuvwxyz0123456789 so it runs the Safari tests.', day2),
  replied([{ type: 'text', text: 'Done: the CI runs the Safari tests on every push now.' }], day2),
  { type: 'custom-title', customTitle: 'SHOP-142 checkout fix', sessionId: SID },
  { type: 'last-prompt', lastPrompt: 'Set up the CI so it runs the Safari tests.', sessionId: SID }
]

// ---- A Codex session: a payment retry bug, from an editor ----

const CID = '019e0000-1111-7222-8333-944445555666'
const billing = 'D:\\work\\billing'
const at = '2026-10-22T09:00:00.000Z'
const codexFile = path.join(codexHome, 'sessions', '2026', '10', '22', `rollout-2026-10-22T09-00-00-${CID}.jsonl`)
const item = (payload) => ({ timestamp: at, type: 'response_item', payload })
const event = (payload) => ({ timestamp: at, type: 'event_msg', payload })
const codexRecords = [
  { timestamp: at, type: 'session_meta', payload: { id: CID, timestamp: at, cwd: billing, originator: 'codex_vscode', cli_version: '0.50.0', git: { branch: 'retry-payments' } } },
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>D:\\work\\billing</cwd>\n</environment_context>' }] }),
  item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Payments fail on retry with a 409. Find out why.' }] }),
  event({ type: 'user_message', message: '# Context from my IDE setup:\n\n## Active file: src/retry.ts\n\n## My request for Codex:\nPayments fail on retry with a 409. Find out why.', images: [] }),
  item({ type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'Get-Content src/retry.ts' }), call_id: 'c0' }),
  event({ type: 'exec_command_end', call_id: 'c0', command: ['powershell.exe', '-Command', 'Get-Content src/retry.ts'], parsed_cmd: [{ type: 'read', cmd: 'Get-Content src/retry.ts' }], exit_code: 0 }),
  event({ type: 'agent_message', message: 'The retry reuses the idempotency key after the amount changed.' }),
  item({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The retry reuses the idempotency key after the amount changed.' }] }),
  item({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: D:\\work\\billing\\src\\retry.ts\n@@\n-a\n+b\n*** End Patch', call_id: 'c1' }),
  event({ type: 'patch_apply_end', call_id: 'c1', changes: { 'D:\\work\\billing\\src\\retry.ts': { type: 'update' } }, success: true }),
  item({ type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'npm test -- retry' }), call_id: 'c2' }),
  event({ type: 'exec_command_end', call_id: 'c2', command: ['powershell.exe', '-Command', 'npm test -- retry'], parsed_cmd: [{ type: 'unknown', cmd: 'npm test -- retry' }], exit_code: 1 }),
  event({ type: 'mcp_tool_call_end', call_id: 'm1', invocation: { server: 'linear', tool: 'get_issue', arguments: { id: 'BIL-7' } }, result: { Ok: { content: [{ type: 'text', text: 'BIL-7: Duplicate charges on retry. Status: In Progress.' }] } } }),
  { timestamp: at, type: 'compacted', payload: { message: 'Earlier: found that the idempotency key is reused.' } },
  event({ type: 'agent_message', message: 'Fixed. One test still fails on currency rounding. The staging password: hunter2hunter2' })
]

// ---- An older Codex session: no events, only what went to the model ----

const OID = '019d0000-aaaa-7bbb-8ccc-dddddddddddd'
const olderFile = path.join(codexHome, 'sessions', '2026', '04', '01', `rollout-2026-04-01T10-00-00-${OID}.jsonl`)
const olderRecords = [
  { timestamp: '2026-04-01T10:00:00.000Z', type: 'session_meta', payload: { id: OID, timestamp: '2026-04-01T10:00:00.000Z', cwd: 'D:\\work\\site' } },
  { timestamp: '2026-04-01T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for D:\\work\\site' }] } },
  { timestamp: '2026-04-01T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a dark mode toggle.' }] } },
  { timestamp: '2026-04-01T10:00:09.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm run build'] }), call_id: 'o1' } },
  { timestamp: '2026-04-01T10:00:10.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added a dark theme toggle in the header.' }] } }
]

write(claudeFile, claudeRecords, '2026-10-21T12:00:00.000Z')
write(codexFile, codexRecords, '2026-10-22T12:00:00.000Z')
write(olderFile, olderRecords, '2026-04-01T12:00:00.000Z')
write(path.join(codexHome, 'session_index.jsonl'), [{ id: CID, thread_name: 'Payment retry 409', updated_at: at }])
// Opened and closed without a word, and a file of some other kind: neither is a session to read.
write(path.join(claudeHome, 'projects', 'C--work-shop', 'bbbb1111-2222-4333-8444-555566667777.jsonl'), [{ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' }, sessionId: 'b' }])
const dataFile = write(path.join(dir, 'data', 'rows.jsonl'), [{ id: 1, price: 3 }])

test('the work sessions on this PC: newest first, by title, folder and what was asked', async () => {
  const all = await findSessions()
  assert.deepEqual(
    all.map((s) => [s.tool, s.title]),
    [
      ['codex', 'Payment retry 409'],
      ['claude-code', 'SHOP-142 checkout fix'],
      ['codex', 'Add a dark mode toggle.']
    ],
    'a title they gave it over the one Claude Code wrote; a Codex session without a name goes by what was asked first'
  )
  const [codex, claude, older] = all
  assert.equal(claude.cwd, shop)
  assert.equal(claude.branch, 'fix-checkout')
  assert.equal(claude.first, 'The checkout page crashes on Safari when the cart is empty. Fix it.', 'without what Claude Code added to it')
  assert.equal(codex.first, 'Payments fail on retry with a 409. Find out why.', 'without the open files the editor put before it')
  assert.equal(codex.branch, 'retry-payments')
  assert.equal(older.cwd, 'D:\\work\\site')

  assert.deepEqual((await findSessions('payment 409')).map((s) => s.id), [CID])
  assert.deepEqual((await findSessions('SHOP-142')).map((s) => s.id), [SID])
  assert.deepEqual((await findSessions('billing')).map((s) => s.id), [CID], 'by its folder')
  assert.deepEqual((await findSessions('safari')).map((s) => s.id), [SID], 'by what was asked')
  assert.deepEqual(await findSessions('kubernetes'), [])
  assert.equal((await findSessions('', 1)).length, 1)

  assert.equal((await sessionInfo(claudeFile)).id, SID)
  assert.equal((await sessionInfo(codexFile)).title, 'Payment retry 409')
  assert.equal(await sessionInfo(dataFile), null)
  await assert.rejects(readSession(dataFile), /not a Claude Code or Codex session|nothing was said/)
})

test('a Claude Code session as a document: what was said and done, day by day, without secrets or what tools printed', async () => {
  const text = await readSession(claudeFile)
  assert.match(text, /^# SHOP-142 checkout fix — a work session in Claude Code/)
  assert.match(text, /working in C:\/work\/shop \(branch fix-checkout\)/)
  assert.match(text, /\n# Tue, Oct 20, 2026\n[\s\S]*\n# Wed, Oct 21, 2026\n/, "each day a heading of its own, so a passage found on a call says its day")
  assert.match(text, /Me \(\d\d:\d\d\): The checkout page crashes on Safari when the cart is empty\. Fix it\./)
  assert.match(text, /Claude: Looking at the cart code\./)
  assert.match(text, /\(used Atlassian: getJiraIssue\)\n\nWhat Atlassian gave: SHOP-142: Checkout crashes on Safari 17/, 'what a tool of their workspace found')
  assert.match(text, /\(edited src\/cart\.ts · ran: Run the tests\)/, 'a file it edited, and what it ran, but not what it read')
  assert.match(text, /Claude asked me: Ship the fix today or with the Thursday release\?\n\nMy answer: "Ship the fix today or with the Thursday release\?"="With the Thursday release"\.\n/, 'without how Claude Code tells it of the answer')
  assert.match(text, /### Summary of the work so far, written in the session\n\nSummary:\n1\. The checkout crash \(SHOP-142\) is fixed/)
  assert.match(text, /my token \[secret removed\] so it runs/)
  for (const left of ['never tell anyone', 'PRIVATE REASONING', 'Read the cart code', 'PRINTED BY A TOOL', 'PASS 41 tests', 'HELPER AGENT PROMPT', 'META CAVEAT', 'being continued', 'without asking', 'ghp_abc', '/model']) {
    assert.ok(!text.includes(left), `left out: ${left}`)
  }
})

test('what only reads stays out of what it did; what changes something is in', async () => {
  const file = path.join(dir, 'looks', `${SID}.jsonl`)
  const ran = (id, command) => ({ type: 'tool_use', id, name: 'Bash', input: { command } })
  write(file, [
    said('Tidy up the notes.', day1),
    said('<bash-input>npm run lint</bash-input>', day1),
    replied(
      [
        ran('l1', 'cd C:/work/shop && ls src 2>&1 | head -20'),
        ran('l2', 'cat src/a.ts > /dev/null'),
        ran('l3', "sed -n '10,20p' src/a.ts"),
        ran('l4', 'git status --short && git diff --stat'),
        ran('d1', "sed -i 's/old/new/' src/a.ts"),
        ran('d2', 'echo done > notes.txt'),
        ran('d3', 'find . -name "*.tmp" -delete'),
        ran('d4', 'git commit -m "Tidy up"')
      ],
      day1
    ),
    replied([{ type: 'text', text: 'Tidied up.' }], day1)
  ])
  const text = await readSession(file)
  assert.match(text, /\(ran: sed -i 's\/old\/new\/' src\/a\.ts · ran: echo done > notes\.txt · ran: find \. -name "\*\.tmp" -delete · ran: git commit -m "Tidy up"\)/)
  for (const looked of ['ls src', 'cat src', "sed -n", 'git status']) assert.ok(!text.includes(looked), `left out: ${looked}`)
  assert.ok(!text.includes('npm run lint'), 'a command they typed with ! is not something they said')
  assert.equal(text.match(/^Me /gm).length, 1)
})

test('a Codex session as a document, newer and older ones', async () => {
  const text = await readSession(codexFile)
  assert.match(text, /^# Payment retry 409 — a work session in Codex/)
  assert.match(text, /working in D:\/work\/billing \(branch retry-payments\)/)
  assert.match(text, /Me \(\d\d:\d\d\): Payments fail on retry with a 409\. Find out why\./)
  assert.equal(text.match(/The retry reuses the idempotency key/g).length, 1, 'said once, though Codex writes it twice')
  assert.match(text, /\(edited src\/retry\.ts · ran: npm test -- retry \(failed\) · used linear: get_issue\)/)
  assert.match(text, /What linear gave: BIL-7: Duplicate charges on retry/)
  assert.match(text, /### Summary of the work so far, written in the session\n\nEarlier: found that the idempotency key is reused\./)
  assert.match(text, /The staging password: \[secret removed\]/)
  for (const left of ['Get-Content', 'environment_context', 'Context from my IDE', 'hunter2']) assert.ok(!text.includes(left), `left out: ${left}`)

  const older = await readSession(olderFile)
  assert.match(older, /Me \(\d\d:\d\d\): Add a dark mode toggle\.\n\n\(ran: npm run build\)\n\nCodex: Added a dark theme toggle in the header\./, 'in the order it happened')
  assert.ok(!older.includes('AGENTS.md'))
})

test('keys, tokens and passwords come out; numbers and words that look like them stay', () => {
  const cases = [
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'key [secret removed]'],
    ['OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz', 'OPENAI_API_KEY=[secret removed]'],
    ['token xoxb-1234567890-abcdefghij', 'token [secret removed]'],
    ['AWS AKIAABCDEFGHIJKLMNOP done', 'AWS [secret removed] done'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', 'Authorization: Bearer [secret removed]'],
    ['postgres://app:s3cretpass@db.internal:5432/shop', 'postgres://app:[secret removed]@db.internal:5432/shop'],
    ['"password": "correct-horse-battery"', '"password": "[secret removed]"'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop', 'jwt [secret removed]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[secret removed]']
  ]
  for (const [text, out] of cases) assert.equal(withoutSecrets(text), out)
  for (const kept of ['max_tokens: 4096', 'the token is stored in the keychain', 'Password reset emails go out at 9', 'Basic plan: 19 euros']) assert.equal(withoutSecrets(kept), kept)
})

test('secrets in settings, addresses and commands come out too; code that reads one stays as it is', () => {
  const cases = [
    ['REDIS_URL=redis://:p4ssw0rdXYZ123@redis.internal:6379/0', 'REDIS_URL=redis://:[secret removed]@redis.internal:6379/0'],
    ['postgresql+psycopg2://app:S3cretPass99@db.internal/shop', 'postgresql+psycopg2://app:[secret removed]@db.internal/shop'],
    ['DB_PASS=hunter2hunter2', 'DB_PASS=[secret removed]'],
    ['SECRET_KEY_BASE=9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928', 'SECRET_KEY_BASE=[secret removed]'],
    ['AccountName=acme;AccountKey=Zm9vYmFyYmF6cXV4Zm9vYmFy==;EndpointSuffix=core.windows.net', 'AccountName=acme;AccountKey=[secret removed];EndpointSuffix=core.windows.net'],
    ['curl -u admin:Sup3rS3cret! https://jenkins.acme.dev/api/json', 'curl -u admin:[secret removed] https://jenkins.acme.dev/api/json'],
    ['mysql -h db.prod -u root -pR00tPassw0rd shop', 'mysql -h db.prod -u root -p[secret removed] shop'],
    ['the password is Hunter2Hunter2', 'the password is [secret removed]'],
    ['passwd = "correct horse battery staple"', 'passwd = "[secret removed]"'],
    // Built from parts, so the file itself holds nothing that looks like a real webhook to secret scanners.
    ['https://hooks.slack.com/services/' + ['T0123ABCD', 'B0456EFGH', 'abcdefghijklmnopqrstuvwx'].join('/'), 'https://hooks.slack.com/services/[secret removed]'],
    ['authorization: bearer abcdefghijklmnopqrstuvwxyz0123456789', 'authorization: bearer [secret removed]'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ', '[secret removed]']
  ]
  for (const [text, out] of cases) assert.equal(withoutSecrets(text), out)
  for (const kept of [
    'const token = req.headers.authorization;',
    'password = hashPassword(input)',
    'apiKey: process.env.OPENAI_API_KEY,',
    'The secret: Thursday’s launch moves to Friday',
    'Use the token=stored-in-keychain approach',
    'pwd: C:\\Users\\me\\project',
    'MAX_TOKENS=4096'
  ])
    assert.equal(withoutSecrets(kept), kept)
})

test('a command they ran with words after it is what they asked; a first request past the start of the file is found', async () => {
  const commandFile = write(path.join(claudeHome, 'projects', 'C--work-sso', 'abab1111-2222-4333-8444-555566667777.jsonl'), [
    said('<command-message>fix-issue is running…</command-message>\n<command-name>/fix-issue</command-name>\n<command-args>SSO login fails for Okta users</command-args>', day1),
    said('Expanded prompt of the command', day1, { isMeta: true }),
    replied([{ type: 'text', text: 'Found it: the Okta callback drops the state parameter.' }], day1)
  ])
  assert.equal((await sessionInfo(commandFile))?.first, '/fix-issue SSO login fails for Okta users')
  assert.match(await readSession(commandFile), /\nMe \(\d\d:\d\d\): \/fix-issue SSO login fails for Okta users\n/)
  // A picture pasted into the first request makes its line longer than the start that's read for the list.
  const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }
  const pictureFile = write(path.join(claudeHome, 'projects', 'C--work-sso', 'abab2222-2222-4333-8444-555566667777.jsonl'), [
    said([picture, { type: 'text', text: 'The login button overlaps the logo on mobile, see the screenshot.' }], day1),
    replied([{ type: 'text', text: 'Moved the logo up.' }], day1)
  ])
  assert.equal((await sessionInfo(pictureFile))?.first, 'The login button overlaps the logo on mobile, see the screenshot.')
})

test('a long session is studied from its start and its end, where the work stands', () => {
  const text = `# Title\n\n${'Me: early words. '.repeat(400)}\n\n${'Claude: middle. '.repeat(4000)}\n\nMe: the latest question\n\nClaude: where it stands now`
  const studied = sessionForStudy(text, 10_000)
  assert.ok(studied.length <= 10_000)
  assert.match(studied, /^# Title\n\nMe: early words/)
  assert.match(studied, /\[… the middle of the session is left out …\]/)
  assert.match(studied, /Me: the latest question\n\nClaude: where it stands now$/)
  assert.equal(sessionForStudy('short', 100), 'short')
})

// ---- Given to an agent ----

const studied = []
// What a session is about, by what was asked in it: several of one title can be about one thing too.
const aboutOf = (user) =>
  /Payments fail on retry/.test(user)
    ? 'Retrying payments that fail with a 409.'
    : /Tidy up the codebase/.test(user)
      ? 'Tidying up the codebase'
      : /Postgres/.test(user)
        ? '**About:** Moving the billing database to Postgres 17 with zero downtime, in three steps over two weekends.'
        : 'The checkout crash on Safari'
// A study that fails, as one can when the plan is busy.
let studyFails = false
const store = new AgentStore(async (system, user) => {
  studied.push({ system, user })
  if (studyFails) throw new Error('ChatGPT request failed (503): overloaded')
  if (!system.includes('work session')) return 'About: a document'
  const about = aboutOf(user)
  return `${about.startsWith('**') ? about : `About: ${about}`}\n- Fixed in src/cart.ts\n- Status as of Wed, Oct 21: ships with the Thursday release`
})
await store.load()
const agentId = store.list()[0].id
const agentNow = () => store.list().find((a) => a.id === agentId)
const sessionDoc = () => agentNow().knowledge.find((d) => d.kind === 'session' && d.source === claudeFile)
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await wait(10)
  }
  assert.fail(`never: ${what}`)
}

test('a session given to an agent is studied for where the work stands, however small', async () => {
  const { done, doc } = await store.addSession(agentId, claudeFile)
  assert.equal(done, 'added')
  assert.equal(doc.name, 'SHOP-142 checkout fix (Claude Code session)')
  assert.equal(doc.kind, 'session')
  assert.ok(doc.stamp)
  await until(() => sessionDoc()?.digest, 'studied')
  assert.equal(studied.length, 1)
  assert.match(studied[0].system, /work session between the user \("Me"\) and an AI agent/)
  assert.match(studied[0].user, /^Work session: SHOP-142 checkout fix \(Claude Code session\)\n\n# SHOP-142 checkout fix — a work session in Claude Code/)
  assert.match(sessionDoc().digest, /^About: The checkout crash on Safari/)
  assert.equal(sessionDoc().name, 'SHOP-142 checkout fix (Claude Code session)', 'named by them in Claude Code, it keeps that name')
  assert.equal(sessionDoc().addedAs, undefined)
  // Small enough to go into answers whole, with what it is.
  const context = await store.knowledgeFor(agentNow(), 'is the checkout fix out?', new Set())
  assert.match(context.standing, /<document n="1" name="SHOP-142 checkout fix \(Claude Code session\)">\n# SHOP-142 checkout fix — a work session in Claude Code/)
  assert.equal((await store.addSession(agentId, claudeFile)).done, 'unchanged')
  // A passage found on a call says which day it's from.
  const [passage] = await store.search(agentNow(), 'Thursday release', new Set(), 1)
  assert.match(passage.section, /^(Tue, Oct 20|Wed, Oct 21), 2026/)
})

test("a session's lines shown at once on a call are what its agent said and its tools gave, not what I asked it", async () => {
  await until(() => sessionDoc()?.digest, 'studied')
  const facts = async (question) => (await store.factsFor(agentNow(), question)).map((f) => f.text)
  // My request shares the most words with the question; the ticket says it, the trimmed line without its priority.
  assert.deepEqual(await facts('Why does the checkout crash on Safari when the cart is empty?'), [
    'What Atlassian gave: SHOP-142: Checkout crashes on Safari 17 with an empty cart.'
  ])
  // What the agent found, without its name before it, and the session's summary of its work; not "Fix it." of mine.
  assert.deepEqual(await facts('What was the crash caused by, and is it fixed?'), [
    'The crash is cart.items[0].price read when the cart is empty. I fixed it and added a test.',
    'The checkout crash (SHOP-142) is fixed in src/cart.ts; it ships with the Thursday release.'
  ])
  for (const question of ['Is the checkout work on the fix-checkout branch done?', 'What is the checkout crash on Safari about?']) {
    for (const fact of await facts(question)) assert.doesNotMatch(fact, /^(Me \(|About:|A session with|Claude:)/, question)
  }
})

test('a long message of mine stays mine over the passages it takes, a heading in it too', async () => {
  const file = path.join(claudeHome, 'projects', 'C--work-deals', 'dddd1111-2222-4333-8444-555566667777.jsonl')
  const notes = Array.from({ length: 12 }, (_, i) => `Point ${i + 1} of the vendor call: they went through the rollout plan, the training days and who signs off on each step.`).join('\n\n')
  const mine = `Here are my notes from the vendor call.\n\n${notes}\n\n# What they claimed\n\nTheir buyer told me the Enterprise plan costs 40 euros per seat, which I doubt.`
  write(file, [said(mine, day1), replied([{ type: 'text', text: 'Checked the price list: the Enterprise plan is 52 euros per seat per month, billed yearly.' }], day1)])
  const agent = await store.create('meeting')
  await store.addSession(agent.id, file)
  const [fact] = await store.factsFor(store.list().find((a) => a.id === agent.id), 'How much does the Enterprise plan cost per seat?')
  assert.equal(fact?.text, 'Checked the price list: the Enterprise plan is 52 euros per seat per month, billed yearly.')
})

test('another session of the same title gets its day in its name', async () => {
  const twin = path.join(claudeHome, 'projects', 'C--work-shop', 'cccc1111-2222-4333-8444-555566667777.jsonl')
  write(twin, [said('Another look at the checkout.', day1), replied([{ type: 'text', text: 'Looked again: all good.' }], day1), { type: 'custom-title', customTitle: 'SHOP-142 checkout fix', sessionId: 'c' }])
  const before = studied.length
  const { doc } = await store.addSession(agentId, twin)
  assert.equal(doc.name, 'SHOP-142 checkout fix (Claude Code session, Oct 20)')
  await until(() => studied.length > before, 'studied')
  await store.removeDocument(agentId, doc.id)
  rmSync(twin)
})

test('before a call, a session worked on since is read again; one only Claude Code touched is not', async () => {
  assert.equal(await store.refreshSessions(agentId), 0, 'nothing changed')
  const docId = sessionDoc().id
  const before = studied.length
  // Claude Code renames it as it goes: the file changed, what was said didn't.
  appendFileSync(claudeFile, lines([{ type: 'ai-title', aiTitle: 'Checkout crash fix and CI', sessionId: SID }]))
  assert.equal(await store.refreshSessions(agentId), 0)
  assert.equal(sessionDoc().id, docId)
  assert.equal(studied.length, before, 'not studied again')
  assert.equal(await store.refreshSessions(agentId), 0, 'and not read again either: its file as it is now is noted')

  appendFileSync(claudeFile, lines([said('Did the Thursday release go out?', day2), replied([{ type: 'text', text: 'Yes, release 4.2 shipped on Thursday with the fix.' }], day2)]))
  const digest = sessionDoc().digest
  assert.equal(await store.refreshSessions(agentId), 1)
  const doc = sessionDoc()
  assert.notEqual(doc.id, docId)
  assert.equal(doc.name, 'SHOP-142 checkout fix (Claude Code session)', 'its name stays, for the line that said it went in')
  assert.equal(agentNow().knowledge.filter((d) => d.kind === 'session').length, 1, 'in place of what it was')
  // What was studied of it stays until it's studied again: a call starting now has where the work stood.
  assert.equal(doc.digest, digest)
  await until(() => sessionDoc() && !sessionDoc().restudy, 'studied again')
  assert.equal(studied.length, before + 1)
  assert.match(studied.at(-1).user, /release 4\.2 shipped on Thursday/)
  // A call stopped and started again minutes later doesn't read it (and study it) again for a line more.
  appendFileSync(claudeFile, lines([said('Thanks!', day2)]))
  assert.equal(await store.refreshSessions(agentId), 0)
  assert.equal(studied.length, before + 1)

  // Gone (Claude Code deletes old sessions): what was read of it stays.
  const moved = claudeFile.replace('.jsonl', '.moved')
  const { renameSync } = await import('node:fs')
  renameSync(claudeFile, moved)
  assert.equal(await store.refreshSessions(agentId), 0)
  assert.ok(sessionDoc())
  renameSync(moved, claudeFile)
})

test("a session without a title of its own isn't read again for a new one; its study, failed again, stays", async () => {
  const file = write(path.join(claudeHome, 'projects', 'C--work-invoices', 'eeee2222-2222-4333-8444-555566667777.jsonl'), [
    said('Is the invoice export done?', day1),
    replied([{ type: 'text', text: 'The invoice export works for 2025 now.' }], day1)
  ])
  const agent = await store.create('general')
  const docOf = () => store.list().find((a) => a.id === agent.id).knowledge.find((d) => d.kind === 'session')
  await store.addSession(agent.id, file)
  await until(() => docOf()?.digest, 'studied')
  const before = studied.length
  // Claude Code titles it as it goes: its heading changes, nothing said does.
  appendFileSync(file, lines([{ type: 'ai-title', aiTitle: 'Invoice export for 2025', sessionId: 'e' }]))
  assert.equal(await store.refreshSessions(agent.id), 0)
  assert.equal(studied.length, before, 'not studied again')
  // Worked on, and studying it again fails: what was studied of it stays, and it's tried again before the next call.
  studyFails = true
  const digest = docOf().digest
  appendFileSync(file, lines([said('And 2024?', day2), replied([{ type: 'text', text: '2024 works too.' }], day2)]))
  assert.equal(await store.refreshSessions(agent.id), 1)
  await until(() => docOf().error, 'its study failed')
  assert.equal(docOf().digest, digest)
  studyFails = false
  assert.equal(await store.refreshSessions(agent.id), 0, 'not read again so soon')
  await until(() => !docOf().restudy, 'studied again')
  assert.equal(docOf().error, undefined)
  assert.match(studied.at(-1).user, /2024 works too/)
})

test("a session removed while a call's start reads it again stays out", async () => {
  const file = write(path.join(claudeHome, 'projects', 'C--work-vendor', 'ffff3333-2222-4333-8444-555566667777.jsonl'), [
    said('Ask the vendor about the SLA.', day1),
    replied([{ type: 'text', text: 'Sent the SLA question to the vendor.' }], day1)
  ])
  const agent = await store.create('general')
  const { doc } = await store.addSession(agent.id, file)
  appendFileSync(file, lines([said('Any answer?', day2), replied([{ type: 'text', text: 'They agreed to 99.9% uptime.' }], day2)]))
  const refreshing = store.refreshSessions(agent.id)
  await store.removeDocument(agent.id, doc.id)
  assert.equal(await refreshing, 0)
  assert.deepEqual(store.list().find((a) => a.id === agent.id).knowledge, [])
})

test('a session file dropped into the conversation goes in as a session, named by what it is about once studied', async () => {
  const other = await store.create('general')
  const { errors } = await store.addFiles(other.id, [codexFile, dataFile])
  assert.equal(errors.length, 1)
  assert.match(errors[0], /^rows\.jsonl: it isn't a Claude Code or Codex session/)
  const docs = () => store.list().find((a) => a.id === other.id).knowledge
  await until(() => docs()[0]?.digest, 'studied')
  // Codex's name for it (Codex gives several sessions one name) gives way to what it's about.
  assert.deepEqual(
    docs().map((d) => [d.kind, d.name, d.addedAs]),
    [['session', 'Retrying payments that fail with a 409 (Codex session)', 'Payment retry 409 (Codex session)']]
  )
})

test('sessions of one title get a name each, before and after they are studied; read again, a session keeps its', async () => {
  const fresh = await store.create('general')
  const docs = () => store.list().find((a) => a.id === fresh.id).knowledge
  // Three Claude Code titled alike on one day, as it titles many sessions "Codebase".
  const files = ['dddd', 'eeee', 'ffff'].map((p) => {
    const id = `${p}1111-2222-4333-8444-555566667777`
    return write(path.join(claudeHome, 'projects', 'C--work-tidy', `${id}.jsonl`), [
      said('Tidy up the codebase: take out what nothing uses.', day1, { cwd: 'C:\\work\\tidy', sessionId: id }),
      replied([{ type: 'text', text: 'Took out three modules nothing used.' }], day1),
      { type: 'ai-title', aiTitle: 'Codebase', sessionId: id }
    ])
  })
  const added = []
  for (const file of files) added.push((await store.addSession(fresh.id, file)).doc.name)
  assert.deepEqual(added, ['Codebase (Claude Code session)', 'Codebase (Claude Code session, Oct 20)', 'Codebase (Claude Code session, Oct 20, 2)'])
  await until(() => docs().length === 3 && docs().every((d) => d.digest), 'all studied')
  // Studied two at a time, each takes a name no other has, and keeps the one it went in under.
  assert.deepEqual(docs().map((d) => d.name).sort(), [
    'Tidying up the codebase (Claude Code session)',
    'Tidying up the codebase (Claude Code session, Oct 20)',
    'Tidying up the codebase (Claude Code session, Oct 20, 2)'
  ])
  assert.deepEqual(docs().map((d) => d.addedAs).sort(), [...added].sort())

  // The agent, asked which are in, sees them by these names.
  const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const requests = backend([call(1, 'find_work_sessions', { query: 'tidy' }), say('All three are in.')])
  await train(store, provider, fresh.id, [], 'Are my tidy-up sessions in?', new AbortController().signal, { onDelta() {}, onChange() {} })
  const listing = requests.at(-1).input.find((i) => i.type === 'function_call_output').output
  assert.equal(listing.match(/\[in Knowledge already, as "Tidying up the codebase \(Claude Code session[^"]*\)"\]/g)?.length, 3, listing)

  // Worked on since: read again under the name it has, not named again.
  const doc = docs().find((d) => d.source === files[0])
  appendFileSync(files[0], lines([said('Tidy up the codebase some more: the old tests too.', day2, { cwd: 'C:\\work\\tidy' }), replied([{ type: 'text', text: 'Took out the old tests.' }], day2)]))
  assert.equal((await store.addSession(fresh.id, files[0])).done, 'updated')
  await until(() => docs().find((d) => d.source === files[0])?.digest, 'studied again')
  const again = docs().find((d) => d.source === files[0])
  assert.notEqual(again.id, doc.id)
  assert.deepEqual([again.name, again.addedAs], [doc.name, doc.addedAs])
  for (const file of files) rmSync(file)
})

test('what a session is about is cut to a name at a word, without its markup or full stop', async () => {
  const fresh = await store.create('general')
  const file = write(path.join(claudeHome, 'projects', 'C--work-db', 'abab1111-2222-4333-8444-555566667777.jsonl'), [
    said('Plan moving the billing database to Postgres 17.', day1, { cwd: 'C:\\work\\db', sessionId: 'abab1111-2222-4333-8444-555566667777' }),
    replied([{ type: 'text', text: 'Three steps, over two weekends.' }], day1)
  ])
  // No title at all: until it's studied, it goes by what was asked first.
  assert.equal((await store.addSession(fresh.id, file)).doc.name, 'Plan moving the billing database to Postgres 17. (Claude Code session)')
  const doc = () => store.list().find((a) => a.id === fresh.id).knowledge[0]
  await until(() => doc().digest, 'studied')
  assert.equal(doc().name, 'Moving the billing database to Postgres 17 with zero downtime, in three steps… (Claude Code session)')
  rmSync(file)
})

test('a work session is never shared with the agent, even ticked', async () => {
  await store.addText(agentId, 'Return policy', 'Returns within 30 days, with the receipt, to any store.')
  const docs = agentNow().knowledge
  const files = await store.pack(agentId, { memory: [], docs: docs.map((d) => d.id) })
  const shared = Object.keys(files).filter((p) => p.startsWith('knowledge/'))
  assert.deepEqual(shared, ['knowledge/return-policy.md'])
  assert.ok(!JSON.stringify(files).includes('SHOP-142'))
})

test('a whole chat from claude.ai pasted in goes to the model by its start and end, and into Knowledge whole', async () => {
  const fresh = await store.create('general')
  const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const turns = Array.from({ length: 2000 }, (_, i) => (i % 2 ? `Claude: answer ${i} about the rollout plan, with the steps in order.` : `Me: question ${i} about the rollout plan?`))
  const chat = `Rollout plan chat\n\n${turns.join('\n\n')}\n\nMe: so we ship on the 4th.`
  const message = `My claude.ai chat about the rollout, for Thursday's call:\n\n${chat}`
  assert.ok(message.length > 100_000)
  const requests = backend([call(9, 'save_document', { name: 'Rollout plan chat (claude.ai)', starts_with: 'Rollout plan chat' }), say('Saved your chat about the rollout.')])
  await train(store, provider, fresh.id, [], message, new AbortController().signal, { onDelta() {}, onChange() {} })
  const sent = requests[0].input.at(-1).content[0].text
  assert.ok(sent.length < 40_000, `sent ${sent.length} characters`)
  assert.match(sent, /^My claude\.ai chat about the rollout/)
  assert.match(sent, /more characters of this message, left out here; save_document still takes all of it/)
  assert.match(sent, /so we ship on the 4th\.$/)
  const [doc] = store.list().find((a) => a.id === fresh.id).knowledge
  assert.equal(doc.chars, chat.length, 'the whole chat, from where it starts')
})

test('told to use a session, the agent finds it and adds it, and only one it listed', async () => {
  const fresh = await store.create('general')
  const provider = new ChatGPTProvider({ getAccess: async () => ({ accessToken: 'token', accountId: 'account' }) })
  const requests = backend([
    call(1, 'find_work_sessions', { query: 'payment retry' }),
    [...call(2, 'add_work_session', { id: CID }), ...call(3, 'add_work_session', { id: 'made-up' })],
    say('Added your Codex session about the payment retries.')
  ])
  const changes = []
  await train(store, provider, fresh.id, [], 'Use my Codex session about the payment retries for the call with finance.', new AbortController().signal, {
    onDelta() {},
    onChange: (c) => changes.push(c)
  })
  // The last request has each tool's output so far.
  const outputs = requests.at(-1).input.filter((i) => i.type === 'function_call_output').map((i) => i.output)
  assert.match(outputs[0], /^- id 019e0000-1111-7222-8333-944445555666: "Payment retry 409" \(Codex, in D:\\work\\billing\), last worked on .+2026; first asked: "Payments fail on retry with a 409\. Find out why\."$/)
  assert.match(outputs[1], /^Added: "Payment retry 409 \(Codex session\)" \(\d+ characters\)/)
  assert.equal(outputs[2], 'No work session has that id: find it with find_work_sessions first.')
  assert.deepEqual(changes, ['Added to Knowledge: Payment retry 409 (Codex session)'])
  assert.match(requests[0].input[0].content[0].text, /Work sessions: their sessions with Claude Code or Codex/)
})
