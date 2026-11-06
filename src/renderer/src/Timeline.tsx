import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Frame, PartialTranscript, TranscriptEntry } from '@shared/types'
import { sameSpeechTurn } from '@shared/speakers'

const LABEL = { me: 'Me', them: 'Them' } as const

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** What a frame's description says about it, for a tooltip or caption. */
const noteOf = (f: Frame): string => f.note ?? (f.unchanged ? 'Nothing new since the frame before.' : 'Not described yet.')

type Line = TranscriptEntry & { live: boolean }
type Row = { kind: 'line'; line: Line } | { kind: 'frames'; frames: Frame[] }

/**
 * Utterances (including live captions still being spoken) and frames in time order; frames that appear
 * back to back, with no words between, share a strip.
 */
function rows(transcript: TranscriptEntry[], partials: PartialTranscript[], frames: Frame[]): Row[] {
  const items = [
    ...transcript.map((e) => ({ at: e.at, line: { ...e, live: false } })),
    ...partials.map((p) => ({ at: p.at, line: { ...p, id: p.segmentId, end: p.at, live: true } })),
    ...frames.map((frame) => ({ at: frame.at, frame }))
  ].sort((a, b) => a.at - b.at)
  const out: Row[] = []
  for (const item of items) {
    if ('line' in item) {
      const last = out.at(-1)
      if (last?.kind === 'line' && !last.line.live && sameSpeechTurn(last.line, item.line)) {
        last.line.text += ' ' + item.line.text
        last.line.end = Math.max(last.line.end, item.line.end)
        last.line.live = item.line.live
      } else out.push({ kind: 'line', line: item.line })
    }
    else {
      const last = out[out.length - 1]
      if (last?.kind === 'frames') last.frames.push(item.frame)
      else out.push({ kind: 'frames', frames: [item.frame] })
    }
  }
  return out
}

interface Props {
  transcript: TranscriptEntry[]
  partials: PartialTranscript[]
  frames: Frame[]
  empty: string
}

// Within this many pixels of the bottom counts as following the newest line.
const FOLLOW_SLACK_PX = 40
const PAGE_SIZE = 100

/** A line said (or still being said). Memoized: a new caption on an hour-long call draws one line, not all of them. */
const LineRow = memo(function LineRow({ speaker, text, live, voiceId, voiceName, voiceNamedBy }: Line) {
  return (
    <p className={`line ${speaker} ${live ? 'live' : ''}`}>
      <span className="who" title={voiceNamedBy === 'suggested' ? 'Suggested name. Correct it under People.' : undefined}>{voiceName ? `${voiceName}${voiceNamedBy === 'suggested' ? '?' : ''}` : speaker === 'them' && voiceId ? `Speaker ${voiceId.split(':').at(-1)}` : LABEL[speaker]}</span>
      <span className="text">
        {text}
        {live && ' …'}
      </span>
    </p>
  )
})

export const Timeline = memo(function Timeline({ transcript, partials, frames, empty }: Props) {
  const [open, setOpen] = useState<Frame | null>(null)
  const preview = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    const element = preview.current
    element?.showModal()
    return () => {
      element?.close()
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [open])
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [pinned, setPinned] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  // Follows new lines only while scrolled to the bottom, so reading back isn't interrupted.
  const following = useRef(true)
  const anchor = useRef<{ height: number; top: number } | null>(null)
  const restoredTop = useRef<number | null>(null)
  // Captions change several times per utterance. Only merge and sort the visible tail;
  // reading older speech is explicit and never removes it from the call or its export.
  const settled = useMemo(() => [
    ...transcript.map(line => ({ at: line.at, line })),
    ...frames.map(frame => ({ at: frame.at, frame }))
  ].sort((a, b) => a.at - b.at), [transcript, frames])
  const keyOf = (item: typeof settled[number]): string => 'line' in item ? item.line.id : item.frame.id
  const pinnedIndex = useMemo(() => pinned === null ? -1 : settled.findIndex(item => keyOf(item) === pinned), [settled, pinned])
  const start = pinnedIndex >= 0 ? pinnedIndex : Math.max(0, settled.length - visible)
  const shownRows = useMemo(() => {
    const tail = settled.slice(start)
    return rows(tail.flatMap(item => 'line' in item ? [item.line] : []), partials, tail.flatMap(item => 'frame' in item ? [item.frame] : []))
  }, [settled, start, partials])

  useLayoutEffect(() => {
    // A cleared timeline starts following again.
    if (!transcript.length && !frames.length) following.current = true
    const el = box.current
    if (!el) return
    if (anchor.current) {
      el.scrollTop = anchor.current.top + el.scrollHeight - anchor.current.height
      restoredTop.current = el.scrollTop
      anchor.current = null
    } else if (following.current) el.scrollTop = el.scrollHeight
  }, [shownRows, start, transcript.length, frames.length])

  // Keep the enlarged frame's description current when it arrives.
  const shown = open && (frames.find((f) => f.id === open.id) ?? open)

  return (
    <div
      className="lines"
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget
        if (restoredTop.current !== null) {
          const restored = Math.abs(el.scrollTop - restoredTop.current) < 2
          restoredTop.current = null
          if (restored) return
        }
        following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK_PX
        if (following.current) {
          setPinned(null)
          setVisible(PAGE_SIZE)
        } else if (settled[start]) setPinned(previous => previous ?? keyOf(settled[start]))
      }}
    >
      {!transcript.length && !partials.length && !frames.length && <p className="empty">{empty}</p>}
      {start > 0 && <button className="link timeline-earlier" onClick={() => {
        const el = box.current
        if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop }
        following.current = false
        setPinned(keyOf(settled[Math.max(0, start - PAGE_SIZE)]))
        setVisible(count => count + PAGE_SIZE)
      }}>Show earlier transcript</button>}
      {shownRows.map((row) =>
        row.kind === 'line' ? (
          <LineRow key={row.line.id} {...row.line} />
        ) : (
          <div key={row.frames[0].id} className="frame-row">
            <div className="strip">
              {row.frames.map((f) => (
                <button key={f.id} className={`thumb ${f.kind}`} title={noteOf(f)} onClick={() => setOpen(f)}>
                  <img src={f.thumbUrl} alt={`Frame F${f.n}`} loading="lazy" />
                  <span>
                    F{f.n} · {clock(f.at)}
                  </span>
                </button>
              ))}
            </div>
            {row.frames
              .filter((f) => f.note)
              .slice(-2)
              .map((f) => (
                <p key={f.id} className="frame-note">
                  <strong>F{f.n}</strong> {f.note}
                </p>
              ))}
          </div>
        )
      )}
      {shown && (
        <dialog className="lightbox" ref={preview} aria-label={`Screenshot F${shown.n}`} onCancel={event => { event.preventDefault(); setOpen(null) }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(null) } }} onClick={event => { if (event.target === event.currentTarget) setOpen(null) }}>
          <button className="lightbox-close" autoFocus onClick={() => setOpen(null)}>Close preview</button>
          <img src={shown.imageUrl} alt={`Frame F${shown.n}`} />
          <p>
            <strong>
              F{shown.n} · {clock(shown.at)} · {shown.kind === 'snapshot' ? 'snapshot' : 'recorded'}
            </strong>
            {` ${noteOf(shown)}`}
          </p>
        </dialog>
      )}
    </div>
  )
})
