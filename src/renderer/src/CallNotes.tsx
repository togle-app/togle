import { useEffect, useRef, useState } from 'react'
import type { CallSession, MeetingNoteTemplate } from '@shared/types'
import { Markdown } from './Markdown'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export function CallNotes({ record, onRecord, canGenerate }: { record: CallSession; onRecord: (record: CallSession) => void; canGenerate: boolean }) {
  const [template, setTemplate] = useState<MeetingNoteTemplate>(record.minutes?.template ?? 'concise')
  const [draft, setDraft] = useState<{ text: string; revision?: string }>()
  const [personal, setPersonal] = useState<{ text: string; before: string }>()
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('')
  const alive = useRef(false), working = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (record.minutes?.template) setTemplate(record.minutes.template) }, [record.minutes?.template])
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (working.current) return
    working.current = true; setBusy(true); setError(''); setStatus('')
    try { await work() } catch (error) { if (alive.current) setError(errorText(error)) }
    finally { working.current = false; if (alive.current) setBusy(false) }
  }
  const generate = (): void => {
    setReplacing(false)
    void run(async () => { const next = await window.togle.generateCallNotes(record.id, template, record.minutes?.revision); if (alive.current) { onRecord(next); setStatus('Meeting notes updated.') } })
  }
  const generating = record.minutes?.state === 'generating'
  const staleDraft = !!draft && draft.revision !== record.minutes?.revision
  return <div className="meeting-notes">
    <div className="meeting-notes-head"><h4>Meeting notes</h4><div className="row">
      <button className="ghost" disabled={busy || !!draft} onClick={() => { setDraft({ text: record.summary, revision: record.minutes?.revision }); setError(''); setStatus('') }}>Edit notes</button>
      {record.summary && !draft && <button className="ghost" disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(record.summary); if (alive.current) setStatus('Notes copied.') })}>Copy notes</button>}
    </div></div>
    {generating && <p className="thinking" role="status">Writing meeting notes…</p>}
    {draft ? <form className="meeting-notes-form" onSubmit={event => {
      event.preventDefault()
      void run(async () => { const next = await window.togle.saveCallNotes(record.id, draft.revision, draft.text); if (alive.current) { onRecord(next); setDraft(undefined); setStatus('Your edits are saved.') } })
    }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setDraft(undefined) } }}>
      <label>Meeting notes<textarea aria-label="Edit meeting notes" value={draft.text} maxLength={60000} rows={10} autoFocus disabled={busy} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
      {staleDraft && <div className="notice"><p>Newer notes are available. Your edits are still here.</p><div className="row"><button type="button" disabled={busy} onClick={() => void run(async () => { const next = await window.togle.saveCallNotes(record.id, record.minutes?.revision, draft.text); if (alive.current) { onRecord(next); setDraft(undefined); setStatus('Your edits are saved.') } })}>Save my version</button><button type="button" disabled={busy} onClick={() => { setDraft({ text: record.summary, revision: record.minutes?.revision }); setError('') }}>Use updated notes</button></div></div>}
      <div className="row"><button className="primary" disabled={busy || staleDraft}>Save notes</button><button type="button" disabled={busy} onClick={() => { setDraft(undefined); setError('') }}>Cancel</button></div>
    </form> : record.summary ? <Markdown text={record.summary} /> : <p className="hint">{record.status === 'live' ? 'Notes are generated after the call ends. You can write your own notes below.' : 'Generate notes from the saved transcript, or write your own.'}</p>}
    {record.minutes?.edited && !draft && <p className="hint">Edited by you. Automatic generation keeps your version.</p>}
    {record.status !== 'live' && canGenerate && record.transcript.length > 0 && !draft && <div className="meeting-notes-generate">
      <label>Format<select aria-label="Meeting note format" disabled={busy || generating} value={template} onChange={event => { setTemplate(event.target.value as MeetingNoteTemplate); setReplacing(false) }}><option value="concise">Concise</option><option value="detailed">Detailed</option><option value="action-items">Action items</option></select></label>
      <button disabled={busy || generating} onClick={() => record.minutes?.edited ? setReplacing(true) : generate()}>{busy || generating ? 'Writing notes…' : record.summary ? 'Regenerate notes' : 'Generate notes'}</button>
    </div>}
    {replacing && <div className="replace-notes"><p>Replace your edited meeting notes with a new AI version?</p><div className="row"><button disabled={busy} onClick={generate}>Replace edited notes</button><button disabled={busy} onClick={() => setReplacing(false)}>Keep my version</button></div></div>}
    <details className="personal-call-notes">
      <summary>My notes{record.personalNotes ? ' · Saved' : ''}</summary>
      <p className="hint">Your own observations. Included the next time you generate meeting notes.</p>
      {personal ? <form className="meeting-notes-form" onSubmit={event => {
        event.preventDefault()
        void run(async () => { const next = await window.togle.savePersonalCallNotes(record.id, personal.before, personal.text); if (alive.current) { onRecord(next); setPersonal(undefined); setStatus('Personal notes saved.') } })
      }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setPersonal(undefined) } }}>
        <label>My notes<textarea aria-label="Personal call notes" rows={5} maxLength={20000} autoFocus value={personal.text} disabled={busy} onChange={event => setPersonal({ ...personal, text: event.target.value })} /></label>
        <div className="row"><button disabled={busy}>Save personal notes</button><button type="button" disabled={busy} onClick={() => { setPersonal(undefined); setError('') }}>Cancel</button></div>
      </form> : <>{record.personalNotes && <div className="personal-notes-text"><Markdown text={record.personalNotes} /></div>}<button className="ghost" disabled={busy} onClick={() => setPersonal({ before: record.personalNotes || '', text: record.personalNotes || '' })}>{record.personalNotes ? 'Edit personal notes' : 'Add personal notes'}</button></>}
    </details>
    {status && <p className="hint" role="status">{status}</p>}
    {(error || record.minutes?.state === 'error' && record.minutes.error) && <p className="error" role="alert">{error || record.minutes?.error}</p>}
  </div>
}
