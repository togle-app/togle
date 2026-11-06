// The agent market: hubs of agents, laid out the way Hermes Agent's skill taps are: a folder per agent under agents/
// (AGENT.md, skills/…/SKILL.md, answers.md), and an index.json listing them, which a hub rebuilds as agents come in by
// pull request. The one that comes with Togle is a folder of it (hub-template/); the others are GitHub repositories,
// read from raw.githubusercontent.com (GitHub doesn't rate-limit it). Either way an agent is installed as a file is:
// read, checked, shown, and only then installed.
import { app, net } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { decodeText, PACKAGE_BYTES, type PackageFiles } from './package'

// Where hubs' files are read from: GitHub's, or (Togle run from source, with TOGLE_HUB_RAW set) a stand-in for a check.
const rawHost = (): string => (app.isPackaged ? undefined : process.env.TOGLE_HUB_RAW) || 'https://raw.githubusercontent.com'

/** A hub: a GitHub repository (and branch) whose agents/ folder holds agents, listed in its index.json. */
export interface HubRef {
  owner: string
  repo: string
  branch: string
}

/** An agent as the hub's index lists it. */
export interface HubEntry {
  slug: string
  name: string
  description: string
  author?: string
  version?: string
  tags: string[]
  skills: number
  answers: number
  /** Its files, relative to its folder. */
  files: string[]
}

/** The format index.json says it has; a later Togle that changes it says so there. */
export const HUB_FORMAT = 'togle-hub/1'

/** Togle's own hub on GitHub, shown as official; none until it's published. */
export const OFFICIAL_HUB = ''

/** The agents that come with Togle, by the name the market lists them under: hub-template/, read from its folder. */
export const TOGLE_HUB = 'togle'

/** Where a hub's files are read from: a GitHub repository, or the folder of the agents that come with Togle. */
export type HubSource = HubRef | typeof TOGLE_HUB

/** A hub by the name it's listed under. */
export const hubSource = (name: string): HubSource => (name === TOGLE_HUB ? TOGLE_HUB : parseHub(name))

const bundledDir = (): string => (app.isPackaged ? path.join(process.resourcesPath, 'hub-template') : path.join(app.getAppPath(), 'hub-template'))

const MAX_INDEX_BYTES = 4_000_000
// What a hub's index lists, at most: more than anyone browses.
const MAX_ENTRIES = 500
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/
// An owner or repository name, and a branch, as GitHub allows them: no "." or ".." to step to another repository.
const NAME = /^(?!\.{1,2}$)[\w.-]{1,100}$/
const BRANCH = /^(?!\/)(?!.*\/\/)(?!.*\.\.)(?!.*\/$)[\w./-]{1,100}$/

/** A hub as people write it: "owner/repo", "owner/repo@branch", or its GitHub address. */
export function parseHub(text: string): HubRef {
  const s = text.trim().replace(/\.git$/, '')
  const url = /^(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/tree\/([\w./-]+))?\/?$/i.exec(s)
  const short = /^([\w.-]+)\/([\w.-]+)(?:@([\w./-]+))?$/.exec(s)
  const m = url ?? short
  if (!m || !NAME.test(m[1]) || !NAME.test(m[2]) || (m[3] !== undefined && !BRANCH.test(m[3])))
    throw new Error('A hub is a GitHub repository: owner/repo, or its address on github.com.')
  return { owner: m[1], repo: m[2], branch: m[3] ?? 'main' }
}

/** The hub as it's shown and kept in settings: "owner/repo", with "@branch" when it isn't main. */
export const hubName = (hub: HubRef): string => `${hub.owner}/${hub.repo}${hub.branch === 'main' ? '' : `@${hub.branch}`}`

const rawUrl = (hub: HubRef, file: string): string =>
  `${rawHost()}/${encodeURIComponent(hub.owner)}/${encodeURIComponent(hub.repo)}/${hub.branch
    .split('/')
    .map(encodeURIComponent)
    .join('/')}/${file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`

const TOO_BIG = 'This agent is too big for Togle.'

/**
 * A file from a hub, read a piece at a time and given up past `limit` bytes (or what's left of `budget`, an agent's
 * files together), whatever its size said.
 */
