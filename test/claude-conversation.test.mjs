// A Claude Code session's conversation, read from the session's file for the Web view (here, in a scratch folder set up as its
// own): what was asked and answered, the commands run with how each ended, the files changed, and nothing of helper agents,
// reminders or results. It is read again as the file grows, and a line that is half written waits.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const dir = workDir('claude-conversation')
const claudeHome = path.join(dir, '.claude')
process.env.CLAUDE_CONFIG_DIR = claudeHome

const { claudeConversation } = await import('./.build/togle.mjs')

const file = (n) => path.join(claudeHome, 'projects', 'C--work-shop', `bbbb${n}111-2222-4333-8444-555566667777.jsonl`)
const id = (n) => `bbbb${n}111-2222-4333-8444-555566667777`
const line = (record) => JSON.stringify(record) + '\n'
const asked = (n, text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, sessionId: id(n), timestamp: '2026-11-16T10:00:00.000Z', isSidechain: false, origin: { kind: 'human' }, ...extra })
const said = (n, blocks, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: blocks }, sessionId: id(n), timestamp: '2026-11-16T10:00:05.000Z', isSidechain: false, ...extra })
const result = (n, toolUseId, text, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] }, sessionId: id(n), timestamp: '2026-11-16T10:00:09.000Z', isSidechain: false })
const write = (n, text) => { mkdirSync(path.dirname(file(n)), { recursive: true }); writeFileSync(file(n), text) }

test('what was asked, what it answered, the commands with how each ended, and the files changed; nothing else', async () => {
  write(1,
    line(asked(1, '<system-reminder>Memory: private</system-reminder>\nRebuild the pricing page.')) +
    line(said(1, [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'I will start with the table.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'rm -rf build' } }, { type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm run lint' } }, { type: 'tool_use', id: 't4', name: 'Read', input: { file_path: 'a.ts' } }])) +
    line(result(1, 't1', 'ok')) +
    line(result(1, 't2', "The user doesn't want to proceed with this tool use. The tool use was rejected.", true)) +
    line(result(1, 't3', 'Exit code 1\nerror', true)) +
    line(said(1, [{ type: 'tool_use', id: 't5', name: 'Edit', input: { file_path: 'C:\\work\\shop\\pricing.tsx', old_string: 'a', new_string: 'b' } }, { type: 'tool_use', id: 't6', name: 'Write', input: { file_path: 'C:\\work\\shop\\table.tsx', content: 'x' } }])) +
    line(said(1, [{ type: 'text', text: 'Done: two plans, side by side.' }])) +
    // A helper agent's chatter and a line Claude Code added itself are not the conversation.
    line(said(1, [{ type: 'text', text: 'helper words' }], { isSidechain: true })) +
    line({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta words' }, sessionId: id(1) }) +
    line({ type: 'ai-title', aiTitle: 'Pricing page', sessionId: id(1) })
  )
  const history = await claudeConversation(id(1))
  assert.ok(history)
  assert.equal(history.more, false)
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.text, entry.status ?? null]), [
    ['you', 'Rebuild the pricing page.', null],
    ['agent', 'I will start with the table.', null],
    ['command', 'npm test', 'finished'],
    ['command', 'rm -rf build', 'declined'],
    ['command', 'npm run lint', 'failed'],
    ['files', 'Changed 1 file: C:\\work\\shop\\pricing.tsx', null],
    ['files', 'Changed 1 file: C:\\work\\shop\\table.tsx', null],
    ['agent', 'Done: two plans, side by side.', null]
  ])
  assert.deepEqual(history.entries[5].paths, ['C:\\work\\shop\\pricing.tsx'])
  assert.equal(new Set(history.entries.map((entry) => entry.id)).size, history.entries.length, 'each entry has an id of its own')
  assert.ok(history.entries.every((entry) => entry.at === Date.parse('2026-11-16T10:00:00.000Z') || entry.at === Date.parse('2026-11-16T10:00:05.000Z')), 'the time of each line is kept')
})

