import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir, ongoingCall } from './helpers.mjs'
workDir('agent-speech-words')
const { OngoingCall, speechWords, withSpeechWord, correctSpeech, speechLesson, vocabularyTerms } = await import('./.build/togle.mjs')

test('natural teaching distinguishes a company name, acronym and spoken number', () => {
  assert.deepEqual(speechLesson('When I say “so three”, it means “SOH 3”.'), { heardAs: 'so three', word: 'SOH 3' })
  assert.deepEqual(speechLesson('When I say Zo three, it means SOH number three.'), { heardAs: 'Zo three', word: 'SOH 3' })
  assert.equal(speechLesson('Denis says so three is deployed.'), undefined)
  let vocabulary = withSpeechWord('Roman, Denis', 'north wind traitors', 'Northwind Traders')
  vocabulary = withSpeechWord(vocabulary, 'so three', 'SOH 3')
  assert.equal(correctSpeech('Ask Roman about north wind traitors, then check so three.', speechWords(vocabulary)), 'Ask Roman about Northwind Traders, then check SOH 3.')
  assert.equal(correctSpeech('also three teams said north wind traitorser.', speechWords(vocabulary)), 'also three teams said north wind traitorser.')
  assert.ok(!vocabularyTerms(vocabulary).some(term => term.includes('→')))
  assert.ok(vocabularyTerms(vocabulary).includes('SOH 3'))
})

test('speech replacements do not cascade or interpret regex characters as instructions', () => {
  const rules = speechWords(withSpeechWord(withSpeechWord('', 'C plus plus', 'C++'), 'C++', 'Cpp'))
  assert.equal(correctSpeech('Use C plus plus and C++.', rules), 'Use C++ and Cpp.')
  assert.equal(correctSpeech('Οσ', speechWords(withSpeechWord('', 'ΟΣ', 'Project Sigma'))), 'Project Sigma')
  assert.throws(() => withSpeechWord('', 'x\ny', 'z'), /short spoken phrase/)
})

test('the call learns an explicit spoken correction only from the user microphone', async () => {
  const learned = []
  const { ongoing } = ongoingCall(OngoingCall, { learnWords: async (correction) => learned.push(correction) })
  ongoing.add('them', 'When I say so three, write SOH 3.', 1000, 2500, 'other-lesson')
  assert.deepEqual(learned, [])
  ongoing.add('me', 'When I say north wind traitors, it means Northwind Traders.', 4000, 7000, 'my-lesson')
  assert.deepEqual(learned, [{ heardAs: 'north wind traitors', word: 'Northwind Traders' }])
})
