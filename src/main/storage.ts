import { app, safeStorage } from 'electron'
import { closeSync, fsyncSync, openSync, promises as fs, renameSync, rmSync, writeSync } from 'node:fs'
import path from 'node:path'

const fileFor = (name: string): string => path.join(app.getPath('userData'), name)

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(fileFor(name), 'utf8')) as T
  } catch {
    return fallback
  }
}

let temps = 0

/**
 * Replaces a file all at once: a crash or power cut mid-save leaves the old file, never a truncated one
 * (which would load as empty and reset everything in it).
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}-${++temps}.tmp`
  try {
    const handle = await fs.open(temp, 'w')
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await fs.rename(temp, file)
        return
      } catch (err) {
        // Windows won't replace a file another program (antivirus, the search indexer) has open for a moment.
        const busy = ['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')
        if (!busy || attempt >= 5) throw err
        await new Promise((r) => setTimeout(r, 50 * attempt))
      }
    }
  } catch (err) {
    await fs.rm(temp, { force: true })
    throw err
  }
}

export async function writeJson(name: string, data: unknown): Promise<void> {
  await writeFileAtomic(fileFor(name), JSON.stringify(data, null, 2))
}

/** Secrets are encrypted with the OS keystore (DPAPI on Windows) before touching disk. */
export async function readSecret<T>(name: string): Promise<T | null> {
  try {
    const json = await readSecretJson(name)
    return json === null ? null : JSON.parse(json) as T
  } catch {
    return null
  }
}

/** The decrypted JSON, for stores that keep a bounded cache without serializing a large record again. */
export async function readSecretJson(name: string): Promise<string | null> {
  try {
    return safeStorage.decryptString(await fs.readFile(fileFor(name)))
  } catch {
    return null
  }
}

/**
 * writeSecret all at once, for when there's no time to wait (Windows is shutting down): the same atomic replace,
 * without the retries of a busy file.
 */
export function writeSecretSync(name: string, data: unknown | null): void {
  const file = fileFor(name)
  if (data === null) return rmSync(file, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; refusing to store secrets in plain text')
  const temp = `${file}.${process.pid}-${++temps}.tmp`
  try {
    const fd = openSync(temp, 'w')
    try {
      writeSync(fd, safeStorage.encryptString(JSON.stringify(data)))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

/** Whether secrets can be stored at all: without the OS keystore they aren't written in plain text. */
export const canStoreSecrets = (): boolean => safeStorage.isEncryptionAvailable()

export async function writeSecret(name: string, data: unknown | null): Promise<void> {
  if (data === null) {
    // A file another program holds for a moment (antivirus, the search indexer) is deleted once it lets go.
    await fs.rm(fileFor(name), { force: true, recursive: true, maxRetries: 5, retryDelay: 100 })
    return
  }
  await writeSecretJson(name, JSON.stringify(data))
}

/** writeSecret for what's already JSON (measured first, say): a large conversation isn't turned into text twice. */
export async function writeSecretJson(name: string, json: string): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; refusing to store secrets in plain text')
  await writeFileAtomic(fileFor(name), safeStorage.encryptString(json))
}
