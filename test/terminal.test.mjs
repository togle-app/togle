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
    const sent = told.filter((chunk) => chunk.key === view.key)
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

test('an agent whose program is not on this computer is not installed, and says so when started', async () => {
  const backend = new T.TerminalBackend({ runner: 'term-none', name: 'Nowhere', command: 'togle-agent-that-is-not-here {task}' })
  assert.deepEqual(await backend.detect(), { installed: false })
  await assert.rejects(backend.start({ folder: scratch(), prompt: 'x' }), /Nowhere is not on this computer: togle-agent-that-is-not-here was not found/)
})
