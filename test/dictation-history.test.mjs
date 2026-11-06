import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
const directory = path.join(import.meta.dirname, '.work', 'dictation-history-' + process.pid)
mkdirSync(directory, { recursive: true }); process.env.TOGLE_TEST_USER_DATA = directory
const { DictationHistoryStore, Dictation, spellingCorrection } = await import('./.build/togle.mjs')
const receipt = (id = 'one', at = Date.now()) => ({ id, revision: 'original-' + id, startedAt: at - 3000, finishedAt: at, originalText: 'um send toggle tomorrow', text: 'Send toggle tomorrow.', destination: 'Slack', outcome: 'inserted' })
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('history is off by default and never writes text before opt-in', async () => {
  const store = new DictationHistoryStore()
  assert.deepEqual(await store.get('default'), { enabled: false, entries: [] })
  await store.record(await store.begin('default'), receipt())
  assert.equal(existsSync(path.join(directory, 'dictation-history')), false)
})

test('opted-in history is encrypted, separated by account and survives restart with original words', async () => {
  const store = new DictationHistoryStore(); await store.configure('work', true)
  await store.record(await store.begin('work'), receipt())
  const restarted = new DictationHistoryStore(), work = await restarted.get('work')
  assert.equal(work.entries[0].originalText, 'um send toggle tomorrow'); assert.equal(work.entries[0].outcome, 'inserted')
  assert.deepEqual(await restarted.get('personal'), { enabled: false, entries: [] })
  for (const file of readdirSync(path.join(directory, 'dictation-history'))) assert.ok(readFileSync(path.join(directory, 'dictation-history', file), 'utf8').startsWith('ENC:'))
  work.entries[0].text = 'Mutated'; assert.equal((await restarted.get('work')).entries[0].text, 'Send toggle tomorrow.')
})

test('turning history off and on again invalidates recordings that began before the change', async () => {
  const store = new DictationHistoryStore(); await store.configure('off-on', true)
  const ticket = await store.begin('off-on')
  await store.configure('off-on', false); await store.configure('off-on', true)
  await store.record(ticket, receipt('late'))
  assert.equal((await store.get('off-on')).entries.length, 0)
})

test('clear wins over an in-flight recording and duplicated completions do not duplicate history', async () => {
  const store = new DictationHistoryStore(); await store.configure('clear', true)
  const ticket = await store.begin('clear')
  await store.record(ticket, receipt('before')); await store.record(ticket, receipt('before'))
  assert.equal((await store.get('clear')).entries.length, 1)
  await store.remove('clear'); await store.record(ticket, receipt('after-clear'))
  assert.equal((await store.get('clear')).entries.length, 0)
})

test('retention keeps the latest fifty entries and purges expired text from disk', async () => {
  let now = Date.now()
  const store = new DictationHistoryStore(() => {}, () => now); await store.configure('retention', true)
  const ticket = await store.begin('retention')
  for (let n = 0; n < 55; n++) await store.record(ticket, receipt('entry-' + n, now + n))
  const current = await store.get('retention')
  assert.equal(current.entries.length, 50); assert.equal(current.entries[0].id, 'entry-54'); assert.equal(current.entries.at(-1).id, 'entry-5')
  now += 8 * 24 * 60 * 60 * 1000
  assert.deepEqual((await store.get('retention')).entries, [])
  assert.deepEqual((await new DictationHistoryStore(() => {}, () => now).get('retention')).entries, [])
})

test('history corrections preserve original speech, reject stale edits and cannot restore deleted text', async () => {
  const store = new DictationHistoryStore(); await store.configure('correct', true)
  await store.record(await store.begin('correct'), receipt())
  const corrected = await store.correct('correct', 'one', 'original-one', 'Send Togle tomorrow.')
  assert.equal(corrected.corrected, true); assert.equal(corrected.originalText, 'um send toggle tomorrow')
  await assert.rejects(store.correct('correct', 'one', 'original-one', 'Stale text'), /changed/)
  await store.remove('correct', 'one')
  await assert.rejects(store.correct('correct', 'one', corrected.revision, 'Deleted text'), /no longer/)
})

