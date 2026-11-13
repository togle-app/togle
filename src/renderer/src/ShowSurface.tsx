import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'

const api = window.togle

type Point = { x: number; y: number }
type Area = { x: number; y: number; w: number; h: number }
/** What is drawn on the picture: a box around something, an arrow to it, a few words, or a free line. */
export type Mark =
  | { kind: 'box'; x: number; y: number; w: number; h: number }
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'text'; at: Point; text: string }
  | { kind: 'pen'; points: Point[] }

/** A drag shorter than this is a click: without a part chosen, the whole screen goes; inside one, words are typed there. */
const SMALLEST = 8
// Togle's indigo, as the design draws the marks.
const INK = '#98a5ff'
const LINE = 2.5
const TEXT = '600 15px "Inter Variable", "Segoe UI", system-ui, sans-serif'
const RADIUS = 8

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * A stroke, as what it was meant to be: one that goes round and comes back is a box around what it went round; one that
 * runs nearly straight is an arrow, its head where it ended; anything else stays as drawn.
 */
export function markOf(points: Point[]): Mark {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y)
  const left = Math.min(...xs), top = Math.min(...ys), w = Math.max(...xs) - left, h = Math.max(...ys) - top
  const first = points[0], last = points[points.length - 1]
  const span = distance(first, last)
  const diagonal = Math.hypot(w, h)
  let length = 0
  for (let at = 1; at < points.length; at++) length += distance(points[at - 1], points[at])
  if (w >= 12 && h >= 12 && span < diagonal * 0.35 && length > diagonal * 1.5) return { kind: 'box', x: left, y: top, w, h }
  // How far the stroke strays from the straight line between its ends.
  const stray = Math.max(...points.map((point) => Math.abs((last.x - first.x) * (first.y - point.y) - (first.x - point.x) * (last.y - first.y)) / (span || 1)))
  if (span >= 24 && stray <= Math.max(8, span * 0.12)) return { kind: 'arrow', from: first, to: last }
  return { kind: 'pen', points }
}

/** The two short lines of an arrow's head, at its end. */
function arrowHead(from: Point, to: Point): [Point, Point] {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const size = 13
  return [-0.45, 0.45].map((turn) => ({ x: to.x - size * Math.cos(angle + turn), y: to.y - size * Math.sin(angle + turn) })) as [Point, Point]
}

/** Draws the marks on the saved picture, in its pixels: `scale` device pixels to a CSS pixel, from the part's corner. */
function paint(ink: CanvasRenderingContext2D, marks: Mark[], part: Area, scale: number): void {
  const at = (point: Point): [number, number] => [(point.x - part.x) * scale, (point.y - part.y) * scale]
  ink.strokeStyle = INK
  ink.fillStyle = INK
  ink.lineWidth = LINE * scale
  ink.lineCap = 'round'
  ink.lineJoin = 'round'
  ink.shadowColor = 'rgba(0, 0, 0, 0.7)'
  ink.shadowBlur = 1.5 * scale
  for (const mark of marks) {
    ink.beginPath()
    if (mark.kind === 'box') ink.roundRect((mark.x - part.x) * scale, (mark.y - part.y) * scale, mark.w * scale, mark.h * scale, RADIUS * scale)
    else if (mark.kind === 'arrow') {
      const [left, right] = arrowHead(mark.from, mark.to)
      ink.moveTo(...at(mark.from)); ink.lineTo(...at(mark.to))
      ink.moveTo(...at(left)); ink.lineTo(...at(mark.to)); ink.lineTo(...at(right))
    } else if (mark.kind === 'pen') mark.points.forEach((point, index) => (index ? ink.lineTo : ink.moveTo).call(ink, ...at(point)))
    else {
      ink.font = TEXT.replace('15px', `${15 * scale}px`)
      ink.textBaseline = 'top'
      ink.fillText(mark.text, ...at(mark.at))
      continue
    }
    ink.stroke()
  }
}

/**
 * F8 Show, on the frozen screen, as the design has it: drag over the part to show (a dashed frame), and draw on it while
 * you talk. A loop round something becomes a box, a straight stroke an arrow; a click starts words typed there. Enter
 * puts the picture in with the words you said; Esc leaves it. A drag outside the part chooses another part.
 */
