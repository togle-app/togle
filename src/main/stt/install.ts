import { app, net } from 'electron'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, promises as fs, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LocalModelId, LocalSpeechState } from '@shared/types'
import { engineById, engineFor, MODELS, RELEASE, whisperFor, type Download, type EngineBuild, type ModelFile } from './catalog'

// Hosts like GitHub and Hugging Face throttle a long-lived connection (one model took over five minutes for its first
// 50 MB), so a file comes as many short range requests over parallel connections. Where each part is, is saved beside
// it, so an install stopped or cut off picks up where it was.
const CONNECTIONS = 8
const CHUNK_BYTES = 16 * 1048576
const STALL_MS = 30_000
const MAX_CHUNK_ATTEMPTS = 30
// The window hears of an install's progress this often at most.
const PROGRESS_MS = 250
const LABELS: Record<LocalModelId, string> = { parakeet: 'Parakeet', 'whisper-turbo': 'Whisper large-v3-turbo', 'whisper-base': 'Whisper base' }

/** What Togle runs to hear on this PC: whisper.cpp's programs and libraries, and the models. */
export interface LocalSpeech {
  /** The folder with whisper-server (where there is one), the libraries and the compute backends. */
  binDir: string
  /** whisper-server; null on macOS, where Whisper runs from the library. */
  server: string | null
  /** The library with Parakeet's functions (on macOS, Whisper's too), and the one that loads the compute backends. */
  library: string
  ggml: string | null
  gpu: boolean
  whisperModel: string | null
  parakeetModel: string | null
}

/** What installed.json says Togle installed. */
interface Installed {
  release: string
  engine: string
  /** The folder the engine was unpacked into, under the speech folder. */
  dir: string
  models: LocalModelId[]
}

/**
 * Where the engine and models are kept: on Windows the local, not the roaming, application data (2 GB has no place in
 * a roaming profile); on Linux the user's data folder; on macOS Togle's own. A check of the window can point it at
 * its own folder (TOGLE_SPEECH_HOME, when Togle runs from source).
 */
export function speechHome(): string {
  if (!app.isPackaged && process.env.TOGLE_SPEECH_HOME) return process.env.TOGLE_SPEECH_HOME
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'togle', 'speech')
  if (process.platform === 'linux') return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'togle', 'speech')
  return path.join(app.getPath('userData'), 'speech')
}

/**
 * The environment native code runs in from a folder of libraries, so they're found there first: PATH on Windows,
 * LD_LIBRARY_PATH on Linux (macOS's framework needs nothing).
 */
export function libraryEnv(binDir: string): NodeJS.ProcessEnv {
  const name = process.platform === 'win32' ? 'PATH' : process.platform === 'linux' ? 'LD_LIBRARY_PATH' : null
  if (!name) return { ...process.env }
  // Windows keeps it as "Path": the same variable, whatever its case.
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === name) ?? name
  return { ...process.env, [key]: [binDir, process.env[key]].filter(Boolean).join(path.delimiter) }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Whether this PC has an NVIDIA GPU, as its driver's nvidia-smi says. */
function hasNvidiaGpu(): Promise<boolean> {
  return new Promise((resolve) => execFile('nvidia-smi', ['-L'], { timeout: 5000, windowsHide: true }, (err, out) => resolve(!err && /GPU/.test(String(out)))))
}

/** A file's SHA-256. */
function sha256Of(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

/** The system's own tar, which reads zip files too (bsdtar, on Windows and macOS) and .tar.gz (on Linux). */
function untar(archive: string, into: string, member?: string): Promise<void> {
  const tar =
    process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : process.platform === 'darwin' ? '/usr/bin/tar' : 'tar'
  return new Promise((resolve, reject) =>
    execFile(tar, ['-xf', archive, '-C', into, ...(member ? [member] : [])], { windowsHide: true, maxBuffer: 16 * 1048576 }, (err, _out, stderr) =>
      err ? reject(new Error(`Couldn't unpack ${path.basename(archive)}: ${String(stderr).trim() || err.message}`)) : resolve()
    )
  )
}

/** A file on this PC that may be one Togle would download: where it is, and how big. */
interface FileHere {
  path: string
  bytes: number
}

/** The files in these folders, a few levels down: what might be the same as a download (its size says, its checksum decides). */
async function filesIn(dirs: string[]): Promise<FileHere[]> {
  const found: FileHere[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const at = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) await walk(at, depth - 1)
      } else if (entry.isFile()) {
        const bytes = await fs.stat(at).then((s) => s.size, () => 0)
        if (bytes) found.push({ path: at, bytes })
      }
    }
  }
  for (const dir of dirs) await walk(dir, 3)
  return found
}

