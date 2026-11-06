// An agent as files, to share and to install: AGENT.md (its setup), each skill as a SKILL.md in the open agentskills.io
// format (so its skills work in Hermes Agent and Claude too), its approved answers, and the memory facts and documents
// its author chose. Never About me, past calls or its history. A .togle file is these files zipped; a hub keeps them as
// a folder. Reading one takes only the text of these files, within Togle's limits: nothing in a package is ever run.
import { createHash, randomUUID } from 'node:crypto'
import type JSZip from 'jszip'
import { FACT_LIMIT, SKILL_LIMITS, type Agent, type ApprovedAnswer, type ShareChoice, type Skill, type SkillDraft } from '@shared/types'
import { readFrontMatter, writeFrontMatter } from './frontmatter'
import { skillPurpose } from '@shared/agent-learning'
import type { GuardKind } from './guard'
import { cleanText } from './knowledge'

/** The files of a package, by their path in it. */
export type PackageFiles = Record<string, string>

/** An agent package as read: what installing it adds. */
export interface AgentPackage {
  name: string
  description: string
  instructions: string
  vocabulary: string
  author?: string
  version?: string
  skills: SkillDraft[]
  answers: { question: string; answer: string }[]
  memory: string[]
  docs: { name: string; text: string }[]
  /** Of the files read, to tell one version from another. */
  hash: string
}

/** AGENT.md's format line: a later Togle that changes the files says so here. */
export const AGENT_FORMAT = 'togle-agent/1'

const LIMITS = {
  instructions: 6_000,
  description: 200,
  vocabulary: 1_000,
  skills: 60,
  answers: 300,
  question: 500,
  answer: 4_000,
  docs: 30,
  docChars: 2_000_000,
  // Each kind of file at most this long before it's read at all: a SKILL.md of megabytes is no skill.
  agentFile: 64_000,
  skillFile: 64_000,
  answersFile: 2_000_000,
  memoryFile: 64_000,
  // A package from a file or a hub: its files, each, and all of them together, in bytes.
  files: 400,
  fileBytes: 4_000_000,
  totalBytes: 20_000_000
}

/** A package's size limits, for a hub's agent as for a file's. */
export const PACKAGE_BYTES = { file: LIMITS.fileBytes, total: LIMITS.totalBytes, files: LIMITS.files }

const TOO_BIG = 'This agent is too big for Togle.'

/** A text file's bytes as text: UTF-8, or UTF-16 by its byte-order mark (as Windows Notepad saves "Unicode"). */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  return new TextDecoder('utf-8').decode(bytes)
}

/** A name on one line, as long as it may be. */
const oneLine = (text: string, limit: number): string => text.replace(/\s+/g, ' ').trim().slice(0, limit)

const DIACRITICS: Record<string, string> = { đ: 'd', ł: 'l', ø: 'o', ß: 'ss', æ: 'ae', œ: 'oe', þ: 'th' }

