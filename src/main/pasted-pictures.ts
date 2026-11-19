// A picture pasted into an agent's screen in Togle (a screenshot taken a moment before): kept as a file in Togle's own folder,
// whose path goes into the screen. Claude Code and Codex take a pasted path to a picture as a picture to attach; any other
// agent can open the file. A picture is kept a week, then deleted.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app, nativeImage } from 'electron'

const FOLDER = 'pasted'
/** How long a pasted picture is kept. */
export const PASTED_KEEP_MS = 7 * 86_400_000
/** The biggest picture kept. */
const MOST_BYTES = 25 * 1024 * 1024
/** The kinds the agents take as they are; any other picture is kept as a PNG. */
const KINDS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

const folder = (): string => path.join(app.getPath('userData'), FOLDER)

/** Keeps a pasted picture and gives back where it is. A picture of another kind (a bitmap) is kept as a PNG. */
export async function savePastedPicture(bytes: Uint8Array, type: string, now = Date.now()): Promise<string> {
  if (!(bytes instanceof Uint8Array) || !bytes.length) throw new Error('There was no picture to paste.')
  if (bytes.length > MOST_BYTES) throw new Error('That picture is too big to paste.')
  let data: Buffer = Buffer.from(bytes)
  let kind = KINDS[typeof type === 'string' ? type.toLowerCase() : '']
  if (!kind) {
    const image = nativeImage.createFromBuffer(data)
    if (image.isEmpty()) throw new Error('That is not a picture Togle can paste.')
    data = image.toPNG()
    kind = 'png'
  }
  await fs.mkdir(folder(), { recursive: true })
  // A name with no space in it, so that the path goes in as one word.
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  let file = path.join(folder(), `paste-${stamp}.${kind}`)
  for (let n = 2; await fs.stat(file).then(() => true, () => false); n++) file = path.join(folder(), `paste-${stamp}-${n}.${kind}`)
  await fs.writeFile(file, data)
  void prunePastedPictures(now)
  return file
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/**
 * A picture kept by `savePastedPicture`, as a data URL for the window to draw (a message that went with it shows it small). Only a
 * file of that name directly in the folder is read: a path in what somebody wrote is no way to read any other file. Null when it is
 * not there any more (a week has passed).
 */
export async function readPastedPicture(file: string): Promise<string | null> {
  const wanted = path.resolve(file)
  const kind = /^paste-[\w-]+\.(png|jpe?g|gif|webp)$/i.exec(path.basename(wanted))?.[1]?.toLowerCase()
  if (!kind || path.dirname(wanted).toLowerCase() !== path.resolve(folder()).toLowerCase()) return null
  const stat = await fs.stat(wanted).catch(() => null)
  if (!stat?.isFile() || stat.size > MOST_BYTES) return null
  const data = await fs.readFile(wanted).catch(() => null)
  return data ? `data:${MIME[kind]};base64,${data.toString('base64')}` : null
}

/** Deletes the pictures pasted more than a week ago. */
export async function prunePastedPictures(now = Date.now()): Promise<void> {
  const names = await fs.readdir(folder()).catch(() => [] as string[])
  for (const name of names) {
    if (!/^paste-[\w-]+\.(png|jpg|gif|webp)$/.test(name)) continue
    const file = path.join(folder(), name)
    const stat = await fs.stat(file).catch(() => null)
    if (stat && now - stat.mtimeMs > PASTED_KEEP_MS) await fs.rm(file, { force: true }).catch(() => undefined)
  }
}
