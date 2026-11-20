// What the window can ask of the to-do list: each a message from the window, answered with the whole list as it is after,
// and one to the window when the file changes (whoever changed it).
import type { TodoList, TodoRef } from '@shared/todo'
import { TodoFile } from './todo'

export interface TodoDeps {
  /** `ipcMain.handle`, without the event the window's message came with. */
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
  send(channel: string, payload: unknown): void
  /** Where the list is kept. */
  file: string
  /** Shows the file in the system's file manager. */
  reveal(file: string): void
}

function ref(value: unknown): TodoRef {
  const given = (value ?? {}) as Record<string, unknown>
  if (typeof given.line !== 'number' || !Number.isInteger(given.line) || given.line < 0 || typeof given.text !== 'string') throw new Error('Pick an item.')
  return { line: given.line, text: given.text }
}

const words = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Say what the item is.')
  return value
}

export function registerTodo(deps: TodoDeps): TodoFile {
  const todo = new TodoFile(deps.file, () => deps.send('todo:changed', null))
  const list = async (): Promise<TodoList> => ({ items: await todo.list(), file: todo.file })
  const { handle } = deps
  handle('todo:list', list)
  handle('todo:add', async (text) => (await todo.add(words(text)), list()))
  handle('todo:set-done', async (item, done) => (await todo.setDone(ref(item), done === true), list()))
  handle('todo:edit', async (item, text) => (await todo.edit(ref(item), words(text)), list()))
  handle('todo:remove', async (item) => (await todo.remove(ref(item)), list()))
  handle('todo:clear', async items => {
    if (!Array.isArray(items)) throw new Error('Choose the items to remove.')
    return { items: await todo.clear(items.map(ref)), file: todo.file }
  })
  handle('todo:link', async (item, task) => {
    if (task !== null && typeof task !== 'string') throw new Error('That task has no name.')
    await todo.link(ref(item), task)
    return list()
  })
  handle('todo:show-file', () => deps.reveal(todo.file))
  return todo
}
