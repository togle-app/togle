// The YAML front matter of a Markdown file (SKILL.md, AGENT.md) as the agentskills.io format uses it: keys with a
// string (plain, quoted, or a block of lines), a list, or one level of keys under them (metadata). Enough to read the
// skills written for Hermes Agent and Claude, and to write files any YAML reader takes.

export type FrontValue = string | string[] | Record<string, string>

export interface FrontMatter {
  data: Record<string, FrontValue>
  body: string
}

const KEY = /^([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/
const indented = (line: string): boolean => /^\s/.test(line)

/** A YAML scalar as written: quoted ("…" with escapes, '…' with '' for '), or plain (a trailing # comment dropped). */
function scalar(raw: string): string {
  const value = raw.trim()
  if (value.startsWith('"') && value.endsWith('"') && value.length > 1) {
    try {
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length > 1) return value.slice(1, -1).replace(/''/g, "'")
  // (Not /\s+#.*$/: on a long run of spaces that one takes time growing with its square.)
  return value.replace(/\s#.*$/, '').trimEnd()
}

/** The items of a flow list ("a, 'b, c', d"), commas inside quotes kept. */
function flowItems(inner: string): string[] {
  const items: string[] = []
  let current = ''
  let quote = ''
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = ''
      current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      items.push(current)
      current = ''
    } else current += ch
  }
  if (current.trim()) items.push(current)
  return items.map(scalar).filter(Boolean)
}

/** A block scalar's lines: kept as they are (|), or folded into one paragraph per run of lines (>). */
function blockText(lines: string[], literal: boolean): string {
  // The smallest indent of its lines (a loop: spreading 200,000 lines into Math.min overflows the stack).
  let width = Infinity
  for (const line of lines) if (line.trim()) width = Math.min(width, line.length - line.trimStart().length)
  const texts = lines.map((l) => l.slice(Number.isFinite(width) ? width : 0))
  if (literal) return texts.join('\n').trim()
  return texts
    .join('\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .join('\n')
    .trim()
}

/** The front matter and the Markdown after it; a file without front matter is all body. */
export function readFrontMatter(text: string): FrontMatter {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
  // It ends at a line that is only "---" (not at a "---" ending some line: a description "Calls ---").
  const head = /^---[ \t]*\n(?:([\s\S]*?)\n)?---[ \t]*(?:\n|$)/.exec(src)
  if (!head) return { data: {}, body: src }
  const data: Record<string, FrontValue> = {}
  const lines = (head[1] ?? '').split('\n')
  // The lines under the current key: indented ones (or list items, which YAML lets start at the key's own indent),
  // and blank lines between them.
  const under = (line: string): boolean => indented(line) || /^-\s/.test(line)
  const takeIndented = (from: number): { taken: string[]; next: number } => {
    let i = from
    while (i < lines.length && (under(lines[i]) || (!lines[i].trim() && i + 1 < lines.length && under(lines[i + 1])))) i++
    return { taken: lines.slice(from, i), next: i }
  }
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]
    const key = indented(line) ? null : KEY.exec(line)
    if (!key || line.trimStart().startsWith('#')) {
      i++
      continue
    }
    const value = (key[2] ?? '').trim()
    const { taken, next } = takeIndented(i + 1)
    i = next
    if (/^[|>][+-]?\d*$/.test(value)) data[key[1]] = blockText(taken, value.startsWith('|'))
    else if (!value) {
      const items: string[] = []
      const map: Record<string, string> = {}
      for (const sub of taken) {
        const item = /^\s*-\s+(.*)$/.exec(sub)
        const pair = /^\s+([A-Za-z0-9_.-]+)\s*:(?:\s+(.*)|\s*)$/.exec(sub)
        if (item) items.push(scalar(item[1]))
        // Keys nested deeper (Hermes Agent's metadata.hermes.tags) come up to this level.
        else if (pair && pair[2] !== undefined) map[pair[1]] = pair[2].startsWith('[') ? flowItems(pair[2].replace(/^\[|\]$/g, '')).join(', ') : scalar(pair[2])
      }
      data[key[1]] = items.length ? items : map
    } else if (value.startsWith('[') && value.endsWith(']')) data[key[1]] = flowItems(value.slice(1, -1))
    // A plain or quoted string, perhaps continued on indented lines.
    else data[key[1]] = scalar([value, ...taken.map((l) => l.trim())].filter(Boolean).join(' '))
  }
  return { data, body: src.slice(head[0].length).replace(/^\n+/, '') }
}

/** A string as YAML: plain when that reads the same, double-quoted otherwise (JSON's quoting is valid YAML). */
function yamlString(value: string): string {
  const plain = /^[A-Za-z][\w .,()/'&+-]*$/.test(value) && !/:\s|\s#|\s$/.test(value) && !/^(true|false|yes|no|on|off|null)$/i.test(value)
  return plain ? value : JSON.stringify(value)
}

/** A Markdown file with front matter; keys with no value are left out. */
export function writeFrontMatter(data: Record<string, FrontValue | undefined>, body: string): string {
  const lines = ['---']
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) continue
    if (Array.isArray(value)) lines.push(`${key}: [${value.map(yamlString).join(', ')}]`)
    else if (typeof value === 'object') {
      const entries = Object.entries(value).filter(([, v]) => v)
      if (!entries.length) continue
      lines.push(`${key}:`)
      for (const [k, v] of entries) lines.push(`  ${k}: ${yamlString(v)}`)
    } else lines.push(`${key}: ${yamlString(value)}`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}\n${body.trim()}\n`
}
