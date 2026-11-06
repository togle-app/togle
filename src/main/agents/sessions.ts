// Work sessions with an AI agent on this PC, as Claude Code and Codex keep them (in the terminal, an editor or their
// apps): a session about the issue a call is about goes into the agent's documents, so the call knows what was found,
// done and decided. Read from the files the tools write as they go, never their sign-ins: Claude Code's under
// ~/.claude/projects (one JSON line per message), Codex's under ~/.codex/sessions, and the same in the folder of each
// other account they use them with (~/.claude-work). What's kept is what was said, with one line for each thing done
// (a file edited, a command run, a ticket looked up in a tool it has); what tools printed is left out, and keys and
// passwords anywhere in it are taken out.
import { createReadStream, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import type { SessionHome, WorkSessionInfo } from '@shared/types'
import { CHAT_NAMES, chatHomes, chatInfo, chatsIn, isChatAddress } from './chat-exports'
import { day, EDITED, isObject, oneLine, sessionForStudy, str, timeOf, Transcript, withoutSecrets, type Json } from './transcript'

export { sessionForStudy, withoutSecrets } from './transcript'

/** A session: its own id (as its tool names it), its title (the one its tool gave it, else what was asked first), the folder it worked in, when it last changed. */
export type WorkSession = WorkSessionInfo
export type SessionTool = WorkSession['tool']
/** The tools whose sessions are files on this PC (the others' are their chats on the web, from an export). */
type LocalTool = 'claude-code' | 'codex'

export const TOOL_NAMES: Record<SessionTool, string> = { 'claude-code': 'Claude Code', codex: 'Codex', ...CHAT_NAMES }
// Who the AI is in a session's text.
const AI_NAMES: Record<LocalTool, string> = { 'claude-code': 'Claude', codex: 'Codex' }
/** What one is called: "Claude Code session", or "ChatGPT chat" for a chat on the web. */
export const kindOf = (tool: SessionTool): string => `${TOOL_NAMES[tool]} ${tool === 'claude-code' || tool === 'codex' ? 'session' : 'chat'}`
const isLocal = (home: SessionHome): boolean => home.tool === 'claude-code' || home.tool === 'codex'

// The newest sessions looked at for a search: enough for weeks of work.
const SCANNED = 200
// Of Codex's sessions (it keeps them all), the newest this many are looked at.
const CODEX_FILES = 1_000
// Read from each end of a session file for its list entry: its start (the folder, what was asked first) and its end
// (its title as it is now). A line can be longer than this (a pasted picture): its title is then looked for further
// back, up to the last of these.
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = [64 * 1024, 1024 * 1024, 4 * 1024 * 1024]
// When no request is in the head read (its first is longer: pictures pasted into it), how far further it's looked for,
// and the longest line read for it.
const START_BYTES = 64 * 1048576
const LONGEST_LINE = 24 * 1048576
// A session is read whole, line by line: a long one is hundreds of megabytes, mostly what tools printed.
export const MAX_SESSION_BYTES = 2 * 1024 * 1048576
// What's kept of one, at most: under what a document holds (knowledge.ts).
export const MAX_SESSION_CHARS = 4_000_000
const TITLE_CHARS = 90
// What a tool's answer to the agent's question to them holds: the choice they made.
const ANSWER_CHARS = 1_000

const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
const codexDir = (): string => process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
// The folders of their other accounts sit beside the one in use, named after it: Claude Code by CLAUDE_CONFIG_DIR
// (~/.claude-work, ~/.claude_personal), Codex by CODEX_HOME.
const HOME_NAMES: Record<LocalTool, RegExp> = {
  'claude-code': /^\.claude(?:[-_.][\p{L}\p{N}][\p{L}\p{N}._-]*)?$/iu,
  codex: /^\.codex(?:[-_.][\p{L}\p{N}][\p{L}\p{N}._-]*)?$/iu
}
// What makes one theirs, not another tool's folder of that name (~/.claude-server-commander): it holds sessions.
const SESSION_FOLDERS: Record<LocalTool, string[]> = { 'claude-code': ['projects'], codex: ['sessions', 'archived_sessions'] }

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
 * What they wrote in a message, without what their tool added to it. A command they ran with words after it stays as
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

// What Codex puts before their first request, as a message of theirs: the folder, the rules of the project.
const CODEX_ADDED = /^\s*<(?:environment_context|user_instructions|permissions instructions)|^\s*# AGENTS\.md/i

// Codex's editor extensions put the open files before the request.
const codexRequest = (text: string): string => {
  const at = text.lastIndexOf('## My request for Codex:')
  return (at >= 0 ? text.slice(at + '## My request for Codex:'.length) : text).trim()
}

/** The text blocks of a Claude message, and whether it had pictures. */
function blocksOf(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 }
  if (!Array.isArray(content)) return { text: '', images: 0 }
  let images = 0
  const texts: string[] = []
  for (const block of content) {
    if (!isObject(block)) continue
    if (block.type === 'text') texts.push(str(block.text))
    else if (block.type === 'image') images++
  }
  return { text: texts.join('\n\n'), images }
}

