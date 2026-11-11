import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

const work = workDir('shared-speech')
const { cleanTranscript, mergedVoiceAccount, migrateVoicePreferences, automaticVoiceAccount, voiceAccountId, effectiveSettings, validatePreferences, voiceAccountsToMigrate, voiceAccountsMigrated, inTimeOrder, needsReply, getSettings, updateSettings, loadSettings } = await import('./.build/togle.mjs')
const second = new Float32Array(16000)

test('live assistance recognizes Chinese and Arabic question marks', () => {
  assert.equal(needsReply('这个功能什么时候发布？'), true)
  assert.equal(needsReply('متى يبدأ الاجتماع؟'), true)
  assert.equal(needsReply('Kada počinje sastanak?'), true)
})

test('mixed-language transcripts keep Chinese, Arabic, Japanese, Cyrillic and accented words even with an English hint', () => {
  for (const language of ['en', 'auto', 'de']) for (const dictation of [false, true]) {
    const text = 'Please check 中文，明天见。 Guten Morgen, André! 日本語です。 Привет. مرحباً بالعالم.'
    assert.equal(cleanTranscript(text, 6, language, dictation), text)
  }
})

test('voice typing has one account: the one it used when it had two (its own over the shared speech account)', () => {
  assert.equal(mergedVoiceAccount('personal', 'work'), 'personal', 'its own choice wins, as it did')
  assert.equal(mergedVoiceAccount('', 'work'), 'work', 'without one it used the speech account')
  assert.equal(mergedVoiceAccount('', ''), '', 'neither: it stays automatic')
  assert.equal(mergedVoiceAccount(undefined, undefined), '')
})

test('upgrading settings moves the speech account into voice typing once, and the old setting leaves the file', async () => {
  const file = path.join(work, 'settings.json')
  for (const [saved, expected] of [
    [{ transcription: { accountId: 'work', language: 'de' }, dictation: { accountId: '' } }, 'work'],
    [{ transcription: { accountId: 'work' }, dictation: { accountId: 'personal' } }, 'personal'],
    [{ transcription: { accountId: 'claude-default' } }, 'claude-default'],
    [{ transcription: { accountId: '' }, dictation: { accountId: '' } }, '']
  ]) {
    writeFileSync(file, JSON.stringify(saved))
    await loadSettings()
    assert.equal(getSettings().dictation.accountId, expected, JSON.stringify(saved))
    assert.equal('accountId' in getSettings().transcription, false, 'calls have no account')
    assert.deepEqual(voiceAccountsToMigrate(), { voice: saved.dictation?.accountId ?? '', speech: saved.transcription.accountId })
    if (saved.transcription.language) assert.equal(getSettings().transcription.language, 'de', 'the rest of speech is kept')
    await voiceAccountsMigrated()
    assert.equal(voiceAccountsToMigrate(), undefined)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(written.transcription.accountId, undefined)
    assert.equal(written.dictation.accountId, expected)
    await loadSettings()
    assert.equal(voiceAccountsToMigrate(), undefined, 'carried over once')
    assert.equal(getSettings().dictation.accountId, expected)
  }
  // From before the shared speech account, and new: nothing to carry over; voice typing keeps what it has.
  writeFileSync(file, JSON.stringify({ dictation: { accountId: 'personal' } }))
  await loadSettings()
  assert.equal(voiceAccountsToMigrate(), undefined)
  assert.equal(getSettings().dictation.accountId, 'personal')
  rmSync(file, { force: true })
  await loadSettings()
  assert.equal(voiceAccountsToMigrate(), undefined)
  assert.equal(getSettings().dictation.accountId, '', 'a new Togle types with the AI account, automatically')
  // A change naming the old speech account can't bring it back.
  await updateSettings({ transcription: { accountId: 'work', language: 'auto' } })
  assert.equal('accountId' in getSettings().transcription, false)
  assert.equal(getSettings().dictation.accountId, '')
  assert.equal(existsSync(file), true)
})

