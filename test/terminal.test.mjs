import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
const T = await import('./.build/togle.mjs')

// An agent without ACP, run in a real pseudo-terminal (node-pty) by the hub: the stand-in in fake-terminal-agent.mjs.

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-terminal-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})
const agent = path.join(import.meta.dirname, 'fake-terminal-agent.mjs')
const command = (rest = '') => `"${process.execPath}" "${agent}"${rest ? ` ${rest}` : ''}`
const until = async (check, what, ms = 15_000) => {
  const began = Date.now()
  while (Date.now() - began < ms) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

const hubWith = (rest) => {
  const told = []
  const backend = new T.TerminalBackend({ runner: 'term-fake', name: 'Fake', command: command(rest) }, (chunk) => told.push(chunk))
  const hub = new T.RunnerHub({ backends: [backend], changed() {} })
  return { hub, told, backend }
}
const seen = async (hub, key) => (await hub.list()).find((task) => task.key === key)

test('an agent without ACP runs in a terminal of its own, with the task\'s words where {task} stands', async () => {
  const { hub, told } = hubWith('--message={task}')
  try {
    assert.deepEqual((await hub.status()).map((agent) => [agent.runner, agent.installed]), [['term-fake', true]])
    const view = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'Fix the "flaky" test & the docs' })
    assert.match(view.key, /^term-fake:/)
    assert.deepEqual([view.terminal, view.words, view.state], [true, undefined, 'working'], 'its words were given: none wait')
    await until(() => plain(hub.terminalRead(view.key).text).includes('ready>'), 'the agent to start')
    assert.ok(plain(hub.terminalRead(view.key).text).includes('started with ["--message=Fix the \\"flaky\\" test & the docs"]'), 'the words, as one argument, as typed')
    // What the person types reaches it, and what it prints comes back, to the window as well, in order.
    hub.terminalWrite(view.key, 'hello\r')
    await until(() => plain(hub.terminalRead(view.key).text).includes('heard: hello'), 'the answer')
    // What it printed goes to the window a moment later (in one piece): wait for the last part before comparing.
    const sentOf = () => told.filter((chunk) => chunk.key === view.key)
    await until(() => sentOf().length > 0 && sentOf().at(-1).at + sentOf().at(-1).data.length === hub.terminalRead(view.key).end, 'the last part to be sent to the window')
    const sent = sentOf()
    assert.ok(sent.length > 0)
    for (let n = 1; n < sent.length; n++) assert.equal(sent[n].at, sent[n - 1].at + sent[n - 1].data.length, 'each part starts where the last ended')
    const { text, end } = hub.terminalRead(view.key)
    assert.equal(end, sent.at(-1).at + sent.at(-1).data.length)
    assert.equal(text, sent.map((chunk) => chunk.data).join(''), 'what is read is all it printed')
    hub.terminalResize(view.key, 90, 20)
    // It ends by itself: done, or why not.
    hub.terminalWrite(view.key, 'exit 0\r')
    await until(async () => (await seen(hub, view.key))?.state === 'idle', 'it to be done')
    const second = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'Another' })
    await until(() => plain(hub.terminalRead(second.key).text).includes('ready>'), 'the second to start')
    hub.terminalWrite(second.key, 'exit 3\r')
    await until(async () => (await seen(hub, second.key))?.state === 'failed', 'it to stop with an error')
    assert.equal((await seen(hub, second.key)).line, 'Fake stopped (exit code 3).')
  } finally {
    await hub.dispose()
  }
})

test('without {task} the words wait, and are typed in on the person\'s click, without Enter', async () => {
  const { hub } = hubWith()
  try {
    const view = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'Rename the module\nand update the imports' })
    assert.equal(view.words, 'Rename the module\nand update the imports')
    await until(() => plain(hub.terminalRead(view.key).text).includes('ready>'), 'the agent to start')
    assert.ok(plain(hub.terminalRead(view.key).text).includes('started with []'), 'nothing of the words in its command')
    hub.typeWords(view.key)
    await until(() => plain(hub.terminalRead(view.key).text).includes('Rename the module and update the imports'), 'the words typed, as one line')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.ok(!plain(hub.terminalRead(view.key).text).includes('heard:'), 'and no Enter: the person presses it')
    assert.equal((await seen(hub, view.key)).words, undefined, 'typed in, they no longer wait')
    hub.terminalWrite(view.key, '\r')
    await until(() => plain(hub.terminalRead(view.key).text).includes('heard: Rename the module and update the imports'), 'Enter, from the person')
  } finally {
    await hub.dispose()
  }
})