/** Their answer to the agent's question, without how Claude Code tells the agent of it. */
const answerText = (text: string): string =>
  text
    .replace(/^\s*User has answered your questions?:\s*/i, '')
    .replace(/\s*You can now continue with the user's answers? in mind\.?\s*$/i, '')
    .trim()

/** A tool result's text (a tool from their workspace, an answer they gave). */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isObject)
    .map((b) => (b.type === 'text' ? str(b.text) : ''))
    .filter(Boolean)
    .join('\n')
}

// ---- A list entry: from the start and the end of the file ----

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

/** Codex's names for its sessions (renamed, or named as they began), by id: the latest of each, from each of these folders of Codex. */
async function codexTitles(homes: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  for (const home of homes) {
    const text = await fs.readFile(path.join(home, 'session_index.jsonl'), 'utf8').catch(() => '')
    for (const line of text.split('\n')) {
      const entry = parse(line.trim())
      if (entry && str(entry.id) && str(entry.thread_name).trim()) titles.set(str(entry.id), str(entry.thread_name).trim())
    }
  }
  return titles
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

/** What's shown of a session in a list (and goes to the model looking for one, and names a document): without secrets. */
const shown = (text: string, max: number): string => oneLine(withoutSecrets(text.slice(0, 2000)), max)

/** What a Claude Code session's first lines say: where it worked, when it began, what was asked first. */
function claudeStart(lines: string[], file: string): { id: string; cwd?: string; branch?: string; startedAt: number; first: string } {
  const start = { id: path.basename(file, '.jsonl'), cwd: undefined as string | undefined, branch: undefined as string | undefined, startedAt: 0, first: '' }
  for (const line of lines) {
    const r = parse(line)
    if (!r) continue
    if (!start.cwd && str(r.cwd)) {
      start.cwd = str(r.cwd)
      start.branch = str(r.gitBranch) || undefined
    }
    if (str(r.sessionId)) start.id = str(r.sessionId)
    if (!start.startedAt && r.timestamp) start.startedAt = timeOf(r.timestamp)
    if (!start.first && said(r)) start.first = theirWords(blocksOf((r.message as Json).content).text)
    if (start.cwd && start.first) break
  }
  return start
}

async function claudeEntry(file: string, size: number, mtime: number): Promise<WorkSession | null> {
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
  const { id, cwd, branch, startedAt, first } = start
  // A session where nothing was asked yet (opened and closed) has nothing to read.
  if (!first) return null
  // Its title as it is now: one they gave it (/rename), wherever it was written (Claude Code goes on writing its own
  // titles after it), else the one Claude Code wrote, else what was asked first.
  const custom = lastField(tail.raw, 'customTitle') || lastField(head.raw, 'customTitle')
  const title = custom || titleIn(tail.raw) || titleIn(head.raw)
  const named = !!custom
  const last = lastField(tail.raw, 'lastPrompt')
  return {
    id,
    tool: 'claude-code',
    title: shown(title || first, TITLE_CHARS),
    ...(named ? { named } : {}),
    cwd,
    branch,
    startedAt: startedAt || mtime,
    updatedAt: mtime,
    bytes: size,
    file,
    first: shown(first, 300),
    last: last ? shown(theirWords(last), 300) : undefined
  }
}

/** A Claude Code line that's their own message (not a tool's result, an added notice, or a helper agent's). */
function said(r: Json): boolean {
  if (r.type !== 'user' || r.isMeta || r.isSidechain || r.isCompactSummary || !isObject(r.message)) return false
  if (isObject(r.origin) && r.origin.kind !== 'human') return false
  return !!theirWords(blocksOf(r.message.content).text)
}

/** What they asked in a line of a Codex session, if it's a request of theirs (older sessions have no events). */
function codexAsked(r: Json, p: Json): string {
  if (r.type === 'event_msg' && p.type === 'user_message') return codexRequest(str(p.message))
  if (r.type !== 'response_item' || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return ''
  const text = p.content.filter(isObject).map((c) => str(c.text)).join('\n')
  return CODEX_ADDED.test(text) ? '' : codexRequest(text)
}

/** What a Codex session's first lines say: which session, where it worked, when it began, what was asked first. */
function codexStart(lines: string[], file: string): { id: string; cwd?: string; branch?: string; startedAt: number; first: string } {
  const start = {
    id: /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(file)?.[1] ?? path.basename(file, '.jsonl'),
    cwd: undefined as string | undefined,
    branch: undefined as string | undefined,
    startedAt: 0,
    first: ''
  }
  for (const line of lines) {
    const r = parse(line)
    if (!r) continue
    const p = isObject(r.payload) ? r.payload : {}
    if (r.type === 'session_meta') {
      start.id = str(p.id) || start.id
      start.cwd = str(p.cwd) || undefined
      start.branch = (isObject(p.git) && str(p.git.branch)) || undefined
      start.startedAt = timeOf(p.timestamp) || timeOf(r.timestamp)
    }
    if (!start.first) start.first = codexAsked(r, p)
    if (start.first && start.cwd) break
  }
  return start
}

async function codexEntry(file: string, size: number, mtime: number, titles: Map<string, string>): Promise<WorkSession | null> {
  const head = await readEnd(file, size, 'head', HEAD_BYTES)
  const tail = size > HEAD_BYTES ? await readEnd(file, size, 'tail', TAIL_BYTES[0]) : head
  let start = codexStart(head.lines, file)
  // Its first request past the head read (the project's rules written out before it, a picture in it): read further.
  if (!start.first && size > HEAD_BYTES) start = codexStart(await startLines(file, START_BYTES, LONGEST_LINE), file)
  const { id, cwd, branch, startedAt, first } = start
  if (!first) return null
  let last = ''
  for (const line of tail.lines) {
    const r = parse(line)
    if (r) last = codexAsked(r, isObject(r.payload) ? r.payload : {}) || last
  }
  const title = titles.get(id) || first
  return {
    id,
    tool: 'codex',
    title: shown(title, TITLE_CHARS),
    cwd,
    branch,
    startedAt: startedAt || mtime,
    updatedAt: mtime,
    bytes: size,
    file,
    first: shown(first, 300),
    last: last ? shown(last, 300) : undefined
  }
}

// List entries by file, as long as the file is the same: a list asked for again reads only what changed.
const entries = new Map<string, { stamp: string; entry: WorkSession | null }>()

/** A file's size and time: when they're the same, so is the session. */
export const stampOf = (stat: { size: number; mtimeMs: number }): string => `${stat.size}:${Math.round(stat.mtimeMs)}`

interface Candidate {
  file: string
  tool: SessionTool
  home: SessionHome
  size: number
  mtime: number
}

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

// ---- Their Claude Code and Codex: one folder for each account ----

const WINDOWS_PATHS = process.platform === 'win32'
/** A folder as it's compared: the same one however its path is written (case, on Windows; a link to it). */
const pathKey = async (dir: string): Promise<string> => {
  const real = await fs.realpath(dir).catch(() => path.resolve(dir))
  return WINDOWS_PATHS ? real.toLowerCase() : real
}
/** Whether a file is in a folder (or under it). */
export function isInside(file: string, dir: string): boolean {
  const rel = path.relative(WINDOWS_PATHS ? dir.toLowerCase() : dir, WINDOWS_PATHS ? file.toLowerCase() : file)
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel)
}
/** Whether two paths are the same folder, as written (for one that may be gone since); or the same account on the web. */
export const samePlace = (a: string, b: string): boolean => {
  if (a.includes('://') || b.includes('://')) return a.toLowerCase() === b.toLowerCase()
  return WINDOWS_PATHS ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
}

/** What sets one of their folders apart in its name: "work" for .claude-work; nothing for .claude. */
const ownPart = (tool: SessionTool, dir: string): string => path.basename(dir).replace(tool === 'claude-code' ? /^\.?claude[-_. ]*/i : /^\.?codex[-_. ]*/i, '')

/** Each folder by the name it's shown and said by: "Claude Code (work)", or just "Claude Code" when it's the only one. */
function named(found: Omit<SessionHome, 'name'>[]): SessionHome[] {
  return found.map((home) => {
    const same = found.filter((h) => h.tool === home.tool)
    const own = ownPart(home.tool, home.dir)
    // Two that say the same (.claude-work, .claude_work): by their folders' names.
    const clash = same.some((h) => h !== home && ownPart(h.tool, h.dir).toLowerCase() === own.toLowerCase())
    const label = same.length === 1 ? '' : clash ? path.basename(home.dir) : own
    return { ...home, name: label ? `${TOOL_NAMES[home.tool]} (${label})` : TOOL_NAMES[home.tool] }
  })
}

/**
 * Their Claude Code and Codex on this PC: the folder each one uses (CLAUDE_CONFIG_DIR, CODEX_HOME, else ~/.claude and
 * ~/.codex) and their other accounts' folders beside it, those that hold sessions; the one in use comes first. Then
 * their accounts on claude.ai and ChatGPT that there's an export of.
 */
export async function sessionHomes(): Promise<SessionHome[]> {
  const found: (Omit<SessionHome, 'name'> & { key: string })[] = []
  for (const tool of ['claude-code', 'codex'] as const) {
    const inUse = tool === 'claude-code' ? claudeDir() : codexDir()
    const root = path.dirname(inUse)
    const beside = (await fs.readdir(root).catch(() => [] as string[]))
      .filter((name) => HOME_NAMES[tool].test(name))
      .sort()
      .map((name) => path.join(root, name))
    for (const dir of [inUse, ...beside]) {
      const key = await pathKey(dir)
      if (found.some((h) => h.key === key)) continue
      const holds = await Promise.all(SESSION_FOLDERS[tool].map((sub) => fs.stat(path.join(dir, sub)).then((s) => s.isDirectory(), () => false)))
      if (holds.some(Boolean)) found.push({ tool, dir, key })
    }
  }
  // Their exports unreadable for now (a list of them that won't parse, a folder being unpacked): their sessions all the same.
  const chats = await chatHomes().catch((err: Error) => {
    console.warn('[sessions] exports of chats not looked at:', err.message)
    return [] as SessionHome[]
  })
  return [...named(found.map(({ tool, dir }) => ({ tool, dir }))), ...chats]
}

async function candidates(homes: SessionHome[]): Promise<Candidate[]> {
  const all: { file: string; home: SessionHome }[] = []
  for (const home of homes) {
    const files =
      home.tool === 'claude-code'
        ? await filesIn(path.join(home.dir, 'projects'), 1, /\.jsonl$/i)
        : // Codex keeps every session it had: the newest of them, by the time in their names (rollout-2026-10-26T09-…).
          [...(await filesIn(path.join(home.dir, 'sessions'), 3, /^rollout-.*\.jsonl$/i)), ...(await filesIn(path.join(home.dir, 'archived_sessions'), 3, /^rollout-.*\.jsonl$/i))]
            .sort((a, b) => path.basename(b).localeCompare(path.basename(a)))
            .slice(0, CODEX_FILES)
    all.push(...files.map((file) => ({ file, home })))
  }
  const stated = await Promise.all(
    all.map(async (c) => {
      const stat = await fs.stat(c.file).catch(() => null)
      return stat && stat.size > 0 ? { ...c, tool: c.home.tool, size: stat.size, mtime: stat.mtimeMs } : null
    })
  )
  return stated.filter((c): c is Candidate => !!c).sort((a, b) => b.mtime - a.mtime)
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) ?? []

/**
 * The work sessions on this PC, and their chats on claude.ai and ChatGPT, newest first: all of them (the newest
 * `limit`), or those whose title, folder or requests have every word of `query`. From the Claude Code and Codex
 * folders and the accounts `from` gives (an agent's own), else from all of them.
 */
export async function findSessions(query = '', limit = 30, from: string[] = []): Promise<WorkSession[]> {
  const words = wordsOf(query)
  const homes = (await sessionHomes()).filter((h) => !from.length || from.some((dir) => samePlace(dir, h.dir)))
  const matches = (session: WorkSession): boolean => {
    const text = `${session.title} ${session.cwd ?? ''} ${session.branch ?? ''} ${session.first ?? ''} ${session.last ?? ''} ${session.home}`.toLowerCase()
    return words.every((w) => text.includes(w))
  }
  const found: WorkSession[] = []
  // The sessions seen so far, matching or not ("<tool> <id>").
  const copies = new Set<string>()
  const titles = new Map<string, Map<string, string>>()
  for (const c of (await candidates(homes.filter(isLocal))).slice(0, SCANNED)) {
    const stamp = `${c.size}:${Math.round(c.mtime)}`
    let entry = entries.get(c.file)?.stamp === stamp ? entries.get(c.file)!.entry : undefined
    // Codex's names, as they are now: renaming one writes only its list of names, not the session.
    if (c.tool === 'codex' && !titles.has(c.home.dir)) titles.set(c.home.dir, await codexTitles([c.home.dir]))
    if (entry === undefined) {
      entry = await (c.tool === 'claude-code' ? claudeEntry(c.file, c.size, c.mtime) : codexEntry(c.file, c.size, c.mtime, titles.get(c.home.dir)!)).catch(() => null)
      entries.set(c.file, { stamp, entry })
    }
    if (!entry) continue
    const renamed = c.tool === 'codex' ? titles.get(c.home.dir)!.get(entry.id) : undefined
    if (renamed) entry = { ...entry, title: shown(renamed, TITLE_CHARS) }
    // One session in two folders (a copy of ~/.claude kept beside it, ~/.claude.bak): the one written in last, and of
    // two alike, the one in use; a copy is never what's added, nor read again before calls.
    const which = `${entry.tool} ${entry.id}`
    if (copies.has(which)) continue
    copies.add(which)
    // Which one it's from, as it's named now (another account's folder added since can rename the others).
    const session = { ...entry, home: c.home.name }
    if (!matches(session)) continue
    found.push(session)
    if (found.length >= limit) break
  }
  // Their chats on the web, among them by when each was last written in.
  const chats = (await chatsIn(homes.filter((h) => !isLocal(h)))).filter(matches).slice(0, limit)
  return [...found, ...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}

/** The session a file is (one dropped in, or added before), or null when it isn't one; a chat, by its address. */
export async function sessionInfo(file: string): Promise<WorkSession | null> {
  if (isChatAddress(file)) return chatInfo(file)
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile() || !/\.jsonl$/i.test(file)) return null
  const head = await readEnd(file, stat.size, 'head', HEAD_BYTES).catch(() => null)
  // Its first line longer than that (a long log pasted into the first request): read further for it.
  const lines = head?.lines.some((l) => parse(l)) || stat.size <= HEAD_BYTES ? head?.lines : await startLines(file, START_BYTES, LONGEST_LINE).catch(() => [])
  const firstRecord = lines?.map(parse).find(Boolean)
  if (!firstRecord) return null
  const codex = firstRecord.type === 'session_meta' || (isObject(firstRecord.payload) && 'type' in firstRecord)
  const home = (await sessionHomes()).find((h) => h.tool === (codex ? 'codex' : 'claude-code') && isInside(file, h.dir))
  const entry = await (codex ? codexEntry(file, stat.size, stat.mtimeMs, await codexTitlesFor(file)) : claudeEntry(file, stat.size, stat.mtimeMs)).catch(() => null)
  return entry && home ? { ...entry, home: home.name } : entry
}

/** Codex's names for the sessions in the folder of Codex a file is in; for one copied out of it, from all of them. */
async function codexTitlesFor(file: string): Promise<Map<string, string>> {
  const homes = (await sessionHomes()).filter((h) => h.tool === 'codex')
  const home = homes.find((h) => isInside(file, h.dir))
  return codexTitles((home ? [home] : homes).map((h) => h.dir))
}

// ---- The session as a document ----

/** A path as it's said: inside the folder the session worked in, from there. */
const shortPath = (file: string, cwd?: string): string => {
  if (!file) return ''
  // A session's paths are as its PC writes them (C:\… or /home/…), whichever PC reads it.
  const paths = /^[A-Za-z]:[\\/]/.test(file) ? path.win32 : path.posix
  const rel = cwd ? paths.relative(cwd, file) : ''
  return rel && !rel.startsWith('..') && !paths.isAbsolute(rel) ? rel.replace(/\\/g, '/') : file.replace(/\\/g, '/')
}

/** A tool of theirs by its name ("mcp__claude_ai_Atlassian__getJiraIssue" is Atlassian's getJiraIssue). */
function workspaceTool(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!m) return null
  const server = m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ')
  return { server, tool: m[2] }
}

