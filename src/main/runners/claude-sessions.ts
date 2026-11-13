// The sessions Claude Code keeps on this PC, for the Agents list: one JSON line per message under ~/.claude/projects, and
// the same in the folder of each other account it is used with (~/.claude-work). Read from the files Claude Code writes as
// it goes, never its sign-in; only the start and the end of each file, for its id, folder, title and what was asked.
// Keys and passwords in a title are taken out.
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** A session in the list: its id, its title (the one Claude Code or the person gave it, else what was asked first), where it worked, when it last changed. */
export interface ClaudeSession {
  id: string
  title: string
  cwd?: string
  updatedAt: number
}

// The newest sessions looked at.
const SCANNED = 200
// Read from each end of a session file: its start (the folder, what was asked first) and its end (its title as it is now).
// A line can be longer than this (a pasted picture): its title is then looked for further back, up to the last of these.
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = [64 * 1024, 1024 * 1024, 4 * 1024 * 1024]
// When no request is in the head read (its first is longer: pictures pasted into it), how far further it's looked for,
// and the longest line read for it.
const START_BYTES = 64 * 1048576
const LONGEST_LINE = 24 * 1048576
const TITLE_CHARS = 90

const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
// The folders of its other accounts sit beside the one in use, named after it (~/.claude-work, ~/.claude_personal).
const HOME_NAME = /^\.claude(?:[-_.][\p{L}\p{N}][\p{L}\p{N}._-]*)?$/iu

type Json = Record<string, unknown>
const isObject = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const oneLine = (text: string, max: number): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

// ---- Keys, passwords and tokens ----

const REMOVED = '[secret removed]'

/**
 * Whether what's written after "password:" or "TOKEN=" looks made up to be secret (a password, a key), not a word, a
 * number, a path, or code that reads it from somewhere ("req.headers.authorization", "process.env.API_KEY").
 */
