import { useEffect, useState, type RefObject } from 'react'
import { cleanQuote } from '@shared/quote'
import { Icon } from './Icon'

/** Where the person's selection is, for the Quote button: its words, and the place over it (or under it, near the top). */
export interface QuoteSpot {
  text: string
  x: number
  y: number
  below: boolean
}

/** The one message a node is in: what holds `data-quotable` (what the agent said, or the person's own words). */
export const messageOf = (node: Node | null): Element | null => ((node instanceof Element ? node : node?.parentElement) ?? null)?.closest('[data-quotable]') ?? null

/** Chromium can put a paragraph selection's end just outside it to include the trailing line break. */
function rangeIn(message: Element, range: Range): Range | null {
  if (message.contains(range.startContainer) && message.contains(range.endContainer)) return range
  if (!range.intersectsNode(message)) return null
  const bounds = document.createRange()
  bounds.selectNodeContents(message)
  const inside = range.cloneRange()
  if (range.compareBoundaryPoints(Range.START_TO_START, bounds) < 0) inside.setStart(message, 0)
  if (range.compareBoundaryPoints(Range.END_TO_END, bounds) > 0) inside.setEnd(message, message.childNodes.length)
  return !inside.collapsed && inside.toString().trim() === range.toString().trim() ? inside : null
}

/** The words the person has selected inside one message, or null when nothing is selected in it (or the selection goes beyond it). */
export function selectionIn(message: Element): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  return rangeIn(message, range) ? selection.toString().trim() || null : null
}

/**
 * All the words of one message as they read (line breaks where its paragraphs and lines are), without the quote a reply of the person's
 * carries above it: for a Reply to the whole message and for Copy. Read from a copy laid out out of sight, since the line breaks
 * are the layout's.
 */
export function wordsOfMessage(message: Element): string {
  const copy = message.cloneNode(true) as HTMLElement
  copy.querySelectorAll('blockquote.you-quote, .code-toolbar, .md-file-path, .md-file-status').forEach((element) => element.remove())
  const holder = document.createElement('div')
  holder.setAttribute('aria-hidden', 'true')
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:640px;pointer-events:none'
  holder.append(copy)
  document.body.append(holder)
  const words = holder.innerText
  holder.remove()
  return words.trim()
}

/**
 * The part of one message the person has selected inside `place`, once the selection is made (not while the mouse is still down),
 * for a Quote button over it. A selection over two messages, or over anything that is not a message, is none.
 */