// Commands that only look around (read a file, list a folder, search, see what changed): the agent's way of reading,
// not something it did. The words after a "cd …" first.
const LOOKS = new Set(
  'cat head tail less more grep rg ag ls dir tree find fd wc file stat type pwd which where get-content gc get-childitem gci select-string sls test-path get-item get-itemproperty get-command resolve-path du nl jq od xxd uniq'.split(' ')
)
const GIT_LOOKS = /^git\s+(?:-C\s+\S+\s+)?(?:status|diff|log|show|branch|rev-parse|ls-files|blame|grep|remote|config\s+--get|stash\s+list)\b/i
// What makes a looking command do something: writing what it prints to a file (not to nowhere), changing a file in
// place, deleting what it finds.
const DOES = /(?:^|[^\d&>])>{1,2}\s*(?!&|\/dev\/null\b|\$null\b|nul\b)\S|\s-(?:i|delete|exec)\b/i
/** Whether a command only reads: every part of it (`cd x && cat y | head`, `sed -n 5,9p f`). */
function onlyLooks(command: string): boolean {
  const parts = command
    .split(/&&|\|\||;|\|/)
    .map((p) => p.trim().replace(/^\(+/, ''))
    .filter((p) => p && !/^(?:cd|set-location|sl|pushd)\b/i.test(p))
  const looks = (p: string): boolean => {
    if (DOES.test(p)) return false
    const word = (p.split(/\s+/)[0] ?? '').toLowerCase().replace(/\.exe$/, '')
    return GIT_LOOKS.test(p) || LOOKS.has(word) || (word === 'sed' && /^sed\s+-n\b/.test(p))
  }
  return parts.length > 0 && parts.every(looks)
}

function header(tool: LocalTool, info: { title?: string; cwd?: string; branch?: string }, from: number, to: number): string {
  const when = from && to ? (day(from) === day(to) ? `on ${day(from)}` : `from ${day(from)} to ${day(to)}`) : ''
  const where = info.cwd ? ` in ${info.cwd.replace(/\\/g, '/')}${info.branch ? ` (branch ${info.branch})` : ''}` : ''
  return [
    `# ${info.title ? `${info.title} — ` : ''}a work session in ${TOOL_NAMES[tool]}`,
    '',
    `A session with ${TOOL_NAMES[tool]}, an AI agent, ${where ? `working${where}` : 'at work'}${when ? `, ${when}` : ''}. "Me" is the user; "${AI_NAMES[tool]}" is the agent they worked with. Lines in parentheses are what the agent did.`
  ].join('\n')
}

async function* linesOf(file: string): AsyncGenerator<string> {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  try {
    for await (const line of rl) yield line
  } finally {
    rl.close()
    stream.destroy()
  }
}

function claudeLine(r: Json, t: Transcript, info: { cwd?: string; branch?: string }, tools: Map<string, string>): void {
  if (r.isSidechain) return
  if (!info.cwd && str(r.cwd)) {
    info.cwd = str(r.cwd)
    info.branch = str(r.gitBranch) || undefined
  }
  const at = timeOf(r.timestamp)
  if (r.type === 'user' && isObject(r.message)) {
    if (r.isCompactSummary) return t.summary(blocksOf(r.message.content).text, at)
    const content = r.message.content
    // What came back from what it did: only an answer they gave it, or what a tool of their workspace found.
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue
        const name = tools.get(str(block.tool_use_id)) ?? ''
        if (name === 'AskUserQuestion') t.got('My answer', answerText(resultText(block.content)), at, ANSWER_CHARS)
        else if (workspaceTool(name) && !block.is_error) t.got(`What ${workspaceTool(name)!.server} gave`, resultText(block.content), at)
      }
    }
    if (said(r)) {
      const { text, images } = blocksOf(content)
      t.me(theirWords(text), at, images)
    }
    return
  }
  if (r.type !== 'assistant' || !isObject(r.message) || r.isApiErrorMessage || !Array.isArray(r.message.content)) return
  for (const block of r.message.content) {
    if (!isObject(block)) continue
    if (block.type === 'text') t.reply(str(block.text), at)
    else if (block.type === 'tool_use') {
      const name = str(block.name)
      const input = isObject(block.input) ? block.input : {}
      if (str(block.id)) tools.set(str(block.id), name)
      const action = claudeAction(name, input, info.cwd)
      if (action) t.did(action, at)
      if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        const asked = input.questions.filter(isObject).map((q) => str(q.question)).filter(Boolean)
        if (asked.length) t.got(`${AI_NAMES['claude-code']} asked me`, asked.join(' / '), at, ANSWER_CHARS)
      }
    }
  }
}

