import { promises as fs } from 'node:fs'
import path from 'node:path'
import { inReader } from './reader'
import { readSession } from './sessions'

export { setReaderScript } from './reader'

export const TEXT_EXTENSIONS = ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log', 'rst']
export const SUPPORTED_EXTENSIONS = [...TEXT_EXTENSIONS, 'pdf', 'docx', 'pptx']

const CHUNK_CHARS = 1200
const MAX_FILE_BYTES = 25 * 1048576
const MAX_FOLDER_FILES = 500

/** A character by its number in a reference (&#99;); one there isn't (&#99999999;) is the replacement character. */
const character = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : String.fromCharCode(0xfffd))

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d{1,8});/g, (_, n) => character(Number(n)))
    .replace(/&#x([0-9a-f]{1,8});/gi, (_, n) => character(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

/** The texts between each `open` and its `close`, scanning forward once: an opener never closed ends it. */
function between(text: string, open: string, close: string): string[] {
  const found: string[] = []
  for (let at = text.indexOf(open); at >= 0; at = text.indexOf(open, at)) {
    const end = text.indexOf(close, at + open.length)
    if (end < 0) break
    found.push(text.slice(at + open.length, end))
    at = end + close.length
  }
  return found
}

/** Text of a DrawingML part (slides, notes): one line per paragraph. */
function drawingText(xml: string): string {
  return between(xml, '<a:p>', '</a:p>')
    .map((p) => decodeXml(between(p, '<a:t>', '</a:t>').join('')))
    .filter((line) => line.trim())
    .join('\n')
}

async function pptxText(buf: Buffer): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buf)
  const slideNo = (name: string): number => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0)
  const slides = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNo(a) - slideNo(b))
  const parts: string[] = []
  for (const [i, name] of slides.entries()) {
    const body = drawingText(await zip.file(name)!.async('string'))
    const rels = await zip.file(name.replace('slides/', 'slides/_rels/') + '.rels')?.async('string')
    const notesTarget = rels && /Target="\.\.\/notesSlides\/(notesSlide\d+\.xml)"/.exec(rels)?.[1]
    const notesXml = notesTarget ? await zip.file(`ppt/notesSlides/${notesTarget}`)?.async('string') : undefined
    // Notes repeat the slide number placeholder; drop bare numbers.
    const notes = notesXml ? drawingText(notesXml).split('\n').filter((l) => !/^\d+$/.test(l.trim())).join('\n') : ''
    parts.push(`## Slide ${i + 1}\n${body}${notes ? `\n\nSpeaker notes: ${notes}` : ''}`)
  }
  return parts.join('\n\n')
}

// The code page Windows saves text in for each language (Excel's "CSV (Comma delimited)", Notepad's ANSI).
const CODE_PAGES: Record<string, string> = {
  ...Object.fromEntries(['hr', 'bs', 'sr', 'sl', 'cs', 'sk', 'pl', 'hu', 'ro', 'sq'].map((l) => [l, 'windows-1250'])),
  ...Object.fromEntries(['ru', 'uk', 'bg', 'mk', 'be'].map((l) => [l, 'windows-1251'])),
  el: 'windows-1253',
  tr: 'windows-1254',
  he: 'windows-1255',
  ar: 'windows-1256',
  fa: 'windows-1256',
  lt: 'windows-1257',
  lv: 'windows-1257',
  et: 'windows-1257',
  vi: 'windows-1258',
  th: 'windows-874',
  ja: 'shift_jis',
  zh: 'gbk',
  ko: 'euc-kr'
}

// Windows' code pages by their numbers (what GetACP says), as TextDecoder names them.
const WINDOWS_CODE_PAGES: Record<number, string> = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  ...Object.fromEntries([1250, 1251, 1252, 1253, 1254, 1255, 1256, 1257, 1258].map((n) => [n, `windows-${n}`]))
}
let windowsCodePage: number | undefined

/** The code page Windows says this PC's programs save text in (its "ANSI" code page), from Togle's main process. */
export function setCodePage(page: number | undefined): void {
  windowsCodePage = page
}

/** The code page this PC saves text in when it isn't Unicode: the one Windows says, or else its language's. */
function localCodePage(): string {
  const windows = windowsCodePage === undefined ? undefined : WINDOWS_CODE_PAGES[windowsCodePage]
  if (windows) return windows
  const language = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale).language
  return CODE_PAGES[language] ?? 'windows-1252'
}