export function useQuoteSpot(place: RefObject<HTMLElement | null>, enabled: boolean): QuoteSpot | null {
  const [spot, setSpot] = useState<QuoteSpot | null>(null)
  useEffect(() => {
    const box = place.current
    if (!enabled || !box) {
      setSpot(null)
      return
    }
    let frame = 0
    let pressing = false
    let waitingForClick = 0
    let anchor: { message: Element; x: number; y: number } | undefined
    const clearWait = (): void => { window.clearTimeout(waitingForClick); waitingForClick = 0 }
    const look = (): void => {
      frame = 0
      if (pressing || waitingForClick) return
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) return setSpot(null)
      const selected = selection.getRangeAt(0)
      const message = messageOf(selected.startContainer) ?? anchor?.message ?? messageOf(selected.endContainer)
      const range = message && box.contains(message) ? rangeIn(message, selected) : null
      if (!range) return setSpot(null)
      const text = cleanQuote(selection.toString())
      const frame0 = box.getBoundingClientRect()
      // Only the lines in view count: a selection scrolled out of the conversation has no button, which would land on the reply box.
      const seen = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > frame0.top + 4 && rect.top < frame0.bottom - 4)
      if (!text || !seen.length) return setSpot(null)
      let first = seen[0], last = seen[seen.length - 1]
      let center = first.left + first.width / 2
      // A word can become a whole paragraph on the next click. Keep the action on the original line.
      if (anchor && anchor.message === message) {
        const bounds = message.getBoundingClientRect()
        const clickY = bounds.top + anchor.y
        const line = seen.find(rect => rect.top <= clickY && rect.bottom >= clickY)
        if (line) { first = last = line; center = bounds.left + anchor.x }
      }
      const room = 36
      const below = first.top - frame0.top < room + 8
      const x = Math.min(Math.max(center - frame0.left, 48), Math.max(48, frame0.width - 48))
      const y = below ? Math.min(last.bottom - frame0.top, frame0.height - room - 4) : Math.max(first.top - frame0.top, room + 4)
      setSpot({ text, x, y, below })
    }
    const soon = (): void => {
      if (!pressing && !waitingForClick && !frame) frame = requestAnimationFrame(look)
    }
    // Held back while the mouse is down (a selection being made), and shown when it is let go.
    const press = (event: MouseEvent | PointerEvent): void => {
      if (event.button !== 0 || (event.target as Element | null)?.closest?.('.quote-float')) return
      clearWait()
      pressing = true
      if (event.detail < 2) { anchor = undefined; setSpot(null); return }
      const message = messageOf(event.target as Node)
      if (message && anchor?.message !== message) {
        const rect = message.getBoundingClientRect()
        anchor = { message, x: event.clientX - rect.left, y: event.clientY - rect.top }
      }
    }
    const release = (event: MouseEvent | PointerEvent): void => {
      if (!pressing) return
      pressing = false
      if (event.detail === 2 && anchor) {
        // Leave time for the browser's third click before offering the word by itself.
        waitingForClick = window.setTimeout(() => { clearWait(); soon() }, 500)
      } else soon()
    }
    // Mouse events carry the native click count. Touch and pen use their pointer events.
    const pointerDown = (event: PointerEvent): void => { if (event.pointerType !== 'mouse') press(event) }
    const pointerUp = (event: PointerEvent): void => { if (event.pointerType !== 'mouse') release(event) }
    const cancel = (): void => { pressing = false; anchor = undefined; clearWait(); soon() }
    const keyboard = (event: KeyboardEvent): void => {
      if (event.shiftKey || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a')) {
        anchor = undefined
        clearWait()
        soon()
      }
    }
    document.addEventListener('selectionchange', soon)
    document.addEventListener('mouseup', release)
    document.addEventListener('pointerup', pointerUp)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('keydown', keyboard)
    box.addEventListener('mousedown', press, true)
    box.addEventListener('pointerdown', pointerDown, true)
    window.addEventListener('blur', cancel)
    // The conversation scrolling moves what is selected.
    box.addEventListener('scroll', soon, true)
    window.addEventListener('resize', soon)
    soon()
    return () => {
      clearWait()
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', soon)
      document.removeEventListener('mouseup', release)
      document.removeEventListener('pointerup', pointerUp)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('keydown', keyboard)
      box.removeEventListener('mousedown', press, true)
      box.removeEventListener('pointerdown', pointerDown, true)
      window.removeEventListener('blur', cancel)
      box.removeEventListener('scroll', soon, true)
      window.removeEventListener('resize', soon)
    }
  }, [place, enabled])
  return spot
}

/** The button over a selected part of a message. It keeps the selection (a press on a button would otherwise end it). */
export function QuoteFloat({ spot, onQuote }: { spot: QuoteSpot; onQuote: () => void }) {
  return (
    <button type="button" className={`quote-float${spot.below ? ' below' : ''}`} style={{ left: spot.x, top: spot.y }} title="Quote this part in your reply" onMouseDown={(event) => event.preventDefault()} onClick={onQuote}>
      Quote
    </button>
  )
}

/** Over the reply box: the part being answered, and a way to let it go. */
export function QuoteBar({ quote, onRemove }: { quote: string; onRemove: () => void }) {
  return (
    <div className="quote-bar" role="group" aria-label="The part you are replying to">
      <span className="quote-bar-words">
        <b>Replying to</b>
        <span>{quote}</span>
      </span>
      <button type="button" className="ghost small quote-bar-remove" aria-label="Remove the quote" title="Remove the quote (Esc)" onClick={onRemove}>
        <Icon name="close" size={12} />
      </button>
    </div>
  )
}

/** A quote as it is drawn in what was said: above the answer, in a line of its own. */
export function QuoteBlock({ text }: { text: string }) {
  return <blockquote className="you-quote">{text}</blockquote>
}
