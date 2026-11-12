import { memo, useDeferredValue, useMemo, useState } from 'react'
import type { CallSession } from '@shared/types'
import { SpeakerName } from './CallPeople'
import { speakerLabel } from '@shared/meeting'
import { speechTurns } from '@shared/speakers'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
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

/** A saved call's transcript: who said what and when, searchable, with the speakers' names to correct. */
export const CallTranscript = memo(function CallTranscript({ record, onRecord }: { record: CallSession; onRecord: (record: CallSession) => void }) {
  const lines = useMemo(() => speechTurns(record.transcript), [record.transcript])
  const people = useMemo(() => [...new Map(lines.filter(line => line.voiceId).map(line => [line.voiceId!, line])).values()], [lines])
  const [query, setQuery] = useState('')
  const search = useDeferredValue(query.trim().toLocaleLowerCase())
  const [shown, setShown] = useState(LINES_PER_PAGE)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const clock = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }), [])
  const matching = useMemo(() => search ? lines.filter(line => line.text.toLocaleLowerCase().includes(search)) : lines, [lines, search])
  return <>
    {people.length > 0 && <details className="call-people"><summary>People · Correct speakers</summary><p className="hint">Confirm names or combine duplicate speakers with “Same person as…”.</p>{people.map(line => <SpeakerName key={`${line.voiceId}:${line.voiceName}:${line.voiceNamedBy}`} line={line} people={people} save={async name => onRecord(await api.renameCallSpeaker(record.id, line.voiceId!, name))} merge={async into => onRecord(await api.mergeCallSpeakers(record.id, line.voiceId!, into))} />)}</details>}
    <div className="transcript-tools"><input aria-label="Search transcript" placeholder="Find something said…" value={query} onChange={event => { setQuery(event.target.value); setShown(LINES_PER_PAGE) }} /><button disabled={!lines.length} onClick={() => void navigator.clipboard.writeText(lines.map(line => `${speakerLabel(line)}: ${line.text}`).join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, error => setError(errorText(error)))}>{copied ? 'Copied' : 'Copy transcript'}</button></div>
    {!lines.length ? <p className="hint">No transcript was saved for this call.</p> : <p className="hint" role="status">{matching.length ? `Showing ${Math.min(shown, matching.length)} of ${matching.length} lines${search ? ' matching your search' : ''}.` : 'No transcript lines match this search.'}</p>}
    {matching.slice(0, shown).map(line => <div className="history-transcript-line" key={line.id}><span className="who">{speakerLabel(line)} <time title={clock.format(line.at)}>{intoCall(line.at - record.startedAt)}</time></span><p>{line.text}</p></div>)}
    {matching.length > shown && <button className="history-more" onClick={() => setShown(previous => previous + LINES_PER_PAGE)}>Show {LINES_PER_PAGE} more lines</button>}
    {error && <p className="error" role="status">{error}</p>}
  </>
})