test('a reply to a screen nobody looks at waits for it to be drawn, is typed as one line with Enter, and is never a command of the agent’s own', async () => {
  const told = []
  const backend = new T.TerminalBackend({ runner: 'term-fake', name: 'Fake', command: command() }, (chunk) => told.push(chunk))
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'Start' })
    // Before anything is drawn it waits (up to its limit); once the prompt is there and quiet, it is settled.
    const began = Date.now()
    await task.settled(300, 10_000)
    assert.ok(plain(task.read().text).includes('ready>'), 'settled once the program had drawn its prompt')
    assert.ok(Date.now() - began >= 250, 'and had been quiet for a while')
    await task.submit('two\nlines\twith a tab')
    await until(() => plain(task.read().text).includes('heard: two lines with a tab'), 'the reply to be heard as one line, with Enter')
    const files = ['C:\\test files\\togle-release.pub', '/tmp/notes.log']
    const message = T.withFilePaths('Review these', files)
    await task.submit(message)
    const recorded = () => /heard: (Review these[^\r\n]*)/.exec(plain(task.read().text))?.[1] ?? ''
    await until(() => T.splitPictures(recorded()).files.length === 2, 'both attachments in the terminal reply')
    assert.deepEqual(T.splitPictures(recorded()), { words: 'Review these', files })
    assert.equal(T.messageKey(recorded()), T.messageKey(message))
    // A quote and its reply, as Chat sends them (src/shared/quote.ts): typed as one line, heard whole, and read back by Chat.
    await task.submit(T.withQuote('Two plans\nit is.', 'Make it\ncheaper.'))
    await until(() => plain(task.read().text).includes('heard: Replying to “Two plans it is.”: Make it cheaper.'), 'the quote and its reply to be heard as one line')
    assert.deepEqual(T.splitQuote('Replying to “Two plans it is.”: Make it cheaper.'), { quote: 'Two plans it is.', reply: 'Make it cheaper.' })
    assert.throws(() => T.refuseCommand('/model'), /command is typed on the agent/)
    assert.throws(() => T.refuseCommand('  !ls'), /command is typed on the agent/)
    assert.doesNotThrow(() => T.refuseCommand('run the tests / and the linter'))
    await assert.rejects(() => task.submit('/clear'), /command is typed on the agent/)
    // A program that never draws anything does not hold the reply for ever.
    const quiet = await backend.start({ folder: scratch(), prompt: 'Quiet' })
    await quiet.close()
    await quiet.settled(300, 400)
  } finally {
    await backend.close()
  }
})

test('Stop is Ctrl+C, and End it ends the agent: either way the task is stopped, not an error', async () => {
  const { hub } = hubWith()
  try {
    const first = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'Long work' })
    await until(() => plain(hub.terminalRead(first.key).text).includes('ready>'), 'the agent to start')
    await hub.stop(first.key)
    await until(async () => (await seen(hub, first.key))?.state === 'stopped', 'Ctrl+C to stop it')
    const second = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'More work' })
    await until(() => plain(hub.terminalRead(second.key).text).includes('ready>'), 'the second to start')
    assert.equal(await hub.endCommands(second.key), 1)
    await until(async () => (await seen(hub, second.key))?.state === 'stopped', 'End it to stop it')
    await assert.rejects(hub.open('term-fake:none'), /gone|terminal|not/i)
  } finally {
    await hub.dispose()
  }
})

