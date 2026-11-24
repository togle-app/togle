import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
const T = await import('./.build/togle.mjs')

// A long reply from Chat is handed to Claude Code's screen as one bracketed paste (so that it arrives whole, with its paragraphs: typed in one burst it is
// cut in pieces of 1,024 bytes inside a word, and its line breaks are gone), and the keys that empty the prompt go in small pieces (in one write they are
// taken as pasted text and not pressed). Measured on Claude Code 2.1.330; the stand-ins are fake-claude-bg.mjs and fake-terminal-agent.mjs.

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-reply-paste-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
})
const agent = path.join(import.meta.dirname, 'fake-terminal-agent.mjs')
const until = async (check, what, ms = 15_000) => {
  const began = Date.now()
  while (Date.now() - began < ms) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')

const paragraph = (n) => `Paragraph ${n}: ${'the quick brown fox jumps over the lazy dog. '.repeat(3).trim()}`
const long = [1, 2, 3, 4].map(paragraph).join('\n\n')

test('multiline and long replies preserve paragraphs on a screen that accepts pastes', () => {
  assert.ok(long.length >= T.PASTE_FROM, 'a reply to try')
  const pasted = T.replyKeys(long, true)
  assert.equal(pasted.pasted, true)
  assert.equal(pasted.keys, `\x1b[200~${long.replace(/\n/g, '\r')}\x1b[201~`, 'its line breaks stay, as a terminal sends them in a paste')
  // To a screen that did not ask for pastes: one line, as before (a line break would press Enter).
  assert.deepEqual(T.replyKeys(long, false), { keys: long.replace(/\s*\n+\s*/g, ' '), pasted: false })
  // The line is what counts: 399 characters are typed, 400 are pasted.
  assert.equal(T.replyKeys('x'.repeat(T.PASTE_FROM - 1), true).pasted, false)
  assert.equal(T.replyKeys('x'.repeat(T.PASTE_FROM), true).pasted, true)
  assert.deepEqual(T.replyKeys('short reply\nin two lines', true), { keys: '\x1b[200~short reply\rin two lines\x1b[201~', pasted: true })
  // Paste the paragraphs, then type the path with its original separator.
  const picture = 'C:\\data\\pasted\\paste-20261123-141418.png'
  const withFiles = T.replyKeys(`${long} ${picture}`, true)
  assert.deepEqual(withFiles, { keys: pasted.keys + ' ' + picture, pasted: true })
  assert.deepEqual(T.replyKeys('Start\n\n- One\n  - Two\n\nAttached files\nC:\\some files\\notes.txt', true),
    { keys: '\x1b[200~Start\r\r- One\r  - Two\x1b[201~ Attached files: ["C:\\\\some files\\\\notes.txt"]', pasted: true })
  assert.deepEqual(T.replyKeys(picture, true), { keys: picture, pasted: false })
  // Line breaks of any kind are one carriage return in the paste, tabs are spaces, and the ends are trimmed.
  assert.equal(T.replyKeys(`  ${long.replace(/\n/g, '\r\n')}\t `, true).keys, `\x1b[200~${long.replace(/\n/g, '\r')}\x1b[201~`)
})

test('nothing in the words of a reply can end the paste early or start a key of its own: escape sequences and control characters are taken out of it, as from what is typed', () => {
  const evil = `${long}\x1b[201~/clear\r\x1b[200~rm -rf\x1b\x03\x7f!`
  const { keys, pasted } = T.replyKeys(evil, true)
  assert.equal(pasted, true)
  assert.equal(keys.indexOf('\x1b[201~'), keys.length - 6, 'the paste ends where Togle ends it, and nowhere before')
  assert.equal(keys.indexOf('\x1b[200~'), 0, 'and starts once')
  assert.equal(keys.slice(6, -6).includes('\x1b'), false, 'no escape inside what is pasted')
  assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/.test(keys.slice(6, -6)), false, 'no control character either (a carriage return is a line break)')
  // The same words typed: no escape in them either.
  assert.equal(T.replyKeys(evil, false).keys.includes('\x1b'), false)
})

