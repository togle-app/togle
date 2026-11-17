// A Claude Code session's conversation, read from the session's file for the Chat view (here, in a scratch folder set up as its
// own): what was asked and answered, the commands run with how each ended and how long each took, the files changed, what else
// it did (files read, searches, the web, helpers, its checklist, its thinking, other tools), and nothing of what a helper agent
// did itself, of reminders or of results. It is read again as the file grows, and a line that is half written waits. What a step
// holds (what a command printed, a thought's words) is not in the conversation: it is read again from the file when asked for.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const dir = workDir('claude-conversation')
const claudeHome = path.join(dir, '.claude')
process.env.CLAUDE_CONFIG_DIR = claudeHome

const { claudeConversation, claudeStep, detailOf } = await import('./.build/togle.mjs')

const file = (n) => path.join(claudeHome, 'projects', 'C--work-shop', `bbbb${n}111-2222-4333-8444-555566667777.jsonl`)
const id = (n) => `bbbb${n}111-2222-4333-8444-555566667777`
const line = (record) => JSON.stringify(record) + '\n'
const asked = (n, text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, sessionId: id(n), timestamp: '2026-11-16T10:00:00.000Z', isSidechain: false, origin: { kind: 'human' }, ...extra })
const said = (n, blocks, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', content: blocks }, sessionId: id(n), timestamp: '2026-11-16T10:00:05.000Z', isSidechain: false, ...extra })
const result = (n, toolUseId, text, isError = false) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }] }, sessionId: id(n), timestamp: '2026-11-16T10:00:09.000Z', isSidechain: false })
const write = (n, text) => { mkdirSync(path.dirname(file(n)), { recursive: true }); writeFileSync(file(n), text) }

test('what was asked, what it answered, the commands with how each ended, the files changed and the file read; nothing of helpers or reminders', async () => {
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
    ['step', 'a.ts', null],
    ['files', 'Changed 1 file: C:\\work\\shop\\pricing.tsx', null],
    ['files', 'Changed 1 file: C:\\work\\shop\\table.tsx', null],
    ['agent', 'Done: two plans, side by side.', null]
  ])
  assert.deepEqual([history.entries[5].step, history.entries[5].paths], ['read', ['a.ts']])
  assert.deepEqual(history.entries[6].paths, ['C:\\work\\shop\\pricing.tsx'])
  assert.equal(history.entries.some((entry) => entry.step === 'think'), false, 'a thought with no time and no line to read it from again is not told')
  assert.equal(JSON.stringify(history).includes('secret thoughts'), false, 'the words of a thought are never in the conversation')
  assert.deepEqual(history.entries.filter((entry) => entry.kind === 'command').map((entry) => entry.took), [4000, 4000, 4000], 'how long each command took: from its call to its result')
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

// The lines of the next tests, each with a time of its own and the id Claude Code gives a line.
const at = (seconds) => new Date(Date.parse('2026-11-16T10:00:00.000Z') + seconds * 1000).toISOString()
const call = (id, name, input) => ({ type: 'tool_use', id, name, input })
const answer = (n, toolUseId, content, seconds, extra = {}) => ({ ...result(n, toolUseId, content), timestamp: at(seconds), ...extra })

