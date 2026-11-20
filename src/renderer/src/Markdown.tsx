import { createContext, createElement, Fragment, memo, useContext, useDeferredValue, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import type { Token, Tokens } from 'marked'
import type { Source } from '@shared/types'
import { externalUrl, localFilePath } from '@shared/links'
import { richDocument, richInline, richText } from '@shared/rich-text'
import { citationTimes, meetingCitation } from '@shared/meeting-citations'

const NO_SOURCES: Source[] = []
type Sources = ReadonlyMap<number, Source>
const EMPTY_SOURCES: Sources = new Map()
const LocalFilesContext = createContext(false)

function FileLink({ href, file, text, title, children }: { href: string; file: string; text?: string; title?: string | null; children: ReactNode }): ReactNode {
  const [missing, setMissing] = useState<string>()
  const show = async (): Promise<void> => {
    const shown = await window.togle.showChatFile(href).catch(() => false)
    setMissing(shown ? undefined : href)
  }
  return <span className="md-file">
    <button type="button" className="link md-file-link" title={`${title ? title + '\n' : ''}Show in folder\n${file}`} onClick={() => void show()}>{children}</button>
    {text !== file && <span className="md-file-path"> ({file})</span>}
    {missing === href && <span role="status" className="md-file-status"> Couldn’t locate this file on this computer.</span>}
  </span>
}

function Link({ href, children, title, label, text }: { href: string; children: ReactNode; title?: string | null; label?: string; text?: string }): ReactNode {
  const localFiles = useContext(LocalFilesContext)
  const url = externalUrl(href)
  if (!url) {
    const file = localFiles && localFilePath(href, window.togle.platform)
    return file ? <FileLink href={href} file={file} text={text} title={title}>{children}</FileLink> : <>{children}</>
  }
  const open = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (event.type === 'auxclick' && event.button !== 1) return
    event.preventDefault()
    window.togle.openExternal(url)
  }
  return <a href={url} target="_blank" rel="noopener noreferrer" aria-label={label} title={title ? `${title}\n${url}` : url} onClick={open} onAuxClick={open}>{children}</a>
}

