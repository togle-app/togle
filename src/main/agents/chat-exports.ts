// Their chats on claude.ai and ChatGPT, from the export of them each one gives (claude.ai: Settings › Privacy › Export
// data; ChatGPT: Settings › Data controls › Export data): neither lets another app read a user's chats, and the export
// is how they give them out. Togle finds the zip they downloaded (in Downloads), or one they give it (dropped in,
// picked), and lists their chats like their work sessions; a chat picked for an agent is read from it as a session is:
// what was said, a line for what the AI did, what they attached, without secrets. The export is never copied, only the
// newest one of each account is read, and of that only the part that holds their conversations (never its pictures).
import { createReadStream, promises as fs, type Stats } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { GivenExport, SessionHome, WorkSessionInfo } from '@shared/types'
import { inReader } from './reader'
import { day, isObject, oneLine, sessionForStudy, str, timeOf, TOOL_RESULT_CHARS, Transcript, withoutSecrets, type Json } from './transcript'
import { entryStream, zipEntries, type ZipEntry } from './zipfile'

export type ChatTool = 'claude-ai' | 'chatgpt'
type Chat = WorkSessionInfo

export const CHAT_NAMES: Record<ChatTool, string> = { 'claude-ai': 'claude.ai', chatgpt: 'ChatGPT' }
const AI: Record<ChatTool, string> = { 'claude-ai': 'Claude', chatgpt: 'ChatGPT' }
// Where each chat is on the web: what it's known by in Togle (a work session's "file"), and what opens it.
const ADDRESS: Record<ChatTool, string> = { 'claude-ai': 'https://claude.ai/chat/', chatgpt: 'https://chatgpt.com/c/' }
const ADDRESS_FORM = /^https:\/\/(?:claude\.ai\/chat|chatgpt\.com\/c)\/[\w-]{6,80}$/

/** Whether a work session's "file" is a chat's address on claude.ai or ChatGPT (read from their export). */
export const isChatAddress = (file: string | undefined): boolean => !!file && ADDRESS_FORM.test(file)

// An export's files of conversations (one, or numbered parts of a large one) and of who it's of (users.json on
// claude.ai, user.json on ChatGPT), in it or in the folder it was unpacked to.
const CONVERSATIONS = /(?:^|[\\/])conversations(?:-\d+)?\.json$/i
const ACCOUNT = /(?:^|[\\/])users?\.json$/i
// Looked at to tell an export from another zip, and which one it is: its first chat starts here.
const PEEK_BYTES = 256 * 1024
const MAX_ACCOUNT_BYTES = 4 * 1048576
// No chat is this large (that's what pictures written into one would take): it isn't read.
const MAX_CHAT_BYTES = 256 * 1048576
// What's kept of a chat, at most, as of a work session (sessions.ts).
const MAX_CHAT_CHARS = 4_000_000
const TITLE_CHARS = 90
// Of a file they attached (claude.ai keeps its text), and of a document the AI wrote them (an artifact, a canvas).
const ATTACHED_CHARS = 4_000
const WROTE_CHARS = 3_000
// Listing an export of years of chats takes seconds; a slow disk, more.
const LIST_TIMEOUT_MS = 180_000
// Their Downloads folder is looked through again after this long, for an export downloaded since.
const SCAN_MS = 10_000

// ---- What's in a JSON array, one element at a time ----

/**
 * The elements of the JSON array a stream holds, one at a time, each parsed only when `keep` wants it: an export of
 * gigabytes takes the memory of its largest chat. Each comes with its size in bytes; one too large to read (`big`), or
 * that isn't JSON, comes without its value, and the rest are read all the same.
 */
async function* elementsOf(
  stream: AsyncIterable<Buffer>,
  keep: (n: number) => boolean = () => true
): AsyncGenerator<{ n: number; value?: unknown; bytes: number; big?: boolean }> {
  let depth = 0
  let quoted = false
  let escaped = false
  let n = 0
  let parts: Buffer[] = []
  let size = 0
  let keeping = false
  let big = false
  for await (const chunk of stream) {
    // Where the element in hand starts in this chunk (its start, or where it went on from the last one).
    let from = 0
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]
      if (quoted) {
        if (escaped) escaped = false
        else if (c === 0x5c) escaped = true
        else if (c === 0x22) quoted = false
        continue
      }
      if (c === 0x22) quoted = true
      else if (c === 0x7b || c === 0x5b) {
        if (depth === 1) {
          keeping = keep(n)
          big = false
          from = i
          parts = []
          size = 0
        }
        depth++
      } else if (c === 0x7d || c === 0x5d) {
        depth--
        if (depth === 1) {
          size += i + 1 - from
          let value: unknown
          if (keeping) {
            parts.push(chunk.subarray(from, i + 1))
            try {
              value = JSON.parse(Buffer.concat(parts).toString('utf8'))
            } catch {
              // Not JSON (a NaN written in it): this one isn't read.
            }
            parts = []
          }
          yield { n: n++, value, bytes: size, ...(big ? { big } : {}) }
        } else if (depth <= 0) return
      }
    }
    if (depth > 1) {
      size += chunk.length - from
      if (keeping) {
        parts.push(chunk.subarray(from))
        // Pictures written into it, likely: no more of it is kept.
        if (size > MAX_CHAT_BYTES) {
          keeping = false
          big = true
          parts = []
        }
      }
    }
  }
}