test("every agent's voice typing account stays the one it used, its own choice stays its own, and inherited ones still follow", () => {
  // What voice typing used before: the agent's own voice account (or the app's), else its speech account (or the app's).
  const before = (app, preferences) => (preferences?.dictation && 'accountId' in preferences.dictation ? preferences.dictation.accountId : app.voice)
    || (preferences?.transcription && 'accountId' in preferences.transcription ? preferences.transcription.accountId : app.speech) || 'AUTOMATIC'
  const after = (app, preferences) => (preferences?.dictation && 'accountId' in preferences.dictation ? preferences.dictation.accountId : mergedVoiceAccount(app.voice, app.speech)) || 'AUTOMATIC'
  const choices = [undefined, '', 'agent-account', 'app-voice', 'app-speech']
  let cases = 0
  for (const appVoice of ['', 'app-voice']) for (const appSpeech of ['', 'app-speech']) for (const voice of choices) for (const speech of choices) {
    const app = { voice: appVoice, speech: appSpeech }
    const preferences = {
      ...(voice === undefined ? {} : { dictation: { accountId: voice, polish: false } }),
      ...(speech === undefined ? {} : { transcription: { accountId: speech, language: 'de' } })
    }
    const migrated = migrateVoicePreferences(preferences, app)
    const result = migrated ?? preferences
    const label = JSON.stringify({ app, preferences })
    assert.equal(after(app, result), before(app, preferences), label)
    assert.equal(!!result.transcription && 'accountId' in result.transcription, false, label)
    if (speech !== undefined) assert.equal(result.transcription.language, 'de', 'the rest of its speech preferences stay: ' + label)
    if (voice !== undefined) assert.equal(result.dictation.polish, false, 'the rest of its voice typing preferences stay: ' + label)
    if (voice) assert.equal(result.dictation.accountId, voice, 'its own pick stays its own: ' + label)
    // Valid as preferences are saved now.
    assert.deepEqual(validatePreferences(result), result, label)
    cases++
  }
  assert.equal(cases, 100)
  assert.equal(migrateVoicePreferences(undefined, { voice: '', speech: 'x' }), undefined)
  assert.equal(migrateVoicePreferences({ dictation: { polish: true } }, { voice: '', speech: 'x' }), undefined, 'nothing about accounts: unchanged')
  // An agent that only had the old speech account (as its own speech settings): its speech settings stay, without it.
  assert.deepEqual(migrateVoicePreferences({ transcription: { accountId: 'app-speech', language: 'de' } }, { voice: '', speech: 'app-speech' }), { transcription: { language: 'de' } })
  assert.deepEqual(migrateVoicePreferences({ transcription: { accountId: 'work' } }, { voice: '', speech: 'personal' }), { dictation: { accountId: 'work' } })
  // The old setting never comes back as an agent preference.
  assert.deepEqual(validatePreferences({ transcription: { accountId: 'work', language: 'de' } }), { transcription: { language: 'de' } })
  const settings = structuredClone(getSettings())
  settings.dictation.accountId = 'app-voice'
  assert.equal(effectiveSettings(settings, { preferences: { dictation: { accountId: 'agent-account' } } }).dictation.accountId, 'agent-account')
  assert.equal(effectiveSettings(settings, { preferences: { transcription: { language: 'de' } } }).dictation.accountId, 'app-voice')
})

test("automatic voice typing uses the AI's own subscription account, else one signed in, else ChatGPT's", () => {
  const accounts = [
    { id: 'chatgpt-default', provider: 'chatgpt', signedIn: false },
    { id: 'claude-default', provider: 'claude', signedIn: true },
    { id: 'work-gpt', provider: 'chatgpt', signedIn: true }
  ]
  const settings = structuredClone(getSettings())
  settings.ai = null; settings.dictation.accountId = ''; settings.dictation.speech = 'auto'
  settings.provider = 'chatgpt'; settings.subscriptionAccountId = ''
  assert.equal(automaticVoiceAccount(settings, accounts), 'chatgpt-default')
  settings.subscriptionAccountId = 'work-gpt'
  assert.equal(automaticVoiceAccount(settings, accounts), 'work-gpt', 'the AI account picked')
  settings.provider = 'claude'; settings.claude.auth = 'subscription'; settings.subscriptionAccountId = ''
  assert.equal(automaticVoiceAccount(settings, accounts), 'claude-default')
  settings.claude.auth = 'api-key'
  assert.equal(automaticVoiceAccount(settings, accounts), 'claude-default', 'an API key: an account that is signed in')
  settings.provider = 'compat'
  assert.equal(automaticVoiceAccount(settings, accounts.map(account => ({ ...account, signedIn: false }))), 'chatgpt-default', 'none signed in: ChatGPT')
  // With a profile of jobs, the first job on a subscription of the AI's kind.
  settings.provider = 'chatgpt'
  const task = sourceId => ({ sourceId, model: 'm', effort: 'low' })
  settings.ai = { tasks: { deep: task('api:compat'), background: task('work-gpt'), vision: task('claude-default'), quick: task('chatgpt-default') } }
  assert.equal(automaticVoiceAccount(settings, accounts), 'work-gpt')
  assert.equal(voiceAccountId(settings, accounts), 'work-gpt')
  settings.dictation.accountId = 'claude-default'
  assert.equal(voiceAccountId(settings, accounts), 'claude-default', 'one picked for voice typing wins')
})

test('the call timeline merges lines and pictures in time order without sorting everything again', () => {
  const line = (id, at) => ({ id, speaker: 'them', text: id, at, end: at })
  const frame = (id, at) => ({ id, n: 1, at, kind: 'snapshot', thumbUrl: '', imageUrl: '' })
  const ids = items => items.map(item => 'line' in item ? item.line.id : item.frame.id)
  assert.deepEqual(ids(inTimeOrder([line('a', 1), line('b', 5), line('c', 9)], [frame('F1', 0), frame('F2', 5), frame('F3', 12)])), ['F1', 'a', 'b', 'F2', 'c', 'F3'], 'a line goes before a picture of the same moment')
  assert.deepEqual(ids(inTimeOrder([line('late', 7), line('early', 3)], [frame('F1', 5)])), ['early', 'F1', 'late'], 'out of order: sorted')
  assert.deepEqual(inTimeOrder([], []), [])
  const long = Array.from({ length: 20000 }, (_, i) => line('l' + i, i * 10))
  const pictures = Array.from({ length: 200 }, (_, i) => frame('f' + i, i * 1000 + 5))
  const merged = inTimeOrder(long, pictures)
  assert.equal(merged.length, 20200)
  assert.ok(merged.every((item, i) => i === 0 || merged[i - 1].at <= item.at))
})

test('a saved automatic language setting survives restart without being rewritten to English', async () => {
  await updateSettings({ transcription: { language: 'auto' }, dictation: { accountId: 'chatgpt-default' } })
  await loadSettings()
  assert.equal(getSettings().transcription.language, 'auto')
  assert.equal(getSettings().dictation.accountId, 'chatgpt-default')
})
