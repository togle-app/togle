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

/** The words the person has selected inside one message, or null when nothing is selected in it (or the selection goes beyond it). */
export function selectionIn(message: Element): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null
  const range = selection.getRangeAt(0)
  if (messageOf(range.startContainer) !== message || messageOf(range.endContainer) !== message) return null
  return selection.toString().trim() || null
}

/**
 * All the words of one message as they read (line breaks where its paragraphs and lines are), without the quote a reply of the person's
 * carries above it: for a Reply to the whole message and for Copy. Read from a copy laid out out of sight, since the line breaks
 * are the layout's.
 */
export function wordsOfMessage(message: Element): string {
  const copy = message.cloneNode(true) as HTMLElement
  copy.querySelectorAll('blockquote.you-quote').forEach((quote) => quote.remove())
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
    const look = (): void => {
      frame = 0
      const selection = window.getSelection()
      if (pressing || !selection || selection.isCollapsed || !selection.rangeCount) return setSpot(null)
      const range = selection.getRangeAt(0)
      const message = messageOf(range.startContainer)
      if (!message || message !== messageOf(range.endContainer) || !box.contains(message)) return setSpot(null)
      const text = cleanQuote(selection.toString())
      const frame0 = box.getBoundingClientRect()
      // Only the lines in view count: a selection scrolled out of the conversation has no button, which would land on the reply box.
      const seen = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0 && rect.bottom > frame0.top + 4 && rect.top < frame0.bottom - 4)
      if (!text || !seen.length) return setSpot(null)
      const first = seen[0]
      const last = seen[seen.length - 1]
      // Over the first line, centered on it; under the last line when there is no room over it; always inside the conversation's height.
      const room = 36
      const below = first.top - frame0.top < room + 8
      const x = Math.min(Math.max(first.left + first.width / 2 - frame0.left, 48), Math.max(48, frame0.width - 48))
      const y = below ? Math.min(last.bottom - frame0.top, frame0.height - room - 4) : Math.max(first.top - frame0.top, room + 4)
      setSpot({ text, x, y, below })
    }
    const soon = (): void => {
      if (!frame) frame = requestAnimationFrame(look)
    }
    // Held back while the mouse is down (a selection being made), and shown when it is let go.
    const press = (event: Event): void => {
      if ((event.target as Element | null)?.closest?.('.quote-float')) return
      pressing = true
      setSpot(null)
    }
    const release = (): void => {
      if (!pressing) return
      pressing = false
      soon()
    }
    document.addEventListener('selectionchange', soon)
    document.addEventListener('pointerup', release)
    document.addEventListener('pointercancel', release)
    box.addEventListener('pointerdown', press, true)
    // The conversation scrolling moves what is selected.
    box.addEventListener('scroll', soon, true)
    window.addEventListener('resize', soon)
    soon()
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', soon)
      document.removeEventListener('pointerup', release)
      document.removeEventListener('pointercancel', release)
      box.removeEventListener('pointerdown', press, true)
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
