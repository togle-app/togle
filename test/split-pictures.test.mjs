// A picture pasted into a reply goes with the words as the path of the file it was kept in; Chat finds those paths to draw the pictures
// and not the paths (shared/pasted-pictures.ts).
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { splitPictures, withFilePaths } = await import('./.build/togle.mjs')
const win = 'C:\\Users\\someone\\AppData\\Roaming\\Togle\\pasted\\paste-20261118-120000.png'
const shot = 'C:\\Users\\Some One\\AppData\\Roaming\\togle\\pictures\\show-2026-11-20T13-46-03-372Z.png'

test('F8 pictures already in chat are displayed as attachments alongside their spoken words', () => {
  const unix = '/home/me/.config/togle/pictures/show-2026-11-20T13-46-03-372Z.png'
  assert.deepEqual(splitPictures('"' + shot + '" Look at the header.'), { words: 'Look at the header.', files: [shot] })
  assert.deepEqual(splitPictures('Picture: ' + unix), { words: '', files: [unix] })
  const mac = "/Users/O'Brien/Library/Application Support/togle/pictures/" + unix.split('/').at(-1)
  assert.deepEqual(splitPictures("'" + mac.replaceAll("'", "'\\''") + "' Look here."), { words: 'Look here.', files: [mac] })
  const apostrophe = shot.replace('Some One', "O'Brien")
  assert.deepEqual(splitPictures('Attached ' + apostrophe), { words: 'Attached', files: [apostrophe] })
  assert.deepEqual(splitPictures(withFilePaths('Review both', [shot, win])), { words: 'Review both', files: [shot, win] })
  for (const text of [unix + '.log', 'https://example.com' + unix, '/tmp/pictures/show-notes.png']) assert.deepEqual(splitPictures(text), { words: text, files: [] })
})

test('arbitrary disk attachments round trip without changing words, spaces or punctuation in a filename', () => {
  const words = 'Check  these files.\n\nAttached files\nwas the heading.'
  const files = ['C:\\Sound Recordings\\Recording.m4a', '/home/me/logs/weird "file".log', '/tmp/video.mp4', '/tmp/frame.png']
  assert.deepEqual(splitPictures(withFilePaths(words, files)), { words, files })
  assert.deepEqual(splitPictures(withFilePaths('', files)), { words: '', files })
  assert.deepEqual(splitPictures('Attached files\nnot a file'), { words: 'Attached files\nnot a file', files: [] })
})

test('file attachments survive Windows line endings and a trailing newline in an agent transcript', () => {
  const words = 'First paragraph.\r\n\r\nPlease check  this.'
  const files = ['C:\\release tools\\togle-release.pub', '\\\\server\\files\\notes.log']
  for (const newline of ['\r\n', '\n']) {
    const block = ['Attached files', ...files, '', ''].join(newline)
    assert.deepEqual(splitPictures(words + newline + newline + block), { words, files })
    assert.deepEqual(splitPictures(block), { words: '', files })
  }
  for (const text of ['Attached files\r\n', 'Attached files\r\nrelative.pub\r\n', 'Attached files\r\n/tmp/a\r\n\r\n/tmp/b']) {
    assert.deepEqual(splitPictures(text), { words: text, files: [] })
  }
})

test('one-line terminal attachment lists preserve paths and ignore ordinary text', () => {
  const files = ['C:\\release tools\\togle-release.pub', '/tmp/a "quoted" name.log']
  const list = 'Attached files: ' + JSON.stringify(files)
  assert.deepEqual(splitPictures('Check  this ' + list), { words: 'Check  this', files })
  assert.deepEqual(splitPictures(list), { words: '', files })
  for (const text of ['Attached files: ["/tmp/x"] in the example', 'Attached files: ["relative"]', 'Attached files: ["/tmp/a",7]', 'Attached files: ["unfinished']) {
    assert.deepEqual(splitPictures(text), { words: text, files: [] })
  }
})

test('words with a picture after them are the words, and the picture is its file', () => {
  const formatted = 'Check  this:\n\n- First\n  - Nested\n\n    indented  code'
  assert.deepEqual(splitPictures(formatted + ' ' + win), { words: formatted, files: [win] })
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
