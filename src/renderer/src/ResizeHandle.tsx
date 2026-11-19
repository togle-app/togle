import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'

/**
 * The edge between two panes, which the pointer drags to change how wide the pane before it is and the keys move too (arrows, Home and
 * End; Shift for bigger steps). There is no button for hiding a pane: squeezed narrower than `collapseBelow` it collapses (the list
 * hides, the navigation goes to its icons), and dragged out again it opens. Enter or a double click collapses it or opens it too; an
 * arrow key at its narrowest collapses it, and from a collapsed pane an arrow key opens it.
 * It owns no width: `size` says what it is when a drag starts (its collapsed width, when it is collapsed), `onSize` is told the width asked
 * for, within `min` and `max` (the pane is open at it), and `onCollapsed` is told when it is to collapse or to open.
 */
export function ResizeHandle({ label, className = '', at, size, onSize, collapseBelow, step = 16, collapsed, onCollapsed }: {
  label: string
  className?: string
  /** Where the edge is from the left of what it is in, in px (not given: the stylesheet places it). */
  at?: number
  /** The pane's width now, and the narrowest and widest it can be open. */
  size: () => { width: number; min: number; max: number }
  /** The width asked for, within its bounds: the pane is open at it. */
  onSize: (width: number) => void
  /** Squeezed narrower than this, the pane collapses. */
  collapseBelow: number
  /** How far an arrow key moves it (Shift: four times that). */
  step?: number
  collapsed: boolean
  onCollapsed: (collapsed: boolean) => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  /** What a width asked for does: it collapses the pane when it is narrower than `collapseBelow`, else the pane is open at it. */
  const ask = (raw: number): void => {
    const { min, max } = size()
    if (raw < collapseBelow) {
      if (!collapsed) onCollapsed(true)
      return
    }
    onSize(Math.min(max, Math.max(min, raw)))
  }
  // What a drag calls is the latest of this, whatever the page has been drawn as since it began.
  const latest = useRef(ask)
  latest.current = ask
  const { width, min, max } = size()
  // A drag follows the pointer over the whole window (it leaves the thin edge at once), and ends where it is let go.
  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent): void => {
      if (drag.current) latest.current(drag.current.width + event.clientX - drag.current.x)
    }
    const end = (): void => {
      drag.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
    window.addEventListener('blur', end)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      window.removeEventListener('blur', end)
    }
  }, [dragging])
  const keys = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const now = size()
    const by = event.shiftKey ? step * 4 : step
    if (event.key === 'Enter' || event.key === ' ') onCollapsed(!collapsed)
    else if (event.key === 'ArrowLeft') {
      if (!collapsed) {
        // At its narrowest, one more press collapses it.
        if (now.width <= now.min) onCollapsed(true)
        else ask(now.width - by)
      }
    } else if (event.key === 'ArrowRight') {
      if (collapsed) onCollapsed(false)
      else ask(now.width + by)
    } else if (event.key === 'Home') ask(now.min)
    else if (event.key === 'End') ask(now.max)
    else return
    event.preventDefault()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={Math.min(min, Math.round(width))}
      aria-valuemax={max}
      tabIndex={0}
      className={`resize-handle ${className}${collapsed ? ' collapsed' : ''}${dragging ? ' dragging' : ''}`}
      style={at === undefined ? undefined : ({ left: at } as CSSProperties)}
      onPointerDown={(event) => {
        if (event.button !== 0) return
        drag.current = { x: event.clientX, width: size().width }
        setDragging(true)
        event.preventDefault()
      }}
      onDoubleClick={() => onCollapsed(!collapsed)}
      onKeyDown={keys}
    />
  )
}
