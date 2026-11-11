// Which on-PC models hear which language: Parakeet's 25, Whisper behind it, and what a CPU downloads.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('local-speech')
const { PARAKEET_LANGUAGES, SPEECH_LANGUAGES, parakeetHears, localModelsFor, speechLanguageName, switchedLanguage, whisperFor, modelNameOf, MODELS } =
  await import('./.build/togle.mjs')

test("Parakeet's 25 languages are all in the language list, and Serbian, Bosnian and Norwegian aren't among them", () => {
  assert.equal(PARAKEET_LANGUAGES.size, 25)
  const listed = new Set(SPEECH_LANGUAGES.map(([code]) => code))
  for (const code of PARAKEET_LANGUAGES) assert.ok(listed.has(code), `${code} is in the language list`)
  for (const code of ['sr', 'bs', 'no', 'ja', 'zh', 'ar', 'tr']) assert.equal(parakeetHears(code), false, code)
  for (const code of ['en', 'hr', 'sl', 'de', 'ru', 'uk', 'el', 'auto', 'EN-us', 'hr_HR']) assert.equal(parakeetHears(code), true, code)
})

test('a CPU downloads Parakeet alone for its languages, and Whisper small only for the others', () => {
  assert.deepEqual(localModelsFor('hr', false), ['parakeet'])
  assert.deepEqual(localModelsFor('en', false), ['parakeet'])
  assert.deepEqual(localModelsFor('ja', false), ['whisper-small'])
  assert.deepEqual(localModelsFor('sr', false), ['whisper-small'])
  assert.deepEqual(localModelsFor('auto', false), ['parakeet', 'whisper-small'], 'detecting the language: Parakeet first, Whisper small for the rest')
})

test('a GPU (or a Mac) keeps Whisper large-v3-turbo behind Parakeet, for every language', () => {
  assert.deepEqual(localModelsFor('hr', true), ['parakeet', 'whisper-turbo'])
  assert.deepEqual(localModelsFor('ja', true), ['whisper-turbo'])
  assert.deepEqual(localModelsFor('auto', true), ['parakeet', 'whisper-turbo'])
})

test('the catalog: Whisper small for a CPU (190 MB), large-v3-turbo for a GPU, and names by file', () => {
  assert.equal(whisperFor({ gpu: false }), 'whisper-small')
  assert.equal(whisperFor({ gpu: true }), 'whisper-turbo')
  assert.equal(MODELS['whisper-small'].bytes, 190085487)
  assert.match(MODELS['whisper-small'].sha256, /^[0-9a-f]{64}$/)
  assert.equal(modelNameOf('C:\\speech\\models\\ggml-small-q5_1.bin'), 'Whisper small')
  assert.equal(modelNameOf('/speech/models/ggml-large-v3-turbo-q5_0.bin'), 'Whisper large-v3-turbo')
  assert.equal(modelNameOf('/elsewhere/custom-model.bin'), 'custom-model.bin')
})

test("a switched language: accented letters in English, another alphabet in Parakeet's other languages, never when detected", () => {
  assert.equal(switchedLanguage('Where is the station?', 'en'), false)
  assert.equal(switchedLanguage('Où est la gare?', 'en'), true)
  assert.equal(switchedLanguage('Koliko košta ovaj čajnik?', 'hr'), false)
  assert.equal(switchedLanguage('Сколько стоит?', 'hr'), true)
  assert.equal(switchedLanguage('Сколько стоит iPhone?', 'ru'), false, 'a Latin brand name in Russian is fine')
  assert.equal(switchedLanguage('How much is it?', 'ru'), true)
  assert.equal(switchedLanguage('Πόσο κοστίζει;', 'el'), false)
  assert.equal(switchedLanguage('Сколько стоит?', 'auto'), false)
})

test('language names for Settings', () => {
  assert.equal(speechLanguageName('hr'), 'Croatian')
  assert.equal(speechLanguageName('mt'), 'Maltese')
  assert.equal(speechLanguageName('auto'), 'every language')
})