// The letters past ASCII each language written in a code page uses, one string per language (the rare ones left
// out). What tells code pages apart: the byte Croatian writes "č" with, French reads as "è", and Russian as "и".
const LETTERS: Record<string, string[]> = {
  // Croatian, Bosnian, Serbian and Slovene; Czech; Slovak; Polish; Hungarian; Romanian.
  'windows-1250': ['čćđšž', 'áčďéěíňóřšťúůýž', 'áäčďéíľňóôšťúýž', 'ąćęłńóśźż', 'áéíóöőúüű', 'ăâîşţ'],
  // Russian, Ukrainian, Belarusian, Bulgarian, Serbian and Macedonian.
  'windows-1251': ['абвгґдђѓеёєжзѕиіїйјклљмнњопрстћќуўфхцчџшщъыьэюя'],
  // French; German; Spanish; Italian; Portuguese; Catalan; Dutch; Swedish and Finnish; Danish and Norwegian; Icelandic.
  'windows-1252': ['àâçéèêëîïôœùûüÿ', 'äöüß', 'áéíñóúü', 'àèéìíîòóù', 'áâãàçéêíóôõú', 'àçèéíïòóúü', 'éèëïöü', 'åäöé', 'åæøé', 'áæðéíóöúýþ'],
  'windows-1254': ['çğıöşüâîû'],
  // Lithuanian; Latvian; Estonian.
  'windows-1257': ['ąčęėįšųūž', 'āčēģīķļņšūž', 'äõöšüž']
}
// Letters past ASCII that are words on their own: French "à", Italian "è", Portuguese "é", Icelandic "í", Swedish
// "å"; Russian "в" and "с". Central European languages have none.
const ALONE: Record<string, string> = {
  'windows-1250': '',
  'windows-1251': 'авикосуяізй',
  'windows-1252': 'àèéáíåöô'
}
const MULTI_BYTE = new Set(['shift_jis', 'gbk', 'euc-kr', 'big5'])

const isLetter = (ch: string | undefined): boolean => !!ch && /\p{L}/u.test(ch) && !/\p{Lm}/u.test(ch)
const isLower = (ch: string | undefined): boolean => !!ch && /\p{Ll}/u.test(ch)
const isUpper = (ch: string | undefined): boolean => !!ch && /\p{Lu}/u.test(ch)

/** A file's words that have bytes past ASCII in them (with the period after one), the first `max`, a space between. */
function wordsPastAscii(buf: Buffer, max = 4000): Buffer {
  const inWord = (b: number): boolean => b >= 0x80 || (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a)
  const words: Buffer[] = []
  for (let i = 0; i < buf.length && words.length < max; i++) {
    if (buf[i] < 0x80) continue
    let start = i
    while (start > 0 && inWord(buf[start - 1])) start--
    while (i < buf.length && inWord(buf[i])) i++
    words.push(buf.subarray(start, buf[i] === 0x2e ? i + 1 : i))
  }
  const space = Buffer.from(' ')
  return Buffer.concat(words.flatMap((word) => [word, space]))
}

/**
 * How well a code page reads a file's words past ASCII (wordsPastAscii): each letter that one of its languages uses
 * counts for it (the language using the most), and what text can't be counts twice against it: a control character
 * or none at all, a symbol inside a word ("mo¿e", Polish "może" read as Western), a word in two alphabets ("Plaжa"),
 * a capital after a small letter ("żCuánto", Spanish "¿Cuánto" read as Central European), a letter on its own that
 * is no word ("39 Ђ", "39 €" read as Cyrillic; Italian "è" read as Central European is "č").
 */
function readsAs(text: string, page: string): number {
  const languages = LETTERS[page]
  const used = (languages ?? ['']).map(() => 0)
  let odd = 0
  for (const word of text.split(' ')) {
    if (/\p{sc=Latin}/u.test(word) && /[\p{sc=Cyrillic}\p{sc=Greek}\p{sc=Hebrew}\p{sc=Arabic}\p{sc=Thai}]/u.test(word)) odd++
    const chars = [...word]
    chars.forEach((ch, i) => {
      const code = ch.charCodeAt(0)
      if (code < 0x80) return
      const before = chars[i - 1]
      const after = chars[i + 1]
      if (isLetter(ch)) {
        const lower = ch.toLowerCase()
        if (!isLetter(before) && !isLetter(after)) {
          const words = ALONE[page]
          // An initial ("Č. Čolić") isn't a word either way.
          if (words === undefined || after === '.') return
          if (words.includes(lower)) used.forEach((_, k) => used[k]++)
          else odd++
          return
        }
        if ((isLower(before) && isUpper(ch)) || (isLower(ch) && isUpper(after))) odd++
        used.forEach((_, k) => {
          if (!languages || languages[k].includes(lower)) used[k]++
        })
      } else if ((code >= 0x80 && code < 0xa0) || code === 0xfffd || (isLetter(before) && isLetter(after))) odd++
    })
  }
  return Math.max(...used) - 2 * odd
}

const decodes = (label: string): boolean => {
  try {
    new TextDecoder(label)
    return true
  } catch {
    return false
  }
}

