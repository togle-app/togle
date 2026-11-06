import { useEffect, useRef, useState } from 'react'
import type { DictationVocabulary as Vocabulary, DictationVocabularyEdit } from '@shared/dictation'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
type Draft = { kind: 'word' | 'snippet'; id?: string; phrase: string; value: string }

export function DictationVocabulary({ accountId, accountName }: { accountId: string; accountName: string }) {
  const [expanded, setExpanded] = useState(false)
  return <details className="dictation-vocabulary" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>Words &amp; shortcuts</summary>
    {expanded && <VocabularyEditor key={accountId} accountId={accountId} accountName={accountName} />}
  </details>
}

function VocabularyEditor({ accountId, accountName }: { accountId: string; accountName: string }) {
  const [vocabulary, setVocabulary] = useState<Vocabulary>()
  const [draft, setDraft] = useState<Draft>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [retry, setRetry] = useState(0)
  const alive = useRef(false), saving = useRef(false)
  useEffect(() => {
    alive.current = true
    let current = true
    setError('')
    void window.togle.dictationVocabulary(accountId).then(value => { if (current) setVocabulary(value) }, error => { if (current) setError(errorText(error)) })
    return () => { current = false; alive.current = false }
  }, [accountId, retry])
  const save = async (edit: DictationVocabularyEdit): Promise<void> => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setStatus('')
    try {
      const next = await window.togle.editDictationVocabulary(accountId, edit)
      if (alive.current) { setVocabulary(next); setDraft(undefined); setStatus(edit.kind === 'remove' ? 'Removed.' : 'Saved. Applies to your next dictation.') }
    } catch (error) { if (alive.current) setError(errorText(error)) }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }
  const edit = (value: Draft): void => { setDraft(value); setError(''); setStatus('') }
  return <div className="vocabulary-editor">
    <p className="hint">For {accountName} only. Saved on this device. Other accounts keep their own words and shortcuts.</p>
    {!vocabulary && !error && <p className="hint" role="status">Loading words…</p>}
    {vocabulary && <>
      <div className="vocabulary-heading"><h4>Words</h4><button className="ghost" disabled={busy || !!draft} onClick={() => edit({ kind: 'word', phrase: '', value: '' })}>Add word</button></div>
      <p className="hint">Names and terms to spell correctly. Add “heard as” to fix a recurring mistake.</p>
      {vocabulary.words.length ? <ul className="vocabulary-list">{vocabulary.words.map(word => <li key={word.id}>
        <span><strong>{word.word}</strong>{word.heardAs && <small>Heard as: {word.heardAs}</small>}</span>
        <button className="ghost" disabled={busy || !!draft} aria-label={`Edit word ${word.word}`} onClick={() => edit({ kind: 'word', id: word.id, phrase: word.word, value: word.heardAs })}>Edit</button>
        <button className="ghost" disabled={busy || !!draft} aria-label={`Remove word ${word.word}`} onClick={() => void save({ kind: 'remove', id: word.id })}>Remove</button>
      </li>)}</ul> : <p className="hint">No words saved yet.</p>}
      <div className="vocabulary-heading"><h4>Spoken shortcuts</h4><button className="ghost" disabled={busy || !!draft} onClick={() => edit({ kind: 'snippet', phrase: '', value: '' })}>Add shortcut</button></div>
      <p className="hint">Say a distinctive phrase, such as “my work email”, to insert your saved text exactly.</p>
      {vocabulary.snippets.length ? <ul className="vocabulary-list">{vocabulary.snippets.map(snippet => <li key={snippet.id}>
        <span><strong>{snippet.phrase}</strong><small className="snippet-preview">{snippet.text}</small></span>
        <button className="ghost" disabled={busy || !!draft} aria-label={`Edit shortcut ${snippet.phrase}`} onClick={() => edit({ kind: 'snippet', id: snippet.id, phrase: snippet.phrase, value: snippet.text })}>Edit</button>
        <button className="ghost" disabled={busy || !!draft} aria-label={`Remove shortcut ${snippet.phrase}`} onClick={() => void save({ kind: 'remove', id: snippet.id })}>Remove</button>
      </li>)}</ul> : <p className="hint">No shortcuts saved yet.</p>}
    </>}
    {draft && <form className="vocabulary-form" onSubmit={event => {
      event.preventDefault()
      void save(draft.kind === 'word' ? { kind: 'word', id: draft.id, word: draft.phrase, heardAs: draft.value } : { kind: 'snippet', id: draft.id, phrase: draft.phrase, text: draft.value })
    }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) { setDraft(undefined); setError('') } } }}>
      <label>{draft.kind === 'word' ? 'Correct spelling' : 'Spoken phrase'}<input required autoFocus maxLength={80} disabled={busy} value={draft.phrase} placeholder={draft.kind === 'word' ? 'Togle' : 'my work email'} onChange={event => setDraft({ ...draft, phrase: event.target.value })} /></label>
      {draft.kind === 'word' ? <label>Heard as (optional)<input maxLength={80} disabled={busy} placeholder="toggle" value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} /></label>
        : <label>Insert this text<textarea required maxLength={4000} rows={4} disabled={busy} value={draft.value} placeholder="Your email, signature, or a reply you often use" onChange={event => setDraft({ ...draft, value: event.target.value })} /></label>}
      <div className="row"><button className="primary" disabled={busy || !draft.phrase.trim() || draft.kind === 'snippet' && !draft.value.trim()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" disabled={busy} onClick={() => { setDraft(undefined); setError('') }}>Cancel</button></div>
    </form>}
    {error && <p className="error" role="alert">{error}{!vocabulary && <button className="ghost" onClick={() => setRetry(value => value + 1)}>Try again</button>}</p>}
    {status && <p className="hint" role="status">{status}</p>}
  </div>
}
