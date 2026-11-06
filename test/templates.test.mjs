import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'

workDir('agent-templates')
const { AgentStore, AGENT_TEMPLATES } = await import('./.build/togle.mjs')
const store = new AgentStore(async () => { assert.fail('A local template must not use an AI request') })
await store.load()

test('every included template creates an independent working agent without a model request', async () => {
  assert.ok(AGENT_TEMPLATES.length >= 8)
  const ids = new Set()
  for (const template of AGENT_TEMPLATES) {
    assert.ok(!ids.has(template.id)); ids.add(template.id)
    const agent = await store.create(template.id)
    assert.equal(agent.instructions, template.instructions)
    assert.equal(agent.description, template.description)
    assert.equal(agent.learning, 'auto')
    assert.deepEqual(agent.memory, [])
    assert.deepEqual(agent.history, [])
  }
})

test('learning in a template-based agent does not alter the template or another copy', async () => {
  const before = structuredClone(AGENT_TEMPLATES)
  const first = await store.create('support')
  const second = await store.create('support')
  await store.applyLessons(first.id, { facts: ['Ask which operating system the customer uses.'], answers: [], skills: [], updates: [], forget: [] }, true)
  assert.equal(store.get(first.id).memory.length, 1)
  assert.deepEqual(store.get(second.id).memory, [])
  assert.deepEqual(AGENT_TEMPLATES, before)
})
