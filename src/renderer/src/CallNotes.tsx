import { useEffect, useMemo, useRef, useState } from 'react'
import type { CallSession } from '@shared/types'
import { splitNotes, type NotesKind } from '@shared/notes-sections'
import { Icon, type IconName } from './Icon'
import { Markdown } from './Markdown'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** What wrote the notes, as the design says it above them. Nothing for notes from before it was kept. */
/** The mark of each kind of section, before its name. A topic has none. */
const KIND_ICON: Record<NotesKind, IconName | null> = { marked: 'pin', decided: 'check', todo: 'todo', open: 'ask', topic: null }
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
  // The notes in cards, one for each section; notes with no sections are one flowing text.
  const parts = useMemo(() => splitNotes(record.summary ?? ''), [record.summary])
  const generating = busy || record.minutes?.state === 'generating'
  const failed = error || (record.minutes?.state === 'error' ? record.minutes.error : '')
  return <div className="meeting-notes">
    {record.summary ? <>
      {record.minutes?.state === 'ready' && writtenBy(record.minutes.by) && <p className="hint notes-by">{writtenBy(record.minutes.by)}</p>}
      <div className="notes-text">
        {parts.lead && <div className="notes-lead"><Markdown text={parts.lead} times /></div>}
        {parts.sections.length > 0 && (
          <div className="notes-sections">
            {parts.sections.map((section, index) => (
              <section key={index} className="notes-section" data-kind={section.kind} data-wide={section.wide ? 'true' : undefined} aria-label={section.heading.replace(/[*_`]/g, '')}>
                <h4 className="notes-heading">
                  {KIND_ICON[section.kind] && <span className="notes-mark" aria-hidden="true"><Icon name={KIND_ICON[section.kind] as IconName} size={13} /></span>}
                  {section.heading.replace(/[*_`]/g, '')}
                </h4>
                <Markdown text={section.body} times />
              </section>
            ))}
          </div>
        )}
        {/* Nothing but a title: the text as it is. */}
        {!parts.lead && !parts.sections.length && <div className="notes-lead"><Markdown text={record.summary} times /></div>}
      </div>
      <p className="hint notes-foot">Your own items are offered on your to-do list.</p>
    </> : generating ? <div className="notes-empty" role="status"><span className="notes-empty-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span><b>Writing the notes…</b><p className="hint">They show here as soon as they are written.</p></div>
      : record.status === 'live' ? <div className="notes-empty"><span className="notes-empty-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span><b>The notes come when the call ends</b><p className="hint">The notes are written as soon as the call ends.</p></div>
      : <div className="notes-empty">
        <span className="notes-empty-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
        <b>No notes for this call</b>
        <p className="hint">The transcript is kept, and an agent you give the call to can write them.</p>
        {record.transcript.length > 0 && <button className="primary" disabled={generating} onClick={write}>Write the notes</button>}
      </div>}
    {failed && <p className="error" role="alert">{failed}</p>}
  </div>
}