/**
 * The code page text that isn't UTF-8 was saved in: the one the file says (an HTML page's charset, an XML file's
 * encoding); else, of this PC's and the common ones (Western, Central European, Cyrillic), the one that reads its
 * words best (readsAs), this PC's winning a tie. A Chinese, Japanese or Korean PC's own is taken when the file is
 * valid in it. A Croatian price list from a Croatian PC reads right on an English one.
 */
function codePageOf(buf: Buffer): string {
  const head = buf.subarray(0, 2048).toString('latin1')
  const declared = (/<meta[^>]{0,200}?charset=["']?([\w-]{1,40})/i.exec(head) ?? /^<\?xml[^>]{0,200}?encoding=["']([\w-]{1,40})/.exec(head))?.[1]
  if (declared && !/^utf-?8$/i.test(declared) && decodes(declared)) return declared
  const local = localCodePage()
  if (MULTI_BYTE.has(local)) {
    try {
      new TextDecoder(local, { fatal: true }).decode(buf)
      return local
    } catch {
      // Not this PC's either: one of the common ones.
    }
  }
  const sample = wordsPastAscii(buf)
  let best = { page: 'windows-1252', score: -Infinity }
  for (const page of new Set([local, 'windows-1252', 'windows-1250', 'windows-1251'])) {
    if (MULTI_BYTE.has(page) || !decodes(page)) continue
    const score = readsAs(new TextDecoder(page).decode(sample), page)
    if (score > best.score) best = { page, score }
  }
  return best.page
}

/** Whether bytes with no byte-order mark are UTF-16: Latin text has a zero in every other byte. */
function utf16Without(buf: Buffer): 'utf-16le' | 'utf-16be' | undefined {
  const sample = buf.subarray(0, 4096 - (Math.min(buf.length, 4096) % 2))
  if (sample.length < 8) return undefined
  let even = 0
  let odd = 0
  for (let i = 0; i < sample.length; i += 2) {
    if (sample[i] === 0) even++
    if (sample[i + 1] === 0) odd++
  }
  const pairs = sample.length / 2
  if (odd > pairs * 0.3 && even < pairs * 0.05) return 'utf-16le'
  if (even > pairs * 0.3 && odd < pairs * 0.05) return 'utf-16be'
  return undefined
}

/**
 * A text file's characters: UTF-16 by its byte-order mark (Excel's "Unicode Text", what Windows PowerShell 5.1
 * writes) or by its zeros without one; UTF-8 (without Notepad's mark); and what isn't UTF-8 in the code page it was
 * saved in (codePageOf), as Excel saves a CSV (Croatian Windows: "Pla\u0107a se mjese\u010Dno" in windows-1250).
 */
function decodeText(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf[0] === 0xfe && buf[1] === 0xff) {
    const big = Buffer.from(buf.subarray(2, buf.length - (buf.length % 2)))
    return big.swap16().toString('utf16le')
  }
  const wide = utf16Without(buf)
  if (wide) return new TextDecoder(wide).decode(buf)
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buf)
  } catch {
    try {
      return new TextDecoder(codePageOf(buf)).decode(buf)
    } catch {
      return buf.toString('latin1')
    }
  }
}

// Parts of a page that aren't its text, skipped to their end; and block ends, which end a line.
const SKIPPED = new Set(['script', 'style', 'noscript', 'template', 'svg', 'head'])
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'tr', 'blockquote', 'pre', 'dl', 'dt', 'dd', 'figure'])

/**
 * What an HTML file shows: its text, headings and lists, without the markup, styles or scripts. Read in one pass, each
 * tag's end found once, so a page of a million "<" (or a comment, a script that's never closed) reads in a moment.
 */
function htmlText(html: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let at = 0
  while (at < html.length) {
    const lt = html.indexOf('<', at)
    if (lt < 0) {
      out += html.slice(at)
      break
    }
    out += html.slice(at, lt)
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      if (end < 0) break
      at = end + 3
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    // A "<" that opens no tag: the rest is text.
    if (gt < 0) {
      out += html.slice(lt + 1)
      break
    }
    const tag = /^(\/?)([a-z][a-z0-9]*)/.exec(lower.slice(lt + 1, Math.min(gt, lt + 40)))
    at = gt + 1
    if (!tag) continue
    const [, closing, name] = tag
    if (!closing && SKIPPED.has(name)) {
      const end = lower.indexOf(`</${name}`, at)
      if (end < 0) break
      const endGt = html.indexOf('>', end)
      at = endGt < 0 ? html.length : endGt + 1
    } else if (!closing && /^h[1-6]$/.test(name)) out += `\n\n${'#'.repeat(Number(name[1]))} `
    else if (!closing && name === 'li') out += '\n- '
    else if (!closing && (name === 'br' || name === 'hr')) out += '\n'
    else if (!closing && (name === 'td' || name === 'th')) out += ' | '
    else if (closing && BLOCKS.has(name)) out += '\n'
  }
  return decodeXml(out.replace(/&nbsp;/gi, ' '))
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// A document's text, at most: more is no document a call's answers can use (a log of a whole year, a zip bomb).
export const MAX_DOC_CHARS = 5_000_000
const TOO_MUCH = `it holds more text than Togle reads (${(MAX_DOC_CHARS / 1_000_000).toFixed(0)} million characters)`
// What a Word or PowerPoint file (a zip) may unpack to: a part, and all of them.
const ZIP_PART_BYTES = 60 * 1048576
const ZIP_TOTAL_BYTES = 200 * 1048576
const MAX_PDF_PAGES = 3000

/** A Word or PowerPoint file that would unpack to far more than any document is refused before it's unpacked. */
async function checkZip(buf: Buffer): Promise<void> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(buf)
  let total = 0
  for (const entry of Object.values(zip.files)) {
    const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
    total += size
    if (size > ZIP_PART_BYTES || total > ZIP_TOTAL_BYTES) throw new Error('it unpacks to more than Togle reads')
  }
}