function claudeAction(name: string, input: Json, cwd?: string): string {
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return `${EDITED}${shortPath(str(input.file_path) || str(input.notebook_path), cwd)}`
    case 'Bash':
    case 'PowerShell':
      return onlyLooks(str(input.command)) ? '' : `ran: ${str(input.description) || str(input.command).split('\n')[0]}`
    case 'WebSearch':
      return `searched the web: ${str(input.query)}`
    case 'WebFetch':
      return `read ${str(input.url)}`
    case 'Agent':
    case 'Task':
      return `had a helper agent ${str(input.description) || 'look into something'}`
  }
  const own = workspaceTool(name)
  return own ? `used ${own.server}: ${own.tool}` : ''
}

/** The command line of a call: as a list (["bash", "-lc", "npm test"]), its script; else as written. */
const commandOf = (value: unknown): string => (Array.isArray(value) ? str(value[value.length - 1]) : str(value)).trim()

/**
 * One line of a Codex session, into `t` as its events tell it; and into `items` as what went to the model tells it,
 * for a session from before Codex wrote events.
 */
function codexLine(r: Json, t: Transcript, info: { cwd?: string; branch?: string }, items: Transcript): void {
  const p = isObject(r.payload) ? r.payload : null
  if (!p) return
  const at = timeOf(r.timestamp)
  if (r.type === 'session_meta') {
    info.cwd = str(p.cwd) || info.cwd
    info.branch = (isObject(p.git) && str(p.git.branch)) || info.branch
    return
  }
  if (r.type === 'compacted') {
    t.summary(str(p.message), at)
    return items.summary(str(p.message), at)
  }
  if (r.type === 'response_item' && p.type === 'message') {
    // Older sessions have no events: what was said is only in these (theirs, beside the instructions Codex adds).
    const text = Array.isArray(p.content) ? p.content.filter(isObject).map((c) => str(c.text)).join('\n') : ''
    if (p.role === 'assistant') items.reply(text, at)
    else if (p.role === 'user' && !CODEX_ADDED.test(text)) items.me(codexRequest(text), at)
    return
  }
  // What it ran or changed, as it asked to (older sessions have only these); the events after say how it went.
  if (r.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call')) {
    const name = str(p.name)
    let args: Json = {}
    try {
      const parsed: unknown = p.type === 'function_call' ? JSON.parse(str(p.arguments) || '{}') : p.type === 'local_shell_call' && isObject(p.action) ? p.action : {}
      if (isObject(parsed)) args = parsed
    } catch {
      // Not JSON: nothing to read of it.
    }
    const key = str(p.call_id) || undefined
    if (name === 'apply_patch') {
      const patch = p.type === 'custom_tool_call' ? str(p.input) : str(args.input)
      for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
        t.did(`${EDITED}${shortPath(m[1].trim(), info.cwd)}`, at, key)
        items.did(`${EDITED}${shortPath(m[1].trim(), info.cwd)}`, at)
      }
    } else if (['shell', 'shell_command', 'exec_command', 'container.exec'].includes(name) || p.type === 'local_shell_call') {
      const command = commandOf(args.command ?? args.cmd)
      if (command && !onlyLooks(command)) {
        t.did(`ran: ${command.split('\n')[0]}`, at, key)
        items.did(`ran: ${command.split('\n')[0]}`, at)
      }
    }
    return
  }
  if (r.type !== 'event_msg') return
  switch (p.type) {
    case 'user_message':
      return t.me(codexRequest(str(p.message)), at, Array.isArray(p.images) ? p.images.length : 0)
    case 'agent_message':
      return t.reply(str(p.message), at)
    case 'exec_command_end': {
      const parsed = Array.isArray(p.parsed_cmd) ? p.parsed_cmd.filter(isObject) : []
      // Reading and searching files is how it looks around: only what it ran for itself is worth a line.
      const looked = parsed.length > 0 && parsed.every((c) => ['read', 'search', 'list_files'].includes(str(c.type)))
      const failed = typeof p.exit_code === 'number' && p.exit_code !== 0
      if (str(p.call_id) && t.ended(str(p.call_id), (line) => (looked ? null : failed ? `${line} (failed)` : line))) return
      const command = commandOf(p.command)
      if (looked || !command || onlyLooks(command)) return
      return t.did(`ran: ${command.split('\n')[0]}${failed ? ' (failed)' : ''}`, at)
    }
    case 'patch_apply_end':
      if (str(p.call_id) && t.ended(str(p.call_id), (line) => line)) return
      for (const file of isObject(p.changes) ? Object.keys(p.changes) : []) t.did(`${EDITED}${shortPath(file, info.cwd)}`, at)
      return
    case 'web_search_end':
      return t.did(`searched the web: ${str(p.query)}`, at)
    case 'mcp_tool_call_end': {
      const call = isObject(p.invocation) ? p.invocation : {}
      const server = str(call.server)
      t.did(`used ${server}: ${str(call.tool)}`, at)
      const ok = isObject(p.result) && isObject(p.result.Ok) ? p.result.Ok : null
      if (ok) t.got(`What ${server} gave`, resultText(ok.content), at)
      return
    }
  }
}

