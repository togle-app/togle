import { spawn } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tool } from './providers/types'

// Folders that never hold code worth reading (dependencies, build output, caches).
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', 'venv', '__pycache__', 'coverage', 'Pods', 'DerivedData'
])
// Files that tend to hold secrets; never read or searched, even when they aren't ignored.
const SECRET = /(^|\/)(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|id_(rsa|dsa|ecdsa|ed25519)|.*\.(pem|key|pfx|p12))$/i
const MAX_FILES = 50_000
const MAX_READ_BYTES = 2_000_000
const MAX_SEARCH_BYTES = 1_000_000
const SEARCH_RESULTS = 60
const READ_LINES = 300
const MAX_READ_LINES = 600
// A file read for an answer, at most: lines this long, and this much in all.
const READ_LINE_CHARS = 2_000
const READ_CHARS = 60_000
// A line of git's output (a search's match), kept to this.
const OUTPUT_LINE_CHARS = 1_000
// File lists go stale as the user edits; list again after this long.
const LIST_TTL_MS = 60_000
const GIT_TIMEOUT_MS = 15_000
// The first overview of a code base waits at most this long; later ones are served from cache.
const OVERVIEW_WAIT_MS = 3_000

/** A count as the overview says it: to one figure (1,234 is about 1,000), exactly under ten. */
const roughly = (n: number): number => (n < 10 ? n : Number(n.toPrecision(1)))

interface Root {
  /** How paths in this folder are written to the model: "src/x.ts", or "api/src/x.ts" with several folders. */
  prefix: string
  dir: string
  git?: Promise<boolean>
}

/**
 * git.exe found on PATH by absolute path. Spawning plain "git" would make Windows look in the working
 * folder first, where a repository could ship its own git.exe.
 */
const GIT = (() => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const exe = path.join(dir, process.platform === 'win32' ? 'git.exe' : 'git')
    if (dir && path.isAbsolute(dir) && existsSync(exe)) return exe
  }
  return null
})()

/**
 * Runs git on a folder; resolves with its output lines (stopping early after `max` lines), or null when git
 * is missing or can't work there. It runs from a neutral folder with -C, and with the repository's
 * fsmonitor hook off: a project's .git/config could otherwise make git run a command of its choosing.
 */
function git(dir: string, args: string[], max = Infinity): Promise<string[] | null> {
  if (!GIT) return Promise.resolve(null)
  return new Promise((resolve) => {
    const lines: string[] = []
    let rest = ''
    const child = spawn(GIT, ['-C', dir, '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '--no-pager', ...args], {
      cwd: os.tmpdir(),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }
    })
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    // Each line as it comes, kept to its first OUTPUT_LINE_CHARS: a matched line of a minified bundle (megabytes)
    // is neither split again with every piece of output nor kept whole.
    let dropping = false
    child.stdout.on('data', (chunk: string) => {
      for (let at = 0; ; ) {
        const nl = chunk.indexOf('\n', at)
        if (!dropping) rest += chunk.slice(at, Math.min(nl < 0 ? chunk.length : nl, at + OUTPUT_LINE_CHARS - rest.length))
        if (rest.length >= OUTPUT_LINE_CHARS) dropping = true
        if (nl < 0) break
        lines.push(rest.replace(/\r$/, ''))
        rest = ''
        dropping = false
        at = nl + 1
      }
      if (lines.length >= max) child.kill()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    // git grep exits 1 when nothing matched; anything else non-zero means it couldn't run here.
    child.on('close', (code) => {
      clearTimeout(timer)
      if (rest) lines.push(rest.replace(/\r$/, ''))
      resolve(code === 0 || code === 1 || lines.length >= max ? lines.slice(0, max) : null)
    })
  })
}

async function walk(dir: string, out: string[], base = dir): Promise<void> {
  if (out.length >= MAX_FILES) return
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    // Dot folders and files (.git, .env, .idea…) are tooling or secrets, not the code being discussed.
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), out, base)
    } else if (entry.isFile()) {
      out.push(path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/'))
    }
  }
}

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, 8000).includes(0)

/** Whether a resolved path is within a resolved folder. */
function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file)
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