/** A PDF's text, page by page, up to the pages and the characters a document has. */
async function pdfText(buf: Buffer): Promise<string> {
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buf))
  const pages = Math.min(pdf.numPages, MAX_PDF_PAGES)
  let text = ''
  for (let n = 1; n <= pages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent()
    for (const item of content.items) if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '')
    text += '\n'
    if (text.length > MAX_DOC_CHARS) throw new Error(TOO_MUCH)
  }
  if (text.trim().length < 20 * pages) throw new Error('no text layer (scanned PDF); not supported yet')
  return text
}

/** Extracts plain text from a file the user wants to teach an agent with, here (see extractText). */
export async function readFileText(file: string): Promise<string> {
  const ext = path.extname(file).slice(1).toLowerCase()
  // A work session (Claude Code, Codex): read a line at a time, however long it got.
  if (ext === 'jsonl') {
    const text = await readSession(file)
    if (text.length > MAX_DOC_CHARS) throw new Error(TOO_MUCH)
    return text
  }
  const { size } = await fs.stat(file)
  if (size > MAX_FILE_BYTES) throw new Error(`larger than ${MAX_FILE_BYTES / 1048576} MB`)
  const buf = await fs.readFile(file)
  let text: string
  if (ext === 'pdf') text = await pdfText(buf)
  else if (ext === 'docx' || ext === 'pptx') {
    await checkZip(buf)
    text = ext === 'docx' ? (await (await import('mammoth')).extractRawText({ buffer: buf })).value : await pptxText(buf)
  } else if (ext === 'html' || ext === 'htm') text = htmlText(decodeText(buf))
  else if (TEXT_EXTENSIONS.includes(ext)) text = decodeText(buf)
  else throw new Error(`unsupported file type .${ext}`)
  if (text.length > MAX_DOC_CHARS) throw new Error(TOO_MUCH)
  return text
}

/**
 * Extracts plain text from a file the user wants to teach an agent with: in a worker of its own (reader.ts), so one
 * built to blow up fails on its own while calls go on.
 */
export async function extractText(file: string): Promise<string> {
  return inReader({ task: 'file', file, codePage: windowsCodePage }, () => readFileText(file))
}

/**
 * Supported files under a folder, skipping hidden folders, dependency caches and subfolders it can't open. At most
 * MAX_FOLDER_FILES: `more`, when given, says whether there were more than that (to say so).
 */
export async function listFolder(dir: string, more?: { more: boolean }): Promise<string[]> {
  const found: string[] = []
  let full = false
  const walk = async (current: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch (err) {
      // One subfolder without access shouldn't fail the whole import; the folder that was picked must open.
      if (current === dir) throw err
      return
    }
    for (const entry of entries) {
      if (full) return
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const at = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(at)
      else if (SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).slice(1).toLowerCase())) {
        // One past the limit is how it knows there are more.
        if (found.length === MAX_FOLDER_FILES) full = true
        else found.push(at)
      }
    }
  }
  await walk(dir)
  if (more) more.more = full
  return found
}

// Capitalized words that start sentences or headings often enough to slip past the sentence-start check.
const COMMON_WORDS = new Set(
  'The This That These Those There Here Then When While Where What Which Who Why How If For And But Or Not No Yes All Each Any Some Our Your Their Its With From Into Over Under After Before Also More Most Only Just Very Use Using See Note Step Example Please Click Open Select Choose Enter Make Get Set Add Remove'.split(
    ' '
  )
)

/**
 * Names and jargon worth telling speech recognition about: product and people names written
 * capitalized mid-sentence (Kafka, Debezium, Marko), CamelCase (PostgreSQL), acronyms (SLA, S3),
 * and terms with digits or dots (p99, Node.js). Most frequent first.
 */
