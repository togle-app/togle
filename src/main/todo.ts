// The to-do list: a plain Markdown file of checkboxes that the person can also read and change in any editor. Every
// change reads the file again first and keeps every line it does not understand, so what was typed elsewhere is never
// written over. An item given to an agent carries the task in a comment at the end of its line.
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { TodoItem, TodoRef } from '@shared/todo'
import { writeFileAtomic } from './storage'

const ITEM = /^(\s*[-*+]\s+\[)([ xX])(\]\s+)(.*?)(?:\s*<!--\s*togle:task=(\S+?)\s*-->)?\s*$/
const LONGEST = 500

/** What a person may type as an item: one line, no comment marks (they would break the line's own note). */
const clean = (text: string): string => text.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim().slice(0, LONGEST)

function parse(lines: readonly string[]): TodoItem[] {
  const items: TodoItem[] = []
  lines.forEach((line, at) => {
    const match = ITEM.exec(line)
    if (match && match[4].trim()) items.push({ line: at, text: match[4].trim(), done: match[2] !== ' ', ...(match[5] ? { task: match[5] } : {}) })
  })
  return items
}

const note = (task: string | undefined): string => (task ? ` <!-- togle:task=${task} -->` : '')

export class TodoFile {
  private chain: Promise<unknown> = Promise.resolve()
  private watcher?: FSWatcher
  private timer?: NodeJS.Timeout

  /** `changed` is told when the file changes, whoever changes it. */
  constructor(readonly file: string, private readonly changed: () => void = () => undefined) {}

  async list(): Promise<TodoItem[]> {
    return parse(split(await this.read()).lines)
  }

  add(text: string): Promise<TodoItem[]> {
    const words = clean(text)
    if (!words) return Promise.reject(new Error('Say what the item is.'))
    return this.change((lines) => {
      if (!lines.length) lines.push('# To do', '')
      lines.push(`- [ ] ${words}`)
    })
  }

  setDone(ref: TodoRef, done: boolean): Promise<TodoItem[]> {
    return this.change((lines) => {
      const match = this.match(lines, ref)
      lines[ref.line] = `${match[1]}${done ? 'x' : ' '}${match[3]}${match[4].trim()}${note(match[5])}`
    })
  }

  edit(ref: TodoRef, text: string): Promise<TodoItem[]> {
    const words = clean(text)
    if (!words) return Promise.reject(new Error('Say what the item is.'))
    return this.change((lines) => {
      const match = this.match(lines, ref)
      lines[ref.line] = `${match[1]}${match[2]}${match[3]}${words}${note(match[5])}`
    })
  }

  remove(ref: TodoRef): Promise<TodoItem[]> {
    return this.change((lines) => {
      this.match(lines, ref)
      lines.splice(ref.line, 1)
    })
  }

  /** Gives an item to a task, or takes it back (`null`). */
  link(ref: TodoRef, task: string | null): Promise<TodoItem[]> {
    if (task !== null && !/^\S+$/.test(task)) return Promise.reject(new Error('That task has no name.'))
    return this.change((lines) => {
      const match = this.match(lines, ref)
      lines[ref.line] = `${match[1]}${match[2]}${match[3]}${match[4].trim()}${note(task ?? undefined)}`
    })
  }

  /** Tells `changed` when the file changes in an editor too. */
  async watch(): Promise<void> {
    if (this.watcher) return
    const directory = path.dirname(this.file)
    await fs.mkdir(directory, { recursive: true })
    const name = path.basename(this.file)
    try {
      this.watcher = watch(directory, (_event, changed) => {
        if (changed && changed !== name) return
        clearTimeout(this.timer)
        this.timer = setTimeout(this.changed, 150)
        this.timer.unref?.()
      })
      this.watcher.on('error', () => undefined)
    } catch {
      // Without a watcher the window still asks again when it is shown.
    }
  }

  dispose(): void {
    clearTimeout(this.timer)
    this.watcher?.close()
    this.watcher = undefined
  }

  private match(lines: readonly string[], ref: TodoRef): RegExpExecArray {
    const match = Number.isInteger(ref.line) ? ITEM.exec(lines[ref.line] ?? '') : null
    if (!match || clean(match[4]) !== clean(ref.text)) throw new Error('The list changed while you were looking at it. Look at it again.')
    return match
  }

  private async read(): Promise<string> {
    try {
      return await fs.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }

  /** One change at a time: read the file, change its lines, write it all at once. */
  private change(work: (lines: string[]) => void): Promise<TodoItem[]> {
    const run = this.chain.then(async () => {
      const { lines, eol } = split(await this.read())
      work(lines)
      await writeFileAtomic(this.file, lines.join(eol) + eol)
      return parse(lines)
    })
    this.chain = run.catch(() => undefined)
    return run
  }
}

function split(text: string): { lines: string[]; eol: string } {
  const lines = text.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return { lines, eol: text.includes('\r\n') ? '\r\n' : '\n' }
}