/** One range of a file still to fetch: `pos` is the next byte it needs. */
interface Chunk {
  pos: number
  end: number
}

/** Fetches one range into the file, again after a dropped or stalled connection, until it's all there. */
async function fetchChunk(url: string, chunk: Chunk, file: fs.FileHandle, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  for (let attempt = 1; chunk.pos < chunk.end; attempt++) {
    signal.throwIfAborted()
    const stalled = new AbortController()
    let watchdog = setTimeout(() => stalled.abort(new Error('stalled')), STALL_MS)
    try {
      const res = await net.fetch(url, { headers: { Range: `bytes=${chunk.pos}-${chunk.end - 1}` }, signal: AbortSignal.any([signal, stalled.signal]) })
      if (res.status !== 206 || !res.body) throw new Error(`HTTP ${res.status}`)
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        // Stopped: what came so far is kept, and the rest isn't read.
        if (signal.aborted) {
          void reader.cancel().catch(() => undefined)
          throw signal.reason
        }
        clearTimeout(watchdog)
        watchdog = setTimeout(() => stalled.abort(new Error('stalled')), STALL_MS)
        const len = Math.min(value.byteLength, chunk.end - chunk.pos)
        await file.write(value, 0, len, chunk.pos)
        chunk.pos += len
        onBytes(len)
      }
      if (chunk.pos < chunk.end) throw new Error('connection closed early')
    } catch (err) {
      if (signal.aborted) throw signal.reason ?? err
      if (attempt >= MAX_CHUNK_ATTEMPTS) throw err
      await sleep(Math.min(20_000, 1000 * attempt))
    } finally {
      clearTimeout(watchdog)
    }
  }
}

/**
 * Downloads a file to `dest`, picking up a download stopped before, and checks its SHA-256: a file that doesn't match
 * is deleted, never used. `onBytes` hears of every byte fetched, and first of those already there.
 */
export async function download(item: Download, dest: string, signal: AbortSignal, onBytes: (n: number) => void): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  const stateFile = `${tmp}.json`
  let chunks: Chunk[]
  try {
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8')) as { bytes: number; chunks: Chunk[] }
    if (saved.bytes !== item.bytes || !existsSync(tmp)) throw new Error('another file')
    chunks = saved.chunks.filter((c) => c.pos < c.end)
  } catch {
    await fs.rm(tmp, { force: true })
    chunks = []
    for (let start = 0; start < item.bytes; start += CHUNK_BYTES) chunks.push({ pos: start, end: Math.min(item.bytes, start + CHUNK_BYTES) })
  }
  onBytes(item.bytes - chunks.reduce((sum, c) => sum + c.end - c.pos, 0))
  const file = await fs.open(tmp, existsSync(tmp) ? 'r+' : 'w+')
  const saveState = (): Promise<void> => fs.writeFile(stateFile, JSON.stringify({ bytes: item.bytes, chunks }))
  const saver = setInterval(() => void saveState().catch(() => undefined), 1000)
  try {
    const queue = [...chunks]
    const worker = async (): Promise<void> => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) await fetchChunk(item.url, chunk, file, signal, onBytes)
    }
    await Promise.all(Array.from({ length: Math.min(CONNECTIONS, Math.max(1, queue.length)) }, worker))
  } finally {
    clearInterval(saver)
    await saveState().catch(() => undefined)
    await file.close()
  }
  if ((await sha256Of(tmp)) !== item.sha256) {
    await fs.rm(tmp, { force: true })
    await fs.rm(stateFile, { force: true })
    throw new Error(`${path.basename(dest)} came down damaged (its checksum doesn't match): install again to fetch it anew.`)
  }
  await fs.rename(tmp, dest)
  await fs.rm(stateFile, { force: true })
}