/** A name as a folder name the agentskills.io format allows: lowercase letters, digits and single hyphens, ≤ 64. */
export function slug(text: string, fallback: string): string {
  const s = text
    .toLowerCase()
    .replace(/[đłøßæœþ]/g, (c) => DIACRITICS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  return s || fallback
}

const unique = (name: string, used: Set<string>): string => {
  let candidate = name
  for (let n = 2; used.has(candidate); n++) candidate = `${name.slice(0, 60)}-${n}`
  used.add(candidate)
  return candidate
}

/** What a skill does and when, as agentskills.io's description asks: other agents choose skills by it. */
const skillDescription = (skill: { name: string; when: string }): string => {
  // "When they ask…" reads "Use when: they ask…".
  const when = skill.when.replace(/^when\s+/i, '')
  return (when ? `${skill.name}. Use when: ${when}` : skill.name).slice(0, 1024)
}

// Approved answers as Markdown: a heading per question. An answer's own lines that look like headings are escaped.
function answersFile(answers: { question: string; answer: string }[]): string {
  const blocks = answers.map((a) => `## ${a.question.replace(/\s+/g, ' ').trim()}\n\n${a.answer.trim().replace(/^#/gm, '\\#')}`)
  return `# Approved answers\n\n${blocks.join('\n\n')}\n`
}

function readAnswers(text: string): { question: string; answer: string }[] {
  const answers: { question: string; answer: string }[] = []
  let current: { question: string; lines: string[] } | null = null
  const flush = (): void => {
    if (current && current.question) answers.push({ question: current.question, answer: current.lines.join('\n').trim().replace(/^\\#/gm, '#') })
  }
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) {
      flush()
      current = { question: heading[1].trim(), lines: [] }
    } else if (current) current.lines.push(line)
  }
  flush()
  return answers.filter((a) => a.answer)
}

/** Shown on GitHub for the agent's folder in a hub: what it is, and how to install it. */
function readme(agent: Agent, shared: { skills: string[]; answers: number; memory: number; docs: string[] }): string {
  const lines = [`# ${agent.name}`, '', agent.description || 'An agent for Togle.', '', 'An agent for Togle, the live call copilot. To use it: in Togle, **Agents → Install**.', '']
  if (shared.skills.length) lines.push(`**Skills:** ${shared.skills.join(', ')}`, '')
  if (shared.answers) lines.push(`**Approved answers:** ${shared.answers}`, '')
  if (shared.memory) lines.push(`**Facts it knows:** ${shared.memory}`, '')
  if (shared.docs.length) lines.push(`**Documents:** ${shared.docs.join(', ')}`, '')
  return `${lines.join('\n').trim()}\n`
}

/**
 * The agent as files: its setup, skills, approved answers and words to recognize, and the memory facts and documents
 * chosen. About me, past calls, work sessions and history never go in.
 */
export async function packAgent(agent: Agent, choice: ShareChoice, readDoc: (docId: string) => Promise<string>): Promise<PackageFiles> {
  const files: PackageFiles = {}
  files['AGENT.md'] = writeFrontMatter(
    { name: agent.name, description: agent.description, author: choice.author?.trim(), format: AGENT_FORMAT, vocabulary: agent.vocabulary.trim() },
    agent.instructions
  )
  const skillDirs = new Set<string>()
  for (const skill of agent.skills) {
    const dir = unique(slug(skill.name, 'skill'), skillDirs)
    files[`skills/${dir}/SKILL.md`] = writeFrontMatter(
      { name: dir, description: skillDescription(skill), metadata: { 'togle-name': skill.name, 'togle-when': skill.when, 'togle-purpose': skillPurpose(skill) } },
      skill.how
    )
  }
  if (agent.answers.length) files['answers.md'] = answersFile(agent.answers)
  const memory = agent.memory.filter((fact) => choice.memory.includes(fact))
  if (memory.length) files['memory.md'] = `# Memory\n\n${memory.map((fact) => `- ${fact.replace(/\s+/g, ' ').trim()}`).join('\n')}\n`
  // A work session is their own work (often their company's): never shared, even if asked for.
  const docs = agent.knowledge.filter((d) => d.kind !== 'session' && choice.docs.includes(d.id))
  const docNames = new Set<string>()
  for (const doc of docs) files[`knowledge/${unique(slug(doc.name, 'document'), docNames)}.md`] = writeFrontMatter({ name: doc.name }, await readDoc(doc.id))
  files['README.md'] = readme(agent, { skills: agent.skills.map((s) => s.name), answers: agent.answers.length, memory: memory.length, docs: docs.map((d) => d.name) })
  return files
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A skill's name as people say it, from a folder name: "pricing-objections" → "Pricing objections". */
const fromSlug = (name: string): string => {
  const words = name.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Reads a package's files as installing it would use them, within Togle's limits; `notes` says what didn't go in as
 * it was. A package needs AGENT.md with a name. Files it doesn't know (scripts among them) are left out.
 */
export function readPackage(input: PackageFiles): { pkg: AgentPackage; notes: string[] } {
  // Paths as zips and hubs write them; a package zipped with its folder around it reads the same.
  let files: PackageFiles = {}
  for (const [path, text] of Object.entries(input)) files[path.replace(/\\/g, '/').replace(/^\.?\//, '')] = text
  if (!files['AGENT.md']) {
    const tops = Object.keys(files).filter((p) => /^[^/]+\/AGENT\.md$/.test(p))
    if (tops.length === 1) {
      const top = tops[0].slice(0, -'AGENT.md'.length)
      files = Object.fromEntries(Object.entries(files).flatMap(([p, t]) => (p.startsWith(top) ? [[p.slice(top.length), t]] : [])))
    }
  }
  const agentFile = files['AGENT.md']
  if (agentFile === undefined) throw new Error("This isn't a Togle agent: it has no AGENT.md.")
  if (agentFile.length > LIMITS.agentFile) throw new Error(TOO_BIG)
  const { data, body } = readFrontMatter(agentFile)
  const name = oneLine(asText(data.name), 60)
  if (!name) throw new Error("This agent has no name in its AGENT.md, so Togle can't install it.")
  const notes: string[] = []
  const cut = (text: string, limit: number, what: string): string => {
    if (text.length <= limit) return text
    notes.push(`${what} was longer than Togle keeps (${limit.toLocaleString('en-US')} characters), so its end was left out.`)
    return text.slice(0, limit)
  }
  // Each kind of file only within its size: one that isn't is left out whole, said so.
  const fits = (path: string, limit: number, what: string): string | undefined => {
    const text = files[path]
    if (text === undefined || text.length <= limit) return text
    notes.push(`${what} is too big for Togle (over ${limit.toLocaleString('en-US')} characters), so it was left out.`)
    return undefined
  }

  // In the order the files came: the agent's own, for a package Togle wrote.
  const skills: SkillDraft[] = []
  const named = new Set<string>()
  const skillPaths = Object.keys(files).filter((p) => /^skills\/[^/]+\/SKILL\.md$/i.test(p))
  for (const path of skillPaths) {
    const dir = path.split('/')[1].slice(0, 64)
    const file = fits(path, LIMITS.skillFile, `The skill in skills/${dir}`)
    if (file === undefined) continue
    const skill = readFrontMatter(file)
    const meta = typeof skill.data.metadata === 'object' && !Array.isArray(skill.data.metadata) ? skill.data.metadata : {}
    const skillName = oneLine(meta['togle-name'] || fromSlug(asText(skill.data.name) || dir), SKILL_LIMITS.name)
    if (!skillName) {
      notes.push(`The skill in skills/${dir} has no name, so it was left out.`)
      continue
    }
    const skillKey = `${meta['togle-purpose'] === 'reference' ? 'reference' : 'assistance'}:${skillName.toLowerCase()}`
    if (named.has(skillKey)) {
      notes.push(`Two skills are named "${skillName}": only the first went in.`)
      continue
    }
    const description = asText(skill.data.description).trim()
    // Its "when": as Togle wrote it (none, when the skill had none), or from the description of one written elsewhere.
    const prefix = `${skillName}. use when:`
    const when = meta['togle-name'] ? (meta['togle-when'] ?? '') : description.toLowerCase().startsWith(prefix.toLowerCase()) ? description.slice(prefix.length) : description
    const how = skill.body.trim()
    if (!how) {
      notes.push(`The skill "${skillName}" has no text, so it was left out.`)
      continue
    }
    named.add(skillKey)
    skills.push({ name: skillName, when: oneLine(when, SKILL_LIMITS.when), how: cut(how, SKILL_LIMITS.how, `The skill "${skillName}"`), ...(meta['togle-purpose'] === 'reference' ? { purpose: 'reference' as const } : {}) })
  }
  if (skills.length > LIMITS.skills) notes.push(`Only the first ${LIMITS.skills} of its ${skills.length} skills go in.`)

  const answers = readAnswers(fits('answers.md', LIMITS.answersFile, 'Its approved answers') ?? '').map((a) => ({
    question: oneLine(a.question, LIMITS.question),
    answer: cut(a.answer, LIMITS.answer, `The answer to "${oneLine(a.question, 60)}"`)
  }))
  if (answers.length > LIMITS.answers) notes.push(`Only the first ${LIMITS.answers} of its ${answers.length} approved answers go in.`)

  // The file-size limit bounds imported data; the live prompt budget must not drop saved facts.
  const memory: string[] = []
  for (const line of (fits('memory.md', LIMITS.memoryFile, 'Its memory') ?? '').split('\n')) {
    const fact = /^\s*[-*]\s+(.+)$/.exec(line)?.[1].trim()
    if (!fact) continue
    if (fact.length > FACT_LIMIT) {
      notes.push(`A fact longer than memory keeps (${FACT_LIMIT} characters) was left out: "${fact.slice(0, 60)}…"`)
      continue
    }
    memory.push(fact)
  }

  const docs: { name: string; text: string }[] = []
  const docPaths = Object.keys(files).filter((p) => /^knowledge\/[^/]+\.(md|txt)$/i.test(p))
  if (docPaths.length > LIMITS.docs) notes.push(`Only the first ${LIMITS.docs} of its ${docPaths.length} documents go in.`)
  for (const path of docPaths.slice(0, LIMITS.docs)) {
    const doc = readFrontMatter(files[path])
    const docName = oneLine(asText(doc.data.name) || path.split('/')[1].replace(/\.(md|txt)$/i, ''), 120)
    // As a document is kept when it's added: one with no text to read isn't.
    const text = cleanText(doc.body)
    if (text.length < 20) {
      notes.push(`The document "${docName}" has no text to read, so it was left out.`)
      continue
    }
    docs.push({ name: docName, text: cut(text, LIMITS.docChars, `The document "${docName}"`) })
  }

  // What was read, in order: the same files are the same version.
  const hash = createHash('sha256')
  for (const path of Object.keys(files).sort())
    if (path === 'AGENT.md' || path === 'answers.md' || path === 'memory.md' || skillPaths.includes(path) || /^knowledge\//.test(path))
      hash.update(`${path}\n${files[path]}\n`)

  return {
    pkg: {
      name,
      description: asText(data.description).trim().slice(0, LIMITS.description),
      instructions: cut(body.trim(), LIMITS.instructions, 'Its instructions'),
      vocabulary: asText(data.vocabulary).trim().slice(0, LIMITS.vocabulary),
      author: asText(data.author).trim().slice(0, 80) || undefined,
      version: asText(data.version).trim().slice(0, 40) || undefined,
      skills: skills.slice(0, LIMITS.skills),
      answers: answers.slice(0, LIMITS.answers),
      memory,
      docs,
      hash: hash.digest('hex')
    },
    notes
  }
}

/** JSZip, loaded the first time an agent is shared or installed: not on every start of Togle (it takes 20-30 ms). */
const zipper = async (): Promise<typeof JSZip> => (await import('jszip')).default

/** The package as a .togle file. */
export async function zipPackage(files: PackageFiles): Promise<Buffer> {
  const zip = new (await zipper())()
  for (const [path, text] of Object.entries(files)) zip.file(path, text)
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}

/** A zipped file's bytes, unzipped a piece at a time and stopped once past `limit` (a zip can say less than it holds). */
function readEntry(entry: JSZip.JSZipObject, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const stream = entry.nodeStream('nodebuffer') as NodeJS.ReadableStream & { destroy?: () => void }
    const end = (err?: Error): void => {
      if (settled) return
      settled = true
      if (err) {
        stream.pause()
        stream.removeAllListeners('data')
        reject(err)
      } else resolve(Buffer.concat(chunks))
    }
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) end(new Error(TOO_BIG))
      else if (!settled) chunks.push(chunk)
    })
    stream.on('error', (err: Error) => end(err))
    stream.on('end', () => end())
  })
}

/**
 * A .togle file's text files (Markdown and plain text only), within the limits of a package: what each says it
 * holds is checked first, then each is unzipped only up to what's left of the limits, so a small file that unzips
 * to gigabytes costs nothing.
 */
export async function unzipPackage(data: Buffer): Promise<PackageFiles> {
  if (data.length > LIMITS.totalBytes) throw new Error(TOO_BIG)
  let zip: JSZip
  try {
    zip = await (await zipper()).loadAsync(data)
  } catch {
    throw new Error("This file isn't a Togle agent (it can't be opened as one).")
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.(md|txt)$/i.test(f.name) && !f.name.split(/[\\/]/).includes('..'))
  if (entries.length > LIMITS.files) throw new Error(TOO_BIG)
  const declared = (entry: JSZip.JSZipObject): number => (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
  if (entries.some((e) => declared(e) > LIMITS.fileBytes) || entries.reduce((n, e) => n + declared(e), 0) > LIMITS.totalBytes) throw new Error(TOO_BIG)
  const files: PackageFiles = {}
  let left = LIMITS.totalBytes
  for (const entry of entries) {
    let bytes: Buffer
    try {
      bytes = await readEntry(entry, Math.min(LIMITS.fileBytes, left))
    } catch (err) {
      throw new Error((err as Error).message === TOO_BIG ? TOO_BIG : "This file isn't a Togle agent (it can't be opened as one).")
    }
    left -= bytes.length
    // A file that isn't text (it has nothing in it, a picture renamed .md) is left out.
    if (bytes.includes(0) && !(bytes[0] === 0xff || bytes[0] === 0xfe)) continue
    files[entry.name] = decodeText(bytes)
  }
  return files
}

/** An installed package's skills and answers, as the agent keeps them: its author's, so tidying up keeps them. */
export function installedItems(pkg: AgentPackage, now: number): { skills: Skill[]; answers: ApprovedAnswer[] } {
  return {
    skills: pkg.skills.map((s) => ({ id: randomUUID(), ...s, origin: 'manual' as const, createdAt: now, updatedAt: now })),
    answers: pkg.answers.map((a) => ({ id: randomUUID(), ...a, origin: 'manual' as const, addedAt: now }))
  }
}

/**
 * What the check reads of a package, each with where it is and what kind of text: what the agent is (its setup,
 * skills, answers, memory, and its documents' names, which go into its requests as they are) or a document's text.
 */
export const packageTexts = (pkg: AgentPackage): { where: string; text: string; kind: GuardKind }[] => [
  { where: 'Name and description', text: `${pkg.name}\n${pkg.description}`, kind: 'setup' },
  { where: 'Instructions', text: pkg.instructions, kind: 'setup' },
  { where: 'Words to recognize', text: pkg.vocabulary, kind: 'setup' },
  ...pkg.skills.map((s) => ({ where: `Skill “${s.name}”`, text: `${s.name}\n${s.when}\n${s.how}`, kind: 'setup' as const })),
  ...pkg.answers.map((a) => ({ where: `Approved answer “${a.question.slice(0, 50)}”`, text: `${a.question}\n${a.answer}`, kind: 'setup' as const })),
  ...pkg.memory.map((m) => ({ where: 'Memory', text: m, kind: 'setup' as const })),
  ...pkg.docs.map((d) => ({ where: 'A document’s name', text: d.name, kind: 'setup' as const })),
  ...pkg.docs.map((d) => ({ where: `Document “${d.name}”`, text: d.text, kind: 'document' as const }))
]