type GlobPart = { kind: 'deep' } | { kind: 'any' } | { kind: 'one' } | { kind: 'char'; ch: string }

/**
 * Whether `parts` match the start of `text` (`prefix`) or all of it, in time growing with their lengths multiplied:
 * a glob as a regex ("**a**a**a…b") can take minutes on one path.
 */
function globMatch(parts: GlobPart[], text: string, prefix: boolean): boolean {
  // reach[j]: the parts so far match text's first j characters.
  let reach = new Uint8Array(text.length + 1)
  reach[0] = 1
  for (const part of parts) {
    const next = new Uint8Array(text.length + 1)
    for (let j = 0; j <= text.length; j++) {
      if (part.kind === 'deep' || part.kind === 'any') {
        // Any run of characters (within one folder for "*"): from where the parts reached, or going on from here.
        if (reach[j] || (j > 0 && next[j - 1] && (part.kind === 'deep' || text[j - 1] !== '/'))) next[j] = 1
      } else if (j > 0 && reach[j - 1] && (part.kind === 'one' ? text[j - 1] !== '/' : text[j - 1] === part.ch)) next[j] = 1
    }
    reach = next
  }
  return prefix ? reach.includes(1) : reach[text.length] === 1
}

/** A path glob ("*.ts", "src/orders/*", "src/**") as a test on a file's path inside its folder. */
export function globTest(glob: string): (file: string) => boolean {
  const parts: GlobPart[] = []
  const lower = glob.toLowerCase()
  for (let i = 0; i < lower.length; i++) {
    if (lower.startsWith('**', i)) {
      parts.push({ kind: 'deep' })
      i++
    } else if (lower[i] === '*') parts.push({ kind: 'any' })
    else if (lower[i] === '?') parts.push({ kind: 'one' })
    else parts.push({ kind: 'char', ch: lower[i] })
  }
  // With a folder in it, from the folder's top (and what's under a match); otherwise a file's name, or its last folders.
  if (glob.includes('/')) return (file) => globMatch(parts, file.toLowerCase(), true)
  return (file) => {
    const name = file.toLowerCase()
    if (globMatch(parts, name, false)) return true
    for (let at = name.indexOf('/'); at >= 0; at = name.indexOf('/', at + 1)) if (globMatch(parts, name.slice(at + 1), false)) return true
    return false
  }
}

/**
 * Read-only access to the user's project folders on this PC, so answers about code can search and read
 * the real files instead of guessing from the screen. Uses git where it can (fast, honors .gitignore).
 * Only files git would track (or, without git, ordinary non-dot files) can be read: ignored files such as
 * .env, and anything outside the folders, stay out of the model's reach.
 */
export class CodeBase {
  private roots: Root[]
  private listed?: { at: number; files: Promise<string[]> }
  private overviewed?: { at: number; text: Promise<string> }
  private lastOverview?: string

  constructor(folders: string[]) {
    const names = folders.map((dir) => path.basename(dir))
    this.roots = folders.map((dir, i) => {
      // Two folders with the same name get their parent's name too.
      const name = names.filter((n) => n === names[i]).length > 1 ? `${path.basename(path.dirname(dir))}-${names[i]}` : names[i]
      return { dir, prefix: folders.length > 1 ? `${name}/` : '' }
    })
  }

  private isGit(root: Root): Promise<boolean> {
    root.git ??= git(root.dir, ['rev-parse', '--is-inside-work-tree']).then((out) => out?.[0] === 'true')
    return root.git
  }

  private async filesOf(root: Root): Promise<string[]> {
    if (await this.isGit(root)) {
      const out = await git(root.dir, ['ls-files', '--cached', '--others', '--exclude-standard'], MAX_FILES)
      if (out) return out.filter((f) => f && !f.startsWith('../') && !SECRET.test(f))
    }
    const files: string[] = []
    await walk(root.dir, files)
    return files.filter((f) => !SECRET.test(f))
  }

  /** Every file, as the model writes its path. */
  files(fresh = false): Promise<string[]> {
    if (fresh || !this.listed || Date.now() - this.listed.at > LIST_TTL_MS) {
      const files = Promise.all(this.roots.map(async (r) => (await this.filesOf(r)).map((f) => r.prefix + f))).then((l) => l.flat())
      this.listed = { at: Date.now(), files }
    }
    return this.listed.files
  }

