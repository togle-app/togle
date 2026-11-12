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

test('a name with the colon inside the bold, and items grouped under a name, are read too', () => {
  assert.deepEqual(myTodoItems('## To do\n- **You:** send the API timeline\n- **Ivan:** check the logs\n', []), ['send the API timeline'])
  const grouped = '## To do\n\n### You\n- send the API timeline: v2 by Friday\n- call Dario\n\n### Ivan\n- check the logs\n\n## Decided\n- You: not a to-do\n'
  assert.deepEqual(myTodoItems(grouped, []), ['send the API timeline: v2 by Friday', 'call Dario'], 'under a sub-heading with their name, the whole line is the task')
  const bold = '## To do\n**Ivan**\n- check the logs\n**You**\n- book the review\n- Marta: not mine, said by name\n'
  assert.deepEqual(myTodoItems(bold, []), ['book the review'], 'under their name in bold, a line for another name is not theirs')
  assert.deepEqual(myTodoItems('## To do\n**Ivan:**\n- check the logs\n', []), [], 'someone else\'s name in bold')
  assert.deepEqual(myTodoItems('## Notes\n### You\n- not under a to-do heading\n', []), [])
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
