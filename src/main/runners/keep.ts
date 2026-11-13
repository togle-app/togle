// What a backend keeps between runs of Togle: a small JSON file in a folder of Togle's own, written whole.
import fs from 'node:fs/promises'
import path from 'node:path'

/** The write each file is waiting on: writes to one file go one after the other, so that an older one never lands after a newer. */
const queues = new Map<string, Promise<void>>()

/**
 * Writes `data` as the whole content of `file`, through a temporary file, and again when Windows has the file busy for a
 * moment (a virus scanner, the search indexer). A write that fails is only not kept: the caller goes on without it.
 */
export function keepJson(file: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data)
  const write = async (): Promise<void> => {
    const temp = `${file}.${process.pid}.tmp`
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(temp, text, { mode: 0o600 })
      for (let attempt = 1; ; attempt++) {
        try {
          await fs.rename(temp, file)
          return
        } catch (error) {
          const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')
          if (!busy || attempt >= 5) throw error
          await new Promise((resolve) => setTimeout(resolve, 50 * attempt))
        }
      }
    } catch {
      await fs.rm(temp, { force: true }).catch(() => undefined)
    }
  }
  const next = (queues.get(file) ?? Promise.resolve()).then(write)
  queues.set(file, next)
  return next
}