test('it is read again as the file grows: earlier entries keep their ids, and a line half written waits for its end', async () => {
  write(2, line(asked(2, 'First question.')) + line(said(2, [{ type: 'text', text: 'First answer.' }])))
  const first = await claudeConversation(id(2))
  assert.deepEqual(first.entries.map((entry) => entry.text), ['First question.', 'First answer.'])
  // A new turn, the last line only half written.
  const whole = line(said(2, [{ type: 'text', text: 'Second answer.' }]))
  appendFileSync(file(2), line(asked(2, 'Second question.')) + whole.slice(0, 30))
  const second = await claudeConversation(id(2))
  assert.deepEqual(second.entries.map((entry) => entry.text), ['First question.', 'First answer.', 'Second question.'])
  assert.deepEqual(second.entries.slice(0, 2).map((entry) => entry.id), first.entries.map((entry) => entry.id), 'what was read before keeps its ids')
  appendFileSync(file(2), whole.slice(30))
  const third = await claudeConversation(id(2))
  assert.deepEqual(third.entries.map((entry) => entry.text), ['First question.', 'First answer.', 'Second question.', 'Second answer.'])
})

test('a file that does not end with a newline is read to its end', async () => {
  write(3, line(asked(3, 'No newline at the end.')) + JSON.stringify(said(3, [{ type: 'text', text: 'Last line.' }])))
  assert.deepEqual((await claudeConversation(id(3))).entries.map((entry) => entry.text), ['No newline at the end.', 'Last line.'])
})

test('the last turns first: older ones are left out, and all of them can be asked for', async () => {
  let text = ''
  for (let turn = 1; turn <= 15; turn++) text += line(asked(4, `Question ${turn}`)) + line(said(4, [{ type: 'text', text: `Answer ${turn}` }]))
  write(4, text)
  const recent = await claudeConversation(id(4))
  assert.equal(recent.more, true)
  assert.equal(recent.entries[0].text, 'Question 4', 'twelve turns, from the one a question starts')
  assert.equal(recent.entries.length, 24)
  const everything = await claudeConversation(id(4), true)
  assert.equal(everything.more, false)
  assert.equal(everything.entries.length, 30)
})

test('a command whose result never came is not shown as running once something was asked after it', async () => {
  write(5, line(asked(5, 'Run it.')) + line(said(5, [{ type: 'tool_use', id: 'x1', name: 'Bash', input: { command: 'sleep 100' } }])) + line(asked(5, 'Never mind, stop.')))
  assert.equal((await claudeConversation(id(5))).entries[1].status, 'failed')
  // While it is the last thing, it is running.
  write(6, line(asked(6, 'Run it.')) + line(said(6, [{ type: 'tool_use', id: 'x2', name: 'Bash', input: { command: 'sleep 100' } }])))
  assert.equal((await claudeConversation(id(6))).entries[1].status, 'running')
})

test('a session with no file is null, and a file rewritten shorter is read from its start', async () => {
  assert.equal(await claudeConversation('cccc0000-2222-4333-8444-555566667777'), null)
  write(7, line(asked(7, 'Long first message that makes the file long.')) + line(said(7, [{ type: 'text', text: 'Long first answer that makes it longer.' }])))
  assert.equal((await claudeConversation(id(7))).entries.length, 2)
  write(7, line(asked(7, 'Short.')))
  assert.deepEqual((await claudeConversation(id(7))).entries.map((entry) => entry.text), ['Short.'])
})

test('two looks at once read the same lines once', async () => {
  write(8, line(asked(8, 'One.')) + line(said(8, [{ type: 'text', text: 'Two.' }])))
  const [a, b] = await Promise.all([claudeConversation(id(8)), claudeConversation(id(8))])
  assert.equal(a.entries.length, 2)
  assert.equal(b.entries.length, 2)
})
