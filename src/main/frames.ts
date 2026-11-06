import { app, nativeImage, net, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Frame } from '@shared/types'

export const FRAME_SCHEME = 'togle-frame'
// Calls' pictures stay on disk this long, then get deleted on the next start.
const KEEP_SESSIONS_MS = 3 * 24 * 3600_000
// The frame on screen goes into one answer after another, and into its description: the last few stay ready.
const CACHED_URLS = 12
// A frame shrunk to this size still tells one view from another (other people, a shared screen).
const MINI_WIDTH = 32
const MINI_HEIGHT = 18

const sessionsDir = (): string => path.join(app.getPath('userData'), 'sessions')

/** Must run before the app is ready. */
export function registerFrameScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: FRAME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])
}

/** Serves frame images to the window as togle-frame://<session>/<file>, from the sessions folder only. */
export function serveFrames(): void {
  protocol.handle(FRAME_SCHEME, (request) => {
    const url = new URL(request.url)
    const root = sessionsDir()
    const file = path.join(root, path.basename(url.hostname), path.basename(decodeURIComponent(url.pathname)))
    if (!file.startsWith(root + path.sep)) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

/** The pictures of one call, saved as files so long calls don't sit in memory. */
export class FrameStore {
  private session: string = randomUUID()
  private count = 0
  /** Data: URLs made recently, by frame and width, most recently used last. */
  private urls = new Map<string, Promise<string>>()
  private minis = new Map<string, Promise<Uint8Array | undefined>>()

  private get dir(): string {
    return path.join(sessionsDir(), this.session)
  }

  /** The folder of this call's pictures. */
  get sessionId(): string {
    return this.session
  }

  /** Goes on with the pictures of a call picked up again: new ones are numbered after its last. */
  resume(session: string, lastNumber: number): void {
    this.session = path.basename(session)
    this.count = lastNumber
    this.urls.clear()
    this.minis.clear()
  }

  async add(kind: Frame['kind'], at: number, image: Buffer, thumb: Buffer): Promise<Frame> {
    const n = ++this.count
    // A call can end while disk IO is pending; never write its pixels into the replacement call.
    const session = this.session, dir = this.dir
    await fs.mkdir(dir, { recursive: true })
    await Promise.all([fs.writeFile(path.join(dir, `F${n}.jpg`), image), fs.writeFile(path.join(dir, `F${n}-thumb.jpg`), thumb)])
    const base = `${FRAME_SCHEME}://${session}`
    return { id: randomUUID(), n, at, kind, imageUrl: `${base}/F${n}.jpg`, thumbUrl: `${base}/F${n}-thumb.jpg` }
  }

  /** The frame as a data: URL for the model, scaled down to `maxWidth` when it's wider. */
  dataUrl(frame: Frame, maxWidth = Infinity): Promise<string> {
    const key = `${this.session}/${frame.n}/${maxWidth}`
    let url = this.urls.get(key)
    if (url) this.urls.delete(key)
    else {
      url = this.encode(frame, maxWidth)
      url.catch(() => this.urls.delete(key))
    }
    this.urls.set(key, url)
    if (this.urls.size > CACHED_URLS) this.urls.delete(this.urls.keys().next().value!)
    return url
  }

  /** The frame shrunk to 32×18 grayscale, from its thumbnail. */
  miniature(frame: Frame): Promise<Uint8Array | undefined> {
    const key = `${this.session}/${frame.n}`
    let mini = this.minis.get(key)
    if (!mini) {
      mini = fs
        .readFile(path.join(this.dir, `F${frame.n}-thumb.jpg`))
        .then((file) => {
          const pixels = nativeImage.createFromBuffer(file).resize({ width: MINI_WIDTH, height: MINI_HEIGHT, quality: 'good' }).toBitmap()
          const lum = new Uint8Array(MINI_WIDTH * MINI_HEIGHT)
          for (let i = 0; i < lum.length; i++) lum[i] = (pixels[i * 4] * 29 + pixels[i * 4 + 1] * 150 + pixels[i * 4 + 2] * 77) >> 8
          return lum
        })
        .catch(() => {
          // Not cached: the next look may find the file.
          this.minis.delete(key)
          return undefined
        })
      this.minis.set(key, mini)
    }
    return mini
  }

  private async encode(frame: Frame, maxWidth: number): Promise<string> {
    const file: Buffer = await fs.readFile(path.join(this.dir, `F${frame.n}.jpg`))
    const image = nativeImage.createFromBuffer(file)
    // A damaged file would be sent as an image the model refuses, failing the whole request.
    if (image.isEmpty()) throw new Error(`F${frame.n} isn't a readable picture`)
    const buf = image.getSize().width > maxWidth ? image.resize({ width: maxWidth, quality: 'best' }).toJPEG(85) : file
    return `data:image/jpeg;base64,${buf.toString('base64')}`
  }

  /** Starts a new call; the previous call's pictures are deleted. */
  async reset(): Promise<void> {
    const old = this.dir
    this.session = randomUUID()
    this.count = 0
    this.urls.clear()
    this.minis.clear()
    await fs.rm(old, { recursive: true, force: true })
  }

  /** Deletes pictures of calls older than a few days, except those of the call picked up again (`keep`). */
  static async cleanup(keep?: string): Promise<void> {
    const root = sessionsDir()
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === keep) continue
      const dir = path.join(root, entry.name)
      const stat = await fs.stat(dir).catch(() => null)
      if (stat && Date.now() - stat.mtimeMs > KEEP_SESSIONS_MS) await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