test('the words are one argument whatever they hold, and lose what a terminal would take as keys', async () => {
  const { hub } = hubWith('{task}')
  const started = async (prompt) => {
    const view = await hub.start({ runner: 'term-fake', folder: scratch(), prompt })
    await until(() => plain(hub.terminalRead(view.key).text).includes('ready>'), 'the agent to start')
    const line = plain(hub.terminalRead(view.key).text).split(/\r?\n/).find((text) => text.startsWith('started with'))
    await hub.endCommands(view.key)
    return JSON.parse(line.slice('started with '.length))
  }
  try {
    assert.deepEqual(await started('"Fix the bug" --yolo "now"'), ['"Fix the bug" --yolo "now"'], 'quoted at both ends, it is still one argument: no flag slips in')
    assert.deepEqual(await started('"a b"'), ['"a b"'])
    assert.deepEqual(await started('keep C:\\temp\\ and C:\\my files\\'), ['keep C:\\temp\\ and C:\\my files\\'], 'backslashes, also at the end')
    assert.deepEqual(await started('\x1b[31mred\x1b[0m words\x03 and\x07 more'), ['red words and more'], 'colors and control keys are not passed on')
  } finally {
    await hub.dispose()
  }
})

test('a terminal task ended or let go leaves nothing behind, and does not wait for a reply it cannot take', async () => {
  const saved = []
  const records = { all: () => [...saved], add: (record) => saved.push(record) }
  const backend = new T.TerminalBackend({ runner: 'term-fake', name: 'Fake', command: command() })
  const hub = new T.RunnerHub({ backends: [backend], changed() {}, records })
  try {
    const view = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'Short' })
    await until(() => plain(hub.terminalRead(view.key).text).includes('ready>'), 'the agent to start')
    assert.deepEqual(saved, [], 'no record to pick it up again: it ends with its program')
    await hub.stop(view.key)
    await until(async () => (await seen(hub, view.key))?.state === 'stopped', 'Ctrl+C to stop it')
    assert.equal(backend.running, 0, 'the backend let go of it')
    assert.equal(T.needsYou(await seen(hub, view.key)), false, 'not waiting for a reply')
    assert.equal(new T.Attention().look(hub.attention()).waiting, 0, 'nor counted on the tray')
    // The agent removed while a task of it runs: the task is stopped, not working for ever.
    const running = await hub.start({ runner: 'term-fake', folder: scratch(), prompt: 'Long' })
    await until(() => plain(hub.terminalRead(running.key).text).includes('ready>'), 'the second to start')
    await hub.removeBackend('term-fake')
    await until(async () => (await seen(hub, running.key))?.state === 'stopped', 'it to be stopped')
    assert.deepEqual(hub.busy(), [], 'nothing busy is left to ask about at quit')
  } finally {
    await hub.dispose()
  }
})

// Claude Code draws on the other screen and asks for the mouse once, when it starts. A window that opens its screen later is sent only
// the last part of what it printed (the last 512 KB), so the modes are told to it again, as the program had them where that part begins:
// else the wheel would scroll nothing until the program set them again (a key made it).
test('the modes a program set on its terminal are told again to a window that opens the screen later', () => {
  const modes = new T.TerminalModes()
  // As Claude Code's own screen starts: win32 input mode (not kept), focus reports, bracketed paste, the other screen, the mouse.
  modes.feed('\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[?2004h\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[?25h')
  assert.equal(modes.restore(), '\x1b[?1049h\x1b[?1004h\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h', 'the other screen first, then the rest as they were set; cursor and win32 modes are not kept')
  modes.feed('\x1b[?1000l\x1b[?1002;1003l')
  assert.equal(modes.restore(), '\x1b[?1049h\x1b[?1004h\x1b[?2004h\x1b[?1006h', 'a mode the program cleared is not told again')
  modes.feed('\x1b[?1049l')
  assert.equal(modes.restore(), '\x1b[?1004h\x1b[?2004h\x1b[?1006h', 'back on the first screen, the other is not asked for')
  // Several modes in one sequence; one that arrives in two parts; the last mouse mode set is the last told.
  const more = new T.TerminalModes()
  more.feed('\x1b[?1000;1006h\x1b[?10')
  more.feed('49h\x1b[?1003h\x1b[?1000h')
  assert.equal(more.restore(), '\x1b[?1049h\x1b[?1006h\x1b[?1003h\x1b[?1000h')
  // A reset, full or soft, clears them.
  more.feed('\x1bc')
  assert.equal(more.restore(), '')
  more.feed('\x1b[?2004h\x1b[!p')
  assert.equal(more.restore(), '')
  more.feed('plain words, ESC alone \x1b')
  more.feed('and more')
  assert.equal(more.restore(), '', 'words, and an escape that begins nothing, set nothing')
})