function secretLike(value: string): boolean {
  if (value.startsWith('[secret')) return false
  if (/^(?:process\.env|os\.environ|env\b|config\b|settings\b|secrets?\.|self\.|this\.|req\.|request\.|getenv|ENV\[|\$|%\w+%|<|\{)/i.test(value)) return false
  // A name in code (a.b.c), a call, a path.
  if (/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+;?$/.test(value) || value.includes('(') || /^(?:[A-Za-z]:[\\/]|\/|~\/|\.\.?[\\/])/.test(value)) return false
  // Letters and digits together (hunter2, a key), or a long run of both cases (a key without digits).
  return (/\d/.test(value) && /[A-Za-z]/.test(value)) || (value.length >= 16 && /[a-z]/.test(value) && /[A-Z]/.test(value) && !/['’]/.test(value))
}
const unlessPlain = (keep: string) => (match: string, lead: string, value: string): string => (secretLike(value) ? `${lead}${keep}` : match)

// Each takes time in proportion to the text's length (no pattern can backtrack over it).
const SECRETS: [RegExp, string | ((...m: string[]) => string)][] = [
  // A private key (PGP's too), or one cut off before its end line.
  [
    /-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,10000}?-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s]{0,10000})/g,
    REMOVED
  ],
  [/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}/g, REMOVED],
  [/\bsk-(?:ant-|proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g, REMOVED],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|glpat-[A-Za-z0-9_-]{20,})/g, REMOVED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REMOVED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REMOVED],
  [/\bAIza[0-9A-Za-z_-]{35}/g, REMOVED],
  [/\bnpm_[A-Za-z0-9]{36}/g, REMOVED],
  [/\bwhsec_[A-Za-z0-9+/=]{20,}/g, REMOVED],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REMOVED],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,}/g, REMOVED],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REMOVED],
  // Webhooks, whose address is the key.
  [/\b(https:\/\/hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]{20,}/g, `$1${REMOVED}`],
  [/\b(https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9_-]{20,}/g, `$1${REMOVED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi, `$1 ${REMOVED}`],
  // An address with its password in it: a database's (postgresql+psycopg2://app:…@, redis://:…@), a registry's.
  [/\b([a-z][a-z0-9+.-]{1,30}:\/\/[^:\s/@]{0,100}:)[^@\s/]{1,200}@/gi, `$1${REMOVED}@`],
  // A connection string's key (Azure's AccountKey=…;), and passwords given to commands.
  [/\b((?:Account|SharedAccess)Key=)[^;\s"']{10,200}/g, `$1${REMOVED}`],
  [/(\bcurl\b[^\n]{0,200}?\s(?:-u|--user)\s+[^:\s]{1,100}:)\S{1,200}/g, `$1${REMOVED}`],
  [/(\bmysql(?:dump|admin)?\b[^\n]{0,200}?\s-p)[^\s-]\S{0,200}/g, `$1${REMOVED}`],
  [/(\bdocker\s+login\b[^\n]{0,200}?\s(?:-p|--password)[\s=]+)\S{1,200}/g, `$1${REMOVED}`],
  // A password in quotes, spaces and all; and one said in words ("the password is …").
  [/(\b(?:password|passwd|passphrase)["']?\s{0,3}[:=]\s{0,3})(["'])[^"'\n]{4,200}\2/gi, `$1$2${REMOVED}$2`],
  [/(\b(?:password|passcode|passphrase)\s+(?:is|was)\s+["']?)([^\s"',;]{4,100})/gi, unlessPlain(REMOVED)],
  // A setting of theirs by its name: DB_PASS=…, SECRET_KEY_BASE=…, SMTP_PASSWORD="…".
  [/(\b[A-Z][A-Z0-9_]*(?:PASS|SECRET|TOKEN|KEY|CREDENTIALS?)[A-Z0-9_]*\s{0,3}=\s{0,3}["']?)([^\s"'`]{4,200})/g, unlessPlain(REMOVED)],
  [
    /((?:api[_-]?key|apikey|secret(?:[_-]?key)?|access[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|password|passwd|pwd)["']?\s{0,3}[:=]\s{0,3}["']?)([^\s"'`,;)}\]]{6,200})/gi,
    unlessPlain(REMOVED)
  ]
]

/** A text with the keys, tokens and passwords in it taken out. */
export function withoutSecrets(text: string): string {
  let out = text
  for (const [pattern, put] of SECRETS) out = typeof put === 'string' ? out.replace(pattern, put) : out.replace(pattern, put as (...m: string[]) => string)
  return out
}

// ---- Reading a session's lines ----

const parse = (line: string): Json | null => {
  if (!line || line[0] !== '{') return null
  try {
    const value: unknown = JSON.parse(line)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

// What Claude Code adds to a message of theirs: reminders, a command's own output, notices of work done meanwhile.
const INJECTED = /<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook)>[\s\S]*?<\/\1>/g
const NOT_SAID = /^\[Request interrupted by user[^\]]*\]$|^No response requested\.?$/
/**
 * What they wrote in a message, without what Claude Code added to it. A command they ran with words after it stays as
 * they typed it ("/fix-issue SSO login fails"): the words are what they asked.
 */
const theirWords = (text: string): string => {
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1].trim()
  const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1]
  const typed = args ? `${name ? `${name.startsWith('/') ? name : `/${name}`} ` : ''}${args}` : ''
  const rest = text
    .replace(INJECTED, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
    .trim()
    .replace(NOT_SAID, '')
  return typed && rest ? `${typed}\n${rest}` : typed || rest
}

/** The text blocks of a Claude message. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(isObject).filter((block) => block.type === 'text').map((block) => str(block.text)).join('\n\n')
}

/** A Claude Code line that's their own message (not a tool's result, an added notice, or a helper agent's). */
function said(r: Json): boolean {
  if (r.type !== 'user' || r.isMeta || r.isSidechain || r.isCompactSummary || !isObject(r.message)) return false
  if (isObject(r.origin) && r.origin.kind !== 'human') return false
  return !!theirWords(textOf(r.message.content))
}

/** Lines of one end of a file: whole lines only (the cut one at the edge is left out). */
async function readEnd(file: string, size: number, from: 'head' | 'tail', bytes: number): Promise<{ lines: string[]; raw: string }> {
  const handle = await fs.open(file, 'r')
  try {
    const length = Math.min(size, bytes)
    const buf = Buffer.alloc(length)
    await handle.read(buf, 0, length, from === 'head' ? 0 : size - length)
    // Without a byte order mark before its first line, which would hide that line.
    const raw = buf.toString('utf8').replace(/^﻿/, '')
    const lines = raw.split('\n')
    if (length < size) {
      if (from === 'head') lines.pop()
      else lines.shift()
    }
    return { lines, raw }
  } finally {
    await handle.close()
  }
}

/**
 * The whole lines of a file's start, as far as `bytes` into it, without any longer than `longest`: for a session whose
 * first request is longer than its head read (a picture pasted into it goes in as text), so it isn't missed.
 */
async function startLines(file: string, bytes: number, longest: number): Promise<string[]> {
  const lines: string[] = []
  let partial: Buffer[] = []
  let partialBytes = 0
  let skipping = false
  let read = 0
  const stream = createReadStream(file, { highWaterMark: 1 << 20 })
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      read += chunk.length
      let from = 0
      for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, from)) {
        if (!skipping) lines.push(Buffer.concat([...partial, chunk.subarray(from, i)]).toString('utf8').replace(/^﻿/, ''))
        partial = []
        partialBytes = 0
        skipping = false
        from = i + 1
      }
      if (!skipping) {
        partial.push(chunk.subarray(from))
        partialBytes += chunk.length - from
        if (partialBytes > longest) {
          skipping = true
          partial = []
        }
      }
      if (read >= bytes) break
    }
  } finally {
    stream.destroy()
  }
  return lines
}

/** The last value of a JSON string field in raw text, even in a line too long to read whole. */
function lastField(raw: string, field: string): string {
  const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){1,2000})"`, 'g')
  let last = ''
  for (const m of raw.matchAll(pattern)) last = m[1]
  if (!last) return ''
  try {
    return String(JSON.parse(`"${last}"`))
  } catch {
    return ''
  }
}

// The title Claude Code keeps writing as a session goes on, and the one they gave it (/rename); older versions wrote a
// summary line.
const CLAUDE_TITLE = /"type"\s*:\s*"(custom-title|ai-title|summary)"/
const titleIn = (raw: string): string => lastField(raw, 'customTitle') || lastField(raw, 'aiTitle') || lastSummary(raw)
/** The text of the last `{"type":"summary","summary":…}` line (not a field of that name in something else). */
function lastSummary(raw: string): string {
  let last = ''
  for (const m of raw.matchAll(/"type"\s*:\s*"summary"\s*,\s*"summary"\s*:\s*"((?:[^"\\]|\\.){1,2000})"/g)) last = m[1]
  try {
    return last ? String(JSON.parse(`"${last}"`)) : ''
  } catch {
    return ''
  }
}

/** What a session's first lines say: which session, where it worked, what was asked first. */
function claudeStart(lines: string[], file: string): { id: string; cwd?: string; first: string } {
  const start = { id: path.basename(file, '.jsonl'), cwd: undefined as string | undefined, first: '' }
  for (const line of lines) {
    const r = parse(line)
    if (!r) continue
    if (!start.cwd && str(r.cwd)) start.cwd = str(r.cwd)
    if (str(r.sessionId)) start.id = str(r.sessionId)
    if (!start.first && said(r)) start.first = theirWords(textOf((r.message as Json).content))
    if (start.cwd && start.first) break
  }
  return start
}

async function entryOf(file: string, size: number, mtime: number): Promise<ClaudeSession | null> {
  const head = await readEnd(file, size, 'head', HEAD_BYTES)
  let tail = head
  for (const bytes of TAIL_BYTES) {
    if (size <= HEAD_BYTES) break
    tail = await readEnd(file, size, 'tail', bytes)
    if (CLAUDE_TITLE.test(tail.raw) || bytes >= size) break
  }
  let start = claudeStart(head.lines, file)
  // Its first request longer than the head read (a picture pasted into it): read further, line by line.
  if (!start.first && size > HEAD_BYTES) start = claudeStart(await startLines(file, START_BYTES, LONGEST_LINE), file)
  // A session where nothing was asked yet (opened and closed) is not listed.
  if (!start.first) return null
  // Its title as it is now: one they gave it (/rename), wherever it was written (Claude Code goes on writing its own
  // titles after it), else the one Claude Code wrote, else what was asked first.
  const title = lastField(tail.raw, 'customTitle') || lastField(head.raw, 'customTitle') || titleIn(tail.raw) || titleIn(head.raw) || start.first
  return { id: start.id, title: oneLine(withoutSecrets(title.slice(0, 2000)), TITLE_CHARS), cwd: start.cwd, updatedAt: mtime }
}

// List entries by file, as long as the file is the same: a list asked for again reads only what changed.
const entries = new Map<string, { stamp: string; entry: ClaudeSession | null }>()

async function filesIn(dir: string, depth: number, match: RegExp): Promise<string[]> {
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const item of items) {
    const at = path.join(dir, item.name)
    if (item.isDirectory() && depth > 0) found.push(...(await filesIn(at, depth - 1, match)))
    else if (item.isFile() && match.test(item.name)) found.push(at)
  }
  return found
}