test('a failed encrypted save keeps the last saved text and can be retried', async () => {
  const store = new DictationHistoryStore(); await store.configure('failed-write', true)
  await store.record(await store.begin('failed-write'), receipt())
  const storage = globalThis.__togleTestElectron.safeStorage, previous = storage.encryptString
  storage.encryptString = () => { throw Error('Disk unavailable') }
  try { await assert.rejects(store.correct('failed-write', 'one', 'original-one', 'Unsaved replacement'), /Disk unavailable/) }
  finally { storage.encryptString = previous }
  assert.equal((await store.get('failed-write')).entries[0].text, 'Send toggle tomorrow.')
  await store.correct('failed-write', 'one', 'original-one', 'Retry succeeds.')
  assert.equal((await store.get('failed-write')).entries[0].text, 'Retry succeeds.')
})

test('short spelling changes can be learned explicitly; punctuation and full rewrites cannot', () => {
  assert.deepEqual(spellingCorrection('Send toggle tomorrow.', 'Send Togle tomorrow.'), { heardAs: 'toggle', word: 'Togle' })
  assert.deepEqual(spellingCorrection('Ask Zeljko.', 'Ask Željko.'), { heardAs: 'Zeljko', word: 'Željko' })
  assert.deepEqual(spellingCorrection('Ask Dennis Smith.', 'Ask Denis Smith.'), { heardAs: 'Dennis', word: 'Denis' })
  assert.equal(spellingCorrection('Ready.', 'Ready!'), undefined)
  assert.equal(spellingCorrection('Please rewrite this whole sentence.', 'Send the document later instead.'), undefined)
})

test('history recording never delays F9 insertion and receipts reflect the actual insertion result', async () => {
  const receipts = [], inserted = [], saving = deferred()
  const job = new Dictation({ speech: () => ({ ready: async () => {}, transcribe: async () => 'raw words', polish: async () => 'Clean words.' }), target: { capture: async () => ({ token: 'slack', label: 'Slack' }), insert: async (_, text) => { inserted.push(text); return { inserted: true } } }, inCall: () => false, changed: () => {}, completed: value => { receipts.push(value); void saving.promise } })
  await job.start(true); const id = job.status().id; job.push(id, new Float32Array(16000)); job.stop()
  await Promise.all([job.finish(id), job.finish(id)])
  assert.deepEqual(inserted, ['Clean words.']); assert.equal(job.status().phase, 'done'); assert.equal(receipts.length, 1)
  assert.equal(receipts[0].originalText, 'raw words'); assert.equal(receipts[0].outcome, 'inserted')
  saving.resolve(); job.dispose()
})

test('cancelled recognition never records an entry or inserts a late result', async () => {
  const recognized = deferred(), receipts = [], inserted = []
  const job = new Dictation({ speech: () => ({ ready: async () => {}, transcribe: () => recognized.promise, polish: async text => text }), target: { capture: async () => ({ token: 'slack', label: 'Slack' }), insert: async (_, text) => { inserted.push(text); return { inserted: true } } }, inCall: () => false, changed: () => {}, completed: value => receipts.push(value) })
  await job.start(); const id = job.status().id; job.push(id, new Float32Array(16000)); job.stop(); const finishing = job.finish(id)
  await tick(); job.cancel(); recognized.resolve('Cancelled private words.'); await finishing
  assert.deepEqual(receipts, []); assert.deepEqual(inserted, [])
})

test('shutdown flush drains a completion queued behind the recording’s initial history read', async () => {
  const store = new DictationHistoryStore(); await store.configure('flush', true)
  const pending = store.begin('flush').then(ticket => store.record(ticket, receipt()))
  await store.flush(); await pending
  assert.equal((await new DictationHistoryStore().get('flush')).entries.length, 1)
})