export async function extractTerms(texts: string[], max: number, least = 2): Promise<string[]> {
  const counts = new Map<string, { total: number; midSentence: number; technical: boolean }>()
  let words = 0
  for (const text of texts) {
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*/g)) {
      // A turn now and then (about every 5 ms): an agent's documents can be millions of words.
      if (++words % 50_000 === 0) await nextTurn()
      const word = m[0]
      const technical =
        /[a-z][A-Z]/.test(word) || // CamelCase, gRPC
        (/^[A-Z][A-Z0-9]{1,6}$/.test(word) && !/^[IVX]+$/.test(word)) || // SLA, S3 (not roman numerals)
        (/\d/.test(word) && /[A-Za-z]/.test(word)) || // p99, http2
        word.includes('.') // Node.js
      const capitalized = /^[A-Z][a-z]{2,}$/.test(word)
      if ((!technical && !capitalized) || COMMON_WORDS.has(word)) continue
      // A capital at the start of a sentence, line, heading or list item says nothing about the word;
      // one in the middle of a sentence shows it's a name (Kafka, Marko).
      const before = text.slice(Math.max(0, m.index - 4), m.index).trimEnd()
      const midSentence = !!before && !/[.!?:;\n#*>|•-]$/.test(before)
      const entry = counts.get(word) ?? { total: 0, midSentence: 0, technical }
      entry.total++
      if (midSentence) entry.midSentence++
      counts.set(word, entry)
    }
  }
  return [...counts]
    .filter(([, c]) => c.total >= least && (c.technical || c.midSentence >= 1))
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, max)
    .map(([word]) => word)
}

export interface Chunk {
  id: string
  docId: string
  doc: string
  /** Heading the passage sits under ("Pricing › Enterprise"), when the document has headings. */
  section?: string
  url?: string
  text: string
}

/**
 * Splits text into ~CHUNK_CHARS passages on paragraph, then sentence, boundaries, remembering the
 * Markdown heading each passage sits under so search and citations can say where it came from.
 */
/** A piece longer than a chunk in consecutive windows, each ending at a space or a sentence's end near its end. */
function windows(piece: string): string[] {
  const out: string[] = []
  let at = 0
  while (piece.length - at > CHUNK_CHARS) {
    let cut = CHUNK_CHARS
    for (let i = CHUNK_CHARS - 1; i > CHUNK_CHARS / 2; i--) {
      if (/[\s。！？；，、,]/.test(piece[at + i])) {
        cut = i + 1
        break
      }
    }
    out.push(piece.slice(at, at + cut))
    at += cut
  }
  out.push(piece.slice(at))
  return out
}

export function chunkText(meta: { docId: string; doc: string; url?: string }, text: string): Chunk[] {
  const chunks: Chunk[] = []
  const headings: string[] = []
  let current = ''
  let section: string | undefined
  const flush = (): void => {
    if (current.trim()) chunks.push({ ...meta, id: `${meta.docId}:${chunks.length}`, section, text: current.trim() })
    current = ''
  }
  for (const block of text.split(/\n\s*\n/)) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(block.trim().split('\n')[0])
    if (heading) {
      flush()
      headings.length = heading[1].length - 1
      headings[heading[1].length - 1] = heading[2].trim()
      section = headings.filter(Boolean).slice(-2).join(' › ')
    }
    // A piece longer than a chunk (a paragraph in Chinese, a minified file, a table's row) goes in windows, all of it.
    const pieces = (block.length > CHUNK_CHARS ? block.split(/(?<=[.!?])\s+|\n/) : [block]).flatMap((p) => (p.length > CHUNK_CHARS ? windows(p) : [p]))
    for (const piece of pieces.map((p) => p.trim()).filter(Boolean)) {
      if (current && current.length + piece.length > CHUNK_CHARS) flush()
      current = current ? `${current}\n\n${piece}` : piece
    }
  }
  flush()
  return chunks
}

// Scripts written without spaces between words, and Korean, whose words carry their endings ("가격은"): searched by
// pairs of characters, as search engines do, so "政策" is found in "退款政策是什么".
const UNSPACED = '\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}\\p{sc=Hangul}\\p{sc=Thai}\\p{sc=Lao}\\p{sc=Khmer}\\p{sc=Myanmar}'
// A run of those (a character with the marks written on it, each), or of other letters and digits: "SAP集成" is two.
const WORDS = new RegExp(`(?:[${UNSPACED}]\\p{M}*)+|(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}])+`, 'gu')
const UNSPACED_CHARACTER = new RegExp(`[${UNSPACED}]\\p{M}*`, 'gu')

