import { memo, useMemo, useState } from 'react'
import type { CallSession } from '@shared/types'
import { speakerLabel } from '@shared/meeting'
import { speechTurns } from '@shared/speakers'

const LINES_PER_PAGE = 100

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

/** A saved call's transcript, behind its notes: who said what, and when into the call. */
export const CallTranscript = memo(function CallTranscript({ record }: { record: CallSession; onRecord?: (record: CallSession) => void }) {
  const lines = useMemo(() => speechTurns(record.transcript), [record.transcript])
  const [shown, setShown] = useState(LINES_PER_PAGE)
  const clock = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }), [])
  return <>
    {!lines.length && <p className="hint">No transcript was saved for this call.</p>}
    {lines.slice(0, shown).map(line => <div className="history-transcript-line" key={line.id}><span className="who">{speakerLabel(line)} <time title={clock.format(line.at)}>{intoCall(line.at - record.startedAt)}</time></span><p>{line.text}</p></div>)}
    {lines.length > shown && <button className="history-more" onClick={() => setShown(previous => previous + LINES_PER_PAGE)}>Show {LINES_PER_PAGE} more lines</button>}
  </>
})
