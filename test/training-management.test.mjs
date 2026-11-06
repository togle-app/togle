import test from 'node:test'
import assert from 'node:assert/strict'
import { workDir } from './helpers.mjs'

workDir('training-management')
const { AgentStore } = await import('./.build/togle.mjs')
let completions = 0
const store = new AgentStore(async () => { completions++; return '' })
await store.load()
const agent = () => store.list()[0]

test('manual facts stay agent scoped, preserve concurrent additions and record reversible edits', async () => {
  const id = agent().id, other = await store.create('blank', { name: 'Other team' })
  await store.saveFact(id, '  The release owner is Denis.  ')
  await store.saveFact(id, 'The incident channel is #support.')
  await store.saveFact(id, 'The release owner is Luka.', 'The release owner is Denis.')
  assert.deepEqual(agent().memory, ['The release owner is Luka.', 'The incident channel is #support.'])
  assert.deepEqual(store.get(other.id).memory, [])
  const edit = agent().history.at(-1)
  assert.equal(edit.origin, 'manual')
  await store.undo(id, edit.id)
  assert.ok(agent().memory.includes('The release owner is Denis.'))
  await store.removeFact(id, 'The release owner is Denis.')
  assert.deepEqual(agent().memory, ['The incident channel is #support.'])
  await store.undo(id, agent().history.at(-1).id)
  assert.ok(agent().memory.includes('The release owner is Denis.'))
})

test('stale or duplicate fact edits protect learning; short facts stay savable beyond the live budget', async () => {
  const id = agent().id
  await assert.rejects(store.saveFact(id, 'Wrong owner', 'The release owner is Luka.'), /changed or was removed/)
  await assert.rejects(store.removeFact(id, 'The release owner is Luka.'), /changed or was removed/)
  await assert.rejects(store.saveFact(id, 'THE RELEASE OWNER IS DENIS.'), /already remembered/)
  await assert.rejects(store.saveFact(id, ' '), /short fact/)
  await assert.rejects(store.saveFact(id, 'x'.repeat(301)), /300/)
  const full = await store.create('blank', { name: 'Full memory', memory: Array.from({ length: 14 }, (_, n) => `${n}:` + 'x'.repeat(278)) })
  await store.saveFact(full.id, 'y'.repeat(100))
  assert.ok(store.get(full.id).memory.includes('y'.repeat(100)))
  const legacy = await store.create('blank', { name: 'Legacy over-budget memory', memory: [...full.memory, 'z'.repeat(280)] })
  await store.saveFact(legacy.id, legacy.memory[0].slice(0, 270), legacy.memory[0])
  assert.equal(store.get(legacy.id).memory[0].length, 270, 'shortening legacy facts is allowed even while memory is still over budget')
  assert.ok(agent().memory.includes('The release owner is Denis.'))
})

test('skill edits preserve identity and usage; stale saves and removals protect newer call learning', async () => {
  const id = agent().id, initial = { name: 'Incident response', when: 'A production incident is reported', how: '- Establish the impact.\n- Find the owner.' }
  const created = await store.saveSkill(id, initial, 'manual')
  store.noteUse(id, { skills: [created.skill.id] }); await store.saveUses()
  const learned = { ...initial, purpose: 'assistance', how: initial.how + '\n- Record the incident timeline.' }
  await store.saveSkill(id, learned, 'call')
  await assert.rejects(store.saveSkill(id, { ...initial, how: '- This stale edit loses the timeline.' }, 'manual', created.skill.id, initial), /changed or was removed/)
  await assert.rejects(store.removeSkill(id, created.skill.id, initial), /changed or was removed/)
  const edited = await store.saveSkill(id, { ...learned, name: 'Production incidents' }, 'manual', created.skill.id, learned)
  assert.equal(edited.skill.id, created.skill.id)
  assert.equal(edited.skill.uses, 1)
  assert.equal(edited.skill.origin, 'manual')
  assert.ok(edited.skill.how.includes('timeline'))
  await store.removeSkill(id, edited.skill.id, edited.skill)
  assert.equal(agent().skills.some(skill => skill.id === edited.skill.id), false)
  const removal = agent().history.at(-1)
  assert.equal(removal.origin, 'manual')
  await store.undo(id, removal.id)
  assert.equal(agent().skills.find(skill => skill.id === edited.skill.id).how, learned.how)
})

test('manual knowledge and skills survive reload without any model request', async () => {
  const reloaded = new AgentStore(async () => { throw new Error('Manual edits must not use a model') })
  await reloaded.load()
  const saved = reloaded.get(agent().id)
  assert.ok(saved.memory.includes('The incident channel is #support.'))
  assert.equal(saved.skills[0].name, 'Production incidents')
  assert.ok(saved.history.some(change => change.undone))
  assert.equal(completions, 0)
})
