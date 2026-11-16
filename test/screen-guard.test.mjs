// /resume and /exit are kept off an agent's own screen: what the rows of a real screen say Enter would run (rows copied from Claude Code
// 2.1.325, Codex 0.166 and Hermes 0.22 as xterm.js held them), what was typed, and which names each agent has for the two.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const T = await import('./.build/togle.mjs')
const rule = '─'.repeat(100)

// ---- Rows as the real programs drew them ----

const claudeListOpen = (typed, highlighted = '/exit') => [
  '  ▐▛███▛█   Claude Code v2.1.325',
  ' ❯ /exit',
  '  ⎿  Resume cancelled',
  `  ❯ ${highlighted.padEnd(44)} Detach from this background session (it keeps running)`,
  '    /context                                     Visualize current context usage as a colored grid',
  '    /product-management:competitive-brief        (product-management) Create a competitive analysis brief for on',
  '                                                 more competitors or a feature area. Use when informing product',
  rule,
  `❯ ${typed}`,
  rule,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
]
const claudeIdle = [
  '  ▐▛███▛█   Claude Code v2.1.325',
  '❯ /exit',
  '  ⎿  Resume cancelled',
  '❯ /resume',
  '  ⎿  Resume cancelled',
  rule,
  '❯ Try "how does <filepath> work?"',
  rule,
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
]
const codexListOpen = (typed, highlighted, said) => [
  '› Say only: ok',
  '',
  '• ok',
  '',
  '  Worked for 5s • 8:53 AM',
  `› ${highlighted}  ${said}`,
  '',
  `› ${typed}`,
  '',
  '  GPT-6.1-Sol max · C:\\work\\site',
  '  tab to queue message'
]
const hermesPrompt = (typed) => [
  '  ╔═════════════════════════════════════════════════════════════',
  '  ║  /export    Export the current conversation (usage: /export <json|md|html> [filename])',
  '  ║  /exit      Exit the CLI (use --delete to also remove session history) (alias for /quit)',
  '  ╚═════════════════════════════════════════════════════════════',
  `  ❯ ${typed}`
]

test('the prompt of a screen is its bottom-most row with the prompt mark, and earlier rows with the mark are not it', () => {
  assert.deepEqual(T.readScreen(claudeIdle), { prompt: 'Try "how does <filepath> work?"', listed: null })
  assert.deepEqual(T.readScreen(claudeListOpen('/ex')), { prompt: '/ex', listed: '/exit' })
  assert.deepEqual(T.readScreen(codexListOpen('/qu', '/quit', 'exit Codex')), { prompt: '/qu', listed: '/quit' })
  assert.deepEqual(T.readScreen(hermesPrompt('/exit')), { prompt: '/exit', listed: null })
  assert.deepEqual(T.readScreen(['no prompt here', 'at all']), { prompt: null, listed: null })
  assert.deepEqual(T.readScreen([]), { prompt: null, listed: null })
})

test('a command already run and shown above the prompt is not what Enter runs', () => {
  // Past /exit and /resume stay on the screen as lines of the conversation; the prompt below them is empty.
  assert.equal(T.caughtOnEnter('claude', claudeIdle, ''), null)
  assert.equal(T.caughtOnEnter('claude', claudeIdle, null), null)
})

test('a kept command typed whole is caught, with its arguments, in any case', () => {
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/exit'), '/exit'), { kept: 'exit', command: 'exit' })
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/quit', '/quit'), null), { kept: 'exit', command: 'quit' })
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/resume', '/resume'), null), { kept: 'resume', command: 'resume' })
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/continue', '/continue'), null), { kept: 'resume', command: 'continue' })
  assert.deepEqual(T.caughtOnEnter('hermes', hermesPrompt('/quit --delete'), null), { kept: 'exit', command: 'quit' }, 'the flag that deletes a session is no way round it')
  assert.deepEqual(T.caughtOnEnter('hermes', hermesPrompt('/Exit'), null), { kept: 'exit', command: 'exit' })
  assert.deepEqual(T.caughtOnEnter('hermes', hermesPrompt('/sessions'), null), { kept: 'resume', command: 'sessions' })
  assert.deepEqual(T.caughtOnEnter('codex', codexListOpen('/resume', '/resume', 'resume a saved chat'), null), { kept: 'resume', command: 'resume' })
})

