import assert from 'node:assert/strict'
import { test } from 'node:test'
const T = await import('./.build/togle.mjs')

// Quote and reply (src/shared/quote.ts): what Chat sends when a part of a message is quoted, and how a message reads back.

test('a quote is one clean line that cannot end early', () => {
  assert.equal(T.cleanQuote('  Two plans\nit is.\t\tAnd  more\r\n'), 'Two plans it is. And more', 'line breaks, tabs and runs of spaces are one space')
  assert.equal(T.cleanQuote('She said “no” and ”yes“'), 'She said "no" and "yes"', 'the curly marks that would close it are straightened')
  assert.equal(T.cleanQuote('red\x1b[31m text\x07 bell \x00nul‮'), 'red text bell nul', 'escape sequences, control characters and direction marks are gone')
  assert.equal(T.cleanQuote(' \n\t '), '', 'nothing selected is nothing quoted')
  assert.equal(T.cleanQuote('a'.repeat(600)).length, T.QUOTE_MOST, 'a long one is cut to its most')
  assert.ok(T.cleanQuote('word '.repeat(200)).endsWith('…'), 'and the cut shows')
  assert.equal(T.cleanQuote('short'), 'short')
})

test('what is sent starts with a word, is one line for one line, and reads back as a quote and a reply', () => {
  const sent = T.withQuote('Two plans it is.', ' Make the second one cheaper. ')
  assert.equal(sent, 'Replying to “Two plans it is.”: Make the second one cheaper.')
  assert.doesNotThrow(() => T.refuseCommand(sent), 'a screen takes it: it does not start as a command of the agent’s own')
  assert.deepEqual(T.splitQuote(sent), { quote: 'Two plans it is.', reply: 'Make the second one cheaper.' })
  // The answer keeps its own lines (a screen makes them one line when it types them).
  assert.deepEqual(T.splitQuote(T.withQuote('x', 'one\ntwo')), { quote: 'x', reply: 'one\ntwo' })
  // A quote that holds the marks of its own, or a line break, still reads back whole.
  assert.deepEqual(T.splitQuote(T.withQuote('He said “stop” and ”go“\nthen left', 'ok')), { quote: 'He said "stop" and "go" then left', reply: 'ok' })
  // The same once a screen has made it one line.
  assert.deepEqual(T.splitQuote(sent.replace(/\n/g, ' ')), { quote: 'Two plans it is.', reply: 'Make the second one cheaper.' })
  // A quote cut short reads back with its cut.
  const cut = T.splitQuote(T.withQuote('word '.repeat(200), 'why?'))
  assert.equal(cut?.reply, 'why?')
  assert.ok(cut?.quote.endsWith('…'))
})

test('a message that is not a quote with a reply is not read as one', () => {
  for (const text of ['Make it cheaper.', 'Replying to the question: yes', 'Replying to “x”', 'Replying to “”: hello', '', '  ']) {
    assert.equal(T.splitQuote(text), null, JSON.stringify(text))
  }
  // Words that only start the same way are a message like any other: it asks for nothing more than it says.
  assert.deepEqual(T.splitQuote('Replying to “a”: b'), { quote: 'a', reply: 'b' })
})
