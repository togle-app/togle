import assert from 'node:assert/strict'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

workDir('shared-speech')
const { SpeechApi, cleanTranscript, CLAUDE_SPEECH_LANGUAGES, speechLanguageProblem, claudeSpeechLanguage,
  migrateSpeechAccounts, subscriptionRecognizer, needsReply, getSettings, updateSettings, loadSettings } = await import('./.build/togle.mjs')
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

test('Claude exposes its supported languages and never silently interprets auto, Chinese or Croatian as English', () => {
  assert.equal(CLAUDE_SPEECH_LANGUAGES.size, 20)
  for (const language of CLAUDE_SPEECH_LANGUAGES) {
    assert.equal(speechLanguageProblem('claude', language), undefined)
    assert.equal(claudeSpeechLanguage(language.toUpperCase() + '_TEST'), language)
  }
  for (const language of ['auto', 'zh', 'hr']) {
    assert.match(speechLanguageProblem('claude', language), /this PC's speech recognition/)
    assert.throws(() => claudeSpeechLanguage(language), /language|supported/)
    assert.equal(speechLanguageProblem('chatgpt', language), undefined)
  }
})

test('Claude call recognition uses the selected subscription adapter without an API key or another provider', async () => {
  electron.net.fetch = async () => assert.fail('Subscription recognition must not fall through to an API endpoint')
  const requests = []
  const api = new SpeechApi('claude', '', () => ({ baseUrl: '', model: '' }), {
    signedIn: () => true,
    recognize: async (pcm, options) => { requests.push({ first: pcm[0], language: options.language, vocabulary: options.vocabulary }); return options.language === 'de' ? 'Wir besprechen morgen OAuth.' : 'Nous parlons de Jira demain.' }
  })
  const one = new Float32Array(second), two = new Float32Array(second); one[0] = 1; two[0] = 2
  const result = await Promise.all([
    api.transcribe(one, { language: 'de', vocabulary: 'OAuth' }),
    api.transcribe(two, { language: 'fr', vocabulary: 'Jira' })
  ])
  assert.deepEqual(result, ['Wir besprechen morgen OAuth.', 'Nous parlons de Jira demain.'])
  assert.deepEqual(requests, [{ first: 1, language: 'de', vocabulary: 'OAuth' }, { first: 2, language: 'fr', vocabulary: 'Jira' }])
  assert.equal(api.who(), 'Claude'); assert.equal(api.label(), 'Claude speech'); assert.equal(api.hasKey(), false)
})

test('speech permissions and quota errors stop repeated Claude requests and never turn into API-key fallback', async () => {
  for (const status of [401, 403, 429]) {
    const api = new SpeechApi('claude', '', () => ({ baseUrl: '', model: '' }), {
      signedIn: () => true, recognize: async () => { throw Object.assign(new Error('Rejected fixture'), { status }) }
    })
    await assert.rejects(api.transcribe(second, { language: 'de', vocabulary: '' }))
    assert.equal(api.canHear(), false)
    assert.ok(status === 429 ? api.restingUntil() > Date.now() : api.refused)
    assert.ok(!api.problem.includes('chatgpt.com'))
    api.reset(); assert.equal(api.canHear(), true)
  }
})

test('missing subscription and unsupported language are caught before a call sends audio', async () => {
  let signedIn = false, language = 'de'
  const api = new SpeechApi('claude', '', () => ({ baseUrl: '', model: '' }), {
    signedIn: () => signedIn, missing: () => speechLanguageProblem('claude', language) || null,
    recognize: async () => assert.fail('Unconfigured speech cannot send audio')
  })
  assert.match(api.missing(), /Claude sign-in/)
  await assert.rejects(api.transcribe(second, { language, vocabulary: '' }), /Claude sign-in/)
  signedIn = true; language = 'auto'
  assert.equal(api.canHear(), false)
  await assert.rejects(api.transcribe(second, { language, vocabulary: '' }), /Choose a language/)
})

test('cancelling a native subscription recognizer cannot deliver a late partial transcript', async () => {
  const controller = new AbortController()
  const api = new SpeechApi('claude', '', () => ({ baseUrl: '', model: '' }), {
    signedIn: () => true, recognize: async () => { controller.abort(new Error('Cancelled fixture')); return 'Late private words' }
  })
  await assert.rejects(api.transcribe(second, { language: 'de', vocabulary: '', signal: controller.signal }), /Cancelled fixture/)
})

test("a ChatGPT account's speech never leaves this PC: Sign in with ChatGPT doesn't include transcription", async () => {
  electron.net.fetch = async () => assert.fail('No clip of speech is uploaded for a ChatGPT account')
  const auth = { identity: () => 'personal', status: () => ({ signedIn: true }) }
  const entry = { kind: 'chatgpt', auth, provider: { transcribe: async () => assert.fail('The ChatGPT plan does not transcribe') } }
  const api = subscriptionRecognizer(entry, () => assert.fail('Must not use Claude'), 'personal', () => 'auto')
  assert.equal(api.canHear(), false)
  assert.match(api.missing(), /this PC's speech recognition/)
  await assert.rejects(api.transcribe(second, { language: 'auto', vocabulary: '' }))
})

test('the production Claude adapter verifies identity after asynchronous account refresh and recognition', async () => {
  for (const changeAt of ['status', 'recognition']) {
    let identity = 'work', prepared = 0
    const auth = { identity: () => identity, cachedStatus: () => ({ signedIn: true }), status: async () => {
      if (changeAt === 'status') identity = 'personal'
      return { signedIn: true, email: 'work@example.test' }
    } }
    const api = subscriptionRecognizer({ kind: 'claude', auth }, () => ({ prepare: async (language, email, signal) => {
      prepared++; assert.equal(language, 'de'); assert.equal(email, 'work@example.test'); assert.ok(signal instanceof AbortSignal)
      return async () => { identity = 'personal'; return 'Private words' }
    } }), identity, () => 'de')
    await assert.rejects(api.transcribe(second, { language: 'de', vocabulary: '' }), /account changed/)
    assert.equal(prepared, changeAt === 'status' ? 0 : 1)
  }
})

test('upgrading speech settings preserves work/personal separation and removes only redundant overrides', () => {
  const settings = structuredClone(getSettings())
  assert.deepEqual(migrateSpeechAccounts(settings, 'work', 'personal'), { transcription: { accountId: 'work' }, dictation: { accountId: 'personal' } })
  assert.deepEqual(migrateSpeechAccounts(settings, 'work', 'work'), { transcription: { accountId: 'work' }, dictation: { accountId: '' } })
  assert.deepEqual(migrateSpeechAccounts(settings, undefined, 'claude-local-call'), { transcription: { accountId: 'claude-local-call' }, dictation: { accountId: '' } })
  assert.equal(settings.transcription.me, getSettings().transcription.me)
})

test('a saved automatic language setting survives restart without being rewritten to English', async () => {
  await updateSettings({ transcription: { language: 'auto', accountId: 'chatgpt-default' } })
  await loadSettings()
  assert.equal(getSettings().transcription.language, 'auto')
  assert.equal(getSettings().transcription.accountId, 'chatgpt-default')
})
