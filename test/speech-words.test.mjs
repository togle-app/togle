import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir, copilotWith } from './helpers.mjs'
workDir('agent-speech-words')
const { AgentStore, Copilot, train, speechWords, withSpeechWord, correctSpeech, speechLesson, vocabularyTerms } = await import('./.build/togle.mjs')

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

test('teaching in chat is immediate, scoped, persistent and independently reversible', async () => {
  const store = new AgentStore(async () => ''); await store.load()
  const agent = await store.create('blank', { name: 'Northwind Traders' }), other = await store.create('blank', { name: 'Personal' })
  const changes = [], output = []
  const provider = { supportsTools: true, stream: async () => assert.fail('An explicit wording lesson needs no model request') }
  const teach = message => train(store, provider, agent.id, [], message, new AbortController().signal, { onDelta: text => output.push(text), onChange: text => changes.push(text) })
  await teach('When I say north wind traitors, it means Northwind Traders.')
  const first = store.get(agent.id).history.at(-1).id
  await teach('When I say so three, write SOH 3.')
  assert.equal(speechWords(store.get(agent.id).vocabulary).length, 2)
  assert.equal(store.get(other.id).vocabulary, '')
  await store.undo(agent.id, first)
  assert.deepEqual(speechWords(store.get(agent.id).vocabulary).map(word => word.word), ['SOH 3'])
  const restored = new AgentStore(async () => ''); await restored.load()
  assert.equal(correctSpeech('so three', speechWords(restored.get(agent.id).vocabulary)), 'SOH 3')
  assert.equal(correctSpeech('so three', speechWords(restored.get(other.id).vocabulary)), 'so three')
  assert.equal(changes.length, 2); assert.equal(output.length, 2)
})

test('speech replacements do not cascade or interpret regex characters as instructions', () => {
  const rules = speechWords(withSpeechWord(withSpeechWord('', 'C plus plus', 'C++'), 'C++', 'Cpp'))
  assert.equal(correctSpeech('Use C plus plus and C++.', rules), 'Use C++ and Cpp.')
  assert.equal(correctSpeech('Οσ', speechWords(withSpeechWord('', 'ΟΣ', 'Project Sigma'))), 'Project Sigma')
  assert.throws(() => withSpeechWord('', 'x\ny', 'z'), /short spoken phrase/)
})

test('the call learns an explicit spoken correction only from the user microphone', async () => {
  const store = new AgentStore(async () => ''); await store.load()
  const agent = await store.create('blank', { name: 'Call words' }), learned = []
  const { copilot } = copilotWith(Copilot, store, agent.id, [], { learnWords: async (owner, correction) => learned.push({ id: owner.id, ...correction }) })
  copilot.add('them', 'When I say so three, write SOH 3.', 1000, 2500, 'other-lesson')
  assert.deepEqual(learned, [])
  copilot.add('me', 'When I say north wind traitors, it means Northwind Traders.', 4000, 7000, 'my-lesson')
  assert.deepEqual(learned, [{ id: agent.id, heardAs: 'north wind traitors', word: 'Northwind Traders' }])
})