function tokenize(text: string): string[] {
  // Without accents ("mjesecno" for "mjesečno"); Korean syllables, taken apart by that, put back together.
  const plain = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC')
  const tokens: string[] = []
  for (const word of plain.match(WORDS) ?? []) {
    const characters = word.match(UNSPACED_CHARACTER)
    if (!characters) {
      if (word.length > 1) tokens.push(word)
    } else if (characters.length === 1) tokens.push(word)
    else for (let i = 1; i < characters.length; i++) tokens.push(characters[i - 1] + characters[i])
  }
  return tokens
}

interface Indexed<T> {
  item: T
  terms: Map<string, number>
  length: number
}

// Words that say nothing about what a question is about, in English and the Croatian/Serbian/Bosnian
// family; without diacritics, as tokenize() strips them.
const STOP_WORDS = new Set(
  (
    'the an is are was were be been do does did can could would will should may might must have has had what which who whom ' +
    'whose when where why how this that these those there here it its of in on at to for from by with about and or but if then ' +
    'so as than too very just also me my you your we our us they them their he she his her tell explain describe please quick per ' +
    'question ok okay well um uh like really actually je su sam si smo ste biti bio bila bili da li ne ni ali ili te pa sto sta ' +
    'koji koja koje kako zasto kada kad gdje gde tko ko to ta taj ovo ovaj ova ono za od do na iz po pri kod mi ti vi oni ona ' +
    'moj tvoj vas nas se bi bih biste sa ja ju ima imam imamo imate imaju ' +
    // Case endings written after a hyphen, as in "SAP-om".
    'om em'
  ).split(' ')
)

// Ways of asking about the same thing in other words, folded into one word on both sides before matching:
// "Does it work with SAP?" is "Do you integrate with SAP?", and "Koliko košta?" is "How much is it?".
const SAME_MEANING: [string, RegExp][] = [
  ['integrate', /^(integrat|integrir|integracij|connect|compatib|kompatib|povez)/],
  ['cost', /^(costs?|costly|pric(e|es|ed|ing|ey)|fees?|charg(e|es|ed|ing)|pay(s|ing|ment|ments)?|paid|cijen\p{L}*|kost(a|ati|aju)|naplat\p{L}*)$/u],
  ['trial', /^(trials?|try|tries|tried|trying|proba|probati|isprobati|probn\p{L}*)$/u],
  ['yearly', /^(annual|annually|yearly|godisnj\p{L}*)$/u]
]
const SAME_MEANING_PAIRS: Record<string, string> = {
  'work with': 'integrate',
  'works with': 'integrate',
  'working with': 'integrate',
  'talk to': 'integrate',
  'talks to': 'integrate',
  'radi sa': 'integrate',
  'how much': 'cost',
  'koliko kosta': 'cost',
  'koliko stoji': 'cost'
}

function contentWords(text: string): string[] {
  const words = tokenize(text)
  const folded: string[] = []
  for (let i = 0; i < words.length; i++) {
    const pair = SAME_MEANING_PAIRS[`${words[i]} ${words[i + 1]}`]
    if (pair) {
      folded.push(pair)
      i++
    } else {
      folded.push(SAME_MEANING.find(([, pattern]) => pattern.test(words[i]))?.[0] ?? words[i])
    }
  }
  return [...new Set(folded.filter((w) => !STOP_WORDS.has(w)))]
}

/** The same word give or take an ending: "prices"/"price", "scaling"/"scale", Croatian "cijena"/"cijenu". */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true
  let common = 0
  while (common < a.length && a[common] === b[common]) common++
  return common >= Math.max(4, Math.max(a.length, b.length) - 3)
}

/**
 * The approved answer to a question asked nearly the same way: nearly all of its question's meaningful
 * words appear in what was asked. Strict on purpose, since it's shown before any model has looked.
 */
export function matchApproved<T extends { question: string }>(answers: T[], asked: string): T | undefined {
  // Sentence by sentence, and both ways: a long turn that happens to contain a saved question's two key
  // words somewhere isn't that question.
  const sentences = asked
    .split(/[.?!;\n]+/)
    .map(contentWords)
    .filter((w) => w.length)
  let best: { answer: T; score: number } | undefined
  for (const answer of answers) {
    const wanted = contentWords(answer.question)
    for (const words of sentences) {
      const hits = wanted.filter((w) => words.some((x) => sameWord(w, x))).length
      const covered = hits / Math.max(1, wanted.length)
      const onTopic = words.filter((x) => wanted.some((w) => sameWord(w, x))).length / words.length
      const score = (covered + onTopic) / 2
      if (hits >= 2 && covered >= 0.75 && onTopic >= 0.5 && score > (best?.score ?? 0)) best = { answer, score }
    }
  }
  return best?.answer
}

/**
 * The skills a moment of a call calls for: those whose name or "when" shares a meaningful word with what was asked,
 * the best first. A hint for the call review and a count of use, not a gate: answers see every skill that fits.
 */
