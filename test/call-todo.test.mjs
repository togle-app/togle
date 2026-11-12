// What a call left on the person's own list: the to-dos in its notes that are theirs.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { myTodoItems } from './.build/togle.mjs'

const notes = `# Sprint review

## Marked
- Marta: the API timeline has to move to the end of the month. [12:40]

## Decided
- The pricing page ships with two plans.

## To do
- You: send the API timeline to Dario. [12:41]
- **Ivan**: check the staging logs before Friday. [13:02]
- Dana: write the release notes by Tuesday [14:10-14:30]
- Not assigned: look at the refund wording
- Marta - sends the invoice
- [ ] **You**: book the review with the design team

## Open questions
- You: is the budget approved?
`

test('the to-dos that are mine are found, and the ones for others or for nobody are not', () => {
  assert.deepEqual(myTodoItems(notes, []), ['send the API timeline to Dario.', 'book the review with the design team'])
  assert.deepEqual(myTodoItems(notes, ['Dana']), ['send the API timeline to Dario.', 'write the release notes by Tuesday', 'book the review with the design team'])
  assert.deepEqual(myTodoItems(notes, ['Dana Whitfield']).length, 3, 'a first name is enough')
  assert.deepEqual(myTodoItems(notes, ['dana']).length, 3, 'any case')
})

test('only items under a to-do heading count, and the next heading ends them', () => {
  assert.deepEqual(myTodoItems('## Decided\n- You: nothing to do here.\n', []), [])
  assert.deepEqual(myTodoItems('## Action items\n- You: first\n\n## Notes\n- You: not this\n', []), ['first'])
  assert.deepEqual(myTodoItems('### Next steps:\n1. You: call Dario\n2) You: email Marta\n', []), ['call Dario', 'email Marta'])
  assert.deepEqual(myTodoItems('## To-do\n* You: with a star\n+ You: with a plus\n', []), ['with a star', 'with a plus'])
  assert.deepEqual(myTodoItems('', []), [])
})

test('an item said twice is offered once, a long one is cut, and there are never many', () => {
  assert.deepEqual(myTodoItems('## To do\n- You: Call Dario\n- You: call dario [3:00]\n', []), ['Call Dario'])
  const long = 'x'.repeat(300)
  const [cut] = myTodoItems(`## To do\n- You: ${long}\n`, [])
  assert.equal(cut.length, 160)
  assert.ok(cut.endsWith('…'))
  const many = '## To do\n' + Array.from({ length: 20 }, (_, n) => `- You: item ${n}`).join('\n')
  assert.equal(myTodoItems(many, []).length, 8)
})