// ---- Which export a file is ----

/** One of an export's files: in its zip, or on disk (unpacked). */
interface Place {
  name: string
  entry?: ZipEntry
  /** The zip it's in, when that's another of the export's batches than its first. */
  zip?: string
  file?: string
}

/** An export of their chats: where it is, which it is, whose. */
export interface ChatExport {
  tool: ChatTool
  /** The zip they downloaded, the folder it was unpacked to, or its file of conversations. */
  file: string
  /** Its files of conversations, in order. */
  parts: Place[]
  /** The account it's of (its id there, when it says), to tell their accounts apart; its email names it. */
  account: string
  email?: string
  /** When it was made (downloaded, unpacked): an account's newest export is the one read. */
  at: number
  /** Its files as read (their sizes and times): what it holds is the same while they are. */
  stamp: string
}

const open = (ex: { file: string }, place: Place): Promise<Readable> =>
  place.entry ? entryStream(place.zip ?? ex.file, place.entry) : Promise.resolve(createReadStream(place.file!, { highWaterMark: 1 << 20 }))

const stampOf = (stat: Stats): string => `${stat.size}:${Math.round(stat.mtimeMs)}`
const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name)
const depthOf = (name: string): number => name.split(/[\\/]/).length

/** The start of a stream, as text. */
async function startOf(stream: Readable, bytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk)
    size += chunk.length
    if (size >= bytes) break
  }
  stream.destroy()
  return Buffer.concat(chunks).subarray(0, bytes).toString('utf8')
}

