import { memo, useMemo, useState, type ReactNode } from 'react'
import type { CallSession } from '@shared/types'
import { speakerLabel } from '@shared/meeting'
import { continuations, markedTurnIds, speechTurns } from '@shared/speakers'
import { colorOf, initialOf } from './voices'

const LINES_PER_PAGE = 100
/** A time stands between the turns where each 5 minutes into the call begin, so a long call can be found one's way in. */
const TIME_EVERY_MS = 5 * 60_000

/** Time into the call ("3:07", "75:20"), exactly as the meeting notes cite it, so a citation can be checked here. */
export function intoCall(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
/** How long a call ran, in words ("23 min", "1 h 5 min", "under a minute"). */
export function callLength(ms: number): string {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'under a minute'
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`
}

/**
 * A saved call's transcript, behind its notes, drawn as the live call draws its words: who said what (an avatar on the voice's color,
 * the name, the time into the call), a marked moment standing out, a voice that goes on without a head of its own. A line of time
 * stands between the turns where each 5 minutes begin.
 */
export const CallTranscript = memo(function CallTranscript({ record }: { record: CallSession; onRecord?: (record: CallSession) => void }) {
  const turns = useMemo(() => speechTurns(record.transcript), [record.transcript])
  const marked = useMemo(() => markedTurnIds(record), [record])
  const joins = useMemo(() => continuations(turns), [turns])
  const [shown, setShown] = useState(LINES_PER_PAGE)
  const clock = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }), [])
  if (!turns.length) return <p className="hint">No transcript was saved for this call.</p>
  const rows: ReactNode[] = []
  let five = 0
  turns.slice(0, shown).forEach((turn, index) => {
    const label = speakerLabel(turn)
    const into = Math.max(0, turn.at - record.startedAt)
    const now = Math.floor(into / TIME_EVERY_MS)
    if (index > 0 && now > five) rows.push(<div key={`time-${turn.id}`} className="transcript-time" aria-hidden="true"><span>{intoCall(now * TIME_EVERY_MS)}</span></div>)
    five = now
    const isMarked = marked.has(turn.id)
    // A long name is shortened in its column: all of it is on the pointer.
    rows.push(
      <div key={turn.id} className={`history-transcript-line call-turn ${turn.speaker}${joins[index] ? ' continues' : ''}${isMarked ? ' marked' : ''}`} style={colorOf(turn)} data-initial={initialOf(label)}>
        <span className="who" title={label}>{label}</span>
        <time title={clock.format(turn.at)}>{intoCall(turn.at - record.startedAt)}</time>
        <p>{turn.text}{isMarked && <span className="marked-tag">Marked</span>}</p>
      </div>
    )
  })
  return <>
    <div className="transcript">{rows}</div>
    {turns.length > shown && <button className="history-more" onClick={() => setShown(previous => previous + LINES_PER_PAGE)}>Show {LINES_PER_PAGE} more lines</button>}
  </>
})
