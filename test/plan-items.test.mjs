// An agent's checklist is kept short as its session goes on: the latest finished items and every one still open (the latest forty).
import assert from 'node:assert/strict'
import { test } from 'node:test'

const { PLAN_DONE_KEPT, PLAN_OPEN_KEPT, tidyPlan } = await import('./.build/togle.mjs')
const item = (n, state) => ({ text: 'Item ' + n, state })
const texts = (plan) => plan.map((entry) => entry.text)

test('a short checklist is left as it is, and what it is given is not changed', () => {
  const plan = [item(1, 'done'), item(2, 'done'), item(3, 'doing'), item(4, 'todo')]
  const copy = structuredClone(plan)
  assert.deepEqual(tidyPlan(plan), plan)
  assert.deepEqual(plan, copy)
  const eight = Array.from({ length: PLAN_DONE_KEPT }, (_, n) => item(n, 'done'))
  assert.equal(tidyPlan(eight).length, PLAN_DONE_KEPT, 'as many finished as are kept: all')
})

test('a checklist of a thousand keeps the latest finished items and every one still open, in their order', () => {
  const plan = [...Array.from({ length: 990 }, (_, n) => item(n, 'done')), item(990, 'doing'), ...Array.from({ length: 9 }, (_, n) => item(991 + n, 'todo'))]
  const tidy = tidyPlan(plan)
  assert.equal(tidy.length, PLAN_DONE_KEPT + 10)
  assert.deepEqual(texts(tidy), [...Array.from({ length: PLAN_DONE_KEPT }, (_, n) => 'Item ' + (982 + n)), ...Array.from({ length: 10 }, (_, n) => 'Item ' + (990 + n))])
  assert.deepEqual(tidy.slice(-10).map((entry) => entry.state), ['doing', ...Array(9).fill('todo')])
})

test('which finished items stay is by when they were finished, when that is told, and not by their place in the list', () => {
  const plan = Array.from({ length: 30 }, (_, n) => ({ ...item(n, 'done'), finished: 30 - n }))
  plan.push(item(30, 'todo'))
  // Item 0 was finished last, item 29 first: the ones kept are the first eight of the list.
  const tidy = tidyPlan(plan, (entry, index) => entry.finished ?? index)
  assert.deepEqual(texts(tidy), [...Array.from({ length: PLAN_DONE_KEPT }, (_, n) => 'Item ' + n), 'Item 30'])
})

test('of what is still to do, the latest forty stay, and what is being done always does', () => {
  const plan = [item(0, 'doing'), ...Array.from({ length: 99 }, (_, n) => item(n + 1, 'todo'))]
  const tidy = tidyPlan(plan)
  assert.equal(tidy.length, PLAN_OPEN_KEPT + 1)
  assert.equal(tidy[0].text, 'Item 0', 'what is being done stays, though it is the oldest')
  assert.equal(tidy[1].text, 'Item 60', 'of what is to do, the forty latest: an item left to do that long ago is one the agent forgot')
  assert.equal(tidy.at(-1).text, 'Item 99')
})