  /** A path the model gave, resolved inside one of the folders (never outside them). */
  private resolve(file: string): { root: Root; abs: string; shown: string } {
    const clean = file.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    const root = this.roots.find((r) => r.prefix && clean.startsWith(r.prefix)) ?? (this.roots.length === 1 ? this.roots[0] : undefined)
    if (!root) throw new Error(`Unknown folder in "${file}". Paths start with one of: ${this.roots.map((r) => r.prefix).join(', ')}`)
    const rel = clean.slice(root.prefix.length)
    const abs = path.resolve(root.dir, rel)
    const inside = path.relative(root.dir, abs)
    if (inside.startsWith('..') || path.isAbsolute(inside)) throw new Error('That path is outside the project folders.')
    return { root, abs, shown: root.prefix + inside.split(path.sep).join('/') }
  }

  /**
   * What the code base looks like, for the system prompt. Served from cache and refreshed in the
   * background, so listing a big repository never holds up an answer.
   */
  overview(): Promise<string> {
    if (!this.overviewed || Date.now() - this.overviewed.at > LIST_TTL_MS) {
      const text = this.buildOverview().then((t) => (this.lastOverview = t))
      this.overviewed = { at: Date.now(), text }
      text.catch(() => (this.overviewed = undefined))
    }
    if (this.lastOverview) return Promise.resolve(this.lastOverview)
    const fallback = this.roots.map((r) => `- ${r.prefix ? `${r.prefix.slice(0, -1)}: ` : ''}${r.dir}`).join('\n')
    return Promise.race([this.overviewed.text, new Promise<string>((resolve) => setTimeout(() => resolve(fallback), OVERVIEW_WAIT_MS))])
  }

  private async buildOverview(): Promise<string> {
    const files = await this.files()
    const lines: string[] = []
    for (const root of this.roots) {
      const own = files.filter((f) => f.startsWith(root.prefix)).map((f) => f.slice(root.prefix.length))
      const exts = new Map<string, number>()
      const top = new Map<string, number>()
      for (const f of own) {
        const ext = path.extname(f).toLowerCase()
        if (ext) exts.set(ext, (exts.get(ext) ?? 0) + 1)
        const first = f.includes('/') ? `${f.split('/')[0]}/` : f
        top.set(first, (top.get(first) ?? 0) + 1)
      }
      // Counted roughly, and in an order a file more doesn't change: this goes at the start of every answer's prompt,
      // which the backend caches while it stays the same, and they may be writing code during the call.
      const languages = [...exts].sort((a, b) => roughly(b[1]) - roughly(a[1]) || a[0].localeCompare(b[0])).slice(0, 6).map(([e]) => e)
      const layout = [...top]
        .sort((a, b) => Number(b[0].endsWith('/')) - Number(a[0].endsWith('/')) || roughly(b[1]) - roughly(a[1]) || a[0].localeCompare(b[0]))
        .slice(0, 30)
        .map(([name]) => name)
      const label = root.prefix ? `${root.prefix.slice(0, -1)}: ` : ''
      const count = own.length < 10 ? `${own.length}` : `about ${roughly(own.length).toLocaleString('en-US')}`
      lines.push(`- ${label}${root.dir}, ${count} files, mostly ${languages.join(' ')}. Top level: ${layout.join(', ')}`)
    }
    return lines.join('\n')
  }