test('what else it did: files read, searches, the web, helpers, other tools and its checklist, with how long things took', async () => {
  write(9,
    line(asked(9, 'Look into the pricing page.')) +
    line(said(9, [call('r1', 'Read', { file_path: 'src/a.ts' }), call('r2', 'Read', { file_path: 'src/b.ts' }), call('r3', 'Read', { file_path: 'src/a.ts' })], { timestamp: at(5) })) +
    line(said(9, [call('g1', 'Grep', { pattern: 'yearly', path: 'src' }), call('g2', 'Glob', { pattern: '**/*.tsx' })], { timestamp: at(6) })) +
    line(answer(9, 'g1', 'src/a.ts', 7)) +
    line(said(9, [call('w1', 'WebSearch', { query: 'tax notes on pricing pages', mode: 'standard' }), call('w2', 'WebFetch', { url: 'https://example.com/pricing', prompt: 'What does it say?' })], { timestamp: at(8) })) +
    line(answer(9, 'w1', 'results', 9, { toolUseResult: { query: 'tax notes on pricing pages', results: [], durationSeconds: 2.5, searchCount: 1 } })) +
    line(answer(9, 'w2', 'the page', 10, { toolUseResult: { url: 'https://example.com/pricing', code: 200, codeText: 'OK', bytes: 10, durationMs: 1234, result: 'the page' } })) +
    line(said(9, [call('h1', 'Agent', { description: 'Find the plan data', prompt: 'Look for plans.ts', subagent_type: 'Explore' }), call('h2', 'Agent', { description: 'Check the tests', prompt: 'Run them', subagent_type: 'general-purpose' })], { timestamp: at(11) })) +
    line(answer(9, 'h1', [{ type: 'text', text: 'It is in src/plans.ts.' }], 41)) +
    line(answer(9, 'h2', 'launched', 12, { toolUseResult: { status: 'async_launched', isAsync: true, agentId: 'x', description: 'Check the tests', prompt: 'Run them' } })) +
    line(said(9, [call('k1', 'Skill', { skill: 'code-review' }), call('m1', 'mcp__github__get_job_logs', { job_id: 1 }), call('s1', 'ToolSearch', { query: 'x', max_results: 5 })], { timestamp: at(42) })) +
    line({ ...answer(9, 'm1', 'not found', 43), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'm1', content: 'not found', is_error: true }] } }) +
    line(said(9, [call('c1', 'TaskCreate', { subject: 'Change the plan data', description: 'x', activeForm: 'Changing' }), call('c2', 'TaskCreate', { subject: 'Rebuild the table', description: 'y', activeForm: 'Rebuilding' })], { timestamp: at(44) })) +
    line(answer(9, 'c1', 'Task #1 created successfully: Change the plan data', 45, { toolUseResult: { task: { id: '1', subject: 'Change the plan data', description: 'x' } } })) +
    line(answer(9, 'c2', 'Task #2 created successfully: Rebuild the table', 45)) +
    line(said(9, [call('u1', 'TaskUpdate', { taskId: '1', status: 'completed' }), call('u2', 'TaskUpdate', { taskId: '2', status: 'in_progress' })], { timestamp: at(46) })) +
    line(said(9, [{ type: 'text', text: 'The plan data is in src/plans.ts.' }], { timestamp: at(47) }))
  )
  const history = await claudeConversation(id(9))
  assert.deepEqual(history.entries.map((entry) => [entry.kind, entry.step ?? null, entry.text, entry.status ?? null, entry.took ?? null]), [
    ['you', null, 'Look into the pricing page.', null, null],
    ['step', 'read', 'src/a.ts', null, null],
    ['step', 'search', 'yearly', null, 1000],
    ['step', 'search', '**/*.tsx', null, null],
    ['step', 'web', 'tax notes on pricing pages', null, 2500],
    ['step', 'web', 'https://example.com/pricing', null, 1234],
    ['step', 'helper', 'Find the plan data', 'finished', 30000],
    ['step', 'helper', 'Check the tests', 'finished', null],
    ['step', 'tool', 'Skill: code-review', null, null],
    ['step', 'tool', 'github: get_job_logs', 'failed', 1000],
    ['step', 'tool', 'ToolSearch', null, null],
    ['step', 'plan', '1 of 2 done', null, null],
    ['agent', null, 'The plan data is in src/plans.ts.', null, null]
  ])
  assert.deepEqual(history.entries[1].paths, ['src/a.ts', 'src/b.ts'], 'reads one after another are one step that names each file once')
  assert.deepEqual(history.entries[11].plan, [{ text: 'Change the plan data', state: 'done' }, { text: 'Rebuild the table', state: 'doing' }], 'the checklist as it stands, the number of a thing read from its result')
  assert.equal(history.entries.some((entry) => entry.more), false, 'none of these has anything to open')
})