export function skillsInPlay<T extends { name: string; when: string; purpose?: 'assistance' | 'reference'; origin?: 'manual' | 'train' | 'call' }>(skills: T[], asked: string, limit = 2): T[] {
  const words = contentWords(asked)
  if (!words.length) return []
  return skills.filter(skill => skill.purpose !== 'reference' && (skill.purpose === 'assistance' || skill.origin !== 'call'))
    .map((skill) => {
      const wanted = contentWords(`${skill.name} ${skill.when}`)
      const hits = wanted.filter((w) => words.some((x) => sameWord(w, x))).length
      return { skill, hits, share: hits / Math.max(1, wanted.length) }
    })
    .filter((s) => s.hits >= 2 || (s.hits === 1 && s.share >= 0.25))
    .sort((a, b) => b.hits - a.hits || b.share - a.share)
    .slice(0, limit)
    .map((s) => s.skill)
}

/** Reference retrieval ignores conversational stop words such as "the" and "when". */
export function referenceSkillsFor<T extends { name: string; when: string; how: string }>(skills: T[], query: string): T[] {
  const meaningful = contentWords(query).join(' ')
  return meaningful ? new SearchIndex(skills, skill => `${skill.name} ${skill.when} ${skill.how}`).search(meaningful, 2) : []
}

/**
 * For an approved answer that matched (matchApproved): whether its question is all they asked, so the approved
 * answer is the whole answer. Every sentence that asks something (`asks`: a question, with or without its
 * question mark, or a request like "Tell me about your pricing.") has no meaningful word the approved question
 * lacks, ways of asking folded the same way. "One more thing." or "We run S/4HANA." around it asks nothing.
 */
export function asksOnly(question: string, asked: string, asks: (sentence: string) => boolean): boolean {
  const wanted = contentWords(question)
  const ways = new Set(askingAbout(question))
  const sentences = (asked.match(/[^.?!;\n]+[.?!;\n]*/g) ?? []).filter(asks)
  const words = sentences.map(contentWords).filter((w) => w.length)
  // "When will you integrate with SAP?" isn't "Do you integrate with SAP?": it asks for a time, not a yes.
  const sameAsk = sentences.every((s) => askingAbout(s).every((w) => ways.has(w)))
  return sameAsk && words.length > 0 && words.every((list) => list.every((w) => wanted.some((x) => sameWord(w, x))))
}

// Question words that ask for something a yes or a what doesn't give (a time, a place, a reason, a person), in
// English and Croatian/Serbian/Bosnian without diacritics. "What", "which" and "how" ask the same things in
// other words ("What does it cost?", "How much is it?"), so they don't count.
const ASKING: Record<string, string> = {
  when: 'when', kada: 'when', kad: 'when',
  where: 'where', gdje: 'where', gde: 'where',
  why: 'why', zasto: 'why',
  who: 'who', whom: 'who', whose: 'who', tko: 'who', ko: 'who'
}

/** What a sentence's question words ask for (see ASKING), which contentWords leaves out. */
function askingAbout(text: string): string[] {
  const plain = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')
  return [...new Set((plain.match(/\p{L}+/gu) ?? []).map((w) => ASKING[w]).filter(Boolean))]
}