test('the start of a command is caught when Enter would run the item the list highlights, and not when it would run another', () => {
  // Claude Code and Codex run the highlighted item on Enter, whatever was typed of it.
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/ex', '/exit'), null), { kept: 'exit', command: 'exit' })
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/res', '/resume'), null), { kept: 'resume', command: 'resume' })
  assert.deepEqual(T.caughtOnEnter('codex', codexListOpen('/qu', '/quit', 'exit Codex'), null), { kept: 'exit', command: 'quit' })
  assert.equal(T.caughtOnEnter('claude', claudeListOpen('/re', '/rename'), null), null, 'the highlight is /rename: it runs')
  assert.equal(T.caughtOnEnter('claude', claudeListOpen('/', '/code-review'), null), null, 'an item picked with the arrow keys is read as well')
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/', '/exit'), null), { kept: 'exit', command: 'exit' }, 'and /exit picked with the arrow keys is caught')
  // Hermes only fills the line on Enter: the start of a command is not yet one.
  assert.equal(T.caughtOnEnter('hermes', hermesPrompt('/ex'), null), null)
})

test('other commands, and names that only start like a kept one, go through', () => {
  for (const line of ['/context', '/model haiku', '/compact', '/exit-codes', '/resume-notes now', '/exiting', 'exit', 'please /exit', '/exit?', '//exit', '/', '']) {
    assert.equal(T.caughtOnEnter('claude', claudeListOpen(line, line || '/context'), line), null, `claude: ${JSON.stringify(line)}`)
  }
  assert.equal(T.caughtOnEnter('claude', claudeListOpen('/constructor', '/constructor'), '/constructor'), null, 'a name that is a property of every object is not a kept name')
  assert.equal(T.caughtOnEnter('claude', claudeListOpen('/__proto__', '/__proto__'), '/__proto__'), null)
})

test('a name is kept only where that agent has it, and an agent Togle has not measured is left alone', () => {
  assert.equal(T.caughtOnEnter('codex', codexListOpen('/continue', '/continue', 'x'), null), null, 'Codex has no /continue')
  assert.equal(T.caughtOnEnter('claude', claudeListOpen('/sessions', '/sessions'), null), null, 'Claude Code has no /sessions of this kind')
  assert.equal(T.caughtOnEnter('aider', hermesPrompt('/exit'), '/exit'), null)
  assert.equal(T.hasGuard('claude'), true)
  assert.equal(T.hasGuard('hermes'), true)
  assert.equal(T.hasGuard('aider'), false)
  assert.equal(T.hasGuard('constructor'), false)
  assert.equal(T.keptBy('claude', null), null)
})

test('what was typed counts when the screen has not drawn it yet', () => {
  // The screen shows the start of the line, the keys already hold all of it.
  assert.deepEqual(T.caughtOnEnter('claude', claudeListOpen('/', '/context'), '/exit'), { kept: 'exit', command: 'exit' })
  assert.deepEqual(T.caughtOnEnter('claude', claudeIdle, '/resume'), { kept: 'resume', command: 'resume' })
  assert.equal(T.caughtOnEnter('claude', claudeIdle, '/context'), null)
})

test('the keys typed on a line are followed until something the keys do not tell can have changed it', () => {
  const line = new T.TypedLine()
  assert.equal(line.text(), '')
  line.feed('/')
  line.feed('e')
  line.feed('xx')
  assert.equal(line.text(), '/exx')
  line.feed('\x7f')
  line.feed('it')
  assert.equal(line.text(), '/exit')
  line.feed('\x15')
  assert.equal(line.text(), '', 'Ctrl+U empties it')
  line.feed('/res')
  line.feed('\x1b[D')
  assert.equal(line.text(), null, 'an arrow key can move the cursor: the line is not told')
  line.feed('\x7f')
  assert.equal(line.text(), null, 'and stays so')
  line.feed('\r')
  assert.equal(line.text(), '', 'Enter ends the line')
  line.feed('/exi')
  line.feed('\t')
  assert.equal(line.text(), null, 'Tab completes it: the screen has the rest')
  line.feed('\x1b')
  line.feed('\x15')
  assert.equal(line.text(), '', 'a line emptied is known again')
  line.feed('\x1b[200~/exit\nsecond line\x1b[201~')
  assert.equal(line.text(), '/exit second line', 'a paste is words, with its line breaks as spaces')
  line.feed('\x03')
  assert.equal(line.text(), null, 'Ctrl+C: not every agent empties the line')
  assert.equal(new T.TypedLine().text(), '')
})

test('what the person is told names the command, and says what to do instead', () => {
  assert.deepEqual(T.noteFor({ kept: 'exit', command: 'exit' }), { title: '/exit is not run here', body: 'Togle keeps this screen on the task. Hand back closes the screen, and the task goes on.' })
  assert.deepEqual(T.noteFor({ kept: 'exit', command: 'quit' }).title, '/quit is not run here')
  assert.match(T.noteFor({ kept: 'resume', command: 'resume' }).body, /another conversation under this task.*Continue here/)
  assert.equal(T.CLEAR_LINE, '\x05\x15')
})