/**
 * A session as an agent's document: what was said, day by day, with a line for what was done, the latest summary
 * the tool wrote of it, and what tools of their workspace found; without secrets. Read a line at a time, so a
 * session of a gigabyte takes seconds and little memory (in the worker that reads files).
 */
export async function readSession(file: string): Promise<string> {
  const stat = await fs.stat(file)
  if (stat.size > MAX_SESSION_BYTES) throw new Error(`larger than ${MAX_SESSION_BYTES / 1073741824} GB`)
  let tool: LocalTool | undefined
  let t: Transcript | undefined
  const info: { cwd?: string; branch?: string; title?: string } = {}
  const tools = new Map<string, string>()
  // A Codex session as what went to the model tells it: used when it has no events (from before Codex wrote them).
  const items = new Transcript(AI_NAMES.codex)
  let codexEvents = false
  let codexId = ''
  const titles = { custom: '', ai: '' }
  for await (const line of linesOf(file)) {
    const r = parse(line)
    if (!r) continue
    if (!tool) {
      tool = r.type === 'session_meta' || r.type === 'response_item' || r.type === 'event_msg' || r.type === 'turn_context' ? 'codex' : 'claude-code'
      t = new Transcript(AI_NAMES[tool])
    }
    if (tool === 'claude-code') {
      if (r.type === 'custom-title' && str(r.customTitle)) titles.custom = str(r.customTitle)
      else if (r.type === 'ai-title' && str(r.aiTitle)) titles.ai = str(r.aiTitle)
      claudeLine(r, t!, info, tools)
      // Its own map of what each of its tools was, for the results that come back: the recent ones are enough.
      if (tools.size > 5000) tools.delete(tools.keys().next().value!)
    } else {
      if (r.type === 'event_msg') codexEvents = true
      if (r.type === 'session_meta' && isObject(r.payload)) codexId = str(r.payload.id)
      codexLine(r, t!, info, items)
    }
  }
  if (!t || !tool) throw new Error('not a Claude Code or Codex session')
  if (tool === 'codex' && !codexEvents) t = items
  if (!t.said && !t.replies) throw new Error('nothing was said in it yet')
  info.title = tool === 'codex' ? (await codexTitlesFor(file)).get(codexId) : titles.custom || titles.ai
  const text = t.text(header(tool, info, t.firstAt, t.endedAt))
  // Months of work in one session: its start and as much of its end as a document holds.
  return text.length > MAX_SESSION_CHARS ? sessionForStudy(text, MAX_SESSION_CHARS) : text
}