/** All of a small file of an export, as text. */
async function wholeOf(ex: { file: string }, place: Place): Promise<string> {
  const stream = await open(ex, place)
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk)
    size += chunk.length
    if (size > MAX_ACCOUNT_BYTES) {
      stream.destroy()
      return ''
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** What its parts and account file make of a zip, a folder or a file: the export it is, or null when it isn't one. */
async function describe(file: string, parts: Place[], account: Place | undefined, at: number, stamp: string): Promise<ChatExport | null> {
  if (!parts.length) return null
  // Which one it is, by how its first chat is written: claude.ai's have chat_messages, ChatGPT's a mapping of them.
  const start = await startOf(await open({ file }, parts[0]), PEEK_BYTES).catch(() => '')
  if (!/^﻿?\s*\[/.test(start)) return null
  const claude = start.search(/"chat_messages"\s*:/)
  const chatgpt = start.search(/"mapping"\s*:\s*\{/)
  if (claude < 0 && chatgpt < 0) return null
  const tool: ChatTool = claude >= 0 && (chatgpt < 0 || claude < chatgpt) ? 'claude-ai' : 'chatgpt'
  // Whose: claude.ai lists its one user (uuid, email_address), ChatGPT gives it (id, email).
  let who: Json = {}
  try {
    const value: unknown = account ? JSON.parse((await wholeOf({ file }, account)) || 'null') : null
    who = (Array.isArray(value) ? value.find(isObject) : isObject(value) ? value : undefined) ?? {}
  } catch {
    // Unreadable: an export of an account it doesn't say.
  }
  const email = str(who.email_address) || str(who.email)
  return { tool, file, parts, account: str(who.uuid) || str(who.id), ...(email ? { email } : {}), at, stamp }
}

// A large account's export from claude.ai comes in batches, data-…-batch-0000.zip, -0001.zip and on: one export.
const BATCH = /^(.*-batch-)\d{4}\.zip$/i

/** The zips of the export a zip is one of, in order: itself alone, unless it's one of the batches of one. */
async function batchesOf(file: string): Promise<string[]> {
  const prefix = BATCH.exec(path.basename(file))?.[1].toLowerCase()
  if (!prefix) return [file]
  const dir = path.dirname(file)
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => BATCH.exec(n)?.[1].toLowerCase() === prefix).sort()
  return names.length ? names.map((n) => path.join(dir, n)) : [file]
}

async function zipExport(batches: { file: string; stat: Stats }[]): Promise<ChatExport | null> {
  const parts: Place[] = []
  let account: Place | undefined
  for (const { file } of batches) {
    // A batch still downloading (cut short) is read once it's whole: its time changes then.
    const entries = (await zipEntries(file))?.filter((e) => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/'))
    if (!entries) continue
    const own = entries.filter((e) => CONVERSATIONS.test(e.name)).sort(byName)
    // Beside its conversations, else the nearest the top.
    const folder = own[0]?.name.replace(/[^/]*$/, '') ?? ''
    const accounts = entries.filter((e) => ACCOUNT.test(e.name)).sort((a, b) => depthOf(a.name) - depthOf(b.name))
    const found = accounts.find((e) => e.name.replace(/[^/]*$/, '') === folder) ?? accounts[0]
    account ??= found && { name: found.name, entry: found, zip: file }
    parts.push(...own.map((e) => ({ name: e.name, entry: e, zip: file })))
  }
  return describe(
    batches[0].file,
    parts,
    account,
    Math.max(...batches.map((b) => b.stat.mtimeMs)),
    batches.map((b) => stampOf(b.stat)).join(' ')
  )
}

/** Files of an unpacked export in a folder: there, or a folder down (one unpacked into a folder of its name). */
async function exportFilesIn(dir: string, depth = 2): Promise<string[]> {
  const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  const found: string[] = []
  for (const item of items) {
    const at = path.join(dir, item.name)
    if (item.isFile() && (CONVERSATIONS.test(item.name) || ACCOUNT.test(item.name))) found.push(at)
    else if (item.isDirectory() && depth > 1 && !item.name.startsWith('.')) found.push(...(await exportFilesIn(at, depth - 1)))
  }
  return found
}

async function filesExport(file: string, files: string[]): Promise<ChatExport | null> {
  const parts = files.filter((f) => CONVERSATIONS.test(f)).map((f) => ({ name: f, file: f })).sort(byName)
  const folder = parts[0] ? path.dirname(parts[0].file) : ''
  const accounts = files.filter((f) => ACCOUNT.test(f)).sort((a, b) => depthOf(a) - depthOf(b))
  const account = accounts.find((f) => path.dirname(f) === folder) ?? accounts[0]
  const stats = await Promise.all(parts.map((p) => fs.stat(p.file)))
  return describe(
    file,
    parts,
    account ? { name: account, file: account } : undefined,
    Math.max(0, ...stats.map((s) => s.mtimeMs)),
    stats.map(stampOf).join(' ')
  )
}

// What each zip and file is while it's the same: one that isn't an export is looked into once.
const looked = new Map<string, { stamp: string; found: Promise<ChatExport | null> }>()

/** The export a zip, a folder or a conversations file is, or null when it isn't one of claude.ai or ChatGPT. */
export async function exportAt(file: string): Promise<ChatExport | null> {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat) return null
  // A folder is looked into each time: what's in it changes without its own time changing. One of its files gone
  // between the two looks (it's being unpacked, or deleted) makes it no export for now.
  if (stat.isDirectory()) return filesExport(file, await exportFilesIn(file)).catch(() => null)
  // A batch of an export is looked at as the export, by its first batch: as all its batches are now.
  const zip = /\.zip$/i.test(file)
  const batches = zip ? await batchesOf(file) : [file]
  const stats = batches.length > 1 ? await Promise.all(batches.map((b) => fs.stat(b).catch(() => null))) : [stat]
  const known = batches.flatMap((b, i) => (stats[i] ? [{ file: b, stat: stats[i] }] : []))
  if (!known.length) return null
  const stamp = known.map((b) => stampOf(b.stat)).join(' ')
  const key = known[0].file
  const had = looked.get(key)
  if (had?.stamp === stamp) return had.found
  const found = zip
    ? zipExport(known)
    : CONVERSATIONS.test(file)
      ? // Its numbered parts beside it, and who it's of.
        fs
          .readdir(path.dirname(file))
          .then((names) => filesExport(file, names.filter((n) => CONVERSATIONS.test(n) || ACCOUNT.test(n)).map((n) => path.join(path.dirname(file), n))))
      : Promise.resolve(null)
  // Not read this time (a file not downloaded from the cloud yet, a drive gone): looked at again next time.
  const safe = found.catch(() => {
    if (looked.get(key)?.found === safe) looked.delete(key)
    return null
  })
  looked.set(key, { stamp, found: safe })
  return safe
}

// ---- The exports Togle reads: the ones they gave it, and the ones in Downloads ----

let listFile: string | undefined
let downloads: string | undefined
let given: string[] | undefined
let scan: { at: number; files: Promise<string[]> } | undefined

/**
 * Where the exports they gave Togle are listed (in its data), and their Downloads folder, where one they download
 * lands. Without them (as in the tests), only exports given since are known, and none is looked for.
 */
export function setChatExports(where: { list?: string; downloads?: string }): void {
  listFile = where.list
  downloads = where.downloads
  given = undefined
  scan = undefined
}

const samePath = (a: string, b: string): boolean =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)

async function givenFiles(): Promise<string[]> {
  if (given) return given
  // Unreadable (cut short by a power cut, edited by hand): as if it listed none, rather than every list failing.
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }
  const saved: unknown = listFile ? await fs.readFile(listFile, 'utf8').then(parse, () => null) : null
  const files = isObject(saved) && Array.isArray(saved.files) ? saved.files : []
  given ??= files.filter((f): f is string => typeof f === 'string' && path.isAbsolute(f))
  return given
}

