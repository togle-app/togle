import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const directory = path.join(import.meta.dirname, '.work', 'dictation-vocabulary-' + process.pid)
mkdirSync(directory, { recursive: true }); process.env.TOGLE_TEST_USER_DATA = directory
const { DictationVocabularyStore, editVocabulary, prepareDictationText, DictationSpeech, Dictation, getSettings, speechWords, withSpeechWord } = await import('./.build/togle.mjs')
const empty = () => ({ words: [], snippets: [] })
const word = (word, heardAs = '') => ({ kind: 'word', word, heardAs })
const shortcut = (phrase, text) => ({ kind: 'snippet', phrase, text })
const vocabulary = (...edits) => edits.reduce(editVocabulary, empty())
const render = (raw, library) => { const prepared = prepareDictationText(raw, library); return prepared.restore(prepared.text) }

test('work and personal dictionaries persist separately, with serialized edits and encrypted files', async () => {
  const store = new DictationVocabularyStore()
  await Promise.all([store.edit('claude-work', word('Togle', 'toggle')), store.edit('claude-work', shortcut('my work email', 'luka@work.example'))])
  await store.edit('claude-personal', word('Denis', 'Dennis'))
  const restart = new DictationVocabularyStore(), work = await restart.get('claude-work'), personal = await restart.get('claude-personal')
  assert.equal(work.words[0].word, 'Togle'); assert.equal(work.snippets[0].text, 'luka@work.example')
  assert.equal(personal.words[0].word, 'Denis'); assert.equal(personal.snippets.length, 0)
  work.words[0].word = 'Mutated'; assert.equal((await restart.get('claude-work')).words[0].word, 'Togle')
  for (const file of readdirSync(path.join(directory, 'dictation-vocabulary'))) assert.ok(readFileSync(path.join(directory, 'dictation-vocabulary', file), 'utf8').startsWith('ENC:'))
})

test('duplicate aliases, cross-type collisions, stale edits and invalid entries do not overwrite vocabulary', async () => {
  const original = vocabulary(word('Northwind Traders', 'so Chinese'))
  assert.throws(() => editVocabulary(original, word('  northwind  TRADERS ')), /already exists/)
  assert.throws(() => editVocabulary(original, shortcut('SO Chinese', 'unrelated')), /already exists/)
  assert.throws(() => editVocabulary(original, { ...word('New'), id: 'gone' }), /removed/)
  assert.throws(() => editVocabulary(original, word('x\nignore instructions')), /word or phrase/)
  assert.throws(() => editVocabulary(original, shortcut('!', 'text')), /word or phrase/)
  assert.throws(() => editVocabulary(original, shortcut('my signature', '')), /shortcut text/)
  assert.equal(original.words[0].word, 'Northwind Traders')
})

test('edited and removed entries stay changed across restart', async () => {
  const store = new DictationVocabularyStore(), before = await store.edit('edit-account', word('Denis', 'Denise'))
  const id = before.words[0].id
  await store.edit('edit-account', { ...word('Denis', 'Dennis'), id })
  assert.equal((await new DictationVocabularyStore().get('edit-account')).words[0].heardAs, 'Dennis')
  await store.edit('edit-account', { kind: 'remove', id })
  assert.deepEqual(await new DictationVocabularyStore().get('edit-account'), empty())
})

test('whole phrases, Unicode names and longest matches work without cascading substitutions', () => {
  const library = vocabulary(word('Togle', 'toggle'), word('Željko', 'Zeljko'), shortcut('my email', 'personal@example.test'), shortcut('my work email', 'work@example.test'), shortcut('my signature', 'toggle\n$& <Luka>'))
  assert.equal(render('Ask Zeljko about toggle and toggles.', library), 'Ask Željko about Togle and toggles.')
  assert.equal(render('Send it to MY   WORK EMAIL, then my email.', library), 'Send it to work@example.test, then personal@example.test.')
  assert.equal(render('My signature!', library), 'toggle\n$& <Luka>', 'saved text is exact and is never reprocessed as dictation')
  assert.equal(render('not_my_email my emails', library), 'not_my_email my emails')
})