  /** Lines matching a word, phrase or regex (case-insensitive), as "path:line: text". */
  async search(query: string, regex: boolean, glob?: string): Promise<string> {
    const cleanGlob = glob?.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    // Git pathspec magic (":/", ":(top)") and "..": both could reach past the chosen folder.
    if (cleanGlob && (cleanGlob.startsWith(':') || cleanGlob.split('/').includes('..') || path.isAbsolute(cleanGlob))) {
      return 'path_glob must be a pattern inside the project, like "*.ts" or "src/orders/*".'
    }
    const results: string[] = []
    let literalOnly = false
    for (const root of this.roots) {
      if (results.length >= SEARCH_RESULTS) break
      const want = SEARCH_RESULTS - results.length
      let lines: string[] | null = null
      if (await this.isGit(root)) {
        const args = ['grep', '-n', '-I', '-i', '--untracked', '--no-color', regex ? '-E' : '-F', '-e', query]
        if (cleanGlob) args.push('--', cleanGlob.includes('/') || cleanGlob.startsWith('*') ? cleanGlob : `*${cleanGlob}`)
        lines = await git(root.dir, args, want)
      }
      if (!lines) {
        // Without git, regexes aren't run: a pathological one would freeze the app on the main thread.
        literalOnly ||= regex
        lines = await this.scan(root, query, cleanGlob, want)
      }
      const allowed = new Set(await this.files())
      // git searches through junctions as if they were folders, and a link could point anywhere.
      const realRoot = await fs.realpath(root.dir).catch(() => root.dir)
      const checked = new Map<string, Promise<boolean>>()
      const within = (file: string): Promise<boolean> => {
        let ok = checked.get(file)
        if (!ok) checked.set(file, (ok = fs.realpath(path.join(root.dir, file)).then((real) => inside(realRoot, real), () => false)))
        return ok
      }
      for (const line of lines) {
        const m = /^([^:]+):(\d+):\s*(.*)$/.exec(line)
        if (!m || m[1].startsWith('../') || !allowed.has(root.prefix + m[1]) || !(await within(m[1]))) continue
        results.push(`${root.prefix}${m[1]}:${m[2]}: ${m[3]}`.slice(0, 240))
      }
    }
    const note = literalOnly ? '\n(Searched for the literal text: regular expressions need a git repository.)' : ''
    if (!results.length) return `No matches for "${query}".${note}`
    const more = results.length >= SEARCH_RESULTS ? `\n(First ${SEARCH_RESULTS} matches; narrow the search for more.)` : ''
    return results.join('\n') + more + note
  }

  /** Literal search without git: read each listed file. */
  private async scan(root: Root, query: string, glob: string | undefined, max: number): Promise<string[]> {
    const files = (await this.files()).filter((f) => f.startsWith(root.prefix)).map((f) => f.slice(root.prefix.length))
    const needle = query.toLowerCase()
    const inGlob = glob ? globTest(glob) : () => true
    const realRoot = await fs.realpath(root.dir).catch(() => null)
    if (!realRoot) return []
    const out: string[] = []
    for (const file of files) {
      if (!inGlob(file)) continue
      // As in read(): a symlink or junction inside the folder could point anywhere.
      const real = await fs.realpath(path.join(root.dir, file)).catch(() => null)
      if (!real || !inside(realRoot, real)) continue
      const stat = await fs.stat(real).catch(() => null)
      if (!stat || stat.size > MAX_SEARCH_BYTES) continue
      const buffer = await fs.readFile(real).catch(() => null)
      if (!buffer || isBinary(buffer)) continue
      const lines = buffer.toString('utf8').split('\n')
      for (let i = 0; i < lines.length && out.length < max; i++) {
        if (lines[i].toLowerCase().includes(needle)) out.push(`${file}:${i + 1}:${lines[i].replace(/\r$/, '').trim()}`)
      }
      if (out.length >= max) break
    }
    return out
  }

