import { useEffect, useEffectEvent, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { Icon } from './Icon'

const api = window.togle

type Point = { x: number; y: number }
type Area = { x: number; y: number; w: number; h: number }
/** What is drawn on the picture: a box around something, an arrow to it, a few words, or a free line. */
export type Mark =
  | ({ kind: 'box' } & Area)
  | ({ kind: 'circle' } & Area)
  | { kind: 'arrow'; from: Point; to: Point }
  | { kind: 'text'; at: Point; text: string }
  | { kind: 'pen'; points: Point[] }

/** A drag shorter than this is a click: without a part chosen, the whole screen goes; inside one, words are typed there. */
const SMALLEST = 8
const INK = '#e03131'
const LINE = 2.5
const TEXT = '600 15px "Inter Variable", "Segoe UI", system-ui, sans-serif'
const RADIUS = 8

const distance = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y)
const bounds = (a: Point, b: Point): Area => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) })
const tools = { crop: 'Crop', arrow: 'Arrow', circle: 'Circle', box: 'Rectangle', draw: 'Draw' } as const
type Tool = keyof typeof tools

/**
 * A closed stroke follows its corners as a rectangle or ellipse. A stroke that
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
  if (w >= 12 && h >= 12 && span < diagonal * 0.35 && length > diagonal * 1.5) {
    const corners = [[left, top], [left + w, top], [left, top + h], [left + w, top + h]]
    const visited = corners.filter(([x, y]) => points.some(p => Math.abs(p.x - x) < w * 0.12 && Math.abs(p.y - y) < h * 0.12))
    return { kind: visited.length >= 3 ? 'box' : 'circle', x: left, y: top, w, h }
  }
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
    else if (mark.kind === 'circle') ink.ellipse(...at({ x: mark.x + mark.w / 2, y: mark.y + mark.h / 2 }), mark.w * scale / 2, mark.h * scale / 2, 0, 0, Math.PI * 2)
    else if (mark.kind === 'arrow') {
      const [left, right] = arrowHead(mark.from, mark.to)
      ink.moveTo(...at(mark.from)); ink.lineTo(...at(mark.to))
      ink.moveTo(...at(left)); ink.lineTo(...at(mark.to)); ink.lineTo(...at(right))
    } else if (mark.kind === 'pen') mark.points.forEach((point, index) => (index ? ink.lineTo : ink.moveTo).call(ink, ...at(point)))
    else if (mark.kind === 'text') {
      ink.font = TEXT.replace('15px', `${15 * scale}px`)
      ink.textBaseline = 'top'
      ink.fillText(mark.text, ...at(mark.at))
      continue
    }
    ink.stroke()
  }
}

/**
 * Draw on the full screen or crop it. The Show shortcut finishes the picture and the dictation together.
 */
