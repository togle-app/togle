#!/usr/bin/env node
// Builds index.json from the agents/ folders, as Togle reads it, and checks each agent the way Togle checks one
// before installing it: an AGENT.md with a name, Markdown and text files only, within Togle's sizes, skill folders
// named as agentskills.io asks, and no text hidden from a reviewer. Togle checks the words again on install.
//   node scripts/build-index.mjs           check, and write index.json
//   node scripts/build-index.mjs --check   only check (pull requests)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const onlyCheck = process.argv.includes('--check')
const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/
// Text a reviewer can't see, as Togle checks it: direction overrides, and tag characters (a flag emoji's aside).
// Joiners and direction marks (Persian, Arabic, Hebrew, emoji) are fine. Built from code points, so this file has none.
const range = (from, to) => `${String.fromCodePoint(from)}-${String.fromCodePoint(to)}`
const DECEIVING = new RegExp(`[${range(0x202a, 0x202e)}${range(0x2066, 0x2069)}]|[${range(0xe0000, 0xe007f)}]`, 'u')
const FLAG_TAGS = new RegExp(`${String.fromCodePoint(0x1f3f4)}[${range(0xe0061, 0xe007a)}]{1,7}${String.fromCodePoint(0xe007f)}`, 'gu')
const MAX_FILE_BYTES = 4_000_000
const MAX_FILES = 400

/** The simple keys of a front matter block (name: value), unquoted; lists as [a, b]. */
function frontMatter(text) {
  const head = /^---[ \t]*\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/.exec(text.replace(/^\uFEFF/, ''))
  const data = {}
  if (!head) return data
  for (const line of head[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (!m || !m[2].trim()) continue
    let value = m[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      data[m[1]] = value
        .slice(1, -1)
        .split(',')
        .map((v) => v.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      continue
    }
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        value = value.slice(1, -1)
      }
    } else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replace(/''/g, "'")
    data[m[1]] = value
  }
  return data
}

/** Every file under a folder, as paths relative to it (dot files left out). */
function filesIn(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.')) return []
    const rel = base ? `${base}/${entry.name}` : entry.name
    return entry.isDirectory() ? filesIn(path.join(dir, entry.name), rel) : [rel]
  })
}

const problems = []
const agents = []
const agentsDir = path.join(root, 'agents')
for (const slug of readdirSync(agentsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
  .map((e) => e.name)
  .sort()) {
  const dir = path.join(agentsDir, slug)
  const say = (problem) => problems.push(`agents/${slug}: ${problem}`)
  if (!SLUG.test(slug)) say('its folder name must be lowercase letters, digits and single hyphens')
  const files = filesIn(dir)
  if (files.length > MAX_FILES) say(`it has ${files.length} files; an agent has at most ${MAX_FILES}`)
  for (const file of files) {
    if (!/\.(md|txt)$/i.test(file)) say(`${file}: only Markdown and text files go in an agent`)
    const size = statSync(path.join(dir, file)).size
    if (size > MAX_FILE_BYTES) say(`${file} is too big (${size} bytes)`)
    const text = readFileSync(path.join(dir, file), 'utf8')
    // An HTML comment hides words in what the agent is; in a document (Markdown's own notes) it's common.
    if (DECEIVING.test(text.replace(FLAG_TAGS, '')) || (!file.startsWith('knowledge/') && text.includes('<!--')))
      say(`${file} has text hidden from a reader (direction overrides, tag characters, or an HTML comment)`)
    const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(file)
    if (skill) {
      const head = frontMatter(text)
      if (head.name !== skill[1]) say(`${file}: its name must be its folder's, "${skill[1]}"`)
      if (!head.description) say(`${file}: it needs a description (what it does and when to use it)`)
    }
  }
  if (!files.includes('AGENT.md')) {
    say('it has no AGENT.md')
    continue
  }
  const head = frontMatter(readFileSync(path.join(dir, 'AGENT.md'), 'utf8'))
  if (!head.name) say('its AGENT.md has no name')
  const answers = files.includes('answers.md') ? (readFileSync(path.join(dir, 'answers.md'), 'utf8').match(/^##\s+\S/gm) ?? []).length : 0
  agents.push({
    slug,
    name: head.name ?? slug,
    description: head.description ?? '',
    ...(head.author ? { author: head.author } : {}),
    ...(head.version ? { version: head.version } : {}),
    tags: Array.isArray(head.tags) ? head.tags : [],
    skills: files.filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f)).length,
    answers,
    files: files.filter((f) => /\.(md|txt)$/i.test(f) && f !== 'README.md')
  })
}

if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`${agents.length} agents`)
if (!onlyCheck) writeFileSync(path.join(root, 'index.json'), `${JSON.stringify({ format: 'togle-hub/1', agents }, null, 2)}\n`)
