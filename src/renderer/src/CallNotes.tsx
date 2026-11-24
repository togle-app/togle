import { useEffect, useMemo, useRef, useState } from 'react'
import type { CallSession } from '@shared/types'
import { missingNotesAccount } from '@shared/meeting'
import { splitNotes, type NotesKind } from '@shared/notes-sections'
import { Icon, type IconName } from './Icon'
import { Markdown } from './Markdown'
import { MeetingTodos } from './MeetingTodo'
import { useAccounts, useKeyConnections } from './Accounts'
import { Menu } from './Menu'
import { openSettings } from './open-settings'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
/** What wrote the notes, as the design says it above them. Nothing for notes from before it was kept. */
/** The mark of each kind of section, before its name. A topic has none. */
const KIND_ICON: Record<NotesKind, IconName | null> = { marked: 'pin', decided: 'check', todo: 'todo', open: 'ask', topic: null }
const writtenBy = (by?: string): string => (by === 'chatgpt' ? 'Written with your ChatGPT plan' : by === 'compat' ? 'Written with your key' : by === 'claude' ? 'Written with Claude' : '')

function NotesAccountChoice({ record, write }: { record: CallSession; write: (sourceId?: string) => void }) {
  const { accounts } = useAccounts()
  const connections = useKeyConnections()
  const sources = [...accounts.filter(account => account.signedIn), ...connections.filter(connection => connection.hasKey || connection.kind === 'local')]
  const original = record.minutes?.sourceId ?? record.ai?.tasks.background.sourceId ?? record.accountId
  const action = record.summary ? 'Update notes' : 'Write notes'
  if (sources.some(source => source.id === original)) return <div className="notes-recovery" role="status">
    <span>The last notes update couldn’t connect to its account.</span><button onClick={() => write()}>Retry notes</button>
  </div>
  return <div className="notes-recovery" role="status">
    <span>{record.summary ? 'Your previous notes are shown. Their original account is unavailable.' : 'The account saved for these notes is unavailable.'}</span>
    {sources.length === 1 ? <button className="primary" onClick={() => write(sources[0].id)}>{action} with {sources[0].label}</button>
      : sources.length ? <Menu label={action + ' with…'} items={sources.map(source => ({ label: source.label, note: 'email' in source ? source.email : undefined, onSelect: () => write(source.id) }))} />
      : <button onClick={() => openSettings('ai')}>Connect an account</button>}
  </div>
}

/**
 * A call's notes, as the design has them: what wrote them, then marked moments, what was decided and the to-dos under
 * each person's name. They are written as soon as the call ends; without an AI, the transcript is kept and the call can
 * be given to an agent, which writes them.
 */
export function CallNotes({ record, onRecord, onTime }: { record: CallSession; onRecord: (record: CallSession) => void; onTime: (seconds: number) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const write = (sourceId?: string): void => {
    setBusy(true); setError('')
    void window.togle.generateCallNotes(record.id, record.minutes?.template ?? 'concise', record.minutes?.revision, sourceId)
      .then(next => { if (alive.current) onRecord(next) }, failure => { if (alive.current) setError(errorText(failure)) })
      .finally(() => { if (alive.current) setBusy(false) })
  }
  // The notes in cards, one for each section; notes with no sections are one flowing text.
  const parts = useMemo(() => splitNotes(record.summary ?? ''), [record.summary])
  const times = record.transcript.length ? onTime : true
  const generating = busy || record.minutes?.state === 'generating'
  const failed = error || (record.minutes?.state === 'error' ? record.minutes.error : '')
  return <div className="meeting-notes">
    {generating && record.summary && <p className="hint" role="status">Updating notes…</p>}
    {!generating && failed && (missingNotesAccount(failed)
      ? <NotesAccountChoice record={record} write={write} />
      : <div className="notes-recovery" role="alert"><span>{failed}</span>{record.status !== 'live' && !!record.transcript.length && <button onClick={() => write()}>Retry notes</button>}</div>)}
    {record.summary ? <>
      {writtenBy(record.minutes?.by) && <p className="hint notes-by">{writtenBy(record.minutes?.by)}</p>}
      <div className="notes-text">
        {parts.lead && <div className="notes-lead"><Markdown text={parts.lead} times={times} /></div>}
        {parts.sections.length > 0 && (
          <div className="notes-sections">
            {parts.sections.map((section, index) => (
              <section key={index} className="notes-section" data-kind={section.kind} data-wide={section.wide ? 'true' : undefined} aria-label={section.heading.replace(/[*_`]/g, '')}>
                <h4 className="notes-heading">
                  {KIND_ICON[section.kind] && <span className="notes-mark" aria-hidden="true"><Icon name={KIND_ICON[section.kind] as IconName} size={13} /></span>}
                  {section.heading.replace(/[*_`]/g, '')}
                </h4>
                <Markdown text={section.body} times={times} />
              </section>
            ))}
          </div>
        )}
        {/* Nothing but a title: the text as it is. */}
        {!parts.lead && !parts.sections.length && <div className="notes-lead"><Markdown text={record.summary} times={times} /></div>}
      </div>
      <MeetingTodos callId={record.id} summary={record.summary} />
    </> : generating ? <div className="notes-empty" role="status"><span className="notes-empty-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span><b>Writing the notes…</b><p className="hint">They show here as soon as they are written.</p></div>
      : record.status === 'live' ? <div className="notes-empty"><span className="notes-empty-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span><b>The notes come when the call ends</b><p className="hint">The notes are written as soon as the call ends.</p></div>
      : <div className="notes-empty">
        <span className="notes-empty-mark" aria-hidden="true"><Icon name="sparkle" size={16} /></span>
        <b>No notes for this call</b>
        <p className="hint">The transcript is kept, and an agent you give the call to can write them.</p>
        {record.transcript.length > 0 && !failed && <button className="primary" disabled={generating} onClick={() => write()}>Write the notes</button>}
      </div>}
  </div>
}
