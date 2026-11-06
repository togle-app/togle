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
