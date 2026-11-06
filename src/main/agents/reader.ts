// Reading in a worker of its own: a file the user teaches an agent with, or an export of their chats. One that unpacks
// to gigabytes, or takes minutes, costs that worker only while calls go on.

/** What the worker reads: a file's text, the chats an export holds, or one chat of an export (see reader-worker.ts). */
export type ReadTask =
  | { task: 'file'; file: string; codePage?: number }
  | { task: 'chats'; file: string }
  | { task: 'chat'; file: string; id: string; part: number; n: number }

// Where the worker's script is (Togle sets it at start; without it, as in the tests, everything is read here).
let readerScript: string | undefined
const READ_TIMEOUT_MS = 60_000
const READ_MEMORY_MB = 1024

export function setReaderScript(script: string): void {
  readerScript = script
}

/**
 * What `task` reads, read in a worker with a memory limit and a time limit, so a file built to blow up (a Word file
 * that unpacks to gigabytes, a PDF of one page repeated) fails on its own; `here` reads it in this thread instead,
 * where there's no worker.
 */
export async function inReader<T>(task: ReadTask, here: () => Promise<T>, timeoutMs = READ_TIMEOUT_MS): Promise<T> {
  if (!readerScript) return here()
  const { Worker } = await import('node:worker_threads')
  return new Promise((resolve, reject) => {
    const worker = new Worker(readerScript!, { workerData: task, resourceLimits: { maxOldGenerationSizeMb: READ_MEMORY_MB } })
    let settled = false
    const end = (err?: Error, value?: T): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (err) reject(err)
      else resolve(value as T)
    }
    const timer = setTimeout(() => end(new Error('reading it took too long')), timeoutMs)
    worker.once('message', (m: { value?: T; error?: string }) => (m.error !== undefined ? end(new Error(m.error)) : end(undefined, m.value)))
    worker.once('error', (err: Error & { code?: string }) => {
      if (err.code === 'ERR_WORKER_OUT_OF_MEMORY') return end(new Error('it holds more than Togle can read'))
      // The worker itself can't start (its script missing from a build): read it here, as before there was one.
      if (err.code === 'ERR_MODULE_NOT_FOUND' || err.code === 'MODULE_NOT_FOUND' || err.code === 'ERR_WORKER_PATH') {
        console.warn('[knowledge] reader worker unavailable:', err.message)
        settled = true
        clearTimeout(timer)
        return void here().then(resolve, reject)
      }
      end(err)
    })
    worker.once('exit', () => end(new Error('it holds more than Togle can read')))
  })
}