  /** Numbered lines of a file. */
  async read(file: string, from = 1, to?: number): Promise<string> {
    const { root, abs, shown } = this.resolve(file)
    if (SECRET.test(shown) || shown.split('/').includes('.git')) throw new Error(`${shown} may hold secrets; it isn't readable.`)
    // Only files of the project as git (or the folder walk) lists them: not ignored files, not build output.
    const listed = (await this.files()).includes(shown) || (await this.files(true)).includes(shown)
    const stat = await fs.stat(abs).catch(() => null)
    if (!listed || !stat?.isFile()) {
      const similar = (await this.find(path.basename(file), 5)).trim()
      throw new Error(`No file "${file}" in the project.${similar && !similar.startsWith('No ') ? ` Did you mean:\n${similar}` : ''}`)
    }
    // A symlink or junction inside the folder could point anywhere.
    const [real, realRoot] = await Promise.all([fs.realpath(abs), fs.realpath(root.dir)])
    if (!inside(realRoot, real)) throw new Error(`${shown} links outside the project folders.`)
    if (stat.size > MAX_READ_BYTES) throw new Error(`${shown} is too large to read (${Math.round(stat.size / 1e6)} MB).`)
    const buffer = await fs.readFile(real)
    if (isBinary(buffer)) throw new Error(`${shown} is a binary file.`)
    const lines = buffer.toString('utf8').split('\n')
    const start = Math.max(1, Math.floor(from))
    const end = Math.min(lines.length, Math.floor(to ?? start + READ_LINES - 1), start + MAX_READ_LINES - 1)
    // Lines as long as a person reads them, and no more of them than one answer can take in (a minified file's lines
    // are thousands of characters).
    let body = ''
    let last = start - 1
    for (const [i, raw] of lines.slice(start - 1, end).entries()) {
      const line = raw.replace(/\r$/, '')
      const shownLine = `${start + i}: ${line.length > READ_LINE_CHARS ? `${line.slice(0, READ_LINE_CHARS)}… (${line.length.toLocaleString('en-US')} characters)` : line}`
      if (body && body.length + shownLine.length > READ_CHARS) break
      body += (body ? '\n' : '') + shownLine
      last = start + i
    }
    const note = last < lines.length ? `\n(lines ${start}-${last} of ${lines.length}; ask for more with start_line)` : ''
    return `${shown} (${lines.length} lines)\n${body}${note}`
  }

  /** Files whose path contains `name` (case-insensitive), best matches first. */
  async find(name: string, max = 40): Promise<string> {
    const needle = name.trim().toLowerCase().replace(/\\/g, '/')
    if (!needle) return 'Give part of a file name or path.'
    const files = await this.files()
    const hits = files
      .filter((f) => f.toLowerCase().includes(needle))
      .sort((a, b) => {
        const score = (f: string): number => (path.posix.basename(f).toLowerCase() === needle ? 0 : path.posix.basename(f).toLowerCase().includes(needle) ? 1 : 2)
        return score(a) - score(b) || a.length - b.length
      })
    if (!hits.length) return `No files matching "${name}".`
    return hits.slice(0, max).join('\n') + (hits.length > max ? `\n(${hits.length - max} more)` : '')
  }

  /** The tools a model uses to look through the code. */
  tools(): Tool[] {
    return [
      {
        name: 'search_code',
        description:
          'Search my code base for a word, identifier, phrase or error message (case-insensitive). Returns matching lines as path:line: text.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Text to find, e.g. a function name or part of an error message' },
            regex: { type: 'boolean', description: 'Treat query as a regular expression (default false)' },
            path_glob: { type: 'string', description: 'Only files matching this, e.g. "*.ts" or "src/orders/*"' }
          },
          required: ['query'],
          additionalProperties: false
        },
        run: async (args) => {
          const query = String(args.query ?? '').trim()
          if (!query) return 'Give a search query.'
          return this.search(query, args.regex === true, typeof args.path_glob === 'string' && args.path_glob ? args.path_glob : undefined)
        }
      },
      {
        name: 'find_files',
        description: 'Find files in my code base by part of their name or path, e.g. "merge.ts" or "orders/".',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Part of a file name or path' } },
          required: ['name'],
          additionalProperties: false
        },
        run: async (args) => this.find(String(args.name ?? ''))
      },
      {
        name: 'read_file',
        description: `Read a file from my code base with line numbers (${READ_LINES} lines unless you give a range).`,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Path as search_code or find_files print it' },
            start_line: { type: 'integer', description: 'First line to read (default 1)' },
            end_line: { type: 'integer', description: 'Last line to read' }
          },
          required: ['path'],
          additionalProperties: false
        },
        run: async (args) =>
          this.read(
            String(args.path ?? ''),
            typeof args.start_line === 'number' ? args.start_line : 1,
            typeof args.end_line === 'number' ? args.end_line : undefined
          )
      }
    ]
  }
}

/** What a code tool call is doing, for the answer card. */
export function codeActivity(name: string, args: Record<string, unknown>): string | undefined {
  if (name === 'search_code') return `Searching the code: ${String(args.query ?? '')}`
  if (name === 'find_files') return `Finding files: ${String(args.name ?? '')}`
  if (name === 'read_file') return `Reading ${String(args.path ?? '')}`
  return undefined
}