/** Kept mounted while the rest of a reply streams, preserving selection and copy feedback. */
function CodeBlock({ code, language = '' }: { code: string; language?: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async (): Promise<void> => {
    try { await navigator.clipboard.writeText(code) } catch { return }
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return <div className="code-block">
    <div className="code-toolbar"><span>{language.split(/\s+/)[0] || 'Code'}</span><button type="button" className="link copy" aria-label={copied ? 'Code copied' : 'Copy code'} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></div>
    <pre tabIndex={0}><code>{code}</code></pre>
  </div>
}

/** Whether the times a call's notes cite ("[12:38]") are drawn as chips: the notes ask for it, an agent's answer does not. */
type MeetingTimes = boolean | ((seconds: number) => void)
const TimesContext = createContext<MeetingTimes>(false)

function TimeText({ text, sources }: { text: string; sources: Sources }): ReactNode {
  const times = useContext(TimesContext)
  if (!times) return <>{plainCitations(text, sources)}</>
  const parts: ReactNode[] = []
  let from = 0
  for (const match of text.matchAll(meetingCitation)) {
    parts.push(<Fragment key={'text-' + from}>{plainCitations(text.slice(from, match.index), sources)}</Fragment>)
    citationTimes(match[0]).forEach(({ label, seconds }, i) => {
      const key = match.index + '-' + i, title = 'Show transcript at ' + label
      parts.push(typeof times === 'function'
        ? <button key={key} type="button" className="md-time" title={title} aria-label={title} onClick={() => times(seconds)}>{label}</button>
        : <span key={key} className="md-time">{label}</span>)
    })
    from = match.index + match[0].length
  }
  return <>{parts}{plainCitations(text.slice(from), sources)}</>
}

function citations(text: string, sources: Sources): ReactNode {
  return text.includes('[') && text.includes(':') ? <TimeText text={text} sources={sources} /> : plainCitations(text, sources)
}

function plainCitations(text: string, sources: Sources): ReactNode {
  if (!sources.size || !text.includes('[')) return text
  return text.split(/(\[\d+(?:\s*,\s*\d+)*\])/g).map((part, index) => {
    const match = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(part)
    const numbers = match?.[1].split(/\s*,\s*/).map(Number)
    if (!numbers?.every(number => sources.has(number))) return part
    return <Fragment key={index}>{numbers.map((number, i) => {
      const source = sources.get(number)!
      const label = `${source.doc}${source.section ? ` › ${source.section}` : ''}`
      return <sup key={i} className="cite" title={label}>{source.url ? <Link href={source.url} title={label} label={`Source ${number}: ${label}`}>{number}</Link> : number}</sup>
    })}</Fragment>
  })
}

function inline(tokens: Token[] = [], sources: Sources, depth = 0, tail = false): ReactNode {
  if (depth > 40) return tokens.map(token => token.raw).join('')
  return tokens.map((token, index) => {
    const atTail = tail && index === tokens.length - 1
    let content: ReactNode
    switch (token.type) {
      case 'strong': content = <strong>{inline(token.tokens, sources, depth + 1, atTail)}</strong>; break
      case 'em': content = <em>{inline(token.tokens, sources, depth + 1, atTail)}</em>; break
      case 'del': content = <del>{inline(token.tokens, sources, depth + 1, atTail)}</del>; break
      case 'codespan': content = <code>{token.text}</code>; break
      case 'br': content = <br />; break
      case 'checkbox': content = <input className="md-checkbox" type="checkbox" checked={token.checked} disabled aria-label={token.checked ? 'Completed task' : 'Incomplete task'} />; break
      case 'link': {
        const label = token.autolink ? token.text : inline(token.tokens, sources, depth + 1)
        content = token.autolink && atTail ? label : <Link href={token.autolink ? token.href : richText(token.href)} title={token.title} text={token.text}>{label}</Link>
        break
      }
      case 'image': content = <Link href={richText(token.href)} title={token.title}>Image: {richText(token.text) || 'Open image'}</Link>; break
      case 'html': content = token.raw; break
      case 'escape': content = richText(token.text); break
      default: {
        const nested = 'tokens' in token ? token.tokens : undefined
        content = nested ? inline(nested, sources, depth + 1, atTail) : citations(richText('text' in token ? token.text ?? token.raw : token.raw), sources)
      }
    }
    return <Fragment key={index}>{content}</Fragment>
  })
}

function block(token: Token, sources: Sources, depth = 0, tail = false): ReactNode {
  if (depth > 40) return <p>{token.raw}</p>
  const children = (tokens: Token[] = [], atTail = tail): ReactNode => tokens.map((child, index) => <Fragment key={index}>{block(child, sources, depth + 1, atTail && index === tokens.length - 1)}</Fragment>)
  switch (token.type) {
    case 'space': case 'def': return null
    case 'paragraph': return <p>{inline(token.tokens, sources, 0, tail && !/\s$/.test(token.raw))}</p>
    case 'heading': return createElement(`h${Math.min(6, token.depth + 2)}`, null, inline(token.tokens, sources))
    case 'code': return <CodeBlock code={token.text} language={token.lang} />
    case 'blockquote': return <blockquote>{children(token.tokens)}</blockquote>
    case 'hr': return <hr />
    case 'list': {
      const list = token as Tokens.List
      const items = list.items.map((item, index) => <li key={index} className={item.task ? 'md-task' : undefined}>{children(item.tokens, tail && index === list.items.length - 1)}</li>)
      return list.ordered ? <ol start={Number(list.start) || undefined}>{items}</ol> : <ul>{items}</ul>
    }
    case 'table': {
      const table = token as Tokens.Table
      return <div className="md-table" role="region" aria-label="Table" tabIndex={0}><table>
        <thead><tr>{table.header.map((cell, index) => <th key={index} scope="col" style={{ textAlign: cell.align ?? undefined }}>{inline(cell.tokens, sources)}</th>)}</tr></thead>
        <tbody>{table.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} style={{ textAlign: cell.align ?? undefined }}>{inline(cell.tokens, sources)}</td>)}</tr>)}</tbody>
      </table></div>
    }
    case 'html': return <p className="md-literal">{token.raw}</p>
    default: return inline([token], sources, 0, tail)
  }
}

interface BlockProps { token: Token; sources: Sources; references: string; tail: boolean }
const Block = memo(function Block({ token, sources, tail }: BlockProps) {
  return block(token, sources, 0, tail)
}, (before, after) => before.token.raw === after.token.raw && before.token.type === after.token.type && before.sources === after.sources && before.references === after.references && before.tail === after.tail)

const Content = memo(function Content({ text, sources, streaming }: { text: string; sources: Source[]; streaming: boolean }) {
  const document = useMemo(() => richDocument(text), [text])
  const byNumber = useMemo(() => new Map(sources.map(source => [source.n, source])), [sources])
  if (document.plain !== undefined) return <div className="md md-literal">{document.plain}</div>
  let last = document.blocks.length - 1
  while (last >= 0 && ['space', 'def'].includes(document.blocks[last].type)) last--
  return <div className="md">{document.blocks.map((token, index) => <Block key={index} token={token} sources={byNumber} references={document.references} tail={streaming && index === last} />)}</div>
})

/** Defer streamed formatting behind typing; completed blocks are memoized independently. */
export const Markdown = memo(function Markdown({ text, sources = NO_SOURCES, streaming = false, times = false, localFiles = false }: { text: string; sources?: Source[]; streaming?: boolean; times?: MeetingTimes; localFiles?: boolean }): ReactNode {
  const deferred = useDeferredValue(streaming ? text : '')
  const content = <Content text={streaming ? deferred : text} sources={sources} streaming={streaming} />
  return <LocalFilesContext.Provider value={localFiles}>
    {times ? <TimesContext.Provider value={times}>{content}</TimesContext.Provider> : content}
  </LocalFilesContext.Provider>
})

/** Evidence excerpts can contain links without inserting block elements into a paragraph. */
export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }): ReactNode {
  const tokens = useMemo(() => richInline(text), [text])
  return <span className="md-inline">{inline(tokens, EMPTY_SOURCES)}</span>
})
