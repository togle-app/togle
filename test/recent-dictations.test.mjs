// The last dictations the tray offers to copy when typing them failed.
import assert from 'node:assert/strict'
import { test } from 'node:test'
const { RECENT_DICTATIONS, recentLabel, withRecent } = await import('./.build/togle.mjs')

test('the newest dictation comes first, once, and only the last ten are kept', () => {
  let list = []
  list = withRecent(list, 'First.')
  list = withRecent(list, 'Second.')
  assert.deepEqual(list, ['Second.', 'First.'])
  list = withRecent(list, 'First.')
  assert.deepEqual(list, ['First.', 'Second.'], 'said again, it moves to the top and is not there twice')
  assert.deepEqual(withRecent(list, '   '), list, 'nothing said is not a dictation')
  assert.deepEqual(withRecent(list, undefined), list)
  for (let n = 0; n < 15; n++) list = withRecent(list, 'Note ' + n)
  assert.equal(list.length, RECENT_DICTATIONS)
  assert.equal(list[0], 'Note 14')
  assert.equal(list.at(-1), 'Note 5')
})

test('a dictation shows in the menu on one line, cut short', () => {
  assert.equal(recentLabel('Send it\nto Marta   by Friday.'), 'Send it to Marta by Friday.')
  const long = 'x'.repeat(100)
  assert.equal(recentLabel(long), 'x'.repeat(47) + '…')
})