/**
 * Speech recognition on this PC: installs whisper.cpp for this system and the models when the user asks, and says
 * what to run. A copy set up for development (npm run setup:whisper, in resources/whisper) is used when nothing is
 * installed.
 */
export class SpeechInstaller extends EventEmitter {
  private abort: AbortController | null = null
  private progress: LocalSpeechState['installing']
  private error: string | undefined
  private gpu: Promise<boolean> | null = null
  // The files in the folders it may take files from, looked through once.
  private here: Promise<FileHere[]> | null = null

  constructor(
    private home = speechHome(),
    /** Where a development copy is (resources/whisper with its config.json), if anywhere. */
    private devRoot: string | null = null,
    /** What it downloads (the catalog's, unless a test gives its own). */
    private catalog: { engine?: EngineBuild | null; models?: Record<LocalModelId, ModelFile> } = {},
    /**
     * Folders this PC may have the same files in already (a development copy, one an older Togle came with): one there,
     * checked against its checksum, is taken from there rather than downloaded.
     */
    private seeds: string[] = []
  ) {
    super()
  }

  /** Files on this PC the same size as a download, that may be it (their checksum says, as one is taken). */
  private async onThisPC(item: Download): Promise<FileHere | undefined> {
    return (await this.sameSize(item))[0]
  }

  private async sameSize(item: Download): Promise<FileHere[]> {
    this.here ??= filesIn(this.seeds)
    return (await this.here).filter((f) => f.bytes === item.bytes)
  }

  /** The file on this PC that is the download, its checksum checked: the first of the same size whose checksum matches. */
  private async sameFile(item: Download, signal: AbortSignal): Promise<FileHere | undefined> {
    for (const file of await this.sameSize(item)) {
      signal.throwIfAborted()
      if ((await sha256Of(file.path).catch(() => '')) === item.sha256) return file
    }
    return undefined
  }

  /** The whisper.cpp build for this PC: CUDA on Windows with an NVIDIA GPU, else the CPU's; Metal on macOS. */
  async engine(): Promise<EngineBuild | null> {
    if (this.catalog.engine !== undefined) return this.catalog.engine
    // A check of the window can take another build than this PC's (TOGLE_SPEECH_ENGINE, when Togle runs from source):
    // the CPU's 9 MB rather than CUDA's 685.
    if (!app.isPackaged && process.env.TOGLE_SPEECH_ENGINE) return engineById(process.env.TOGLE_SPEECH_ENGINE)
    this.gpu ??= process.platform === 'win32' && process.arch === 'x64' ? hasNvidiaGpu() : Promise.resolve(false)
    return engineFor(process.platform, process.arch, await this.gpu)
  }

  private get models(): Record<LocalModelId, ModelFile> {
    return this.catalog.models ?? MODELS
  }

  private installedFile(): string {
    return path.join(this.home, 'installed.json')
  }

  /** What Togle installed, when all of it is still there. */
  private installed(): { record: Installed; engine: EngineBuild } | null {
    let record: Installed
    try {
      record = JSON.parse(readFileSync(this.installedFile(), 'utf8')) as Installed
    } catch {
      return null
    }
    const engine = this.catalog.engine?.id === record.engine ? this.catalog.engine : engineById(record.engine)
    if (!engine || record.release !== RELEASE || !existsSync(path.join(this.home, record.dir, engine.dir, engine.library))) return null
    const models = (record.models ?? []).filter((m) => m in this.models && this.hasModel(m))
    return { record: { ...record, models }, engine }
  }

  private modelPath(id: LocalModelId): string {
    return path.join(this.home, 'models', this.models[id].file)
  }

  private hasModel(id: LocalModelId): boolean {
    try {
      return statSync(this.modelPath(id)).size === this.models[id].bytes
    } catch {
      return false
    }
  }

