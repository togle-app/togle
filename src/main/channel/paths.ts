// Where the channel lives for one person's Togle, and the secret that goes with it.
import { createHash, randomBytes } from 'node:crypto'
import { promises as fs, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { secretOf } from './protocol'

/**
 * Where an installed Togle keeps its data, for a program that is not Togle and cannot ask it (the `togle` command in a
 * terminal). A development run keeps its data elsewhere: `TOGLE_DATA` names that folder.
 */
export function defaultDataFolder(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir(), platform: string = process.platform): string {
  if (env.TOGLE_DATA?.trim()) return env.TOGLE_DATA.trim()
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Togle')
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Togle')
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Togle')
}

/** The folder Togle keeps the channel's secret in. */
export const channelFolder = (dataFolder: string): string => path.join(dataFolder, 'channel')

/**
 * The name of the pipe (on Windows) or the socket file (elsewhere). It depends on the data folder, so a development run
 * and an installed Togle do not meet. Anyone can make something that answers to the name; what keeps that harmless is
 * the secret, not the name.
 */
export function channelAddress(dataFolder: string): string {
  // Always from the whole path: a socket named by a relative path would be found only from the folder it was made in.
  let folder = path.resolve(dataFolder)
  if (process.platform === 'win32') {
    // Electron and CLI callers can spell the same existing Windows profile with different casing.
    // Keep the on-disk spelling so a client also reaches older apps that already used that spelling.
    try { folder = realpathSync.native(folder) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const id = createHash('sha256').update(folder).digest('hex').slice(0, 16)
  if (process.platform === 'win32') return `\\\\.\\pipe\\togle-${id}`
  const inside = path.join(channelFolder(folder), 'channel.sock')
  // A socket's path has a short limit; past it the socket goes to the temporary folder, under a name made from the data folder.
  return Buffer.byteLength(inside) < 100 ? inside : path.join(os.tmpdir(), `togle-${id}.sock`)
}

const secretFile = (dataFolder: string): string => path.join(channelFolder(dataFolder), 'secret')

/**
 * Reads the secret in a file. One that is being written by another start at this moment is empty for a few
 * milliseconds, so what does not read as a secret is read again a few times before it is called damaged.
 */
async function readSecretFile(file: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return secretOf((await fs.readFile(file, 'utf8')).trim())
    } catch (error) {
      if (attempt >= 12 || (error as NodeJS.ErrnoException).code === 'ENOENT') throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

/** Reads the channel's secret, making it the first time: 32 random bytes, in a file only this person can read. */
export async function loadSecret(dataFolder: string): Promise<Buffer> {
  const file = secretFile(dataFolder)
  await fs.mkdir(channelFolder(dataFolder), { recursive: true, mode: 0o700 })
  try {
    return await readSecretFile(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    // `wx`: never over one that is there, so two starts at once cannot end with two secrets.
    await fs.writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return readSecretFile(file)
}

/** Reads the secret without making one: for a program that only asks Togle, and must not invent a secret of its own. */
export function readSecret(dataFolder: string): Promise<Buffer> {
  return readSecretFile(secretFile(dataFolder))
}
