import { Lexer, type Token, type Tokens } from 'marked'
import { decodeHTML } from 'entities'

const OPTIONS = { gfm: true, breaks: true }
const MAX_MARKDOWN_CHARS = 200_000

export const richText = (value: string): string => value.includes('&') ? decodeHTML(value) : value

export interface RichDocument { blocks: Token[]; references: string; plain?: string }

export function richInline(text: string): Token[] {
  if (text.length <= MAX_MARKDOWN_CHARS) {
    try { return Lexer.lexInline(text, OPTIONS) } catch { /* Keep the original text readable. */ }
  }
  return [{ type: 'text', raw: text, text, escaped: true }]
}

/** Tokenize only: React owns rendering, so model output never becomes executable HTML. */
export function richDocument(text: string): RichDocument {
  if (text.length > MAX_MARKDOWN_CHARS) return { blocks: [], references: '', plain: text }
  try {
    const blocks = Lexer.lex(text, OPTIONS)
    return { blocks, references: JSON.stringify(blocks.links) }
  } catch {
    return { blocks: [], references: '', plain: text }
  }
}

/** Some terminal transcripts saved pasted documents as one line. The divider and paired outer pipes
 * still identify complete table rows. Only repair the display when those boundaries agree. */
export function userMessageMarkdown(text: string): string {
  if (text.length > MAX_MARKDOWN_CHARS || /[\r\n`]/.test(text) || !/\|[ \t]+\|[ \t]*:?-{3,}/.test(text)) return text
  const cells = text.split(/(?<!\\)\|/)
  const isDivider = (cell: string): boolean => /^:?-{3,}:?$/.test(cell.trim())
  const rowGap = (cell: string): boolean => /^[ \t]+$/.test(cell)
  const divider = cells.findIndex(isDivider)
  if (divider < 1 || !rowGap(cells[divider - 1])) return text
  let end = divider
  while (end < cells.length && isDivider(cells[end])) end++
  const columns = end - divider
  // The prefix, header cells and gap must account for every pipe before the divider.
  if (columns < 2 || divider !== columns + 2) return text
  const row = (start: number): string => '|' + cells.slice(start, start + columns).join('|') + '|'
  const rows = [row(1), row(divider)]
  let next = end
  while (next + columns + 1 < cells.length && rowGap(cells[next])) {
    rows.push(row(next + 1))
    next += columns + 1
  }
  if (rows.length < 3 || next !== cells.length - 1) return text

  // A heading marker still identifies a section start. Its title and following sentence can no longer
  // be separated reliably, so keep their words together as prose.
  const intro = cells[0].trim(), rest = cells[next].trim()
  if (!/^#{1,6}[ \t]+/.test(rest)) return [intro, rows.join('\n'), rest].filter(Boolean).join('\n\n')
  const lead = intro.replace(/(?:^|[ \t]+)#[ \t]+(?=\p{Lu})/u, '\n\n').trim()
  const sections = rest.replace(/(?:^|(?<=[.!?])[ \t]+)#{1,6}[ \t]+(?=\S)/g, '\n\n').trim()
  return [lead, rows.join('\n'), sections].filter(Boolean).join('\n\n')
}

/** A readable folded preview, using the same grammar as the expanded reply. */
export function richPreview(text: string): string {
  const walk = (tokens: Token[], depth = 0): string => depth > 40 ? tokens.map(token => token.raw).join('') : tokens.map(token => {
    switch (token.type) {
      case 'space': case 'br': case 'hr': return ' '
      case 'def': case 'checkbox': return ''
      case 'code': return token.text + '\n'
      case 'codespan': return token.text
      case 'paragraph': case 'heading': case 'blockquote': return walk(token.tokens ?? [], depth + 1) + '\n'
      case 'list': return (token as Tokens.List).items.map(item => walk(item.tokens, depth + 1)).join(' ') + '\n'
      case 'table': return [(token as Tokens.Table).header, ...(token as Tokens.Table).rows].map(row => row.map(cell => walk(cell.tokens, depth + 1)).join(' ')).join(' ') + '\n'
      default: {
        const nested = 'tokens' in token ? token.tokens : undefined
        return nested ? walk(nested, depth + 1) : richText('text' in token ? token.text ?? token.raw : token.raw)
      }
    }
  }).join('')
  const document = richDocument(text)
  return (document.plain ?? walk(document.blocks)).replace(/\s+/g, ' ').trim()
}