test('what is cut from the start of a long print is not cut inside a sequence', () => {
  const text = 'abc\x1b[?1049hdef\x1b]0;a title\x07ghi\x1bcjk'
  assert.equal(T.safeCut(text, 5), 11, 'a cut inside a mode sequence goes on to its end')
  assert.equal(T.safeCut(text, 3), 3, 'a cut just before one leaves it whole')
  assert.equal(T.safeCut(text, 11), 11, 'a cut just after one is where it is')
  assert.equal(T.safeCut(text, 16), 26, 'a cut inside a window title goes on to its end')
  assert.equal(T.safeCut(text, 30), 31, 'a cut between ESC and the letter of a reset goes on past it')
  assert.equal(T.safeCut('plain words only', 6), 6, 'words are cut where asked')
})

test('a terminal task sends a window that opens late the modes its program set, ahead of the last part of what it printed', () => {
  const pty = { pid: 1, onData: (listen) => { pty.print = listen }, onExit() {}, write() {}, resize() {}, kill() {} }
  const task = new T.TerminalTask('term-fake', 'modes', 'Modes', scratch(), 'Fake', pty, undefined, () => {}, () => {})
  let printedInAll = 0
  const print = (data) => { printedInAll += data.length; pty.print(data) }
  print('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h')
  print('the first screen\r\n')
  assert.equal(task.read().text, '\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004hthe first screen\r\n', 'all of it kept: sent as it was, nothing told twice')
  for (let n = 0; n < 30; n++) print('x'.repeat(20_000) + '\r\n')
  const late = task.read()
  assert.ok(!late.text.includes('the first screen'), 'the start is no longer kept')
  assert.ok(late.text.startsWith('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[?2004h'), 'but what the program set there is told again, first: ' + JSON.stringify(late.text.slice(0, 60)))
  assert.ok(late.text.length <= 512 * 1024 + 64, 'the last 512 KB and the modes')
  assert.equal(late.end, printedInAll, 'where it ends is all it printed, however much is kept')
  // The program leaves the other screen: where the kept part begins it was still on it, and the part kept says it left.
  print('\x1b[?1049l\x1b[?1000l' + 'y'.repeat(20_000) + '\r\n')
  assert.ok(task.read().text.includes('\x1b[?1049l'), 'the leaving is in what is kept')
  // Cut inside a sequence: what is kept does not start with its tail.
  const cutting = { pid: 2, onData: (listen) => { cutting.print = listen }, onExit() {}, write() {}, resize() {}, kill() {} }
  const other = new T.TerminalTask('term-fake', 'cut', 'Cut', scratch(), 'Fake', cutting, undefined, () => {}, () => {})
  cutting.print('\x1b[?1049h' + 'z'.repeat(512 * 1024 - 3))
  const cut = other.read().text
  assert.equal(cut.slice(0, 8), '\x1b[?1049h', 'the mode is told')
  assert.equal(cut.slice(8, 12), 'zzzz', 'and the part kept does not start with the tail of the sequence the cut fell in: ' + JSON.stringify(cut.slice(0, 24)))
})

test('the words of a command started through cmd.exe are taken out with the flag that held them', () => {
  assert.deepEqual(T.withoutTaskWords(['--message', '{task}']), [])
  assert.deepEqual(T.withoutTaskWords(['-p', '{task}', '--verbose']), ['--verbose'])
  assert.deepEqual(T.withoutTaskWords(['--message={task}', '--model', 'x']), ['--model', 'x'])
  assert.deepEqual(T.withoutTaskWords(['--model=x', '{task}']), ['--model=x'], 'a flag with its own value stays')
  assert.deepEqual(T.withoutTaskWords(['run', '{task}']), ['run'], 'a word that is not a flag stays')
  assert.equal(T.windowsArg('plain'), 'plain')
  assert.equal(T.windowsArg(''), '""')
  assert.equal(T.windowsArg('"a b"'), '"\\"a b\\""')
  assert.equal(T.windowsArg('C:\\my files\\'), '"C:\\my files\\\\"')
  assert.equal(T.cleanWords('a\x1b]0;title\x07b\x1b[1;31mc\r\nd\te\x7f'), 'abc\r\nd\te')
})

