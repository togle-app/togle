import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icon'

// The space a list keeps from the window's sides.
const EDGE_PX = 8

export type MenuItem =
  /**
   * `detail`: its keys, beside it; `note`: a few words more, under it. `keepOpen`: a choice that shows more choices (the
   * menu's items change) rather than being one.
   */
  | { label: ReactNode; detail?: string; note?: string; checked?: boolean; disabled?: boolean; danger?: boolean; keepOpen?: boolean; onSelect: () => void }
  | { heading: string }
  | 'divider'

interface Props {
  /** What the button shows. */
  label: ReactNode
  className?: string
  title?: string
  ariaLabel?: string
  items: MenuItem[]
  /** The side of the button the list lines up with. */
  align?: 'left' | 'right'
  /** Which way the list opens: down, or up from a button at the bottom of the window. */
  direction?: 'down' | 'up'
  /** As it opens: a chance to load what it lists. */
  onOpen?: () => void
}

/** A button that opens a short list of choices; a pick, a click elsewhere, Escape or switching apps closes it. */
export function Menu({ label, className = '', title, ariaLabel, items, align = 'left', direction = 'down', onOpen }: Props) {
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const focusEdge = useRef<'first' | 'last'>('first')
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const positioned = position !== null
  const choices = (): HTMLButtonElement[] => [...(list.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])]
  useEffect(() => {
    if (!open || !positioned) return
    const buttons = choices()
    const button = focusEdge.current === 'last' ? buttons.at(-1) : buttons[0]
    button?.focus()
  }, [open, positioned])
  // A viewport overlay escapes scrolling panels and inherited header/form styles.
  useLayoutEffect(() => {
    if (!open) { setPosition(null); return }
    const place = (): void => {
      const button = trigger.current, menu = list.current
      if (!button || !menu) return
      if (!button.getClientRects().length) { setOpen(false); return }
      const anchor = button.getBoundingClientRect()
      if (anchor.bottom < EDGE_PX || anchor.top > innerHeight - EDGE_PX) { setOpen(false); return }
      const below = Math.max(0, innerHeight - anchor.bottom - EDGE_PX - 4)
      const above = Math.max(0, anchor.top - EDGE_PX - 4)
      const height = Math.min(menu.scrollHeight + 2, 360)
      const up = direction === 'up' ? above >= height || above > below : below < height && above > below
      const maxHeight = Math.min(360, up ? above : below)
      const width = menu.getBoundingClientRect().width
      const left = Math.max(EDGE_PX, Math.min(align === 'right' ? anchor.right - width : anchor.left, innerWidth - EDGE_PX - width))
      const top = up ? Math.max(EDGE_PX, anchor.top - 4 - Math.min(height, maxHeight)) : anchor.bottom + 4
      setPosition(previous => previous?.left === left && previous.top === top && previous.maxHeight === maxHeight ? previous : { left, top, maxHeight })
    }
    place()
    const observer = new ResizeObserver(place)
    if (trigger.current) observer.observe(trigger.current)
    if (list.current) observer.observe(list.current)
    const scroll = (event: Event): void => { if (!list.current?.contains(event.target as Node)) place() }
    window.addEventListener('resize', place)
    document.addEventListener('scroll', scroll, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', place); document.removeEventListener('scroll', scroll, true) }
  }, [open, items.length, align, direction])

  useEffect(() => {
    if (!open) return
    const outside = (e: PointerEvent): void => {
      if (!box.current?.contains(e.target as Node) && !list.current?.contains(e.target as Node)) setOpen(false)
    }
    // Its Escape, before the page's (which would go back): it only closes the list.
    const escape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    const away = (): void => setOpen(false)
    const focus = (event: FocusEvent): void => {
      if (!box.current?.contains(event.target as Node) && !list.current?.contains(event.target as Node)) setOpen(false)
    }
    const another = (event: Event): void => { if ((event as CustomEvent).detail !== menuId) setOpen(false) }
    window.dispatchEvent(new CustomEvent('togle:menu-open', { detail: menuId }))
    window.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('blur', away)
    window.addEventListener('focusin', focus)
    window.addEventListener('togle:menu-open', another)
    return () => {
      window.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('blur', away)
      window.removeEventListener('focusin', focus)
      window.removeEventListener('togle:menu-open', another)
    }
  }, [open])

  // The column of ticks, only in a menu where something can be ticked.
  const ticks = items.some((item) => typeof item === 'object' && 'label' in item && item.checked !== undefined)
  return (
    <div className="menu-anchor" ref={box}>
      {/* Never a form's submit button: in the box to write in, a click would send what's written. */}
      <button
        ref={trigger}
        type="button"
        className={`${className} ${open ? 'open' : ''}`}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          focusEdge.current = e.key === 'ArrowUp' ? 'last' : 'first'
          if (!open) onOpen?.()
          setOpen(true)
          if (open) {
            const buttons = choices()
            const button = focusEdge.current === 'last' ? buttons.at(-1) : buttons[0]
            button?.focus()
          }
        }}
        onClick={() => {
          focusEdge.current = 'first'
          if (!open) onOpen?.()
          setOpen(!open)
        }}
      >
        {label}
      </button>
      {open && createPortal(
        <div
          id={menuId}
          ref={list}
          className="popover menu menu-overlay"
          role="menu"
          aria-label={ariaLabel ?? title}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              setOpen(false)
              trigger.current?.focus()
              return
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
            e.preventDefault()
            e.stopPropagation()
            const buttons = choices()
            if (!buttons.length) return
            const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (current + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
            buttons[next].focus()
          }}
          style={position ? { ...position, visibility: 'visible' } : { visibility: 'hidden' }}
        >
          {items.map((item, i) =>
            item === 'divider' ? (
              <hr key={i} />
            ) : 'heading' in item ? (
              <p key={i} className="popover-title">
                {item.heading}
              </p>
            ) : (
              <button
                key={i}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={item.checked}
                className={item.danger ? 'danger' : undefined}
                disabled={item.disabled}
                onClick={() => {
                  if (!item.keepOpen) {
                    setOpen(false)
                    trigger.current?.focus()
                  }
                  item.onSelect()
                }}
              >
                {ticks && <span className="mark">{item.checked && <Icon name="check" size={12} />}</span>}
                <span className="label">
                  {item.label}
                  {item.note && <span className="note">{item.note}</span>}
                </span>
                {item.detail && <span className="detail">{item.detail}</span>}
              </button>
            )
          )}
        </div>, document.body
      )}
    </div>
  )
}