  /** The development copy (npm run setup:whisper), as config.json describes it. */
  private dev(): LocalSpeech | null {
    if (!this.devRoot) return null
    try {
      const config = JSON.parse(readFileSync(path.join(this.devRoot, 'config.json'), 'utf8')) as { server: string; model: string; gpu: boolean }
      const server = path.join(this.devRoot, config.server)
      const binDir = path.dirname(server)
      const whisperModel = path.join(this.devRoot, config.model)
      const parakeetModel = path.join(path.dirname(whisperModel), MODELS.parakeet.file)
      if (!existsSync(server) || !existsSync(whisperModel)) return null
      return {
        binDir,
        server,
        library: path.join(binDir, 'parakeet.dll'),
        ggml: path.join(binDir, 'ggml.dll'),
        gpu: config.gpu,
        whisperModel,
        parakeetModel: existsSync(parakeetModel) ? parakeetModel : null
      }
    } catch {
      return null
    }
  }

  /** What to run to hear on this PC: what Togle installed, else a development copy, else nothing. */
  local(): LocalSpeech | null {
    const found = this.installed()
    if (!found) return this.dev()
    const { record, engine } = found
    const binDir = path.join(this.home, record.dir, engine.dir)
    const whisper = record.models.includes('whisper-turbo') ? 'whisper-turbo' : record.models.includes('whisper-base') ? 'whisper-base' : null
    return {
      binDir,
      server: engine.server ? path.join(binDir, engine.server) : null,
      library: path.join(binDir, engine.library),
      ggml: engine.ggml ? path.join(binDir, engine.ggml) : null,
      gpu: engine.gpu,
      whisperModel: whisper && this.modelPath(whisper),
      parakeetModel: record.models.includes('parakeet') ? this.modelPath('parakeet') : null
    }
  }

  /** For Settings: what's installed, what installing would download here, and how far an install has got. */
  async state(): Promise<LocalSpeechState> {
    const found = this.installed()
    const engine = await this.engine()
    const ids = Object.keys(this.models) as LocalModelId[]
    // What's on this PC already is taken from there: nothing of it to download.
    const engineHere = !!engine && found?.engine.id !== engine.id && !!(await this.onThisPC(engine))
    const modelsHere = new Set<LocalModelId>()
    for (const id of ids) if (!this.hasModel(id) && (await this.onThisPC(this.models[id]))) modelsHere.add(id)
    return {
      installed: found?.record.models ?? [],
      dev: !found && !!this.dev(),
      offer: engine && {
        gpu: engine.gpu,
        engine: found?.engine.id === engine.id || engineHere ? 0 : engine.bytes,
        models: ids.map((id) => ({
          id,
          label: LABELS[id],
          bytes: this.models[id].bytes,
          recommended: id === 'parakeet' || id === whisperFor(engine),
          ...(modelsHere.has(id) ? { here: true } : {})
        }))
      },
      ...(this.progress ? { installing: this.progress } : {}),
      ...(this.error ? { error: this.error } : {})
    }
  }

  private changed(): void {
    void this.state().then((state) => this.emit('change', state))
  }