// A line of a document longer than this reads as prose: its sentences are matched one by one.
const FACT_CHARS = 300
// A line that ends in a question mark, its quotes or brackets after it.
const ASKS = /[?？][\s"'”’)\]]*$/
// Words any price or plan line shares (the folded ways of asking, units of time): a line must also share a
// more specific one to be about the question. "Paid yearly, whole year cost" isn't answered by a line on
// cancelling annual plans.
const GENERIC = new Set([...SAME_MEANING.map(([word]) => word), 'year', 'month', 'week', 'day'])

/**
 * A document's text as it's kept: line ends and runs of blank lines evened out. Line by line, so a line of a
 * million spaces costs no more than its length.
 */
export const cleanText = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/** A text's sentences: "4.1.4 is out." and "It's live." of "4.1.4 is out. It's live." */
export const sentencesOf = (text: string): string[] => text.split(/(?<=[.!?。！？])\s+(?=\S)/)

/**
 * Lines of documents that answer a question, found without a model: a bullet, or a sentence of prose, that
 * holds at least two of the question's meaningful words, and at least 40% of them (ways of asking folded as
 * for approved answers). A line labelled with one of them ("Growth: €39 per user…" for the Growth plan) is
 * about it rather than mentioning it. Only the best-scoring lines come back: they're shown before any model
 * has looked, and nothing beats a near miss. `chunks` in the order a search ranked them. With `trim`, a line of a
 * few sentences comes back as the ones that answer, for a glance: those with the question's words, not one asking.
 */
export function factsFor<T extends { text: string }>(question: string, chunks: T[], max = 2, trim = false): { text: string; chunk: T }[] {
  // The question itself, not the "thanks for the demo" around it.
  const asked = question.split(/(?<=[.?!])\s+/).filter((s) => s.trim().endsWith('?')).join(' ') || question
  const wanted = contentWords(asked)
  if (wanted.length < 2) return []
  const has = (words: string[], w: string): boolean => words.some((x) => sameWord(w, x))
  // Each of the line's words answers for one of the question's at most, and the specific ones are counted too.
  const hitsIn = (words: string[]): { hits: number; specific: number } => {
    const used = new Set<number>()
    let specific = 0
    for (const w of wanted) {
      const i = words.findIndex((x, k) => !used.has(k) && sameWord(w, x))
      if (i < 0) continue
      used.add(i)
      if (!GENERIC.has(w)) specific++
    }
    return { hits: used.size, specific }
  }
  // From the first sentence with the question's words to the last: what's between ties them together.
  const answering = (piece: string): string => {
    const sentences = sentencesOf(piece)
    const hit = sentences.map((s) => !ASKS.test(s) && hitsIn(contentWords(s)).hits > 0)
    const first = hit.indexOf(true)
    if (first < 0) return piece
    return sentences
      .slice(first, hit.lastIndexOf(true) + 1)
      .filter((s) => !ASKS.test(s))
      .join(' ')
  }
  const found: { text: string; chunk: T; score: number }[] = []
  for (const chunk of chunks) {
    for (const line of chunk.text.split('\n')) {
      const text = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()
      if (!text || text.startsWith('#')) continue
      for (const piece of text.length > FACT_CHARS ? text.split(/(?<=[.!?])\s+/) : [text]) {
        // A question answers nothing ("Does it work with Salesforce?" over its answer), however many words it shares.
        if (piece.length < 12 || piece.length > FACT_CHARS || ASKS.test(piece)) continue
        const words = contentWords(piece)
        const { hits, specific } = hitsIn(words)
        if (hits < 2 || hits < wanted.length * 0.4 || !specific) continue
        const label = /^([^:]{1,40}):/.exec(piece)?.[1]
        const about = label !== undefined && wanted.some((w) => has(contentWords(label), w))
        found.push({ text: trim ? answering(piece) : piece, chunk, score: hits + (about ? 1 : 0) })
      }
    }
  }
  const top = Math.max(...found.map((f) => f.score))
  const best: { text: string; chunk: T }[] = []
  for (const { text, chunk, score } of found) {
    if (best.length === max) break
    if (score === top && !best.some((b) => b.text === text)) best.push({ text, chunk })
  }
  return best
}

/** Lets what else Togle's main process has to do (a call's lines, the window) run before going on. */
export const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
// Passages indexed between turns, when a big agent's documents are (about 10 ms of work).
const INDEX_BATCH = 500

/** Okapi BM25 over any items: passages of documents, or approved answers matched by their question. */
export class SearchIndex<T> {
  private entries: Indexed<T>[] = []
  private df = new Map<string, number>()
  private totalLength = 0

  constructor(items: T[], textOf: (item: T) => string) {
    this.add(items, textOf)
  }

  /** The same, built INDEX_BATCH items at a time with a turn between: millions of characters hold nothing up. */
  static async build<T>(items: T[], textOf: (item: T) => string): Promise<SearchIndex<T>> {
    const index = new SearchIndex<T>([], textOf)
    for (let at = 0; at < items.length; at += INDEX_BATCH) {
      if (at) await nextTurn()
      index.add(items.slice(at, at + INDEX_BATCH), textOf)
    }
    return index
  }

  private add(items: T[], textOf: (item: T) => string): void {
    for (const item of items) {
      const terms = new Map<string, number>()
      const tokens = tokenize(textOf(item))
      for (const t of tokens) terms.set(t, (terms.get(t) ?? 0) + 1)
      for (const t of terms.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      this.entries.push({ item, terms, length: tokens.length })
      this.totalLength += tokens.length
    }
  }

  private get avgLength(): number {
    return this.totalLength / Math.max(1, this.entries.length)
  }

  get size(): number {
    return this.entries.length
  }

  search(query: string, limit: number, skip: (item: T) => boolean = () => false): T[] {
    const k1 = 1.2
    const b = 0.75
    const n = this.entries.length
    const terms = [...new Set(tokenize(query))]
    return this.entries
      .filter((e) => !skip(e.item))
      .map((e) => {
        let score = 0
        for (const t of terms) {
          const tf = e.terms.get(t)
          if (!tf) continue
          const df = this.df.get(t) ?? 0
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
          score += (idf * tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * e.length) / this.avgLength))
        }
        return { item: e.item, score }
      })
      .filter((s) => s.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, limit)
      .map((s) => s.item)
  }
}
