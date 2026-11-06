import { useEffect, useRef, useState } from 'react'
import { spellingCorrection, type DictationHistory as History, type DictationReceipt } from '@shared/dictation'
import { Toggle } from './Rows'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export function DictationHistory({ accountId, accountName }: { accountId: string; accountName: string }) {
  const [open, setOpen] = useState(false)
  return <details className="dictation-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Recent dictations</summary>
    {open && <HistoryEditor key={accountId} accountId={accountId} accountName={accountName} />}
  </details>
}

function HistoryEditor({ accountId, accountName }: { accountId: string; accountName: string }) {
  const [history, setHistory] = useState<History>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [retry, setRetry] = useState(0)
  const mounted = useRef(false), working = useRef(false)
  useEffect(() => {
    mounted.current = true
    let current = true, revision = 0
    const refresh = async (): Promise<void> => {
      const request = ++revision
      try { const value = await window.togle.dictationHistory(accountId); if (current && request === revision) setHistory(value) }
      catch (error) { if (current && request === revision) setError(errorText(error)) }
    }
    void refresh()
    const off = window.togle.onDictationHistory(change => { if (change.accountId === accountId) void refresh() })
    return () => { current = false; mounted.current = false; off() }
  }, [accountId, retry])
  const run = async (work: () => Promise<History>): Promise<void> => {
    if (working.current) return
    working.current = true; setBusy(true); setError('')
    try { const next = await work(); if (mounted.current) { setHistory(next); setClearing(false) } }
    catch (error) { if (mounted.current) setError(errorText(error)) }
    finally { working.current = false; if (mounted.current) setBusy(false) }
  }
  return <div className="dictation-history-body">
    <p className="hint">Recent text for {accountName}. Each account keeps its own history.</p>
    {history ? <>
      <Toggle name="Keep recent text" checked={history.enabled} disabled={busy} onChange={enabled => void run(() => window.togle.keepDictationHistory(accountId, enabled))} note="Up to 50 dictations for 7 days, encrypted on this device. Audio is never saved." />
      {!history.enabled && history.entries.length > 0 && <p className="hint">New dictations are not saved. You can clear the older text below.</p>}
      {history.entries.length > 0 ? <>
        <div className="dictation-history-heading"><span>{history.entries.length} recent {history.entries.length === 1 ? 'dictation' : 'dictations'}</span><button className="ghost" disabled={busy} onClick={() => setClearing(true)}>Clear history</button></div>
        {clearing && <div className="history-clear-confirm"><p>Delete this account’s saved dictation text?</p><div className="row"><button disabled={busy} onClick={() => void run(() => window.togle.removeDictationHistory(accountId))}>Clear history</button><button disabled={busy} onClick={() => setClearing(false)}>Cancel</button></div></div>}
        {history.entries.map(entry => <HistoryEntry key={entry.id} entry={entry} accountId={accountId} remove={() => run(() => window.togle.removeDictationHistory(accountId, entry.id))} disabled={busy} />)}
      </> : <p className="hint">{history.enabled ? 'Your next completed dictation will appear here.' : 'No dictation text is saved for this account.'}</p>}
    </> : !error && <p className="hint" role="status">Loading recent text…</p>}
    {error && <p className="error" role="alert">{error}{!history && <button className="ghost" onClick={() => { setError(''); setRetry(value => value + 1) }}>Try again</button>}</p>}
  </div>
}

function HistoryEntry({ entry, accountId, remove, disabled }: { entry: DictationReceipt; accountId: string; remove: () => Promise<void>; disabled: boolean }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ text: '', revision: '' })
  const [proposal, setProposal] = useState<ReturnType<typeof spellingCorrection>>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('')
  const alive = useRef(false), saving = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setStatus('')
    try { await work() } catch (error) { if (alive.current) setError(errorText(error)) }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }
  return <details className="dictation-history-entry">
    <summary><span>{entry.text.split('\n')[0].slice(0, 100)}</span><time>{new Date(entry.finishedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></summary>
    <p className="hint">{entry.destination} · {entry.corrected ? 'Corrected in history' : entry.outcome === 'inserted' ? 'Inserted' : 'Text retained for recovery'}</p>
    {!editing ? <>
      {(entry.text.length > 100 || entry.text.includes('\n')) && <p className="dictation-history-text">{entry.text}</p>}
      <div className="row"><button className="ghost" disabled={busy || disabled} onClick={() => void run(async () => { await navigator.clipboard.writeText(entry.text); if (alive.current) setStatus('Copied.') })}>Copy</button><button className="ghost" disabled={busy || disabled} onClick={() => { setDraft({ text: entry.text, revision: entry.revision }); setEditing(true); setError(''); setStatus(''); setProposal(undefined) }}>Correct text</button><button className="ghost" disabled={busy || disabled} onClick={() => void remove()}>Delete</button></div>
      {entry.originalText !== entry.text && <details className="recognized-text"><summary>Recognized words</summary><p className="dictation-history-text">{entry.originalText}</p></details>}
    </> : <form className="history-correction" onSubmit={event => {
      event.preventDefault()
      const correction = spellingCorrection(entry.text, draft.text)
      void run(async () => {
        await window.togle.correctDictationHistory(accountId, entry.id, draft.revision, draft.text)
        if (alive.current) { setEditing(false); setProposal(correction); setStatus('Corrected in history. Copy it to use the updated text.') }
      })
    }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setEditing(false) } }}>
      <label>Correct this dictation<textarea aria-label="Correct dictation text" autoFocus rows={4} maxLength={16000} value={draft.text} disabled={busy || disabled} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
      <div className="row"><button disabled={busy || disabled || !draft.text.trim()}>Save correction</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
    </form>}
    {proposal && <button className="remember-spelling ghost" disabled={busy || disabled} onClick={() => void run(async () => {
      await window.togle.editDictationVocabulary(accountId, { kind: 'word', ...proposal })
      if (alive.current) { setProposal(undefined); setStatus('Spelling remembered for this account. Manage it under Words & shortcuts.') }
    })}>Remember “{proposal.heardAs}” as “{proposal.word}”</button>}
    {status && <p className="hint" role="status">{status}</p>}
    {error && <p className="error" role="alert">{error}</p>}
  </details>
}