// The list's writes, one after another, each of the list as it is then.
let writing: Promise<void> = Promise.resolve()

/** Keeps the list of exports they gave as `change` makes it of the list as it is when it's written. */
function keepGiven(change: (files: string[]) => string[]): Promise<void> {
  const write = writing.then(async () => {
    given = change(await givenFiles())
    if (!listFile) return
    // All at once: a crash mid-write leaves the list it had.
    const temp = `${listFile}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(listFile), { recursive: true })
    await fs.writeFile(temp, JSON.stringify({ files: given }, null, 2), 'utf8')
    await fs.rename(temp, listFile)
  })
  writing = write.catch(() => undefined)
  return write
}

/**
 * Whether an export they gave is gone for good: its folder is there without it (moved, deleted). Not one on a drive
 * that isn't there now (a USB stick, a share while offline), nor one that couldn't be read this time: they come back.
 */
async function goneForGood(file: string): Promise<boolean> {
  const missing = await fs.stat(file).then(
    () => false,
    (err: NodeJS.ErrnoException) => err.code === 'ENOENT'
  )
  return (
    missing &&
    fs.stat(path.dirname(file)).then(
      () => true,
      () => false
    )
  )
}

/** In their Downloads folder: zips, and the folders and files unpacked from one (an export is told by what's in it). */
async function inDownloads(): Promise<string[]> {
  if (!downloads) return []
  if (!scan || Date.now() - scan.at > SCAN_MS) {
    const dir = downloads
    const files = (async (): Promise<string[]> => {
      const items = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
      const found: string[] = []
      for (const item of items) {
        const at = path.join(dir, item.name)
        if (item.isFile() && (/\.zip$/i.test(item.name) || CONVERSATIONS.test(item.name))) found.push(at)
        // A zip unpacked there, or into a folder of its name with its own folder in it ("Extract All").
        else if (item.isDirectory() && !item.name.startsWith('.') && (await exportFilesIn(at)).some((f) => CONVERSATIONS.test(f))) found.push(at)
      }
      return found
    })()
    scan = { at: Date.now(), files }
  }
  return scan.files
}

/** The newest export of each of their accounts on claude.ai and ChatGPT: the ones their chats are read from. */
export async function currentExports(): Promise<ChatExport[]> {
  const mine = await givenFiles()
  const files = [...mine, ...(await inDownloads()).filter((f) => !mine.some((g) => samePath(g, f)))]
  const found = await Promise.all(files.map((f) => exportAt(f)))
  // One they gave that's gone (moved, deleted) isn't looked for again; one given meanwhile stays.
  const missing = mine.filter((f, i) => !found[i])
  const gone = (await Promise.all(missing.map(async (f) => ((await goneForGood(f)) ? [f] : [])))).flat()
  if (gone.length) await keepGiven((files) => files.filter((f) => !gone.includes(f))).catch(() => {})
  const newest = new Map<string, ChatExport>()
  // Each export once (the batches of one are one export).
  for (const ex of found.filter((e, i) => e && found.findIndex((o) => o && samePath(o.file, e.file)) === i)) {
    if (!ex) continue
    const key = `${ex.tool} ${ex.account}`
    const had = newest.get(key)
    if (!had || ex.at > had.at) newest.set(key, ex)
  }
  return [...newest.values()].sort((a, b) => (a.tool === b.tool ? b.at - a.at : a.tool === 'claude-ai' ? -1 : 1))
}

/** What an account's chats are kept apart by, in an agent's own sources: "chatgpt://user-…". */
const homeKey = (ex: { tool: ChatTool; account: string }): string => `${ex.tool === 'claude-ai' ? 'claude.ai' : 'chatgpt'}://${ex.account || 'export'}`

/** An account's export as where its chats come from: "ChatGPT", or "ChatGPT (me@acme.com)" beside another one's. */
function homeOf(ex: ChatExport, all: ChatExport[]): SessionHome {
  const label = all.filter((o) => o.tool === ex.tool).length > 1 ? ex.email || ex.account || path.basename(ex.file) : ''
  return { tool: ex.tool, dir: homeKey(ex), name: label ? `${CHAT_NAMES[ex.tool]} (${label})` : CHAT_NAMES[ex.tool], from: ex.file }
}

/** Their accounts on claude.ai and ChatGPT that Togle has an export of, as where their chats come from. */
export async function chatHomes(): Promise<SessionHome[]> {
  const exports = await currentExports()
  return exports.map((ex) => homeOf(ex, exports))
}

// ---- The chats in an export ----

/** An export's chats, newest first, and where each is in it (which of its files, which of the chats there), by address. */
export interface ExportChats {
  chats: Chat[]
  where: Record<string, [number, number]>
}

/** The chats an export holds, read through once (in the worker that reads files: years of chats take seconds). */
export async function exportChats(file: string): Promise<ExportChats> {
  const ex = await exportAt(file)
  if (!ex) throw new Error("it isn't an export of chats from claude.ai or ChatGPT")
  const chats: Chat[] = []
  const where: Record<string, [number, number]> = {}
  for (const [part, place] of ex.parts.entries()) {
    for await (const { n, value, bytes } of elementsOf(await open(ex, place))) {
      const chat = isObject(value) ? chatOf(ex.tool, value, bytes) : null
      if (!chat || where[chat.file]) continue
      chats.push(chat)
      where[chat.file] = [part, n]
    }
  }
  return { chats: chats.sort((a, b) => b.updatedAt - a.updatedAt), where }
}

// Each export's chats while it's the same (a failure too, said once: it isn't read again each time it's looked at).
const lists = new Map<string, { stamp: string; chats: Promise<ExportChats> }>()

function listOf(ex: ChatExport): Promise<ExportChats> {
  const had = lists.get(ex.file)
  if (had?.stamp === ex.stamp) return had.chats
  const chats = inReader({ task: 'chats', file: ex.file }, () => exportChats(ex.file), LIST_TIMEOUT_MS)
  chats.catch((err: Error) => console.warn(`[chats] ${path.basename(ex.file)} not read:`, err.message))
  lists.set(ex.file, { stamp: ex.stamp, chats })
  return chats
}

/** Their chats from the accounts these are (an agent's own, or all), newest first, each with which it's from. */
export async function chatsIn(homes: SessionHome[]): Promise<Chat[]> {
  const exports = await currentExports()
  const found: Chat[] = []
  for (const ex of exports) {
    const home = homeOf(ex, exports)
    if (!homes.some((h) => h.dir.toLowerCase() === home.dir.toLowerCase())) continue
    const list = await listOf(ex).catch(() => null)
    // One at a time: years of chats are more than a call's arguments hold.
    for (const chat of list?.chats ?? []) found.push({ ...chat, home: home.name })
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Where a chat is: the newest export of its account that has it. */
async function locate(address: string): Promise<{ ex: ChatExport; at: [number, number]; chat: Chat; home: string } | null> {
  const exports = await currentExports()
  for (const ex of exports) {
    if (!address.startsWith(ADDRESS[ex.tool])) continue
    const list = await listOf(ex).catch(() => null)
    const at = list?.where[address]
    const chat = at && list.chats.find((c) => c.file === address)
    if (at && chat) return { ex, at, chat, home: homeOf(ex, exports).name }
  }
  return null
}

/** A chat by its address, as the newest export of it has it; null when none has it (deleted since, or not exported). */
export async function chatInfo(address: string): Promise<Chat | null> {
  const found = await locate(address)
  return found && { ...found.chat, home: found.home }
}

/** A chat as an agent's document, read from the newest export of it (in the worker that reads files). */
export async function readChat(address: string): Promise<string> {
  const found = await locate(address)
  if (!found) throw new Error("it isn't in your newest export from claude.ai or ChatGPT")
  const [part, n] = found.at
  return inReader({ task: 'chat', file: found.ex.file, id: address, part, n }, () => chatAt(found.ex.file, address, part, n))
}

/** The chat at that place in an export, as a document; looked for all through it when it isn't there. */
export async function chatAt(file: string, address: string, part: number, n: number): Promise<string> {
  const ex = await exportAt(file)
  if (!ex) throw new Error("it isn't an export of chats from claude.ai or ChatGPT")
  const find = async (p: number, only?: number): Promise<Json | null> => {
    for await (const item of elementsOf(await open(ex, ex.parts[p]), (i) => only === undefined || i === only)) {
      if (item.big && item.n === only) throw new Error('it is larger than Togle reads of a chat')
      if (isObject(item.value) && chatOf(ex.tool, item.value, item.bytes)?.file === address) return item.value
      if (only !== undefined && item.n >= only) break
    }
    return null
  }
  let chat = part < ex.parts.length ? await find(part, n) : null
  for (let p = 0; !chat && p < ex.parts.length; p++) chat = await find(p)
  if (!chat) throw new Error("it isn't in that export any more")
  return chatText(ex, chat)
}

// ---- A chat as it was said ----

/** One thing in a chat, in order: what they said, what the AI replied, did, or wrote them, what they attached. */
interface Turn {
  kind: 'me' | 'ai' | 'did' | 'got'
  text: string
  at: number
  images?: number
  label?: string
  max?: number
}

const PICTURE = /\.(?:png|jpe?g|gif|webp|heic|bmp)$/i
// A chat named nothing yet: its tool's word for that.
const UNTITLED = /^(?:new chat|untitled|new conversation)?$/i

// claude.ai's own tools, not a workspace of theirs: what a connector of theirs gave it (a ticket, a doc) is kept, as in a
// work session, but not its own searches.
const CLAUDE_OWN = new Set([
  'web_search',
  'web_fetch',
  'artifacts',
  'repl',
  'analysis',
  'conversation_search',
  'recent_chats',
  'memory_user_edits',
  'end_conversation',
  'bash_tool',
  'create_file',
  'str_replace',
  'view',
  'present_files',
  'image_search',
  'launch_extended_search_task'
])

/** claude.ai keeps every try of a chat: the one it ended on (its newest message), from its start. */
function claudeMessages(c: Json): Json[] {
  const all = Array.isArray(c.chat_messages) ? c.chat_messages.filter(isObject) : []
  if (!all.some((m) => str(m.parent_message_uuid))) return all
  const byId = new Map(all.map((m) => [str(m.uuid), m]))
  const parents = new Set(all.map((m) => str(m.parent_message_uuid)))
  const leaves = all.filter((m) => !parents.has(str(m.uuid)))
  let last = leaves[0] ?? all[all.length - 1]
  for (const m of leaves) if (timeOf(m.created_at) >= timeOf(last.created_at)) last = m
  const branch: Json[] = []
  const seen = new Set<string>()
  for (let m: Json | undefined = last; m && !seen.has(str(m.uuid)); m = byId.get(str(m.parent_message_uuid))) {
    seen.add(str(m.uuid))
    branch.push(m)
  }
  return branch.reverse()
}

const blockText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter(isObject)
          .map((b) => (b.type === 'text' ? str(b.text) : ''))
          .filter(Boolean)
          .join('\n')
      : ''

function claudeTool(block: Json, at: number): Turn[] {
  const name = str(block.name)
  const input = isObject(block.input) ? block.input : {}
  if (name === 'web_search') return [{ kind: 'did', text: `searched the web: ${str(input.query)}`, at }]
  if (name === 'web_fetch') return [{ kind: 'did', text: `read ${str(input.url)}`, at }]
  if (name === 'artifacts' || name === 'create_file') {
    const title = str(input.title) || str(input.path).split(/[\\/]/).pop() || ''
    const content = str(input.content) || str(input.file_text)
    if (content.trim() && ['create', 'rewrite', ''].includes(str(input.command)))
      return [{ kind: 'got', label: `${AI['claude-ai']} wrote${title ? ` "${title}"` : ''}`, text: content, at, max: WROTE_CHARS }]
    return [{ kind: 'did', text: `changed ${title ? `"${title}"` : 'what it wrote'}`, at }]
  }
  if (name === 'str_replace') return [{ kind: 'did', text: `changed ${str(input.path).split(/[\\/]/).pop() || 'what it wrote'}`, at }]
  if (name === 'repl' || name === 'analysis' || name === 'bash_tool') return [{ kind: 'did', text: 'ran code', at }]
  return name && !CLAUDE_OWN.has(name) ? [{ kind: 'did', text: `used ${name}`, at }] : []
}

function claudeTurns(c: Json): Turn[] {
  const turns: Turn[] = []
  for (const m of claudeMessages(c)) {
    const at = timeOf(m.created_at)
    const blocks = Array.isArray(m.content) ? m.content.filter(isObject) : []
    if (m.sender === 'human') {
      const text = blocks.length ? blockText(blocks) : str(m.text)
      let images = 0
      const named: string[] = []
      const attached: Turn[] = []
      const files = [...(Array.isArray(m.attachments) ? m.attachments : []), ...(Array.isArray(m.files) ? m.files : [])].filter(isObject)
      for (const f of files) {
        const name = str(f.file_name)
        if (str(f.extracted_content).trim()) attached.push({ kind: 'got', label: `What I attached${name ? ` (${name})` : ''}`, text: str(f.extracted_content), at, max: ATTACHED_CHARS })
        else if (PICTURE.test(name) || /image/i.test(str(f.file_type) || str(f.file_kind))) images++
        else if (name) named.push(name)
      }
      turns.push({ kind: 'me', text: [text.trim(), named.length ? `[attached ${named.join(', ')}]` : ''].filter(Boolean).join(' '), at, images }, ...attached)
    } else if (m.sender === 'assistant') {
      if (!blocks.length) turns.push({ kind: 'ai', text: str(m.text), at })
      for (const b of blocks) {
        if (b.type === 'text') turns.push({ kind: 'ai', text: str(b.text), at })
        else if (b.type === 'tool_use') turns.push(...claudeTool(b, at))
        else if (b.type === 'tool_result' && str(b.name) && !CLAUDE_OWN.has(str(b.name)) && !b.is_error)
          turns.push({ kind: 'got', label: `What ${str(b.name)} gave`, text: blockText(b.content), at, max: TOOL_RESULT_CHARS })
      }
    }
  }
  return turns
}

/**
 * ChatGPT keeps a chat as a tree (each edit or retry a branch): the branch it's on now, from its start. Without its
 * current message, the newest one ends it.
 */
function chatgptMessages(c: Json): Json[] {
  const nodes = new Map(Object.entries(isObject(c.mapping) ? c.mapping : {}).filter((e): e is [string, Json] => isObject(e[1])))
  let id = str(c.current_node)
  if (!nodes.has(id)) {
    let newest = -1
    for (const [key, node] of nodes) {
      const leaf = !Array.isArray(node.children) || !node.children.length
      const at = isObject(node.message) ? timeOf(node.message.create_time) : 0
      if (leaf && at > newest) [id, newest] = [key, at]
    }
  }
  const branch: Json[] = []
  const seen = new Set<string>()
  for (let node = nodes.get(id); node && !seen.has(id); node = nodes.get(id)) {
    seen.add(id)
    if (isObject(node.message)) branch.push(node.message)
    id = str(node.parent)
  }
  return branch.reverse()
}

/** What a ChatGPT message's parts say (and what voice chats heard), and how many pictures it had. */
function partsOf(parts: unknown): { text: string; images: number } {
  let images = 0
  const texts: string[] = []
  for (const part of Array.isArray(parts) ? parts : []) {
    if (typeof part === 'string') texts.push(part)
    else if (isObject(part) && part.content_type === 'image_asset_pointer') images++
    else if (isObject(part) && part.content_type === 'audio_transcription') texts.push(str(part.text))
  }
  return { text: texts.join('\n').trim(), images }
}

const jsonOf = (text: string): Json | null => {
  try {
    const value: unknown = JSON.parse(text)
    return isObject(value) ? value : null
  } catch {
    return null
  }
}

/** What ChatGPT searched the web for, as its call writes it. */
function searched(text: string): string {
  const call = jsonOf(text)
  const queries = call && Array.isArray(call.search_query) ? call.search_query.filter(isObject) : []
  return str(queries[0]?.q) || str(call?.query) || str(call?.q) || /search\("([^"]{1,200})"/.exec(text)?.[1] || ''
}

// What ChatGPT's message holds that isn't said in the chat: their custom instructions and its memory of them, its
// thinking, its errors.
const NOT_SAID = new Set(['user_editable_context', 'model_editable_context', 'thoughts', 'reasoning_recap', 'system_error'])

function chatgptTool(to: string, content: Json, at: number): Turn[] {
  const text = str(content.text) || partsOf(content.parts).text
  if (/^(?:web|browser)(?:\.|$)/.test(to)) {
    const query = searched(text)
    return [{ kind: 'did', text: `searched the web${query ? `: ${query}` : ''}`, at }]
  }
  if (to === 'python') return [{ kind: 'did', text: 'ran Python', at }]
  if (/text2im|image_gen|dalle/i.test(to)) return [{ kind: 'did', text: 'made a picture', at }]
  // What it noted in its memory of them.
  if (to === 'bio') return []
  if (to === 'canmore.create_textdoc') {
    const doc = jsonOf(text)
    const name = str(doc?.name)
    return [{ kind: 'got', label: `${AI.chatgpt} wrote${name ? ` "${name}"` : ''}`, text: str(doc?.content) || text, at, max: WROTE_CHARS }]
  }
  if (to.startsWith('canmore.')) return [{ kind: 'did', text: 'changed what it wrote in the canvas', at }]
  if (/file_search|myfiles_browser/.test(to)) return [{ kind: 'did', text: 'searched the files I gave it', at }]
  return [{ kind: 'did', text: `used ${to}`, at }]
}

function chatgptTurns(c: Json): Turn[] {
  const turns: Turn[] = []
  for (const m of chatgptMessages(c)) {
    const content = isObject(m.content) ? m.content : {}
    const meta = isObject(m.metadata) ? m.metadata : {}
    const role = isObject(m.author) ? str(m.author.role) : ''
    if (meta.is_visually_hidden_from_conversation || NOT_SAID.has(str(content.content_type))) continue
    const at = timeOf(m.create_time)
    if (role === 'user') {
      const { text, images } = partsOf(content.parts)
      const named = (Array.isArray(meta.attachments) ? meta.attachments.filter(isObject) : [])
        .filter((a) => !/^image\//i.test(str(a.mime_type)) && !PICTURE.test(str(a.name)))
        .map((a) => str(a.name))
        .filter(Boolean)
      turns.push({ kind: 'me', text: [text, named.length ? `[attached ${named.join(', ')}]` : ''].filter(Boolean).join(' '), at, images })
    } else if (role === 'assistant') {
      const to = str(m.recipient) || 'all'
      if (to !== 'all') turns.push(...chatgptTool(to, content, at))
      else if (['text', 'multimodal_text'].includes(str(content.content_type))) turns.push({ kind: 'ai', text: partsOf(content.parts).text, at })
    }
  }
  return turns
}

const turnsOf = (tool: ChatTool, c: Json): Turn[] => (tool === 'claude-ai' ? claudeTurns(c) : chatgptTurns(c))

/** A chat's entry in a list (as a work session's), or null when nothing was asked in it. */
function chatOf(tool: ChatTool, c: Json, bytes: number): Chat | null {
  const id = tool === 'claude-ai' ? str(c.uuid) : str(c.conversation_id) || str(c.id)
  if (!/^[\w-]{6,80}$/.test(id)) return null
  const turns = turnsOf(tool, c)
  const asked = turns.filter((t) => t.kind === 'me' && t.text.trim())
  if (!asked.length) return null
  const name = (tool === 'claude-ai' ? str(c.name) : str(c.title)).trim()
  // Its name in their list of chats, which they know it by: it stays, unless it has none yet.
  const named = !UNTITLED.test(name)
  const times = turns.map((t) => t.at).filter(Boolean)
  const startedAt = timeOf(tool === 'claude-ai' ? c.created_at : c.create_time) || (times.length ? Math.min(...times) : 0)
  const updatedAt = timeOf(tool === 'claude-ai' ? c.updated_at : c.update_time) || (times.length ? Math.max(...times) : startedAt)
  // What's shown of it in a list, and goes to the model looking for it (and names a document): without secrets either.
  const shown = (text: string, max: number): string => oneLine(withoutSecrets(text.slice(0, 2000)), max)
  return {
    id,
    tool,
    title: shown(named ? name : asked[0].text, TITLE_CHARS),
    ...(named ? { named } : {}),
    startedAt,
    updatedAt,
    bytes,
    file: `${ADDRESS[tool]}${id}`,
    first: shown(asked[0].text, 300),
    last: asked.length > 1 ? shown(asked[asked.length - 1].text, 300) : undefined
  }
}

function chatText(ex: ChatExport, c: Json): string {
  const t = new Transcript(AI[ex.tool])
  for (const turn of turnsOf(ex.tool, c)) {
    if (turn.kind === 'me') t.me(turn.text, turn.at, turn.images)
    else if (turn.kind === 'ai') t.reply(turn.text, turn.at)
    else if (turn.kind === 'did') t.did(turn.text, turn.at)
    else t.got(turn.label ?? 'What it gave', turn.text, turn.at, turn.max)
  }
  if (!t.said && !t.replies) throw new Error('nothing was said in it')
  const name = (ex.tool === 'claude-ai' ? str(c.name) : str(c.title)).trim()
  const when = t.firstAt && t.endedAt ? (day(t.firstAt) === day(t.endedAt) ? `on ${day(t.firstAt)}` : `from ${day(t.firstAt)} to ${day(t.endedAt)}`) : ''
  const header = [
    `# ${UNTITLED.test(name) ? '' : `${name} — `}a chat on ${CHAT_NAMES[ex.tool]}`,
    '',
    `A chat on ${CHAT_NAMES[ex.tool]} with ${AI[ex.tool]}, an AI assistant${when ? `, ${when}` : ''}. "Me" is the user; "${AI[ex.tool]}" is the AI they talked with. Lines in parentheses are what it did. It's from an export of their chats: what was said there since isn't in it.`
  ].join('\n')
  const text = t.text(header)
  return text.length > MAX_CHAT_CHARS ? sessionForStudy(text, MAX_CHAT_CHARS) : text
}

// ---- One they give Togle ----

/**
 * An export they gave Togle (dropped in, picked): their chats are read from it from now on, while it's there. What
 * it holds, as they're told it went in; null when the file isn't an export of their chats.
 */
export async function addExport(file: string): Promise<GivenExport | null> {
  const ex = await exportAt(file)
  if (!ex) return null
  await keepGiven((files) => (files.some((f) => samePath(f, ex.file)) ? files : [...files, ex.file]))
  const list = await listOf(ex)
  const exports = await currentExports()
  const current = exports.find((o) => homeKey(o) === homeKey(ex))
  const newer = current && !samePath(current.file, ex.file) ? current.at : undefined
  return { home: homeOf(current ?? ex, exports).name, chats: list.chats.length, newest: list.chats[0]?.updatedAt ?? 0, ...(newer ? { newer } : {}) }
}
