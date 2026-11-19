// A picture pasted into a reply goes with the words as the path of the file it was kept in; Chat finds those paths to draw the pictures
// and not the paths (shared/pasted-pictures.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { splitPictures } = await import('./.build/togle.mjs')
const win = 'C:\\Users\\someone\\AppData\\Roaming\\Togle\\pasted\\paste-20261118-120000.png'

test('words with a picture after them are the words, and the picture is its file', () => {
  assert.deepEqual(splitPictures('Why is this cut? ' + win), { words: 'Why is this cut?', files: [win] })
  assert.deepEqual(splitPictures('Look at ' + win + ' and then ' + win.replace('120000', '120001') + ' please'), { words: 'Look at and then please', files: [win, win.replace('120000', '120001')] })
})

test('a path with a space in it is in quotes, and is found with the quotes', () => {
  const spaced = 'C:\\Users\\Some One\\AppData\\Roaming\\Togle\\pasted\\paste-20261118-120000.png'
  assert.deepEqual(splitPictures('Here: "' + spaced + '"'), { words: 'Here:', files: [spaced] })
})

test('pictures sent alone have the word Togle put before them, and it goes with them', () => {
  assert.deepEqual(splitPictures('Picture: ' + win), { words: '', files: [win] })
  assert.deepEqual(splitPictures('Pictures: ' + win + ' ' + win.replace('120000', '120001')), { words: '', files: [win, win.replace('120000', '120001')] })
  assert.deepEqual(splitPictures('Picture: what is this ' + win).words, 'Picture: what is this', 'a person who wrote that word wrote it')
})

test('paths of other kinds are not pictures, and what has none is returned as it is', () => {
  assert.deepEqual(splitPictures('Edit C:\\work\\pasted\\notes.txt and /home/me/pasted/paste-x.txt'), { words: 'Edit C:\\work\\pasted\\notes.txt and /home/me/pasted/paste-x.txt', files: [] })
  const text = 'a  b\n\nc'
  assert.equal(splitPictures(text).words, text, 'its spaces and lines are not touched when there is no picture')
  assert.deepEqual(splitPictures('/home/me/.config/togle/pasted/paste-20261118-120000.jpg'), { words: '', files: ['/home/me/.config/togle/pasted/paste-20261118-120000.jpg'] })
})