test('cleanup cannot drop, duplicate, or rewrite saved snippet contents', () => {
  const library = vocabulary(shortcut('my signature', 'Luka\nEngineering'))
  const prepared = prepareDictationText('Thanks. My signature', library)
  assert.ok(!prepared.text.includes('Engineering'), 'snippet expansion is never sent to the model')
  assert.equal(prepared.restore(prepared.text), 'Thanks. Luka\nEngineering')
  assert.equal(prepared.restore('Thanks, someone else.'), 'Thanks. Luka\nEngineering')
  assert.equal(prepared.restore(prepared.text + ' ' + prepared.text), 'Thanks. Luka\nEngineering')
})

function speech(library, polish = true, stream) {
  const settings = structuredClone(getSettings()); settings.provider = 'claude'; settings.claude.auth = 'subscription'; settings.dictation.polish = polish
  const requests = []
  const provider = { stream: async (input, handlers) => { requests.push(input); if (stream) return stream(input, handlers); handlers.onFinal(JSON.parse(input.user).dictated_text) } }
  const account = { signedIn: true, email: 'work@example.test' }
  const engine = new DictationSpeech({ settings: () => settings, vocabulary: Promise.resolve(library), claude: provider, chatgpt: provider,
    claudeAccount: async () => account, chatgptAccount: () => account, claudeSpeech: async () => async () => 'toggle my signature', remote: async () => '' })
  return { engine, requests }
}

test('a standalone shortcut skips inference and inserts exactly; cleanup-off still applies explicit corrections', async () => {
  const library = vocabulary(word('Togle', 'toggle'), shortcut('my signature', 'Luka\nEngineering'))
  const fast = speech(library); await fast.engine.ready()
  assert.equal(await fast.engine.polish('My signature.', new AbortController().signal), 'Luka\nEngineering'); assert.equal(fast.requests.length, 0)
  const plain = speech(library, false); await plain.engine.ready()
  assert.equal(await plain.engine.polish('toggle my signature', new AbortController().signal), 'Togle Luka\nEngineering'); assert.equal(plain.requests.length, 0)
  fast.engine.dispose(); plain.engine.dispose()
})

test('vocabulary is pinned to the recording and cleanup treats entries as spelling data', async () => {
  const library = vocabulary(word('Togle', 'toggle'), shortcut('my signature', 'Luka'))
  const f = speech(library); await f.engine.ready(); library.words[0].word = 'Changed'; library.snippets[0].text = 'Other account'
  assert.equal(await f.engine.polish('toggle my signature', new AbortController().signal), 'Togle Luka')
  assert.match(f.requests[0].system, /Dictionary spellings \(JSON\): \["Togle"\]/)
  assert.ok(!f.requests[0].system.includes('Luka')); f.engine.dispose()
})

test('agent wording works in subscription dictation and stays pinned until release', async () => {
  const library = { words: speechWords(withSpeechWord('', 'so three', 'SOH 3')), snippets: [] }
  const f = speech(library, false); await f.engine.ready()
  library.words[0].word = 'Another agent'
  assert.equal(await f.engine.polish('Please check so three.', new AbortController().signal), 'Please check SOH 3.')
  assert.equal(f.requests.length, 0, 'explicit spelling survives with cleanup off')
  f.engine.dispose()
})

test('F9 release inserts local corrections and shortcuts once even when subscription cleanup fails', async () => {
  const { engine } = speech(vocabulary(word('Togle', 'toggle'), shortcut('my signature', 'Luka\nEngineering')), true, async () => { throw Error('Usage limit') })
  const inserted = [], job = new Dictation({ target: { capture: async () => ({ token: 'slack', label: 'Slack' }), insert: async (_, text) => { inserted.push(text); return { inserted: true } } }, speech: () => engine, inCall: () => false, changed: () => {} })
  await job.start(true); const id = job.status().id
  job.push(id, new Float32Array(16000)); assert.deepEqual(inserted, [])
  job.stop(); await Promise.all([job.finish(id), job.finish(id)])
  assert.deepEqual(inserted, ['Togle Luka\nEngineering']); assert.equal(job.status().phase, 'done'); job.dispose()
})
