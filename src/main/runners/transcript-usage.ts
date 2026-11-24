import { createReadStream, promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import type { RunnerUsage } from '@shared/runner-usage'
import { rec } from './jsonrpc'

const HOUR = 3_600_000
const WEEK = 7 * 24 * HOUR
const uuid = '[\\da-f]{8}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{4}-[\\da-f]{12}'
const claudeName = new RegExp('^(' + uuid + ')\\.jsonl$', 'i')
const rolloutName = new RegExp('^rollout-.+-(' + uuid + ')\\.jsonl$', 'i')
const unavailable = { kind: 'unavailable', reason: 'unsupported' } as const

interface UsageFile { file: string; id: string }
interface Charge { at: number; tokens: number }
interface Counter {
  calls: Map<string, Charge>
  offset: number
  size: number
  mtime: number
  ino: number
  checked: number
  previous: number
  forkedAt: number
}

async function entries(dir: string) {
  return fs.readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return []
    throw error
  })
}

export async function codexUsageFiles(home: string): Promise<UsageFile[]> {
  const found: UsageFile[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    for (const item of await entries(dir)) {
      const file = path.join(dir, item.name)
      if (item.isDirectory() && depth && /^\d{2,4}$/.test(item.name)) await walk(file, depth - 1)
      const id = item.isFile() && rolloutName.exec(item.name)?.[1]
      if (id) found.push({ file, id })
    }
  }
  await Promise.all([walk(path.join(home, 'sessions'), 3), walk(path.join(home, 'archived_sessions'), 0)])
  return found
}

export async function claudeUsageFiles(homes: string[]): Promise<UsageFile[]> {
  const found: UsageFile[] = []
  for (const home of homes) {
    const projects = path.join(home, 'projects')
    for (const project of await entries(projects)) {
      if (!project.isDirectory()) continue
      const dir = path.join(projects, project.name)
      for (const item of await entries(dir)) {
        const id = claudeName.exec(item.name)?.[1]
        if (id && item.isFile()) found.push({ file: path.join(dir, item.name), id })
        if (!item.isDirectory() || !claudeName.test(item.name + '.jsonl')) continue
        const helpers = path.join(dir, item.name, 'subagents')
        for (const sub of await entries(helpers)) {
          if (sub.isFile() && /^agent-[\w-]+\.jsonl$/i.test(sub.name)) found.push({ file: path.join(helpers, sub.name), id: item.name })
        }
      }
    }
  }
  return found
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

function include(calls: Map<string, Charge>, key: string, charge: Charge): void {
  const old = calls.get(key)
  if (!old || charge.tokens > old.tokens) calls.set(key, { at: old ? Math.min(old.at, charge.at) : charge.at, tokens: charge.tokens })
}

/** Retains only numeric readings and message IDs. A minute refresh reads newly appended bytes. */
export class TranscriptUsage {
  private readonly counters = new Map<string, Counter>()
  private readonly pending = new Map<string, Promise<Counter>>()

  constructor(private readonly agent: 'codex' | 'claude', private readonly files: () => Promise<UsageFile[]>) {}

  private line(line: Buffer, id: string, counter: Counter): void {
    if (this.agent === 'claude' ? !line.includes('"usage"') : !line.includes('"token_count"') && !line.includes('"session_meta"')) return
    let row
    try { row = rec(JSON.parse(line.toString('utf8'))) } catch { return }
    const at = Date.parse(String(row.timestamp))
    if (!Number.isFinite(at)) return
    if (this.agent === 'claude') {
      if (row.type !== 'assistant' || (row.sessionId && row.sessionId !== id)) return
      const message = rec(row.message)
      const usage = rec(message.usage)
      if (typeof message.id !== 'string' || !message.id || message.model === '<synthetic>' || !count(usage.input_tokens) || !count(usage.output_tokens)) return
      const tokens = [usage.input_tokens, usage.output_tokens, usage.cache_creation_input_tokens, usage.cache_read_input_tokens]
        .reduce<number>((sum, value) => sum + (count(value) ? value : 0), 0)
      // Several assistant/content blocks can carry the same model response, including after a fork.
      include(counter.calls, message.id, { at, tokens })
      return
    }
    const payload = rec(row.payload)
    if (row.type === 'session_meta' && payload.id === id && payload.forked_from_id) {
      counter.forkedAt = Date.parse(String(payload.timestamp)) || at
      return
    }
    if (row.type !== 'event_msg' || payload.type !== 'token_count') return
    const info = rec(payload.info)
    const total = rec(info.total_token_usage).total_tokens
    if (!count(total)) return
    const last = rec(info.last_token_usage).total_tokens
    const delta = total - counter.previous
    counter.previous = total
    if (at < counter.forkedAt || delta <= 0) return
    const tokens = counter.forkedAt && count(last) ? Math.min(delta, last) : delta
    include(counter.calls, id + '/' + at + '/' + total, { at, tokens })
  }

  private async scan({ file, id }: UsageFile, stat: Stats): Promise<Counter> {
    let counter = this.counters.get(file)
    if (!counter || counter.ino !== stat.ino || stat.size < counter.size || (stat.size === counter.size && stat.mtimeMs !== counter.mtime)) {
      counter = { calls: new Map(), offset: 0, size: 0, mtime: 0, ino: stat.ino, checked: 0, previous: 0, forkedAt: 0 }
      this.counters.set(file, counter)
    }
    counter.checked = Date.now()
    if (stat.size === counter.size && stat.mtimeMs === counter.mtime) return counter
    if (stat.size > counter.offset) {
      let tail: Buffer[] = []
      const stream = createReadStream(file, { start: counter.offset, end: stat.size - 1, highWaterMark: 256 * 1024 })
      for await (const chunk of stream as AsyncIterable<Buffer>) {
        let start = 0
        for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
          const part = chunk.subarray(start, end)
          const line = tail.length ? Buffer.concat([...tail, part]) : part
          this.line(line, id, counter)
          counter.offset += line.length + 1
          tail = []
          start = end + 1
        }
        if (start < chunk.length) tail.push(chunk.subarray(start))
      }
      // The writer can still be in the middle of a JSON line. Resume at its first byte next time.
    }
    counter.size = stat.size
    counter.mtime = stat.mtimeMs
    return counter
  }

  async read(id?: string, now = Date.now()): Promise<RunnerUsage> {
    const all = await this.files()
    const files = id === undefined ? all : all.filter(item => item.id === id)
    if (!files.length) return unavailable
    const since = id === undefined ? now - WEEK : 0
    for (const [file, counter] of this.counters) if (Date.now() - counter.checked > 10 * 60_000 && !this.pending.has(file)) this.counters.delete(file)
    const calls = new Map<string, Charge>()
    let scanned = false, metered = false
    for (let i = 0; i < files.length; i += 4) {
      const counters = await Promise.all(files.slice(i, i + 4).map(async item => {
        const stat = await fs.stat(item.file).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (!stat || stat.mtimeMs < since) return
        let pending = this.pending.get(item.file)
        if (!pending) {
          pending = this.scan(item, stat).finally(() => this.pending.delete(item.file))
          this.pending.set(item.file, pending)
        }
        return pending
      }))
      for (const counter of counters) if (counter) {
        scanned = true
        metered ||= counter.calls.size > 0
        for (const [key, charge] of counter.calls) if (charge.at >= since && charge.at <= now) include(calls, key, charge)
      }
    }
    if ((scanned && !metered) || (id !== undefined && !calls.size)) return unavailable
    let total = 0
    for (const charge of calls.values()) total += charge.tokens
    return { kind: 'tokens', period: id === undefined ? '7d' : 'session', total }
  }
}