export function ShowSurface() {
  const [shot, setShot] = useState<{ dataUrl: string; width: number; height: number } | null>(null)
  const [area, setArea] = useState<Area | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  // The stroke being drawn, and the words being typed on the picture.
  const [stroke, setStroke] = useState<Point[] | null>(null)
  const [typing, setTyping] = useState<{ at: Point; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const drag = useRef<{ kind: 'choose'; from: Point } | { kind: 'draw'; from: Point } | null>(null)
  // The stroke and the words as they are this moment: a key or a move can come before the screen shows the one before.
  const points = useRef<Point[]>([])
  const words = useRef<{ at: Point; text: string } | null>(null)
  const type = (next: { at: Point; text: string } | null): void => { words.current = next; setTyping(next) }
  const image = useRef<HTMLImageElement>(null)

  useEffect(() => {
    void api.showPicture().then((picture) => (picture ? setShot(picture) : api.showCancel()), () => api.showCancel())
  }, [])

  const chosen = area && area.w >= SMALLEST && area.h >= SMALLEST ? area : null
  /** The marks with the words being typed, if any. */
  const allMarks = useCallback((): Mark[] => {
    const now = words.current
    return now?.text.trim() ? [...marks, { kind: 'text', at: now.at, text: now.text }] : marks
  }, [marks])

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
    paint(ink, allMarks(), part, scale)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!blob) { setBusy(false); return }
    api.showDone(new Uint8Array(await blob.arrayBuffer()))
  }, [busy, shot, chosen, allMarks])

  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Enter') { event.preventDefault(); void save(); return }
      const now = words.current
      if (event.key === 'Escape') {
        event.preventDefault()
        // Esc leaves the words being typed first, then the picture.
        if (now) type(null)
        else api.showCancel()
        return
      }
      if (!now || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key === 'Backspace') { event.preventDefault(); type({ ...now, text: now.text.slice(0, -1) }) }
      else if (event.key.length === 1) { event.preventDefault(); type({ ...now, text: now.text + event.key }) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [save])

  const inside = (point: Point): boolean => !!chosen && point.x >= chosen.x && point.x <= chosen.x + chosen.w && point.y >= chosen.y && point.y <= chosen.y + chosen.h
  /** The words typed so far become a mark of their own. */
  const keepTyping = (): void => {
    const now = words.current
    if (now?.text.trim()) setMarks((previous) => [...previous, { kind: 'text', at: now.at, text: now.text }])
    type(null)
  }
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || busy) return
    const point = { x: event.clientX, y: event.clientY }
    // The drag goes on past the window's edge; a pointer that cannot be held is followed while it stays in the window.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* see above */ }
    keepTyping()
    if (inside(point)) {
      drag.current = { kind: 'draw', from: point }
      points.current = [point]
      setStroke([point])
      return
    }
    drag.current = { kind: 'choose', from: point }
    setArea({ ...point, w: 0, h: 0 })
    setMarks([])
  }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const now = drag.current
    if (!now) return
    const point = { x: event.clientX, y: event.clientY }
    if (now.kind === 'draw') { points.current = [...points.current, point]; setStroke(points.current) }
    else setArea({ x: Math.min(now.from.x, point.x), y: Math.min(now.from.y, point.y), w: Math.abs(point.x - now.from.x), h: Math.abs(point.y - now.from.y) })
  }
  const up = (event: PointerEvent<HTMLDivElement>): void => {
    const now = drag.current
    drag.current = null
    if (now?.kind === 'draw') {
      const drawn = points.current
      points.current = []
      setStroke(null)
      const end = { x: event.clientX, y: event.clientY }
      // A click on the part: words typed from there.
      if (distance(now.from, end) < SMALLEST && drawn.every((point) => distance(now.from, point) < SMALLEST)) type({ at: { x: now.from.x, y: now.from.y - 9 }, text: '' })
      else if (drawn.length > 1) setMarks((previous) => [...previous, markOf(drawn)])
      return
    }
    setArea((previous) => (previous && (previous.w < SMALLEST || previous.h < SMALLEST) ? null : previous))
  }

  return (
    <div className="show" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => { drag.current = null; points.current = []; setStroke(null) }} aria-label="Show part of the screen. Drag over a part and draw on it. Enter puts it in, Esc leaves it.">
      {shot && <img ref={image} className="show-shot" src={shot.dataUrl} alt="" draggable={false} />}
      {chosen ? <div className="show-part" style={{ left: chosen.x, top: chosen.y, width: chosen.w, height: chosen.h }} /> : <div className="show-dim" />}
      <svg className="show-ink" aria-hidden="true">
        {marks.map((mark, index) => <MarkShape key={index} mark={mark} />)}
        {stroke && stroke.length > 1 && <MarkShape mark={{ kind: 'pen', points: stroke }} />}
      </svg>
      {typing && <span className="show-typing" style={{ left: typing.at.x, top: typing.at.y }}>{typing.text}</span>}
    </div>
  )
}

function MarkShape({ mark }: { mark: Mark }) {
  const line = { fill: 'none', stroke: INK, strokeWidth: LINE, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (mark.kind === 'box') return <rect x={mark.x} y={mark.y} width={mark.w} height={mark.h} rx={RADIUS} {...line} />
  if (mark.kind === 'arrow') {
    const [left, right] = arrowHead(mark.from, mark.to)
    return <path d={`M${mark.from.x} ${mark.from.y} L${mark.to.x} ${mark.to.y} M${left.x} ${left.y} L${mark.to.x} ${mark.to.y} L${right.x} ${right.y}`} {...line} />
  }
  if (mark.kind === 'text') return <text x={mark.at.x} y={mark.at.y} dominantBaseline="hanging" fill={INK}>{mark.text}</text>
  return <polyline points={mark.points.map((point) => `${point.x},${point.y}`).join(' ')} {...line} />
}