async function fetchText(url: string, limit: number, budget?: { left: number }): Promise<string> {
  let res: Response
  try {
    res = await net.fetch(url, { signal: AbortSignal.timeout(20_000) })
  } catch {
    throw new Error("Couldn't reach GitHub. Check the connection and try again.")
  }
  if (res.status === 404) throw new Error('Not found on GitHub: is the hub public, and its name right?')
  if (!res.ok) throw new Error(`GitHub answered ${res.status}. Try again later.`)
  const most = Math.min(limit, budget?.left ?? Infinity)
  if (Number(res.headers.get('content-length') ?? 0) > most) throw new Error(TOO_BIG)
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = res.body?.getReader()
  for (;;) {
    const piece = reader ? await reader.read() : undefined
    if (!piece || piece.done) break
    size += piece.value.length
    if (size > most) {
      void reader?.cancel()
      throw new Error(TOO_BIG)
    }
    chunks.push(piece.value)
  }
  if (budget) budget.left -= size
  return decodeText(Buffer.concat(chunks))
}

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.trim().slice(0, limit) : '')
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0)

/** A file path inside an agent's folder that's safe to fetch: relative, no "..", Markdown or text. */
const safeFile = (file: unknown): file is string =>
  typeof file === 'string' && /^[\w][\w./-]*\.(md|txt)$/i.test(file) && !file.split('/').some((part) => part === '..' || part === '.' || !part)

/** A file of the agents that come with Togle, held to the same limits as one from GitHub. */
async function readBundled(file: string, limit: number, budget?: { left: number }): Promise<string> {
  let data: Buffer
  try {
    data = await fs.readFile(path.join(bundledDir(), ...file.split('/')))
  } catch {
    throw new Error("The agents that come with Togle aren't there: install Togle again.")
  }
  if (data.length > Math.min(limit, budget?.left ?? Infinity)) throw new Error(TOO_BIG)
  if (budget) budget.left -= data.length
  return decodeText(data)
}

const readHub = (hub: HubSource, file: string, limit: number, budget?: { left: number }): Promise<string> =>
  hub === TOGLE_HUB ? readBundled(file, limit, budget) : fetchText(rawUrl(hub, file), limit, budget)

/** The agents a hub lists, newest index first as the hub keeps it; entries that don't read right are left out. */
export async function listHub(hub: HubSource): Promise<HubEntry[]> {
  let index: unknown
  try {
    index = JSON.parse(await readHub(hub, 'index.json', MAX_INDEX_BYTES))
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error("This hub's index.json can't be read.")
    throw err
  }
  const agents = (index as { agents?: unknown })?.agents
  if (!Array.isArray(agents)) throw new Error("This hub's index.json lists no agents.")
  const entries: HubEntry[] = []
  for (const raw of agents) {
    if (entries.length === MAX_ENTRIES) break
    const e = raw as Record<string, unknown>
    const slug = text(e?.slug, 64)
    const files = Array.isArray(e?.files) && e.files.length <= PACKAGE_BYTES.files ? e.files.filter(safeFile) : []
    if (!SLUG.test(slug) || !files.includes('AGENT.md')) continue
    entries.push({
      slug,
      name: text(e.name, 60) || slug,
      description: text(e.description, 200),
      author: text(e.author, 80) || undefined,
      version: text(e.version, 40) || undefined,
      tags: Array.isArray(e.tags) ? e.tags.map((t) => text(t, 30)).filter(Boolean).slice(0, 8) : [],
      skills: count(e.skills),
      answers: count(e.answers),
      files
    })
  }
  return entries
}

/** An agent's files from the hub, as its index lists them. */
export async function fetchHubAgent(hub: HubSource, entry: HubEntry): Promise<PackageFiles> {
  const files: PackageFiles = {}
  // The same limits as a .togle file's: each file, and all of them together.
  const budget = { left: PACKAGE_BYTES.total }
  for (const file of entry.files) files[file] = await readHub(hub, `agents/${entry.slug}/${file}`, PACKAGE_BYTES.file, budget)
  return files
}

/**
 * Where a hub takes new agents: GitHub's page for adding files to the agent's folder, which offers a fork and a pull
 * request to anyone who can't write to it, for the hub's keepers to review.
 */
export const publishUrl = (hub: HubRef, slug: string): string =>
  `https://github.com/${hub.owner}/${hub.repo}/upload/${hub.branch}/agents/${slug}`
