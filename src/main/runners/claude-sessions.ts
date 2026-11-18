// The sessions Claude Code keeps on this PC, for the Agents list: one JSON line per message under ~/.claude/projects, and
// the same in the folder of each other account it is used with (~/.claude-work). Read from the files Claude Code writes as
// it goes, never its sign-in; only the start and the end of each file, for its id, folder, title and what was asked.
// Keys and passwords in a title are taken out.
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { LogEntry, PlanItem, StepKind, TaskHistory } from '@shared/runner'
import { lastTurns } from './history-turns'

/**
 * A session in the list: its id, its title (the one Claude Code or the person gave it, else what was asked first), what was
 * asked first when the title is something else, where it worked, when it last changed.
 */
export interface ClaudeSession {
  id: string
  title: string
  asked?: string
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

/** The most of what was asked first that Togle's sorting reads with a task's name. */
const ASKED_CHARS = 300
/**
 * What was asked first in a task, as Togle's sorting reads it: one line with no secret in it, at most 300 characters. None
 * when it says no more than the task's name (a task named by its first words).
 */
export function askedLine(text: string, title: string): string | undefined {
  const asked = oneLine(withoutSecrets(text.slice(0, 4000)), ASKED_CHARS)
  const plain = (line: string): string => line.replace(/…$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
  if (!asked || plain(title).startsWith(plain(asked)) || (plain(asked).startsWith(plain(title)) && asked.length <= title.length + 8)) return undefined
  return asked
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
  const title = oneLine(withoutSecrets((lastField(tail.raw, 'customTitle') || lastField(head.raw, 'customTitle') || titleIn(tail.raw) || titleIn(head.raw) || start.first).slice(0, 2000)), TITLE_CHARS)
  const asked = askedLine(start.first, title)
  return { id: start.id, title, ...(asked ? { asked } : {}), cwd: start.cwd, updatedAt: mtime }
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

// Where each session's file was found, so that what a session said last is not looked for among all of them each time.
const sessionFiles = new Map<string, string>()

/**
 * What Claude Code said last in a session, in words: the text of the last answer it wrote (not a tool it used), for the
 * notice that a task finished. Read from the end of the session's file, with keys and passwords taken out. Empty when it
 * has said nothing, or the file is not there.
 */
export async function claudeLastSaid(id: string): Promise<string> {
  let file = sessionFiles.get(id)
  if (file && !(await fs.stat(file).then((stat) => stat.size > 0, () => false))) file = undefined
  if (!file) {
    for (const home of await claudeHomes()) {
      file = (await filesIn(path.join(home, 'projects'), 1, /\.jsonl$/i)).find((candidate) => path.basename(candidate, '.jsonl') === id)
      if (file) break
    }
    if (!file) return ''
    sessionFiles.set(id, file)
  }
  const size = (await fs.stat(file).catch(() => null))?.size ?? 0
  for (const bytes of TAIL_BYTES) {
    const tail = await readEnd(file, size, 'tail', bytes).catch(() => null)
    if (!tail) return ''
    for (const line of tail.lines.slice().reverse()) {
      const r = parse(line)
      if (!r || r.type !== 'assistant' || r.isSidechain || !isObject(r.message)) continue
      const words = textOf(r.message.content).trim()
      if (words) return withoutSecrets(words).slice(0, 2000)
    }
    if (bytes >= size) break
  }
  return ''
}

/**
 * When a session's file was last written, in milliseconds: the last time anything was said in it, which a restart of Togle does not
 * change. Undefined when it has no file (a session that has had no message yet).
 */
export async function claudeWrittenAt(id: string): Promise<number | undefined> {
  let file = sessionFiles.get(id)
  if (file && !(await fs.stat(file).then((stat) => stat.isFile(), () => false))) file = undefined
  if (!file) {
    for (const home of await claudeHomes()) {
      file = (await filesIn(path.join(home, 'projects'), 1, /\.jsonl$/i)).find((candidate) => path.basename(candidate, '.jsonl') === id)
      if (file) break
    }
    if (!file) return undefined
    sessionFiles.set(id, file)
  }
  return (await fs.stat(file).catch(() => null))?.mtimeMs
}

// ---- A session's conversation, for the Chat view ----

// The most of a session's file read (its end, when it is longer), the longest words or command kept, and the most entries held.
const READ_MOST = 24 * 1048576
const WORDS_MOST = 20_000
const COMMAND_MOST = 2_000
const ENTRIES_MOST = 8_000
const CONVERSATIONS_KEPT = 6
// The most files one run of reads names (the next read starts a new run), and the longest name of anything else it did.
const READS_MOST = 60
const NAME_MOST = 300
// The longest line read again for what a step holds (what a command printed, its thinking), and the most of that given back.
const DETAIL_LINE_MOST = 8 * 1048576
const DETAIL_MOST = 400_000
// A thought with no words kept is told only when it took this long, in milliseconds.
const THOUGHT_LEAST = 1_000
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
// Monitor runs a command too, and watches what it prints.
const RUNS = new Set(['Bash', 'PowerShell', 'Monitor'])
const SEARCHES = new Set(['Grep', 'Glob'])
// What Claude Code writes as the result of a command that was refused or interrupted.
const REFUSED = /^(?:The user doesn't want|User rejected|The user rejected|Permission to use .{1,40} has been denied|\[Request interrupted)/i

/** Where a line is in a session's file, in bytes. */
interface Place {
  offset: number
  length: number
}

/** A tool that waits for its result: its entry when it has one, when it was called, and what it was. */
interface Waiting {
  entry?: LogEntry
  at: number
  tool: string
  /** For something put on the checklist: its words. */
  subject?: string
}

/** What is read of a session so far: its entries, and how far into its file. */
export interface Conversation {
  entries: LogEntry[]
  /** Tools that wait for their result, by the id Claude Code gave the call. */
  tools: Map<string, Waiting>
  /** Where what a step holds is in the file (what a command printed, its thinking), by the key the step is opened with. */
  places: Map<string, Place>
  /** Its checklist as it stands, by the number Claude Code gave each thing on it. */
  tasks: Map<string, PlanItem>
  next: number
  /** Where in the file the next line starts. */
  offset: number
  /** Whether what came before was left out: a file longer than is read, or more entries than are kept. */
  cut: boolean
}

export const newConversation = (): Conversation => ({ entries: [], tools: new Map(), places: new Map(), tasks: new Map(), next: 1, offset: 0, cut: false })

function push(state: Conversation, kind: LogEntry['kind'], text: string, at: number, more: Partial<LogEntry> = {}): LogEntry {
  const entry: LogEntry = { id: state.next++, at, kind, text, ...more }
  state.entries.push(entry)
  if (state.entries.length > ENTRIES_MOST) {
    const dropped = new Set(state.entries.splice(0, state.entries.length - ENTRIES_MOST))
    for (const [call, waiting] of state.tools) if (waiting.entry && dropped.has(waiting.entry)) state.tools.delete(call)
    for (const gone of dropped) if (gone.more) state.places.delete(gone.more)
    state.cut = true
  }
  return entry
}

const step = (state: Conversation, kind: StepKind, text: string, at: number, more: Partial<LogEntry> = {}): LogEntry =>
  push(state, 'step', text.slice(0, NAME_MOST), at, { step: kind, ...more })

const lastOf = (state: Conversation): LogEntry | undefined => state.entries[state.entries.length - 1]

/** How long it was from a call to its result, when both have a time and they are in order. */
const spanOf = (from: number, to: number): number | undefined => (from > 0 && to >= from ? to - from : undefined)

/** A tool by the name a person reads: a connector's as "server: tool", a skill with its name, any other as Claude Code names it. */
function toolName(name: string, input: Json): string {
  const connector = /^mcp__(.+?)__(.+)$/.exec(name)
  if (connector) return `${connector[1]}: ${connector[2]}`
  if (name === 'Skill' && str(input.skill)) return `Skill: ${str(input.skill)}`
  return name
}

/** What a command printed, as its result's line has it. */
function printed(r: Json, block: Json, alone: boolean): string {
  const result = r.toolUseResult
  // The line's own account of the result, when the line is of this one result.
  if (alone && isObject(result) && (typeof result.stdout === 'string' || typeof result.stderr === 'string')) {
    return [str(result.stdout), str(result.stderr)].filter((part) => part.trim()).join('\n')
  }
  return textOf(block.content)
}

/** A file read. Several one after another are one step that names them all. */
function read(state: Conversation, file: string, at: number): void {
  const last = lastOf(state)
  if (last?.kind === 'step' && last.step === 'read' && last.paths && last.paths.length < READS_MOST) {
    if (!last.paths.includes(file)) last.paths.push(file)
  } else step(state, 'read', file, at, { paths: [file] })
}

/** The checklist as it stands now, as a step. Changes one after another are one step that holds the last of them. */
function planned(state: Conversation, at: number): void {
  const plan = [...state.tasks.values()].map((item) => ({ ...item }))
  if (!plan.length) return
  const text = `${plan.filter((item) => item.state === 'done').length} of ${plan.length} done`
  const last = lastOf(state)
  if (last?.kind === 'step' && last.step === 'plan') {
    last.plan = plan
    last.text = text
  } else step(state, 'plan', text, at, { plan })
}

/**
 * A thought. Its time is on its line; its words are kept by Claude Code only now and then, and are read again from the file
 * when the step is opened. Thoughts one after another are one step, with their times added up; a short one with no words is
 * not told at all.
 */
function thought(state: Conversation, r: Json, block: Json, position: number, first: boolean, at: number, place: Place | undefined): void {
  const took = first && typeof r.thinkingDurationMs === 'number' && r.thinkingDurationMs > 0 ? Math.round(r.thinkingDurationMs) : 0
  const key = str(block.thinking).trim() && place && str(r.uuid) ? `think:${str(r.uuid)}:${position}` : undefined
  const last = lastOf(state)
  if (last?.kind === 'step' && last.step === 'think' && !(key && last.more)) {
    if (took) last.took = (last.took ?? 0) + took
    if (key && place) {
      last.more = key
      state.places.set(key, place)
    }
    return
  }
  if (!key && took < THOUGHT_LEAST) return
  step(state, 'think', '', at, { ...(took ? { took } : {}), ...(key ? { more: key } : {}) })
  if (key && place) state.places.set(key, place)
}

/** A tool Claude Code called: the entry it becomes, and what waits for its result. */
function called(state: Conversation, block: Json, at: number): void {
  const name = str(block.name)
  const input = isObject(block.input) ? block.input : {}
  const id = str(block.id)
  const wait = (entry?: LogEntry, subject?: string): void => {
    if (id) state.tools.set(id, { at, tool: name, ...(entry ? { entry } : {}), ...(subject ? { subject } : {}) })
  }
  if (RUNS.has(name)) {
    if (str(input.command)) wait(push(state, 'command', str(input.command).slice(0, COMMAND_MOST), at, { status: 'running' }))
  } else if (EDITS.has(name)) {
    // Its result says whether it changed the file, and holds how.
    const file = str(input.file_path) || str(input.notebook_path)
    if (file) wait(push(state, 'files', `Changed 1 file: ${file}`, at, { paths: [file] }))
  } else if (name === 'Read') {
    if (str(input.file_path)) read(state, str(input.file_path), at)
  } else if (SEARCHES.has(name)) {
    if (str(input.pattern)) wait(step(state, 'search', str(input.pattern), at))
  } else if (name === 'WebFetch' || name === 'WebSearch') {
    const what = str(input.url) || str(input.query)
    if (what) wait(step(state, 'web', what, at))
  } else if (name === 'Agent') {
    wait(step(state, 'helper', str(input.description) || 'A helper', at, { status: 'running' }))
  } else if (name === 'TaskCreate') {
    // Its number comes with the result: it is on the checklist from then.
    if (str(input.subject)) wait(undefined, str(input.subject).slice(0, NAME_MOST))
  } else if (name === 'TaskUpdate') {
    const item = state.tasks.get(String(input.taskId))
    const to = str(input.status)
    if (to === 'deleted') state.tasks.delete(String(input.taskId))
    else if (item) {
      if (to === 'completed') item.state = 'done'
      else if (to === 'in_progress') item.state = 'doing'
      else if (to === 'pending') item.state = 'todo'
      if (str(input.subject)) item.text = str(input.subject).slice(0, NAME_MOST)
    }
    if (item || to === 'deleted') planned(state, at)
  } else if (name) wait(step(state, 'tool', toolName(name, input), at))
}

/** A tool's result: how its step ended, how long it took, and where what it printed is. */
function ended(state: Conversation, call: string, waiting: Waiting, r: Json, block: Json, alone: boolean, at: number, place: Place | undefined): void {
  const failed = block.is_error === true
  const took = spanOf(waiting.at, at)
  const result = alone && isObject(r.toolUseResult) ? r.toolUseResult : {}
  if (waiting.tool === 'TaskCreate') {
    if (failed || !waiting.subject) return
    const task = isObject(result.task) ? result.task : {}
    const number = typeof task.id === 'string' || typeof task.id === 'number' ? String(task.id) : /#(\d+)/.exec(textOf(block.content))?.[1]
    if (!number) return
    state.tasks.set(number, { text: waiting.subject, state: 'todo' })
    planned(state, at)
    return
  }
  const entry = waiting.entry
  if (!entry) return
  if (entry.kind === 'files') {
    // A change that failed (or was refused) changed nothing: it is not opened to a change that did not happen.
    if (failed) {
      entry.status = 'failed'
      return
    }
    const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch.filter(isObject) : []
    const created = !patch.length && str(result.type) === 'create' && str(result.content) !== ''
    if (place && (patch.length || created)) {
      entry.more = `file:${call}`
      state.places.set(entry.more, place)
    }
    return
  }
  if (entry.kind === 'command') {
    entry.status = failed ? (REFUSED.test(textOf(block.content).trim()) ? 'declined' : 'failed') : 'finished'
    if (took !== undefined) entry.took = took
    if (place && printed(r, block, alone).trim()) {
      entry.more = call
      state.places.set(call, place)
    }
  } else if (entry.step === 'helper') {
    entry.status = failed ? 'failed' : 'finished'
    // A helper sent off to work on its own answers at once: how long it then works is not told here.
    if (took !== undefined && result.isAsync !== true) entry.took = took
  } else {
    if (failed) entry.status = 'failed'
    const told = typeof result.durationMs === 'number' ? result.durationMs : typeof result.durationSeconds === 'number' ? result.durationSeconds * 1000 : took
    if (told !== undefined && told >= 0) entry.took = Math.round(told)
  }
}

/**
 * Reads lines of a session's file into its conversation: what they asked, what Claude Code answered, the commands it ran (with
 * how each ended and how long it took), the files it changed, and what else it did: the files it read, its searches, what it
 * looked up on the web, the helpers it gave work to, its checklist, its thinking, and its other tools by name. `places` says
 * where each line is in the file, for what is read again when a step is opened. What a helper agent did itself is left out.
 */
export function feedConversation(state: Conversation, lines: string[], places?: Place[]): void {
  lines.forEach((line, index) => {
    const r = parse(line)
    if (!r || r.isSidechain || !isObject(r.message)) return
    const place = places?.[index]
    const stamp = Date.parse(str(r.timestamp))
    const at = Number.isFinite(stamp) ? stamp : 0
    const content = r.message.content
    const blocks = Array.isArray(content) ? content.filter(isObject) : []
    if (r.type === 'user') {
      if (said(r)) {
        push(state, 'you', theirWords(textOf(content)).slice(0, WORDS_MOST), at)
        return
      }
      const results = blocks.filter((block) => block.type === 'tool_result')
      for (const block of results) {
        const call = str(block.tool_use_id)
        const waiting = state.tools.get(call)
        if (!waiting) continue
        state.tools.delete(call)
        ended(state, call, waiting, r, block, results.length === 1, at, place)
      }
    } else if (r.type === 'assistant') {
      let thoughts = 0
      blocks.forEach((block, position) => {
        if (block.type === 'text') {
          const words = str(block.text).trim()
          if (words && !NOT_SAID.test(words)) push(state, 'agent', words.slice(0, WORDS_MOST), at)
        } else if (block.type === 'thinking') thought(state, r, block, position, thoughts++ === 0, at, place)
        else if (block.type === 'tool_use' || block.type === 'server_tool_use') called(state, block, at)
      })
    }
  })
}

/** The last turns of what is read, or all of them (up to a limit). */
export function snapshotConversation(state: Conversation, all: boolean): TaskHistory {
  return lastTurns(state.entries, all, state.cut)
}

/** Reads what a session's file gained since `state.offset` (only whole lines: the last may be half written). */
async function readInto(file: string, size: number, state: Conversation): Promise<void> {
  const trimmed = state.offset === 0 && size > READ_MOST
  const from = trimmed ? size - READ_MOST : state.offset
  const handle = await fs.open(file, 'r')
  let buffer: Buffer
  try {
    buffer = Buffer.alloc(size - from)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, from)
    buffer = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  // Each whole line with where it is in the file, counted in bytes: what a step holds is read again from there.
  const lines: string[] = []
  const places: Place[] = []
  // A byte order mark before the first line is not part of it.
  let at = from === 0 && buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0
  // Read from the middle of the file, its first line is cut: it is left out.
  let skip = trimmed
  for (let end = buffer.indexOf(10, at); end >= 0; end = buffer.indexOf(10, at)) {
    if (skip) skip = false
    else {
      lines.push(buffer.toString('utf8', at, end))
      places.push({ offset: from + at, length: end - at })
    }
    at = end + 1
  }
  if (trimmed) state.cut = true
  feedConversation(state, lines, places)
  // A last line with no newline yet that is whole already (a file that does not end with one) is taken too.
  const rest = buffer.toString('utf8', at).trim()
  if (!skip && rest && parse(rest)) {
    feedConversation(state, [rest], [{ offset: from + at, length: buffer.length - at }])
    at = buffer.length
  }
  state.offset = from + at
}

const conversations = new Map<string, { file: string; state: Conversation }>()
// One look at a session's file at a time: two at once would read the same lines twice.
const reading = new Map<string, Promise<unknown>>()

async function readConversation(id: string, all: boolean): Promise<TaskHistory | null> {
  let held = conversations.get(id)
  let file = held?.file ?? sessionFiles.get(id)
  if (file && !(await fs.stat(file).then((stat) => stat.isFile(), () => false))) {
    file = undefined
    held = undefined
    conversations.delete(id)
    sessionFiles.delete(id)
  }
  if (!file) {
    for (const home of await claudeHomes()) {
      file = (await filesIn(path.join(home, 'projects'), 1, /\.jsonl$/i)).find((candidate) => path.basename(candidate, '.jsonl') === id)
      if (file) break
    }
    if (!file) return null
    sessionFiles.set(id, file)
  }
  const size = (await fs.stat(file).catch(() => null))?.size
  if (size === undefined) return null
  // A file that got shorter was written again: it is read from its start.
  let state = held && held.file === file && size >= held.state.offset ? held.state : newConversation()
  if (size > state.offset) await readInto(file, size, state)
  conversations.delete(id)
  conversations.set(id, { file, state })
  while (conversations.size > CONVERSATIONS_KEPT) conversations.delete(conversations.keys().next().value!)
  return snapshotConversation(state, all)
}

/**
 * The conversation of a Claude Code session as the session's file keeps it, for the Chat view: its last turns, or all (up to a
 * limit). Only what the file gained since the last look is read. Null when Claude Code has kept no file under this id.
 */
export function claudeConversation(id: string, all = false): Promise<TaskHistory | null> {
  const run = (reading.get(id) ?? Promise.resolve()).then(() => readConversation(id, all), () => readConversation(id, all))
  reading.set(id, run)
  void run.finally(() => {
    if (reading.get(id) === run) reading.delete(id)
  }).catch(() => undefined)
  return run
}

/** The line of a session's file where its conversation found what a key names, read again; null when it is not held any more. */
async function lineAt(id: string, key: string): Promise<Json | null> {
  const held = conversations.get(id)
  const place = held?.state.places.get(key)
  if (!held || !place || place.length > DETAIL_LINE_MOST) return null
  const handle = await fs.open(held.file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.alloc(place.length)
    const { bytesRead } = await handle.read(buffer, 0, place.length, place.offset)
    return parse(buffer.toString('utf8', 0, bytesRead).trim())
  } finally {
    await handle.close()
  }
}

/**
 * How a file changed in a session, read again from the result of the change where the conversation found it: its patch, a line
 * for each (" " kept, "+" added, "-" taken out, "@@" where), or all of a file it made, each line added. `more` is the key the
 * change came with ("file:<call>", and "#0" for its one file). Null when it is not held, or the line there is not that result.
 */
export async function claudeChange(id: string, more: string): Promise<string | null> {
  const key = /^(file:[^#]+)(?:#0)?$/.exec(more)?.[1]
  if (!key) return null
  const r = await lineAt(id, key)
  if (!r || r.type !== 'user' || !isObject(r.message) || !Array.isArray(r.message.content)) return null
  const results = r.message.content.filter(isObject).filter((block) => block.type === 'tool_result')
  const call = key.slice('file:'.length)
  // The line's own account of the result is of its one result: that one.
  if (results.length !== 1 || str(results[0].tool_use_id) !== call || results[0].is_error === true) return null
  const result = isObject(r.toolUseResult) ? r.toolUseResult : {}
  const patch = Array.isArray(result.structuredPatch) ? result.structuredPatch.filter(isObject) : []
  if (patch.length) {
    const number = (value: unknown): number => (typeof value === 'number' ? value : 0)
    return patch.map((hunk) => [`@@ -${number(hunk.oldStart)},${number(hunk.oldLines)} +${number(hunk.newStart)},${number(hunk.newLines)} @@`, ...(Array.isArray(hunk.lines) ? hunk.lines.map(str) : [])].join('\n')).join('\n')
  }
  if (str(result.type) === 'create' && str(result.content)) return str(result.content).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').map((line) => `+${line}`).join('\n')
  return null
}

/**
 * What a step of a session holds, read again from the session's file where the conversation found it: what a command printed,
 * or the words of a thought. `more` is the key the step came with, and only a key this conversation gave is looked up: nothing
 * of a place in the file comes from outside. Null when the conversation is not held any more, the key is not one of its own,
 * or the line there is not the one the key names (the file was written again).
 */
export async function claudeStep(id: string, more: string): Promise<string | null> {
  const r = await lineAt(id, more)
  if (!r || !isObject(r.message) || !Array.isArray(r.message.content)) return null
  const blocks = r.message.content.filter(isObject)
  const thinking = /^think:(.+):(\d+)$/.exec(more)
  let text = ''
  if (thinking) {
    const block = r.message.content[Number(thinking[2])]
    if (str(r.uuid) !== thinking[1] || !isObject(block) || block.type !== 'thinking') return null
    text = str(block.thinking)
  } else {
    const results = blocks.filter((block) => block.type === 'tool_result')
    const block = results.find((one) => str(one.tool_use_id) === more)
    if (!block) return null
    text = printed(r, block, results.length === 1)
  }
  return text.trim() ? text.slice(-DETAIL_MOST) : null
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