  /** Downloads and sets up whisper.cpp for this PC (unless it's there) and the models asked for, beside any installed before. */
  async install(models: LocalModelId[]): Promise<void> {
    if (this.abort) return
    const engine = await this.engine()
    if (!engine) throw new Error("whisper.cpp has no build for this system: pick OpenAI or a speech server to hear calls.")
    const abort = (this.abort = new AbortController())
    const { signal } = abort
    this.error = undefined
    const found = this.installed()
    const haveEngine = found?.engine.id === engine.id
    const dir = `engine-${RELEASE}-${engine.id}`
    const wanted = [...new Set(models.filter((m) => m in this.models))]
    const fetch: { what: string; item: Download; dest: string; engine?: boolean }[] = [
      ...(haveEngine ? [] : [{ what: 'whisper.cpp', item: engine, dest: path.join(this.home, 'downloads', path.basename(engine.url)), engine: true }]),
      ...wanted.filter((m) => !this.hasModel(m)).map((m) => ({ what: LABELS[m], item: this.models[m], dest: this.modelPath(m) }))
    ]
    const total = fetch.reduce((sum, f) => sum + f.item.bytes, 0)
    let received = 0
    let told = 0
    try {
      await fs.mkdir(this.home, { recursive: true })
      // The space it needs, with room to unpack the engine beside its archive.
      const free = await fs.statfs(this.home).then((s) => s.bavail * s.bsize, () => Infinity)
      const needs = total + (haveEngine ? 0 : engine.bytes * 2)
      if (free < needs) throw new Error(`Not enough free space: it needs ${(needs / 1e9).toFixed(1)} GB, and ${(free / 1e9).toFixed(1)} GB is free.`)
      // Written as each piece is in, so an install stopped partway keeps what it finished: a model stopped after the
      // engine is unpacked doesn't fetch the engine again.
      const record: Installed = { release: RELEASE, engine: engine.id, dir, models: haveEngine ? found.record.models : [] }
      const keep = (): Promise<void> => fs.writeFile(this.installedFile(), JSON.stringify(record, null, 2))
      for (const f of fetch) {
        // The same file on this PC already (its checksum checked): linked where it goes, no second copy on the disk
        // (copied, on another drive), rather than downloaded.
        this.progress = { what: f.what, received, total, ...((await this.onThisPC(f.item)) ? { here: true } : {}) }
        this.changed()
        const here = await this.sameFile(f.item, signal)
        if (here) {
          signal.throwIfAborted()
          await fs.mkdir(path.dirname(f.dest), { recursive: true })
          await fs.rm(f.dest, { force: true })
          await fs.link(here.path, f.dest).catch(() => fs.copyFile(here.path, f.dest))
          received += f.item.bytes
        } else {
          this.progress = { what: f.what, received, total }
          this.changed()
          await download(f.item, f.dest, signal, (n) => {
            received += n
            if (Date.now() - told < PROGRESS_MS) return
            told = Date.now()
            this.progress = { what: f.what, received, total }
            this.changed()
          })
        }
        if (!f.engine) continue
        // Unpacked beside where it goes, then moved there whole: a half-unpacked engine is never run.
        const unpacked = path.join(this.home, `${dir}.tmp`)
        await fs.rm(unpacked, { recursive: true, force: true })
        await fs.mkdir(unpacked, { recursive: true })
        // On macOS only the framework for macOS, of all Apple's systems in the archive.
        await untar(f.dest, unpacked, process.platform === 'darwin' ? engine.dir.split('/whisper.framework')[0] : undefined)
        if (!existsSync(path.join(unpacked, engine.dir, engine.library))) throw new Error(`${path.basename(f.dest)} doesn't have ${engine.library}.`)
        await fs.rm(path.join(this.home, dir), { recursive: true, force: true })
        await fs.rename(unpacked, path.join(this.home, dir))
        await fs.rm(f.dest, { force: true })
        await keep()
      }
      record.models = [...new Set([...record.models, ...wanted])]
      await keep()
    } catch (err) {
      if (!signal.aborted) this.error = (err as Error).message
      throw err
    } finally {
      this.abort = null
      this.progress = undefined
      this.changed()
    }
  }

  /**
   * Nothing installed, and what suits this PC is on it already (the same files, on the same drive, so they're linked,
   * not copied): taken from there as Togle starts, so it hears calls without a download or a click. Otherwise it's
   * offered in Settings, as a download is (what's here then isn't downloaded).
   */
  async adopt(): Promise<boolean> {
    if (this.installed() || this.dev() || this.abort) return false
    const engine = await this.engine()
    if (!engine) return false
    const wanted = (Object.keys(this.models) as LocalModelId[]).filter((id) => id === 'parakeet' || id === whisperFor(engine))
    const drive = (file: string): string => path.parse(path.resolve(file)).root.toLowerCase()
    for (const item of [engine, ...wanted.map((id) => this.models[id])]) {
      const here = await this.onThisPC(item)
      if (!here || drive(here.path) !== drive(this.home)) return false
    }
    await this.install(wanted)
    return true
  }

  /** Stops an install; what it fetched so far is kept, for the next one to pick up. */
  cancel(): void {
    this.abort?.abort(new Error('Stopped'))
  }

  /** Deletes what Togle installed (stop what runs from it first). */
  async remove(): Promise<void> {
    this.cancel()
    await fs.rm(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    this.error = undefined
    this.changed()
  }
}
