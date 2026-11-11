// What Togle remembers of its tasks between runs: the names it gave them ("Port the settings screen"), and which tasks
// it started, for the agents that cannot list their own sessions.
import { readJson, writeJson } from '../storage'
import type { RecordStore, TaskRecord, TitleStore } from './hub'

const TITLES = 'runner-titles.json'
const RECORDS = 'runner-tasks.json'
const KEEP = 500

/** Writes a file a moment after the last change, not once for each. */
class Later {
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
