import { useEffect, useRef, useState } from 'react'

export interface Point {
  x: number
  y: number
}

/**
 * A short menu where something was right-clicked (or its menu key pressed): a pick, a click elsewhere, Escape or switching
 * apps closes it. It stays inside the window.
 */
export function PointMenu({ at, label, items, onClose }: { at: Point; label: string; items: { label: string; danger?: boolean; onSelect: () => void }[]; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(at)
  useEffect(() => {
    const menu = box.current
    if (!menu) return
    const { width, height } = menu.getBoundingClientRect()
    setPlace({ x: Math.max(8, Math.min(at.x, innerWidth - width - 8)), y: Math.max(8, Math.min(at.y, innerHeight - height - 8)) })
    menu.querySelector('button')?.focus()
    const outside = (event: PointerEvent): void => {
      if (!menu.contains(event.target as Node)) onClose()
    }
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
    }
  }, [at, onClose])
  return (
    <div ref={box} className="popover call-menu" role="menu" aria-label={label} style={{ left: place.x, top: place.y }}>
      {items.map((item) => (
        <button key={item.label} role="menuitem" className={item.danger ? 'danger' : undefined} onClick={() => { onClose(); item.onSelect() }}>
          {item.label}
        </button>
      ))}
    </div>
  )
}
