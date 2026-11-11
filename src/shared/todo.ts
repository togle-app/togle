// The to-do list as the window sees it. It is kept as a plain Markdown file of checkboxes, so these are lines of it.

/** One item: a line of the file. */
export interface TodoItem {
  /** Which line of the file it is, counting from 0. */
  line: number
  text: string
  done: boolean
  /** The agent task it was given to, by key (`claude:3f2a…`). */
  task?: string
}

/** Names an item for a change: its line, and the words it had when the person looked, so a change never lands on another item. */
export interface TodoRef {
  line: number
  text: string
}

export interface TodoList {
  items: TodoItem[]
  /** Where the file is on this computer. */
  file: string
}
