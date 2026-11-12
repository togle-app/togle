import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('todo')
const T = await import('./.build/togle.mjs')

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-todo-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const fileOf = () => path.join(scratch(), 'to-do.md')
const read = (file) => readFileSync(file, 'utf8')
const until = async (check, what, ms = 4000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('an item can be added already given to a task, as a task started elsewhere is', async () => {
  const todo = new T.TodoFile(fileOf())
  const items = await todo.add('Add a dark mode switch', 'claude:abc-123')
  assert.deepEqual(items, [{ line: 2, text: 'Add a dark mode switch', done: false, task: 'claude:abc-123' }])
  assert.equal(read(todo.file), '# To do\n\n- [ ] Add a dark mode switch <!-- togle:task=claude:abc-123 -->\n')
  await assert.rejects(todo.add('Another', 'two words'), /That task has no name/)
})

test('a list that is not there yet is empty, and the first item makes the file', async () => {
  const file = fileOf()
  const todo = new T.TodoFile(file)
  assert.deepEqual(await todo.list(), [])
  const items = await todo.add('Review the onboarding copy')
  assert.deepEqual(items, [{ line: 2, text: 'Review the onboarding copy', done: false }])
  assert.equal(read(file), '# To do\n\n- [ ] Review the onboarding copy\n')
  await todo.add('Send the invoice to Marta')
  assert.equal(read(file), '# To do\n\n- [ ] Review the onboarding copy\n- [ ] Send the invoice to Marta\n')
})

test('the file is read as a person would write it, and lines that are not items are left alone', async () => {
  const file = fileOf()
  writeFileSync(file, ['# To do', '', 'Notes for Thursday.', '', '- [ ] Plain', '* [x] Ticked with a star', '+ [X] Capital X', '  - [ ] Nested', '- [ ] Given away <!-- togle:task=claude:3f2a9c -->', '- [ ]', '- not a checkbox', '- [ ]no space', '', '## Later', '- [ ] Last one', ''].join('\n'))
  const items = await new T.TodoFile(file).list()
  assert.deepEqual(items.map((i) => [i.line, i.text, i.done, i.task ?? null]), [
    [4, 'Plain', false, null],
    [5, 'Ticked with a star', true, null],
    [6, 'Capital X', true, null],
    [7, 'Nested', false, null],
    [8, 'Given away', false, 'claude:3f2a9c'],
    [14, 'Last one', false, null]
  ])
})

test('ticking, editing, giving to a task and deleting change that line and nothing else', async () => {
  const file = fileOf()
  const original = ['# To do', '', 'Notes for Thursday.', '', '* [ ] First', '- [ ] Second', '  - [ ] Third', ''].join('\n')
  writeFileSync(file, original)
  const todo = new T.TodoFile(file)
  const [first, second, third] = await todo.list()

  await todo.setDone(first, true)
  assert.equal(read(file), original.replace('* [ ] First', '* [x] First'), 'the bullet is as they wrote it')
  await todo.setDone({ line: 4, text: 'First' }, false)
  assert.equal(read(file), original)

  const linked = await todo.link(second, 'codex:019a-b7')
  assert.equal(linked[1].task, 'codex:019a-b7')
  assert.ok(read(file).includes('- [ ] Second <!-- togle:task=codex:019a-b7 -->'))
  await todo.setDone({ line: 5, text: 'Second' }, true)
  assert.ok(read(file).includes('- [x] Second <!-- togle:task=codex:019a-b7 -->'), 'ticking keeps the task')
  await todo.edit({ line: 5, text: 'Second' }, 'Second, with more words')
  assert.ok(read(file).includes('- [x] Second, with more words <!-- togle:task=codex:019a-b7 -->'), 'editing keeps the task and the tick')
  await todo.link({ line: 5, text: 'Second, with more words' }, null)
  assert.ok(read(file).includes('- [x] Second, with more words\n'), 'taking it back from the task')

  await todo.remove(third)
  assert.equal(read(file), ['# To do', '', 'Notes for Thursday.', '', '* [ ] First', '- [x] Second, with more words', ''].join('\n'))
})

test('a change to an item that is not what the person looked at is refused, and the file is not touched', async () => {
  const file = fileOf()
  writeFileSync(file, '- [ ] One\n- [ ] Two\n')
  const todo = new T.TodoFile(file)
  const before = read(file)
  await assert.rejects(todo.setDone({ line: 0, text: 'Two' }, true), /The list changed/)
  await assert.rejects(todo.remove({ line: 5, text: 'One' }), /The list changed/)
  await assert.rejects(todo.edit({ line: 1.5, text: 'Two' }, 'x'), /The list changed/)
  await assert.rejects(todo.link({ line: 0, text: 'One' }, 'two words'), /no name/)
  assert.equal(read(file), before)
  // What they typed in an editor in the meantime is what is changed, not a copy from before.
  writeFileSync(file, '- [ ] Inserted above\n- [ ] One\n- [ ] Two\n')
  await assert.rejects(todo.setDone({ line: 0, text: 'One' }, true), /The list changed/)
  await todo.setDone({ line: 1, text: 'One' }, true)
  assert.equal(read(file), '- [ ] Inserted above\n- [x] One\n- [ ] Two\n')
})

test('what is typed is one clean line, and nothing can break the note a line keeps', async () => {
  const file = fileOf()
  const todo = new T.TodoFile(file)
  await assert.rejects(todo.add('   '), /Say what the item is/)
  await assert.rejects(todo.add(''), /Say what the item is/)
  const items = await todo.add('  Fix the\n   login <!-- togle:task=evil --> redirect --> now  ')
  assert.equal(items[0].text, 'Fix the login togle:task=evil redirect now')
  assert.equal(items[0].task, undefined, 'typed words never name a task')
  const long = await todo.add('x'.repeat(900))
  assert.equal(long[1].text.length, 500)
  await assert.rejects(todo.edit(items[0], '<!-- -->'), /Say what the item is/)
})

test('windows line endings stay, and many changes at once all land', async () => {
  const file = fileOf()
  writeFileSync(file, '# To do\r\n\r\n- [ ] One\r\n')
  const todo = new T.TodoFile(file)
  await todo.add('Two')
  assert.equal(read(file), '# To do\r\n\r\n- [ ] One\r\n- [ ] Two\r\n')
  const fresh = fileOf()
  const many = new T.TodoFile(fresh)
  await Promise.all(Array.from({ length: 25 }, (_, n) => many.add(`Item ${n}`)))
  const items = await many.list()
  assert.equal(items.length, 25, 'no change was lost')
  assert.deepEqual(items.map((i) => i.text).sort(), Array.from({ length: 25 }, (_, n) => `Item ${n}`).sort())
  assert.equal(read(fresh).split('\n').filter((line) => line.startsWith('- [ ] ')).length, 25)
})

test('a change made in an editor is told, and a closed list tells nothing more', async () => {
  const file = fileOf()
  writeFileSync(file, '- [ ] One\n')
  const told = []
  const todo = new T.TodoFile(file, () => told.push(Date.now()))
  await todo.watch()
  writeFileSync(file, '- [ ] One\n- [ ] Two\n')
  await until(() => told.length > 0, 'the change to be told')
  assert.equal((await todo.list()).length, 2)
  await todo.add('Three')
  await until(() => told.length > 1, 'a change made here to be told as well')
  todo.dispose()
  const seen = told.length
  writeFileSync(file, '- [ ] Four\n')
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(told.length, seen)
})

test('the window can ask for the list through its messages, and a bad message is refused in words', async () => {
  const handlers = new Map()
  const sent = []
  const file = fileOf()
  const revealed = []
  const todo = T.registerTodo({ handle: (channel, listener) => handlers.set(channel, listener), send: (channel, payload) => sent.push([channel, payload]), file, reveal: (f) => revealed.push(f) })
  try {
    for (const channel of ['list', 'add', 'set-done', 'edit', 'remove', 'link', 'show-file']) assert.ok(handlers.has(`todo:${channel}`), channel)
    assert.deepEqual(await handlers.get('todo:list')(), { items: [], file })
    const added = await handlers.get('todo:add')('Write the release notes')
    assert.deepEqual(added, { items: [{ line: 2, text: 'Write the release notes', done: false }], file })
    const ticked = await handlers.get('todo:set-done')({ line: 2, text: 'Write the release notes' }, true)
    assert.equal(ticked.items[0].done, true)
    const linked = await handlers.get('todo:link')({ line: 2, text: 'Write the release notes' }, 'hermes:local-abc')
    assert.equal(linked.items[0].task, 'hermes:local-abc')
    assert.equal((await handlers.get('todo:link')({ line: 2, text: 'Write the release notes' }, null)).items[0].task, undefined)
    const edited = await handlers.get('todo:edit')({ line: 2, text: 'Write the release notes' }, 'Write the notes')
    assert.equal(edited.items[0].text, 'Write the notes')
    assert.equal((await handlers.get('todo:remove')({ line: 2, text: 'Write the notes' })).items.length, 0)
    await assert.rejects(async () => handlers.get('todo:add')(42), /Say what the item is/)
    await assert.rejects(async () => handlers.get('todo:set-done')(null, true), /Pick an item/)
    await assert.rejects(async () => handlers.get('todo:set-done')({ line: -1, text: 'x' }, true), /Pick an item/)
    await assert.rejects(async () => handlers.get('todo:remove')({ line: 'one', text: 'x' }), /Pick an item/)
    await assert.rejects(async () => handlers.get('todo:link')({ line: 2, text: 'x' }, 7), /no name/)
    handlers.get('todo:show-file')()
    assert.deepEqual(revealed, [file])
    await todo.watch()
    writeFileSync(file, '- [ ] From an editor\n')
    await until(() => sent.some(([channel]) => channel === 'todo:changed'), 'the window to be told')
  } finally {
    todo.dispose()
  }
})

test('a request can be allowed from a small place only when all of it is shown and it is not dangerous', () => {
  const command = (text, extra = {}) => T.canAllowHere({ kind: 'command', command: text, ...extra })
  assert.equal(command('npm run migrate'), true)
  assert.equal(command('npm run migrate', { danger: 'It deletes files or folders for good.' }), false)
  assert.equal(command(''), false)
  assert.equal(command('x'.repeat(240)), true)
  assert.equal(command('x'.repeat(241)), false)
  assert.equal(command('a\nb\nc\nd'), true)
  assert.equal(command('a\nb\nc\nd\ne'), false)
  assert.equal(T.canAllowHere({ kind: 'command', raw: 'git status' }), true, 'the command as sent, when it was not unwrapped')
  assert.equal(T.canAllowHere({ kind: 'edit', files: ['C:\\work\\a.css'] }), true)
  assert.equal(T.canAllowHere({ kind: 'edit', files: [] }), false)
  assert.equal(T.canAllowHere({ kind: 'edit', files: ['1', '2', '3', '4', '5'] }), false)
  assert.equal(T.canAllowHere({ kind: 'question' }), false)
})
