// What Togle remembers of its tasks between runs: the names it gave them ("Port the settings screen"), which tasks it
// started, for the agents that cannot list their own sessions, and which finished since the person last looked at them.
import { readJson, writeJson } from '../storage'
import { applyGroupChange, cleanGroups, NO_GROUPS, type GroupChange, type TaskGroups } from '@shared/task-groups'
import type { FreshStore, RecordStore, TaskRecord, TitleStore } from './hub'

const TITLES = 'runner-titles.json'
const RECORDS = 'runner-tasks.json'
const FRESH = 'runner-fresh.json'
const GROUPS = 'runner-groups.json'
const KEEP = 500

/** Writes a file a moment after the last change, not once for each. */
export class Later {
  private timer: NodeJS.Timeout | null = null
  constructor(private readonly save: () => Promise<void>) {}
  ask(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.save().catch(() => undefined)
    }, 500)
    this.timer.unref?.()
  }
}

export class StoredTitles implements TitleStore {
  private titles: Record<string, string> = {}
  private readonly later = new Later(() => writeJson(TITLES, this.titles))

  async load(): Promise<void> {
    this.titles = await readJson<Record<string, string>>(TITLES, {})
  }

  get(key: string): string | undefined {
    return this.titles[key]
  }

  set(key: string, title: string): void {
    const clean = title.trim()
    if (!clean || this.titles[key] === clean) return
    delete this.titles[key]
    this.titles[key] = clean
    const keys = Object.keys(this.titles)
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete this.titles[old]
    this.later.ask()
  }
}

export class StoredRecords implements RecordStore {
  private records: TaskRecord[] = []
  private readonly later = new Later(() => writeJson(RECORDS, this.records))

  async load(): Promise<void> {
    const saved = await readJson<unknown>(RECORDS, [])
    this.records = Array.isArray(saved) ? saved.filter((r): r is TaskRecord => typeof r?.id === 'string' && typeof r?.runner === 'string' && typeof r?.folder === 'string') : []
  }

  all(): TaskRecord[] {
    return [...this.records]
  }

  add(record: TaskRecord): void {
    this.records = [...this.records.filter((r) => !(r.runner === record.runner && r.id === record.id)), record].slice(-KEEP)
    this.later.ask()
  }
}

/** The person's own arrangement of the Agents list (task-groups.ts): the groups they made, the names they gave, the tasks they moved. */
export class StoredGroups {
  private groups: TaskGroups = NO_GROUPS
  private readonly later: Later

  /** `file`: where it is kept (a test gives none). */
  constructor(private readonly file: string | null = GROUPS) {
    this.later = new Later(() => (file ? writeJson(file, this.groups) : Promise.resolve()))
  }

  async load(): Promise<void> {
    if (this.file) this.groups = cleanGroups(await readJson<unknown>(this.file, NO_GROUPS))
  }

  get(): TaskGroups {
    return this.groups
  }

  /** A change the person made, kept: the arrangement as it is now comes back (unchanged when the change did not fit). */
  change(change: GroupChange): TaskGroups {
    const next = applyGroupChange(this.groups, change)
    if (next !== this.groups) {
      this.groups = next
      this.later.ask()
    }
    return this.groups
  }
}

/**
 * The tasks that finished since the person last had them on screen: "done · new" in the list until they open one. A task is
 * marked when Togle sees its turn end (the same look that gives the notice that it finished), and not while it is on screen
 * in Togle's window with that window in front. Kept between runs, so a restart makes old news neither new nor gone. A task
 * Togle sees for the first time is not new: only what ends while Togle watches is.
 */
export class StoredFresh implements FreshStore {
  private fresh: Record<string, number> = {}
  private onScreen: string | null = null
  private readonly later: Later

  /** `front`: whether Togle's window is in front, where a task on screen is seen. `file`: where it is kept (a test gives none). */
  constructor(private readonly front: () => boolean, private readonly file: string | null = FRESH) {
    this.later = new Later(() => (file ? writeJson(file, this.fresh) : Promise.resolve()))
  }

  async load(): Promise<void> {
    if (!this.file) return
    const saved = await readJson<Record<string, unknown>>(this.file, {})
    this.fresh = Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  }

  has(key: string): boolean {
    return key in this.fresh
  }

  /** A task's turn ended, or it stopped by an error: new, unless the person is looking at it. Says whether it was marked. */
  finished(key: string, at = Date.now()): boolean {
    if (key === this.onScreen && this.front()) return false
    delete this.fresh[key]
    this.fresh[key] = at
    const keys = Object.keys(this.fresh)
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP))) delete this.fresh[old]
    this.later.ask()
    return true
  }

  /** The task on screen in the window, or none: it is seen now if the window is in front. Says whether one stopped being new. */
  shown(key: string | null): boolean {
    this.onScreen = key
    return this.look()
  }

  /** The window came to the front: the task on screen is seen. Says whether one stopped being new. */
  look(): boolean {
    if (!this.onScreen || !this.front() || !(this.onScreen in this.fresh)) return false
    delete this.fresh[this.onScreen]
    this.later.ask()
    return true
  }
}
