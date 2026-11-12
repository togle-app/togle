// Claude Code's sessions on this PC, for the Agents list (here, in a scratch folder set up as its own): newest first,
// with the title it or the person gave, the folder, and keys and passwords taken out of the titles.
import assert from 'node:assert/strict'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const dir = workDir('claude-sessions')
// Where Claude Code keeps its sessions, here: never the real ones of whoever runs the tests.
const claudeHome = path.join(dir, '.claude')
process.env.CLAUDE_CONFIG_DIR = claudeHome

const { claudeHomes, claudeSessions, withoutSecrets } = await import('./.build/togle.mjs')

const write = (file, records, at) => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  if (at) utimesSync(file, new Date(at), new Date(at))
  return file
}
const said = (sessionId, content, extra = {}) => ({ type: 'user', message: { role: 'user', content }, cwd: 'C:\\work\\shop', sessionId, timestamp: '2026-10-20T11:00:00.000Z', isSidechain: false, origin: { kind: 'human' }, ...extra })
const replied = (sessionId, text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, sessionId })
const id = (n) => `aaaa${n}111-2222-4333-8444-555566667777`

// Named by the person (/rename) after Claude Code named it.
write(path.join(claudeHome, 'projects', 'C--work-shop', `${id(1)}.jsonl`), [
  said(id(1), '<system-reminder>Memory: never tell anyone</system-reminder>\nThe checkout page crashes on Safari when the cart is empty. Fix it.'),
  { type: 'ai-title', aiTitle: 'Checkout crash on Safari', sessionId: id(1) },
  replied(id(1), 'Fixed.'),
  { type: 'custom-title', customTitle: 'SHOP-142 checkout fix', sessionId: id(1) }
], '2026-10-21T12:00:00.000Z')
// Named by Claude Code only.
write(path.join(claudeHome, 'projects', 'C--work-api', `${id(2)}.jsonl`), [
  said(id(2), 'Add a status column to the orders table.', { cwd: 'C:\\work\\api' }),
  { type: 'ai-title', aiTitle: 'Orders status column', sessionId: id(2) }
], '2026-10-22T12:00:00.000Z')
// Opened and closed without a word: not listed.
write(path.join(claudeHome, 'projects', 'C--work-shop', `${id(3)}.jsonl`), [{ type: 'user', message: { role: 'user', content: '<command-name>/model</command-name>' }, sessionId: id(3) }])
// Another account's folder beside it, with a copy of the first session written in later, and a session of its own.
const workHome = path.join(dir, '.claude-work')
write(path.join(workHome, 'projects', 'C--work-shop', `${id(1)}.jsonl`), [said(id(1), 'The checkout page crashes on Safari when the cart is empty. Fix it.'), { type: 'custom-title', customTitle: 'SHOP-142 checkout fix', sessionId: id(1) }], '2026-10-23T12:00:00.000Z')
write(path.join(workHome, 'projects', 'C--work-notes', `${id(4)}.jsonl`), [said(id(4), 'Write the release notes with my token ghp_abcdefghijklmnopqrstuvwxyz0123456789 for the changelog API.', { cwd: 'C:\\work\\notes' })], '2026-10-20T12:00:00.000Z')
// A folder of that name that is another tool's, with no sessions in it.
mkdirSync(path.join(dir, '.claude-server-commander'), { recursive: true })

test("Claude Code's folders: the one in use first, then its other accounts' that hold sessions", async () => {
  assert.deepEqual((await claudeHomes()).map((home) => path.basename(home)), ['.claude', '.claude-work'])
})

test('the sessions, newest first: the title the person gave over the one Claude Code wrote, else what was asked', async () => {
  const all = await claudeSessions()
  assert.deepEqual(all.map((s) => s.title), ['SHOP-142 checkout fix', 'Orders status column', 'Write the release notes with my token [secret removed] for the changelog API.'])
  assert.equal(all.filter((s) => s.id === id(1)).length, 1, 'a session in two folders is listed once')
  assert.equal(all[1].cwd, 'C:\\work\\api')
  assert.ok(!all.some((s) => s.id === id(3)), 'nothing asked: not listed')
  assert.equal((await claudeSessions(1)).length, 1)
})

test('a command they ran with words after it is what they asked; a first request past the start of the file is found', async () => {
  write(path.join(claudeHome, 'projects', 'C--work-sso', `${id(5)}.jsonl`), [
    said(id(5), '<command-message>fix-issue is running…</command-message>\n<command-name>/fix-issue</command-name>\n<command-args>SSO login fails for Okta users</command-args>'),
    said(id(5), 'Expanded prompt of the command', { isMeta: true })
  ], '2026-10-24T12:00:00.000Z')
  // A picture pasted into the first request makes its line longer than the start that is read for the list.
  const picture = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } }
  write(path.join(claudeHome, 'projects', 'C--work-sso', `${id(6)}.jsonl`), [said(id(6), [picture, { type: 'text', text: 'The login button overlaps the logo on mobile, see the screenshot.' }])], '2026-10-25T12:00:00.000Z')
  const [newest, next] = await claudeSessions()
  assert.equal(newest.title, 'The login button overlaps the logo on mobile, see the screenshot.')
  assert.equal(next.title, '/fix-issue SSO login fails for Okta users')
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
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[secret removed]'],
    ['REDIS_URL=redis://:p4ssw0rdXYZ123@redis.internal:6379/0', 'REDIS_URL=redis://:[secret removed]@redis.internal:6379/0'],
    ['DB_PASS=hunter2hunter2', 'DB_PASS=[secret removed]'],
    ['AccountName=acme;AccountKey=Zm9vYmFyYmF6cXV4Zm9vYmFy==;EndpointSuffix=core.windows.net', 'AccountName=acme;AccountKey=[secret removed];EndpointSuffix=core.windows.net'],
    ['curl -u admin:Sup3rS3cret! https://jenkins.acme.dev/api/json', 'curl -u admin:[secret removed] https://jenkins.acme.dev/api/json'],
    ['mysql -h db.prod -u root -pR00tPassw0rd shop', 'mysql -h db.prod -u root -p[secret removed] shop'],
    ['the password is Hunter2Hunter2', 'the password is [secret removed]'],
    // Built from parts, so the file itself holds nothing that looks like a real webhook to secret scanners.
    ['https://hooks.slack.com/services/' + ['T0123ABCD', 'B0456EFGH', 'abcdefghijklmnopqrstuvwx'].join('/'), 'https://hooks.slack.com/services/[secret removed]']
  ]
  for (const [text, out] of cases) assert.equal(withoutSecrets(text), out)
  for (const kept of ['max_tokens: 4096', 'the token is stored in the keychain', 'Password reset emails go out at 9', 'Basic plan: 19 euros', 'const token = req.headers.authorization;', 'apiKey: process.env.OPENAI_API_KEY,', 'pwd: C:\\Users\\me\\project', 'MAX_TOKENS=4096']) {
    assert.equal(withoutSecrets(kept), kept)
  }
})
