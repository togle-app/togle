// Togle's updates, as the design says: every update is signed with a key kept off every server, and Togle checks the
// signature before it installs anything. Once a day it looks at the latest release; a newer one signed by the key Togle
// carries (release-key.ts) waits until the person chooses to restart, and one that isn't is deleted and never runs.
// Until a release key is set, Togle doesn't look for updates at all.
import { createHash, verify as verifySignature } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { UpdateState } from '@shared/updates'
import { betaBuild } from './release-channel'
export type { UpdatePhase, UpdateState } from '@shared/updates'

export interface ReleaseAsset { name: string; browser_download_url: string }
export interface Release { tag_name: string; assets: ReleaseAsset[]; prerelease?: boolean }

/** Whether version `a` is newer than `b` ("v0.2.0" > "0.1.9"); anything after a "-" is a pre-release, older than without. */
export function newer(a: string, b: string): boolean {
  const parse = (value: string): [number[], string] => {
    const [core, pre = ''] = value.replace(/^v/i, '').split('-', 2)
    return [core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre]
  }
  const [x, xp] = parse(a), [y, yp] = parse(b)
  for (let index = 0; index < 3; index++) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) > (y[index] ?? 0)
  if (xp === yp) return false
  const beta = /^beta\.(\d+)$/
  const xa = beta.exec(xp)
  const ya = beta.exec(yp)
  if (xa && ya) return Number(xa[1]) > Number(ya[1])
  return !xp ? true : !yp ? false : xp > yp
}

/** The build for this system in a release, and its signature, by the same rules as install.ps1 and install.sh. */
export function assetFor(platform: NodeJS.Platform, arch: string, assets: ReleaseAsset[]): { build: ReleaseAsset; signature: ReleaseAsset } | undefined {
  const fits = (name: string): boolean => {
    if (name.endsWith('.sig')) return false
    if (platform === 'win32') return /Setup.*\.exe$/i.test(name)
    if (platform === 'darwin') return arch === 'arm64' ? /-arm64-mac\.zip$/.test(name) : /-mac\.zip$/.test(name) && !/arm64/.test(name)
    if (platform === 'linux') return arch === 'x64' && /\.AppImage$/.test(name)
    return false
  }
  const build = assets.find((asset) => fits(asset.name))
  const signature = build && assets.find((asset) => asset.name === build.name + '.sig')
  return build && signature ? { build, signature } : undefined
}

export interface UpdateOptions {
  current: string
  /** The release key's public half (PEM), or '' while none is set. */
  key: string
  folder: string
  releases: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  changed: (state: UpdateState) => void
  platform?: NodeJS.Platform
  arch?: string
  now?: () => number
}

export class Updates {
  private state: UpdateState
  private file?: string
  private checking?: Promise<void>
  private readonly platform: NodeJS.Platform
  private readonly arch: string

  constructor(private options: UpdateOptions) {
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.state = { phase: options.key.trim() ? 'none' : 'off' }
  }

  status(): UpdateState { return { ...this.state } }
  /** The signed build waiting to be installed, once checked. */
  get ready(): string | undefined { return this.state.phase === 'ready' ? this.file : undefined }

  private set(state: UpdateState): void { this.state = state; this.options.changed(this.status()) }

  check(): Promise<void> {
    if (this.state.phase === 'off' || this.state.phase === 'ready') return Promise.resolve()
    this.checking ??= this.look().finally(() => { this.checking = undefined })
    return this.checking
  }

  private async look(): Promise<void> {
    const now = (this.options.now ?? Date.now)()
    this.set({ phase: 'checking', checkedAt: now })
    try {
      const releases = betaBuild ? 'https://togle.app/beta/release.json' : this.options.releases
      const response = await this.options.fetch(releases, { headers: { Accept: 'application/vnd.github+json' } })
      if (!response.ok) throw new Error(`The release list answered ${response.status}.`)
      const release = await response.json() as Release
      if (betaBuild && (!release.prerelease || !/^v\d+\.\d+\.\d+-beta\.\d+$/.test(release.tag_name))) {
        throw new Error('The update does not belong to the Togle Beta channel.')
      }
      if (!release?.tag_name || !Array.isArray(release.assets) || !newer(release.tag_name, this.options.current)) { this.set({ phase: 'none', checkedAt: now }); return }
      const version = release.tag_name.replace(/^v/i, '')
      const found = assetFor(this.platform, this.arch, release.assets)
      if (!found) { this.set({ phase: 'none', checkedAt: now, message: `Togle ${version} has no signed build for this computer.` }); return }
      this.set({ phase: 'downloading', version, checkedAt: now })
      const download = async (asset: ReleaseAsset): Promise<Buffer> => {
        const answer = await this.options.fetch(asset.browser_download_url)
        if (!answer.ok) throw new Error(`The download answered ${answer.status}.`)
        return Buffer.from(await answer.arrayBuffer())
      }
      const [build, signature] = await Promise.all([download(found.build), download(found.signature)])
      if (!verifySignature('sha256', build, this.options.key, signature)) {
        this.set({ phase: 'refused', version, checkedAt: now, message: `The download of Togle ${version} isn't signed by Togle's release key, so it was deleted and nothing was installed.` })
        return
      }
      await fs.mkdir(this.options.folder, { recursive: true })
      // Its digest is kept, so a file swapped in the folder afterwards is noticed at install time.
      const file = path.join(this.options.folder, path.basename(found.build.name).replace(/[^\w.-]/g, '_'))
      await fs.writeFile(file, build)
      this.file = file
      this.digest = createHash('sha256').update(build).digest('hex')
      this.set({ phase: 'ready', version, checkedAt: now })
    } catch (error) {
      this.set({ phase: 'failed', checkedAt: now, message: (error as Error).message })
    }
  }

  private digest?: string

  /**
   * What to do with the checked build: on Windows run its installer quietly once Togle has quit (it opens Togle again);
   * on Linux the AppImage replaces the running one, and Togle starts again; on a Mac the download is shown, to open.
   * The file is checked against its digest just before, so one changed since it was checked never runs.
   * `reopen: false` is for an update that goes in as Togle closes at the person's own quit: Togle is not opened again after it
   * (on Linux the new AppImage is in place, and `replaced` says so).
   */
  async install(appImage = process.env.APPIMAGE, options: { reopen?: boolean } = {}): Promise<{ after: 'quit-and-run'; file: string; args: string[] } | { after: 'relaunch' } | { after: 'replaced' } | { after: 'show'; file: string }> {
    const reopen = options.reopen ?? true
    const file = this.ready
    if (!file) throw new Error('No checked update is waiting.')
    const data = await fs.readFile(file)
    if (createHash('sha256').update(data).digest('hex') !== this.digest) throw new Error('The update changed after it was checked, so it won’t run.')
    if (this.platform === 'win32') return { after: 'quit-and-run', file, args: reopen ? ['/S', '--force-run'] : ['/S'] }
    if (this.platform === 'linux' && appImage) {
      const next = appImage + '.new'
      await fs.writeFile(next, data, { mode: 0o755 })
      await fs.rename(next, appImage)
      return { after: reopen ? 'relaunch' : 'replaced' }
    }
    return { after: 'show', file }
  }
}