test('an npm or pnpm shim starts what it names, without cmd.exe, so the words go in its command (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const dir = scratch()
  const { cpSync, mkdirSync, writeFileSync } = await import('node:fs')
  mkdirSync(path.join(dir, 'node_modules', 'fake', 'bin'), { recursive: true })
  cpSync(agent, path.join(dir, 'node_modules', 'fake', 'bin', 'fake.mjs'))
  const npm = path.join(dir, 'fake.cmd')
  writeFileSync(npm, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\bin\\fake.mjs" %*\r\n')
  const pnpm = path.join(dir, 'fake-pnpm.cmd')
  writeFileSync(pnpm, '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\fake\\bin\\fake.mjs" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\fake\\bin\\fake.mjs" %*\r\n)\r\n')
  const other = path.join(dir, 'other.cmd')
  writeFileSync(other, `@ECHO off\r\n"${process.execPath}" "${agent}" %*\r\n`)
  assert.deepEqual((await T.shimTarget(npm)).at(-1), path.join(dir, 'node_modules', 'fake', 'bin', 'fake.mjs'))
  assert.deepEqual((await T.shimTarget(pnpm)).at(-1), path.join(dir, 'node_modules', 'fake', 'bin', 'fake.mjs'))
  assert.equal(await T.shimTarget(other), null, 'any other .cmd is not read for what it starts')
  const startedWith = async (cmd, rest, prompt) => {
    const backend = new T.TerminalBackend({ runner: 'term-fake', name: 'Fake', command: `"${cmd}" ${rest}` })
    const hub = new T.RunnerHub({ backends: [backend], changed() {} })
    try {
      const view = await hub.start({ runner: 'term-fake', folder: scratch(), prompt })
      await until(() => plain(hub.terminalRead(view.key).text).includes('ready>'), 'the agent to start')
      const line = plain(hub.terminalRead(view.key).text).split(/\r?\n/).find((text) => text.startsWith('started with'))
      return { args: JSON.parse(line.slice('started with '.length)), words: view.words }
    } finally {
      await hub.dispose()
    }
  }
  assert.deepEqual(await startedWith(npm, '--message {task}', 'Fix "it" & more'), { args: ['--message', 'Fix "it" & more'], words: undefined }, 'npm: the words are in its command')
  assert.deepEqual(await startedWith(pnpm, '-p {task}', 'Fix it'), { args: ['-p', 'Fix it'], words: undefined }, 'pnpm too')
  assert.deepEqual(await startedWith(other, '-p {task} --verbose', 'Fix it'), { args: ['--verbose'], words: 'Fix it' }, 'any other .cmd: cmd.exe, the words wait, and the flag goes with them')
})

test('what Windows cannot start as a program is refused before a terminal is made for it', { skip: process.platform !== 'win32' }, async () => {
  const backend = new T.TerminalBackend({ runner: 'term-script', name: 'Script', command: `"${agent}" {task}` })
  await assert.rejects(backend.start({ folder: scratch(), prompt: 'x' }), /Script cannot be started: fake-terminal-agent\.mjs is not a program/)
  assert.equal(backend.running, 0)
})

test('an agent whose program is not on this computer is not installed, and says so when started', async () => {
  const backend = new T.TerminalBackend({ runner: 'term-none', name: 'Nowhere', command: 'togle-agent-that-is-not-here {task}' })
  assert.deepEqual(await backend.detect(), { installed: false })
  await assert.rejects(backend.start({ folder: scratch(), prompt: 'x' }), /Nowhere is not on this computer: togle-agent-that-is-not-here was not found/)
})
