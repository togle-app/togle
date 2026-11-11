// The names Togle gave tasks ("Port the settings screen"), kept between runs: the agents name their own sessions by what
// was asked first, and a name chosen here is the one the person knows the task by.
import { readJson, writeJson } from '../storage'
import type { TitleStore } from './hub'

const FILE = 'runner-titles.json'
const KEEP = 500

export class StoredTitles implements TitleStore {
  private titles: Record<string, string> = {}
  private timer: NodeJS.Timeout | null = null

  async load(): Promise<void> {
    this.titles = await readJson<Record<string, string>>(FILE, {})
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
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void writeJson(FILE, this.titles).catch(() => undefined)
    }, 500)
  }
}
