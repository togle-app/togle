import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'

const api = window.togle

type Point = { x: number; y: number }
type Area = { x: number; y: number; w: number; h: number }
/** A drag shorter than this is a click: without a part chosen, the whole screen goes. */
const SMALLEST = 8
const INK = '#ff4d4d'

/**
 * F8 Show, on the frozen screen: drag over the part to show, draw on it while you talk, then Save (or Enter) to put it in
 * with the words you said, or Cancel (or Esc) to leave it. A drag outside the part chooses another part.
 */
export function ShowSurface() {
  const [shot, setShot] = useState<{ dataUrl: string; width: number; height: number } | null>(null)
  const [area, setArea] = useState<Area | null>(null)
  const [strokes, setStrokes] = useState<Point[][]>([])
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ kind: 'choose'; from: Point } | { kind: 'draw' } | null>(null)
  const image = useRef<HTMLImageElement>(null)

  useEffect(() => {
    void api.showPicture().then((picture) => (picture ? setShot(picture) : api.showCancel()), () => api.showCancel())
  }, [])

  const chosen = area && area.w >= SMALLEST && area.h >= SMALLEST ? area : null
  const save = useCallback(async () => {
    const img = image.current
    if (busy || !shot || !img?.complete) return
    setBusy(true)
    // The screen in device pixels: the part chosen (or all of it), with what was drawn on it.
    const scale = shot.width / window.innerWidth
    const part = chosen ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(part.w * scale))
    canvas.height = Math.max(1, Math.round(part.h * scale))
    const ink = canvas.getContext('2d')!
    ink.drawImage(img, part.x * scale, part.y * scale, part.w * scale, part.h * scale, 0, 0, canvas.width, canvas.height)
    ink.strokeStyle = INK
    ink.lineWidth = 4 * scale
    ink.lineCap = 'round'
    ink.lineJoin = 'round'
    for (const stroke of strokes) {
      ink.beginPath()
      stroke.forEach((point, at) => (at ? ink.lineTo : ink.moveTo).call(ink, (point.x - part.x) * scale, (point.y - part.y) * scale))
      ink.stroke()
    }
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) { setBusy(false); return }
    api.showDone(new Uint8Array(await blob.arrayBuffer()))
  }, [busy, shot, chosen, strokes])

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); api.showCancel() }
      else if (event.key === 'Enter') { event.preventDefault(); void save() }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [save])

  const inside = (point: Point): boolean => !!chosen && point.x >= chosen.x && point.x <= chosen.x + chosen.w && point.y >= chosen.y && point.y <= chosen.y + chosen.h
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || busy || (event.target as HTMLElement).closest('.show-bar')) return
    const point = { x: event.clientX, y: event.clientY }
    // The drag goes on past the window's edge; a pointer that cannot be held is followed while it stays in the window.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* see above */ }
    if (inside(point)) {
      drag.current = { kind: 'draw' }
      setStrokes((previous) => [...previous, [point]])
      return
    }
    drag.current = { kind: 'choose', from: point }
    setArea({ ...point, w: 0, h: 0 })
    setStrokes([])
  }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const now = drag.current
    if (!now) return
    const point = { x: event.clientX, y: event.clientY }
    if (now.kind === 'draw') setStrokes((previous) => [...previous.slice(0, -1), [...previous[previous.length - 1], point]])
    else setArea({ x: Math.min(now.from.x, point.x), y: Math.min(now.from.y, point.y), w: Math.abs(point.x - now.from.x), h: Math.abs(point.y - now.from.y) })
  }
  const up = (): void => {
    drag.current = null
    setArea((previous) => (previous && (previous.w < SMALLEST || previous.h < SMALLEST) ? null : previous))
  }

  return (
    <div className="show" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} aria-label="Show part of the screen">
      {shot && <img ref={image} className="show-shot" src={shot.dataUrl} alt="" draggable={false} />}
      {chosen ? <div className="show-part" style={{ left: chosen.x, top: chosen.y, width: chosen.w, height: chosen.h }} /> : <div className="show-dim" />}
      <svg className="show-ink" aria-hidden="true">
        {strokes.map((stroke, at) => <polyline key={at} points={stroke.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={INK} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />)}
      </svg>
      <div className="show-bar" role="toolbar" aria-label="Show">
        <span>{chosen ? 'Draw on it while you talk. Save puts the picture and your words in.' : 'Drag over the part to show, and talk.'}</span>
        <button onClick={() => api.showCancel()}>Cancel</button>
        <button className="primary" disabled={busy || !shot} onClick={() => void save()}>Save</button>
      </div>
    </div>
  )
}