test('thinking: its time is told, thoughts in a row are one, and a short one with no words is not told', async () => {
  const thinks = (uuid, words, ms, seconds) => said(10, [{ type: 'thinking', thinking: words, signature: 'x' }], { uuid, timestamp: at(seconds), ...(ms === undefined ? {} : { thinkingDurationMs: ms }) })
  write(10,
    line(asked(10, 'Why is the test red?')) +
    line(thinks('u-1', '', 300, 1)) +
    line(said(10, [call('b1', 'Bash', { command: 'npm test' })], { timestamp: at(2) })) +
    line(answer(10, 'b1', 'x', 4)) +
    line(thinks('u-2', '', 5000, 5)) +
    line(thinks('u-3', '', 3200, 6)) +
    line(thinks('u-4', 'The mock returns the monthly price.', 2000, 7)) +
    line(thinks('u-5', 'So the test must change.', 1000, 8)) +
    line(said(10, [{ type: 'text', text: 'The test expects the old price.' }], { timestamp: at(9) }))
  )
  const history = await claudeConversation(id(10))
  const thoughts = history.entries.filter((entry) => entry.step === 'think')
  assert.deepEqual(thoughts.map((entry) => [entry.took, !!entry.more]), [[10200, true], [1000, true]], 'three in a row are one with its times added up; the next with words of its own is another')
  assert.equal(history.entries[1].kind, 'command', 'the short thought before the command is not told')
  assert.equal(await claudeStep(id(10), thoughts[0].more), 'The mock returns the monthly price.')
  assert.equal(await claudeStep(id(10), thoughts[1].more), 'So the test must change.')
})

test('what a command printed is read again from the file when asked for, by a key the conversation gave, and by no other', async () => {
  write(11,
    line(asked(11, 'Run the tests.')) +
    line(said(11, [call('o1', 'Bash', { command: 'npm test' }), call('o2', 'Bash', { command: 'true' }), call('o3', 'PowerShell', { command: 'Get-ChildItem' })], { timestamp: at(1) })) +
    line(answer(11, 'o1', 'ignored when the line has its own account', 3, { toolUseResult: { stdout: 'ok 14 tests\n', stderr: 'a warning', interrupted: false, isImage: false } })) +
    line(answer(11, 'o2', '', 3, { toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false } })) +
    line(answer(11, 'o3', 'a.txt\nb.txt', 4))
  )
  const history = await claudeConversation(id(11))
  const [first, second, third] = history.entries.filter((entry) => entry.kind === 'command')
  assert.deepEqual([first.more, second.more, third.more], ['o1', undefined, 'o3'], 'a command that printed nothing has nothing to open')
  assert.equal(JSON.stringify(history).includes('ok 14 tests'), false, 'what it printed is not in the conversation')
  assert.equal(await claudeStep(id(11), 'o1'), 'ok 14 tests\n\na warning')
  assert.equal(await claudeStep(id(11), 'o3'), 'a.txt\nb.txt', 'a result with no account of its own is its words')
  assert.equal(await claudeStep(id(11), 'o2'), null)
  assert.equal(await claudeStep(id(11), 'nothing-like-a-key'), null)
  assert.equal(await claudeStep(id(11), '../../etc/passwd'), null, 'a key is looked up, never read as a place')
  assert.equal(await claudeStep(id(9), 'o1'), null, 'a key of one session opens nothing in another')
  assert.equal(await claudeStep('cccc0000-2222-4333-8444-555566667777', 'o1'), null)
  // The file is written again, shorter and with other lines: where the key pointed is another line now, and nothing is given.
  write(11, line(asked(11, 'x'.repeat(400))) + line(asked(11, 'y'.repeat(400))))
  assert.equal(await claudeStep(id(11), 'o1'), null)
})

test('a line with a byte order mark before it, and letters of more than one byte, are found again where they are', async () => {
  write(12, '\ufeff' +
    line(asked(12, 'Größe prüfen, 가격표 확인.')) +
    line(said(12, [call('z1', 'Bash', { command: 'echo größe' })], { timestamp: at(1) })) +
    line(answer(12, 'z1', 'größe: 12 가격', 2))
  )
  const history = await claudeConversation(id(12))
  assert.deepEqual(history.entries.map((entry) => entry.text), ['Größe prüfen, 가격표 확인.', 'echo größe'])
  assert.equal(await claudeStep(id(12), 'z1'), 'größe: 12 가격')
})

test('what is shown of a step is made fit to show: no colors or control keys, no keys or passwords, and only its end when it is long', () => {
  assert.deepEqual(detailOf('\u001b[32mok\u001b[0m\r\nAPI_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789\r\n\u0007done   \n'), { text: 'ok\nAPI_KEY=[secret removed]\ndone', cut: false })
  assert.equal(detailOf(''), null)
  assert.equal(detailOf('   \n  '), null)
  assert.equal(detailOf(null), null)
  const long = detailOf(Array.from({ length: 5000 }, (_, n) => 'line ' + n).join('\n'))
  assert.equal(long.cut, true)
  assert.ok(long.text.length <= 24000 && long.text.endsWith('line 4999') && long.text.startsWith('line '), 'its end, from the start of a line')
})
