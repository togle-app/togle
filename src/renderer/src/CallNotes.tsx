import { useEffect, useRef, useState } from 'react'
import type { CallSession } from '@shared/types'
import { Markdown } from './Markdown'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** What wrote the notes, as the design says it above them. Nothing for notes from before it was kept. */
const writtenBy = (by?: string): string => (by === 'chatgpt' ? 'Written with your ChatGPT plan' : by === 'compat' ? 'Written with your key' : by === 'claude' ? 'Written with Claude' : '')

/**
 * A call's notes, as the design has them: what wrote them, then marked moments, what was decided and the to-dos under
 * each person's name. They are written as soon as the call ends; without an AI, the transcript is kept and the call can
 * be given to an agent, which writes them.
 */
export function CallNotes({ record, onRecord }: { record: CallSession; onRecord: (record: CallSession) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const write = (): void => {
    setBusy(true); setError('')
    void window.togle.generateCallNotes(record.id, record.minutes?.template ?? 'concise', record.minutes?.revision)
      .then(next => { if (alive.current) onRecord(next) }, failure => { if (alive.current) setError(errorText(failure)) })
      .finally(() => { if (alive.current) setBusy(false) })
  }
  const generating = busy || record.minutes?.state === 'generating'
  const failed = error || (record.minutes?.state === 'error' ? record.minutes.error : '')
  return <div className="meeting-notes">
    {record.summary ? <>
      {record.minutes?.state === 'ready' && writtenBy(record.minutes.by) && <p className="hint notes-by">{writtenBy(record.minutes.by)}</p>}
      <div className="notes-text"><Markdown text={record.summary} /></div>
      <p className="hint notes-foot">Your own items are offered on your to-do list.</p>
    </> : generating ? <p className="thinking" role="status">Writing the notes…</p>
      : record.status === 'live' ? <p className="hint">The notes are written as soon as the call ends.</p>
      : <>
        <p className="hint">No notes for this call. The transcript is kept, and an agent you give the call to can write them.</p>
        {record.transcript.length > 0 && <button disabled={generating} onClick={write}>Write the notes</button>}
      </>}
    {failed && <p className="error" role="alert">{failed}</p>}
  </div>
}