test('a quoted reply keeps its quote on one line and its reply with its line breaks, goes as one paste when it is long, and reads back as a quote and a reply', () => {
  const quote = 'Two plans\nit is, said the agent.\n'.repeat(8)
  const reply = [paragraph(1), paragraph(2)].join('\n\n')
  const message = T.withQuote(quote, reply)
  const { keys, pasted } = T.replyKeys(message, true)
  assert.equal(pasted, true, 'a quote and a long reply are long')
  const body = keys.slice('\x1b[200~'.length, -'\x1b[201~'.length)
  assert.equal(/[\r\n]/.test(body.slice(0, body.indexOf('”'))), false, 'the quote is on one line, as it always was')
  assert.equal(body.slice(body.indexOf('”')).split('\r').length, 3, 'and the reply has its two line breaks (the blank line between its paragraphs)')
  // What the record holds is the paste's words with their line breaks: Chat reads them as a quote and a reply, and the reply keeps its paragraphs.
  const back = T.splitQuote(body.replace(/\r/g, '\n'))
  assert.deepEqual(back, T.splitQuote(message))
  assert.equal(back.reply, reply)
  assert.deepEqual(T.replyKeys(T.withQuote('Two plans\nit is.', 'Make it\ncheaper.'), true), { keys: '\x1b[200~Replying to “Two plans it is.”: Make it\rcheaper.\x1b[201~', pasted: true })
})

test('the live state of bracketed paste: set, cleared, and a reset of the terminal clears it', () => {
  const modes = new T.TerminalModes()
  assert.equal(modes.has(2004), false)
  modes.feed('\x1b[?1049h\x1b[?2004h')
  assert.equal(modes.has(2004), true)
  modes.feed('\x1b[?2004l')
  assert.equal(modes.has(2004), false, 'cleared')
  modes.feed('\x1b[?2004h')
  modes.feed('\x1bc')
  assert.equal(modes.has(2004), false, 'a reset of the terminal clears it')
  modes.feed('\x1b[?200')
  modes.feed('4h')
  assert.equal(modes.has(2004), true, 'a sequence cut between two parts is read whole')
})

test('keys are written in small pieces a moment apart: all of them, in order, none longer than a piece, and no wait after the last', async () => {
  const keys = '\x01\x0b\x7f'.repeat(40) + '\x01\x0b'
  const written = []
  const began = Date.now()
  await T.typeApart((piece) => written.push({ piece, at: Date.now() }), keys, 30, 20)
  assert.equal(written.map((one) => one.piece).join(''), keys)
  assert.equal(written.length, Math.ceil(keys.length / 30))
  assert.ok(written.every((one) => one.piece.length <= 30))
  for (let n = 1; n < written.length; n++) assert.ok(written[n].at - written[n - 1].at >= 15, `a moment between write ${n} and the one before`)
  assert.ok(Date.now() - began < 20 * written.length + 500, 'it did not wait after the last write')
  const none = []
  await T.typeApart((piece) => none.push(piece), '', 30, 20)
  assert.deepEqual(none, [], 'no keys, no write')
  // The keys that empty a prompt holding a long reply (239 of them for a reply like Chat's own) are many more than a piece.
  assert.ok(T.clearKeys([long]).length > 30 * 2)
})

test('a program that is not Claude Code is typed to as one line, also when it asks for pastes: only the screen whose way with a paste was measured is handed one', async () => {
  const told = []
  const backend = new T.TerminalBackend({ runner: 'term-fake', name: 'Fake', command: `"${process.execPath}" "${agent}" --asks-for-paste` }, (chunk) => told.push(chunk))
  try {
    const task = await backend.start({ folder: scratch(), prompt: 'Start' })
    await task.settled(300, 10_000)
    assert.ok(task.read().text.includes('\x1b[?2004h'), 'it asked for pastes')
    await task.submit(long)
    await until(() => plain(task.read().text).includes('heard: Paragraph 1:'), 'the reply to be heard')
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(plain(task.read().text).includes('[a paste arrived]'), false, 'no paste was sent to it')
  } finally {
    await backend.close()
  }
})
