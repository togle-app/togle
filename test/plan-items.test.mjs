// An agent's checklist is a list a person looks at, so it is kept whole until it is far past that: then only the latest finished items
// and the latest of what is still open stay.
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { PLAN_DONE_KEPT, PLAN_OPEN_KEPT, tidyPlan } = await import('./.build/togle.mjs')
const item = (n, state) => ({ text: 'Item ' + n, state })
const texts = (plan) => plan.map((entry) => entry.text)

test('a checklist of a few dozen is left as it is, and what it is given is not changed', () => {
  const plan = [item(1, 'done'), item(2, 'done'), item(3, 'doing'), item(4, 'todo')]
  const copy = structuredClone(plan)
  assert.deepEqual(tidyPlan(plan), plan)
  assert.deepEqual(plan, copy)
  const full = Array.from({ length: PLAN_DONE_KEPT + PLAN_OPEN_KEPT }, (_, n) => item(n, n < PLAN_DONE_KEPT + 10 ? 'done' : 'todo'))
  assert.deepEqual(tidyPlan(full), full, 'as many as are kept in all: every one, finished long ago or not')
  const twenty = Array.from({ length: 20 }, (_, n) => item(n, n < 12 ? 'done' : n === 12 ? 'doing' : 'todo'))
  assert.deepEqual(tidyPlan(twenty), twenty, 'what Chat shows is what the agent shows: none of a short list is left out')
})

test('a checklist of a thousand keeps the latest finished items and every one still open, in their order', () => {
  const plan = [...Array.from({ length: 990 }, (_, n) => item(n, 'done')), item(990, 'doing'), ...Array.from({ length: 9 }, (_, n) => item(991 + n, 'todo'))]
  const tidy = tidyPlan(plan)
  assert.equal(tidy.length, PLAN_DONE_KEPT + 10)
  assert.deepEqual(texts(tidy), [...Array.from({ length: PLAN_DONE_KEPT }, (_, n) => 'Item ' + (990 - PLAN_DONE_KEPT + n)), ...Array.from({ length: 10 }, (_, n) => 'Item ' + (990 + n))])
  assert.deepEqual(tidy.slice(-10).map((entry) => entry.state), ['doing', ...Array(9).fill('todo')])
})

test('which finished items stay is by when they were finished, when that is told, and not by their place in the list', () => {
  const total = PLAN_DONE_KEPT + PLAN_OPEN_KEPT + 20
  const plan = Array.from({ length: total }, (_, n) => ({ ...item(n, 'done'), finished: total - n }))
  plan.push(item(total, 'todo'))
  // Item 0 was finished last, the one before the todo first: the ones kept are the first of the list.
  const tidy = tidyPlan(plan, (entry, index) => entry.finished ?? index)
  assert.deepEqual(texts(tidy), [...Array.from({ length: PLAN_DONE_KEPT }, (_, n) => 'Item ' + n), 'Item ' + total])
})

test('of what is still to do, the latest hundred stay, and what is being done always does', () => {
  const open = PLAN_OPEN_KEPT + PLAN_DONE_KEPT + 50
  const plan = [item(0, 'doing'), ...Array.from({ length: open }, (_, n) => item(n + 1, 'todo'))]
  const tidy = tidyPlan(plan)
  assert.equal(tidy.length, PLAN_OPEN_KEPT + 1)
  assert.equal(tidy[0].text, 'Item 0', 'what is being done stays, though it is the oldest')
  assert.equal(tidy[1].text, 'Item ' + (open - PLAN_OPEN_KEPT + 1), 'of what is to do, the latest: an item left to do that long ago is one the agent forgot')
  assert.equal(tidy.at(-1).text, 'Item ' + open)
})