/** A folder as it's compared: the same one however its path is written (case, on Windows; a link to it). */
const pathKey = async (dir: string): Promise<string> => {
  const real = await fs.realpath(dir).catch(() => path.resolve(dir))
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/**
 * The folders Claude Code keeps sessions in: the one in use (CLAUDE_CONFIG_DIR, else ~/.claude) first, then its other
 * accounts' folders beside it, those that hold sessions.
 */
export async function claudeHomes(): Promise<string[]> {
  const inUse = claudeDir()
  const root = path.dirname(inUse)
  const beside = (await fs.readdir(root).catch(() => [] as string[])).filter((name) => HOME_NAME.test(name)).sort().map((name) => path.join(root, name))
  const found: { dir: string; key: string }[] = []
  for (const dir of [inUse, ...beside]) {
    const key = await pathKey(dir)
    if (found.some((home) => home.key === key)) continue
    if (await fs.stat(path.join(dir, 'projects')).then((s) => s.isDirectory(), () => false)) found.push({ dir, key })
  }
  return found.map((home) => home.dir)
}

/**
 * Whether Claude Code has kept a conversation under this session id. A session that has had no message has none, and
 * cannot be resumed: `claude --resume` stops at once.
 */
export async function claudeHasSession(id: string): Promise<boolean> {
  for (const home of await claudeHomes()) {
    for (const file of await filesIn(path.join(home, 'projects'), 1, /\.jsonl$/i)) {
      if (path.basename(file, path.extname(file)) !== id) continue
      const stat = await fs.stat(file).catch(() => null)
      if (stat && stat.size > 0) return true
    }
  }
  return false
}

/**
 * Claude Code's sessions on this PC, newest first (the newest `limit`). One session in two folders (a copy of ~/.claude
 * kept beside it) is listed once: the copy written in last.
 */
export async function claudeSessions(limit = 100): Promise<ClaudeSession[]> {
  const files: string[] = []
  for (const home of await claudeHomes()) files.push(...(await filesIn(path.join(home, 'projects'), 1, /\.jsonl$/i)))
  const stated = (
    await Promise.all(
      files.map(async (file) => {
        const stat = await fs.stat(file).catch(() => null)
        return stat && stat.size > 0 ? { file, size: stat.size, mtime: stat.mtimeMs } : null
      })
    )
  )
    .filter((c): c is { file: string; size: number; mtime: number } => !!c)
    .sort((a, b) => b.mtime - a.mtime)
  const found: ClaudeSession[] = []
  const seen = new Set<string>()
  for (const c of stated.slice(0, SCANNED)) {
    const stamp = `${c.size}:${Math.round(c.mtime)}`
    let entry = entries.get(c.file)?.stamp === stamp ? entries.get(c.file)!.entry : undefined
    if (entry === undefined) {
      entry = await entryOf(c.file, c.size, c.mtime).catch(() => null)
      entries.set(c.file, { stamp, entry })
    }
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    found.push(entry)
    if (found.length >= limit) break
  }
  return found
}
