// The model and the effort a task works with, for its status line: the words for them (shared/model-words.ts), and what each agent's own record
// says of them (Claude Code's last answer, a Hermes export). Codex's come from the thread the server lists, and the hub that asks for all of them
// is tried with the other hub tests.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

const dir = workDir('model-line')
const claudeHome = path.join(dir, '.claude')
process.env.CLAUDE_CONFIG_DIR = claudeHome

const T = await import('./.build/togle.mjs')

test('a model id is said as a person says it: Claude by family and version, GPT in capitals, any other as it is', () => {
  const says = {
    'claude-opus-5-5': 'Opus 5.5',
    'claude-sonnet-5-5': 'Sonnet 5.5',
    'claude-haiku-5-5': 'Haiku 5.5',
    'claude-fable-5-2': 'Fable 5.2',
    'claude-3-5-sonnet-20241022': 'Sonnet 3.5',
    'claude-opus-4-1-20250805': 'Opus 4.1',
    'claude-sonnet-4-20250514': 'Sonnet 4',
    'claude-3-7-sonnet-latest': 'Sonnet 3.7',
    'claude-opus-5-5[1m]': 'Opus 5.5 (1M)',
    'gpt-6.2-sol': 'GPT 6.2 Sol',
    'gpt-6.1-sol-900k': 'GPT 6.1 Sol 900k',
    'gemini-2.5-pro': 'gemini-2.5-pro',
    'claude-something-new': 'claude-something-new',
    '': ''
  }
  for (const [id, words] of Object.entries(says)) assert.equal(T.modelWords(id), words, id)
})

test('the status line says the model and the effort, whichever the agent tells; the pointer says them in full', () => {
  assert.equal(T.modelLine({ model: 'claude-opus-5-5', effort: 'max' }), 'Opus 5.5 · max')
  assert.equal(T.modelLine({ model: 'gpt-6.2-sol', effort: 'Ultra' }), 'GPT 6.2 Sol · ultra')
  assert.equal(T.modelLine({ model: 'claude-haiku-5-5' }), 'Haiku 5.5')
  assert.equal(T.modelLine({ effort: 'high' }), 'high')
  assert.equal(T.modelLine(null), '')
  assert.equal(T.modelLine({}), '')
  assert.equal(T.modelTitle({ model: 'claude-opus-5-5', effort: 'max' }), 'Model: Opus 5.5 (claude-opus-5-5). Effort: max.')
  assert.equal(T.modelTitle({ model: 'gemini-2.5-pro' }), 'Model: gemini-2.5-pro.', 'an id with no words of its own is not said twice')
  assert.equal(T.modelTitle(undefined), '')
})

// ---- Claude Code: the end of the session's file ----

const id = (n) => `cccc${n}111-2222-4333-8444-555566667777`
const file = (n) => path.join(claudeHome, 'projects', 'C--work-shop', `${id(n)}.jsonl`)
const line = (record) => JSON.stringify(record) + '\n'
const asked = (n) => ({ type: 'user', message: { role: 'user', content: 'Rebuild the pricing page.' }, sessionId: id(n), timestamp: '2026-11-19T10:00:00.000Z', isSidechain: false })
const answer = (n, model, extra = {}) => ({ type: 'assistant', message: { role: 'assistant', model, content: [{ type: 'text', text: 'Done.' }] }, sessionId: id(n), timestamp: '2026-11-19T10:00:05.000Z', isSidechain: false, ...extra })
const write = (n, text) => { mkdirSync(path.dirname(file(n)), { recursive: true }); writeFileSync(file(n), text) }

test('Claude Code: the model and the effort of the last answer in the session, not a helper’s and not a stand-in’s', async () => {
  write(1,
    line(asked(1)) +
    line(answer(1, 'claude-haiku-5-5', { effort: 'low', perTurnEffort: 'low' })) +
    line(asked(1)) +
    line(answer(1, 'claude-sonnet-5-5', { effort: 'high', perTurnEffort: 'high' })) +
    // A helper agent answers with a model of its own, and Claude Code writes answers of its own with no model: neither is the session's.
    line(answer(1, 'claude-opus-5-5', { effort: 'max', isSidechain: true })) +
    line(answer(1, '<synthetic>', { effort: 'max' }))
  )
  assert.deepEqual(await T.claudeModel(id(1)), { model: 'claude-sonnet-5-5', effort: 'high' })
  // The person changes both on the screen: the next answer says so, and it is read again from the file.
  appendFileSync(file(1), line(asked(1)) + line(answer(1, 'claude-opus-5-5', { effort: 'xhigh', perTurnEffort: 'xhigh' })))
  assert.deepEqual(await T.claudeModel(id(1)), { model: 'claude-opus-5-5', effort: 'xhigh' })
  // An older Claude Code writes no effort: only the model is told.
  appendFileSync(file(1), line(answer(1, 'claude-sonnet-5-5')))
  assert.deepEqual(await T.claudeModel(id(1)), { model: 'claude-sonnet-5-5' })
})

test('Claude Code: an answer far back in a long session is found, and a session with no answer, or no file, has none', async () => {
  // 600 KB of what the person said after the one answer: the end of the file that is read first holds none.
  write(2, line(asked(2)) + line(answer(2, 'claude-fable-5-2', { effort: 'max' })) + line(asked(2)).repeat(8_000))
  assert.deepEqual(await T.claudeModel(id(2)), { model: 'claude-fable-5-2', effort: 'max' })
  write(3, line(asked(3)))
  assert.equal(await T.claudeModel(id(3)), null, 'nothing answered yet')
  assert.equal(await T.claudeModel('ffff6666-0000-4000-8000-000000000009'), null, 'no such session')
})

// ---- Hermes: the session's export ----

test('Hermes: the session’s model, and the effort of its reasoning, whether model_config is JSON text or an object', () => {
  const text = JSON.stringify({ api_mode: 'codex_responses', model: 'gpt-6.1-sol-900k', reasoning_config: { effort: 'ultra', enabled: true } })
  assert.deepEqual(T.hermesModel({ model: 'gpt-6.2-sol', model_config: text }), { model: 'gpt-6.2-sol', effort: 'ultra' })
  assert.deepEqual(T.hermesModel({ model: 'gpt-6.2-sol', model_config: { reasoning_config: { effort: 'high' } } }), { model: 'gpt-6.2-sol', effort: 'high' })
  assert.deepEqual(T.hermesModel({ model: 'gpt-6.2-sol', model_config: { reasoning_config: JSON.stringify({ effort: 'medium', enabled: true }) } }), { model: 'gpt-6.2-sol', effort: 'medium' }, 'reasoning_config as text too')
  // Reasoning turned off is said so; no model of its own falls back to the one in the config; neither is nothing.
  assert.deepEqual(T.hermesModel({ model: 'gpt-6.2-sol', model_config: { reasoning_config: { enabled: false } } }), { model: 'gpt-6.2-sol', effort: 'off' })
  assert.deepEqual(T.hermesModel({ model_config: text }), { model: 'gpt-6.1-sol-900k', effort: 'ultra' })
  assert.equal(T.hermesModel({ id: 'x' }), null)
  assert.equal(T.hermesModel({ model_config: 'not json {' }), null)
  assert.equal(T.hermesModel(null), null)
})