export function ShowSurface() {
  const [shot, setShot] = useState<Awaited<ReturnType<typeof api.showPicture>>>(null)
  const [tool, setTool] = useState<Tool>('crop')
  const [area, setArea] = useState<Area | null>(null)
  const [marks, setMarks] = useState<Mark[]>([])
  // The stroke being drawn, and the words being typed on the picture.
  const [stroke, setStroke] = useState<Mark | null>(null)
  const [typing, setTyping] = useState<{ at: Point; text: string } | null>(null)
  const busy = useRef(false)
  const drag = useRef<{ tool: Tool; from: Point; pointerId: number; previousArea: Area | null } | null>(null)
  // The stroke and the words as they are this moment: a key or a move can come before the screen shows the one before.
  const points = useRef<Point[]>([])
  const words = useRef<{ at: Point; text: string } | null>(null)
  const type = (next: { at: Point; text: string } | null): void => { words.current = next; setTyping(next) }
  const image = useRef<HTMLImageElement>(null)

  useEffect(() => {
    void api.showPicture().then((picture) => (picture ? setShot(picture) : api.showCancel()), () => api.showCancel())
  }, [])

  const chosen = area && area.w >= SMALLEST && area.h >= SMALLEST ? area : null
  const save = async () => {
    const img = image.current
    if (busy.current || !shot || !img?.naturalWidth) return
    busy.current = true
    try {
      // The screen in device pixels: the part chosen (or all of it), with what was drawn on it.
      const scale = shot.width / window.innerWidth
      const part = chosen ?? { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(part.w * scale))
      canvas.height = Math.max(1, Math.round(part.h * scale))
      const ink = canvas.getContext('2d')!
      ink.drawImage(img, part.x * scale, part.y * scale, part.w * scale, part.h * scale, 0, 0, canvas.width, canvas.height)
      const drawn = [...marks]
      if (stroke) drawn.push(stroke)
      if (words.current?.text.trim()) drawn.push({ kind: 'text', ...words.current })
      paint(ink, drawn, part, scale)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('Could not encode the screenshot')
      api.showDone(new Uint8Array(await blob.arrayBuffer()))
    } catch { busy.current = false; api.showCancel() }
  }
  const finish = useEffectEvent(() => { void save() })

  useEffect(() => {
    const off = api.onShowFinish(finish)
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) { event.preventDefault(); finish(); return }
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
    return () => { off(); window.removeEventListener('keydown', key) }
  }, [])

  const shape = (which: Exclude<Tool, 'crop'>, start: Point, end: Point, drawn: Point[], final: boolean): Mark => {
    if (which === 'draw') return final ? markOf(drawn) : { kind: 'pen', points: drawn }
    if (which === 'arrow') return { kind: 'arrow', from: start, to: end }
    return { kind: which, ...bounds(start, end) }
  }
  /** The words typed so far become a mark of their own. */
  const keepTyping = (): void => {
    const now = words.current
    if (now?.text.trim()) setMarks((previous) => [...previous, { kind: 'text', at: now.at, text: now.text }])
    type(null)
  }
  const down = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || busy.current || drag.current) return
    const point = { x: event.clientX, y: event.clientY }
    // The drag goes on past the window's edge; a pointer that cannot be held is followed while it stays in the window.
    try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* see above */ }
    keepTyping()
    drag.current = { tool, from: point, pointerId: event.pointerId, previousArea: area }
    points.current = [point]
    if (tool === 'crop') setArea({ ...point, w: 0, h: 0 })
  }
  const move = (event: PointerEvent<HTMLDivElement>): void => {
    const now = drag.current
    if (!now || now.pointerId !== event.pointerId) return
    const point = { x: event.clientX, y: event.clientY }
    if (now.tool === 'crop') setArea(bounds(now.from, point))
    else {
      if (now.tool === 'draw') points.current = [...points.current, point]
      setStroke(shape(now.tool, now.from, point, points.current, false))
    }
  }
  const up = (event: PointerEvent<HTMLDivElement>): void => {
    const now = drag.current
    if (!now || now.pointerId !== event.pointerId) return
    drag.current = null
    const end = { x: event.clientX, y: event.clientY }
    if (now.tool !== 'crop') {
      const drawn = [...points.current, end]
      points.current = []
      setStroke(null)
      // A click on the part: words typed from there.
      if (drawn.every(point => distance(now.from, point) < SMALLEST)) {
        if (now.tool === 'draw') type({ at: { x: now.from.x, y: now.from.y - 9 }, text: '' })
      } else {
        const mark = shape(now.tool, now.from, end, drawn, true)
        setMarks(previous => [...previous, mark])
      }
      return
    }
    const part = bounds(now.from, end)
    if (part.w < SMALLEST || part.h < SMALLEST) { setArea(null); return }
    setArea(part)
    setTool('arrow')
  }
  const cancelDrag = (event: PointerEvent<HTMLDivElement>): void => {
    const now = drag.current
    if (!now || now.pointerId !== event.pointerId) return
    if (now.tool === 'crop') setArea(now.previousArea)
    drag.current = null
    points.current = []
    setStroke(null)
  }

  return (
    <div className="show" style={{ '--show-ink': INK } as CSSProperties} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelDrag} aria-label="Annotate the screenshot while you speak">
      {shot && <img ref={image} className="show-shot" src={shot.dataUrl} alt="" draggable={false} onLoad={() => api.showReady()} onError={() => api.showCancel()} />}
      {chosen && <div className="show-part" style={{ left: chosen.x, top: chosen.y, width: chosen.w, height: chosen.h }} />}
      <svg className="show-ink" aria-hidden="true">
        {marks.map((mark, index) => <MarkShape key={index} mark={mark} />)}
        {stroke && <MarkShape mark={stroke} />}
      </svg>
      {typing && <span className="show-typing" style={{ left: typing.at.x, top: typing.at.y }}>{typing.text}</span>}
      <div className="show-controls" onPointerDown={event => event.stopPropagation()}>
        <div className="show-tools" role="toolbar" aria-label="Screenshot tools" aria-describedby="show-voice-hint">
          {(Object.keys(tools) as Tool[]).map(key => <button key={key} type="button" aria-pressed={tool === key} onClick={() => { keepTyping(); setTool(key) }}>{tools[key]}</button>)}
          <button type="button" className="primary" onClick={() => void save()}>Finish <kbd>{shot?.shortcut || 'F8'}</kbd></button>
          <button type="button" onClick={() => api.showCancel()}>Cancel</button>
        </div>
        <span className="show-voice-hint" id="show-voice-hint"><Icon name="mic" size={14} />Speak while you draw.</span>
      </div>
    </div>
  )
}

function MarkShape({ mark }: { mark: Mark }) {
  const line = { fill: 'none', stroke: INK, strokeWidth: LINE, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  if (mark.kind === 'box') return <rect x={mark.x} y={mark.y} width={mark.w} height={mark.h} rx={RADIUS} {...line} />
  if (mark.kind === 'circle') return <ellipse cx={mark.x + mark.w / 2} cy={mark.y + mark.h / 2} rx={mark.w / 2} ry={mark.h / 2} {...line} />
  if (mark.kind === 'arrow') {
    const [left, right] = arrowHead(mark.from, mark.to)
    return <path d={`M${mark.from.x} ${mark.from.y} L${mark.to.x} ${mark.to.y} M${left.x} ${left.y} L${mark.to.x} ${mark.to.y} L${right.x} ${right.y}`} {...line} />
  }
  if (mark.kind === 'text') return <text x={mark.at.x} y={mark.at.y} dominantBaseline="hanging" fill={INK}>{mark.text}</text>
  return <polyline points={mark.points.map((point) => `${point.x},${point.y}`).join(' ')} {...line} />
}
