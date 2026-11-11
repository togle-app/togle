// What differs from the last commit in the folder a task works in, read with git. The folder is one an agent writes in, so
// nothing in its own git settings may run: the options below turn off what a repository's config could make git start.
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ChangedFile, Changes } from '@shared/runner'

const SAFE = ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'core.quotepath=off', '-c', 'core.hooksPath=', '-c', 'diff.external=', '-c', 'protocol.ext.allow=never']
/** Characters of diff kept; more is cut at the end of a file. */
const LIMIT = 300_000
/** A new file is shown up to this many bytes. */
const NEW_FILE_SHOWN = 20_000
/** Its lines are counted when it is no bigger than this. */
const COUNT_LIMIT = 5_000_000

function git(folder: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...SAFE, '-C', folder, ...args], {
      timeout: 15_000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      // No questions asked, no lock taken: reading must not get in the way of the agent's own git.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
    }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

/** The entries of `git status --porcelain=v1 -z`: a two letter state and a path, and for a rename the old path after. */
export function parseStatus(raw: string): { code: string; path: string }[] {
  const parts = raw.split('\0')
  const entries: { code: string; path: string }[] = []
  for (let at = 0; at < parts.length; at++) {
    const part = parts[at]
    if (part.length < 4) continue
    const code = part.slice(0, 2)
    entries.push({ code, path: part.slice(3) })
    if (code[0] === 'R' || code[0] === 'C') at++
  }
  return entries
}

function statusOf(code: string): ChangedFile['status'] {
  if (code === '??') return 'new'
  if (code.includes('R') || code.includes('C')) return 'renamed'
  if (code.includes('D')) return 'deleted'
  if (code.includes('A')) return 'added'
  return 'modified'
}

/** `--numstat -z` lines: added, removed and a path (a rename carries two more, empty path then old and new). */
function parseNumstat(raw: string): Map<string, [number | null, number | null]> {
  const counts = new Map<string, [number | null, number | null]>()
  const parts = raw.split('\0')
  for (let at = 0; at < parts.length; at++) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[at])
    if (!match) continue
    const numbers: [number | null, number | null] = [match[1] === '-' ? null : Number(match[1]), match[2] === '-' ? null : Number(match[2])]
    if (match[3] === '') {
      counts.set(parts[at + 2] ?? '', numbers)
      at += 2
    } else counts.set(match[3], numbers)
  }
  return counts
}

/** A file that is new to git, as the diff would show it: its first part, and how many lines it has when that can be told. */
async function newFile(root: string, file: string): Promise<{ chunk: string; lines: number | null }> {
  const target = path.join(root, file)
  try {
    const stat = await fs.stat(target)
    if (!stat.isFile()) return { chunk: '', lines: null }
    const whole = stat.size <= COUNT_LIMIT ? await fs.readFile(target) : null
    let head: Buffer
    if (whole) head = whole.subarray(0, NEW_FILE_SHOWN)
    else {
      const handle = await fs.open(target, 'r')
      try {
        head = Buffer.alloc(NEW_FILE_SHOWN)
        await handle.read(head, 0, head.length, 0)
      } finally {
        await handle.close()
      }
    }
    const title = `diff --git a/${file} b/${file}\nnew file\n`
    // As git decides it: a zero byte in the first part means it is not text.
    if (head.subarray(0, 8000).includes(0)) return { chunk: `${title}Binary file ${file}\n`, lines: null }
    const cut = stat.size > NEW_FILE_SHOWN
    const shown = head.toString('utf8').split('\n')
    // A part cut in the middle of a line leaves that line out; a whole file ends with an empty piece after its last newline.
    if (cut || shown.at(-1) === '') shown.pop()
    const counted = whole ? whole.toString('utf8').split('\n') : null
    if (counted?.at(-1) === '') counted.pop()
    return {
      chunk: `${title}--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${shown.length} @@\n${shown.map((line) => `+${line}`).join('\n')}\n${cut ? '… the rest of the file is not shown\n' : ''}`,
      lines: counted ? counted.length : null
    }
  } catch {
    return { chunk: '', lines: null }
  }
}

/** Cuts a diff at the end of a file once it is longer than `limit`. */
export function cutDiff(diff: string, limit = LIMIT): { diff: string; truncated: boolean } {
  if (diff.length <= limit) return { diff, truncated: false }
  const at = diff.lastIndexOf('\ndiff --git ', limit)
  return { diff: at > 0 ? diff.slice(0, at + 1) : diff.slice(0, limit), truncated: true }
}

export async function changesIn(folder: string): Promise<Changes> {
  const none = (problem: string): Changes => ({ git: false, problem, files: [], diff: '', truncated: false })
  let root: string
  try {
    root = (await git(folder, ['rev-parse', '--show-toplevel'])).trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return none(code === 'ENOENT' ? 'Git is not installed on this computer, so Togle cannot tell what changed.' : 'This folder is not in a git repository, so Togle cannot tell what changed.')
  }
  if (!root) return none('This folder is not in a git repository, so Togle cannot tell what changed.')
  try {
    const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim()
    const status = parseStatus(await git(root, ['status', '--porcelain=v1', '-z', '-uall']))
    const hasHead = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false)
    const counts = hasHead ? parseNumstat(await git(root, ['diff', 'HEAD', '--numstat', '-z', '--no-ext-diff', '--no-textconv'])) : new Map<string, [number | null, number | null]>()
    let diff = hasHead ? await git(root, ['diff', 'HEAD', '--no-ext-diff', '--no-textconv', '--no-color']) : ''
    const files: ChangedFile[] = []
    const added: string[] = []
    for (const entry of status) {
      const state = statusOf(entry.code)
      if (state === 'new' || (!hasHead && state === 'added')) {
        const shown = await newFile(root, entry.path)
        files.push({ path: entry.path, status: 'new', added: shown.lines, removed: shown.lines === null ? null : 0 })
        if (shown.chunk) added.push(shown.chunk)
        continue
      }
      const count = counts.get(entry.path)
      files.push({ path: entry.path, status: state, added: count ? count[0] : null, removed: count ? count[1] : null })
    }
    if (added.length) diff = `${diff}${diff && !diff.endsWith('\n') ? '\n' : ''}${added.join('')}`
    const cut = cutDiff(diff)
    return { git: true, branch: branch === 'HEAD' ? '' : branch, files, diff: cut.diff, truncated: cut.truncated }
  } catch (error) {
    return none(`Git would not read this folder: ${(error as Error).message.split('\n')[0]}`)
  }
}
