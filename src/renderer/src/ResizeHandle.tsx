import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Icon } from './Icon'

/**
 * The edge between two panes, which the pointer drags to change how wide the pane before it is and the keys move too (arrows, Home and
 * End; Shift for bigger steps). A tab on it hides that pane or shows it again: a press on the tab, a double-click on the edge, or Enter.
 * It owns no width: `size` says what it is when a drag starts, and `onSize` is told the width asked for (the owner keeps it in bounds,
 * and says whether the pane is `collapsed`).
 */
export function ResizeHandle({ label, className = '', at, size, onSize, step = 16, collapsed, onToggle }: {
  label: string
  className?: string
  /** Where the edge is from the left of what it is in, in px (not given: the stylesheet places it). */
  at?: number
  /** The pane's width now, and the least and most it can have. */
  size: () => { width: number; min: number; max: number }
  onSize: (width: number) => void
  /** How far an arrow key moves it (Shift: four times that). */
  step?: number
  collapsed: boolean
  onToggle: () => void
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  // What a drag calls is the latest of these, whatever the page has been drawn as since it began.
  const latest = useRef({ onSize })
  latest.current = { onSize }
  const { width, min, max } = size()
  // A drag follows the pointer over the whole window (it leaves the thin edge at once), and ends where it is let go.
  useEffect(() => {
    if (!dragging) return
    const move = (event: PointerEvent): void => {
      if (drag.current) latest.current.onSize(drag.current.width + event.clientX - drag.current.x)
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
    const next = event.key === 'ArrowLeft' ? now.width - by : event.key === 'ArrowRight' ? now.width + by : event.key === 'Home' ? now.min : event.key === 'End' ? now.max : undefined
    if (next === undefined) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onToggle()
      }
      return
    }
    event.preventDefault()
    onSize(next)
  }
  const what = label.replace(/^Resize /, '')
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
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
      onDoubleClick={onToggle}
      onKeyDown={keys}
    >
      <button
        type="button"
        className="resize-tab"
        tabIndex={-1}
        aria-label={collapsed ? `Show ${what}` : `Hide ${what}`}
        title={collapsed ? `Show ${what}` : `Hide ${what}`}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={onToggle}
      >
        <Icon name="chevron" size={11} />
      </button>
    </div>
  )
}
