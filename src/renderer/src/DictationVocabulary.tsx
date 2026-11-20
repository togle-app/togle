import { useEffect, useRef, useState } from 'react'
import type { DictationVocabulary as Vocabulary, DictationVocabularyEdit } from '@shared/dictation'
import { Field, openedInView } from './Rows'
import { useKeptState } from './kept'

const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
type Draft = { kind: 'word' | 'snippet'; id?: string; phrase: string; value: string }

export function VocabularyEditor({ accountId, accountName }: { accountId: string; accountName?: string }) {
  const [vocabulary, setVocabulary] = useKeptState<Vocabulary | undefined>('settings.vocabulary:' + accountId, undefined)
  const [draft, setDraft] = useKeptState<Draft | undefined>('settings.vocabulary.draft:' + accountId, undefined)
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
  }, [accountId, retry, setVocabulary])
  const save = async (edit: DictationVocabularyEdit): Promise<void> => {
    if (saving.current) return
    saving.current = true; setBusy(true); setError(''); setStatus('')
    try {
      const next = await window.togle.editDictationVocabulary(accountId, edit)
      setVocabulary(next)
      setDraft(current => current === draft ? undefined : current)
      if (alive.current) setStatus(edit.kind === 'remove' ? 'Removed.' : 'Saved. Applies to your next dictation.')
    } catch (error) { if (alive.current) setError(errorText(error)) }
    finally { saving.current = false; if (alive.current) setBusy(false) }
  }
  const edit = (value: Draft): void => { setDraft(value); setError(''); setStatus('') }
  return <div className="vocabulary-editor">
    {accountName && <p className="hint">Kept with {accountName}, on this computer. Another account has its own words and snippets.</p>}
    {!vocabulary && !error && <p className="hint" role="status">Loading words…</p>}
    {vocabulary && <>
      {/* Each list as the rest of Settings: a small name over its rows, each row a name with quiet words to change it or take it out. */}
      <div className="vocabulary-heading"><h4 className="tasks-label">Words</h4><button className="small" disabled={busy || !!draft} onClick={() => edit({ kind: 'word', phrase: '', value: '' })}>Add word</button></div>
      <p className="hint">Names and terms to spell correctly. Add “heard as” to fix a recurring mistake.</p>
      {vocabulary.words.length ? <ul className="vocabulary-list">{vocabulary.words.map(word => <li key={word.id}>
        <span><strong>{word.word}</strong>{word.heardAs && <small>Heard as: {word.heardAs}</small>}</span>
        <button className="quiet-action" disabled={busy || !!draft} aria-label={`Edit word ${word.word}`} onClick={() => edit({ kind: 'word', id: word.id, phrase: word.word, value: word.heardAs })}>Edit</button>
        <button className="quiet-action" disabled={busy || !!draft} aria-label={`Remove word ${word.word}`} onClick={() => void save({ kind: 'remove', id: word.id })}>Remove</button>
      </li>)}</ul> : <p className="hint">No words saved yet.</p>}
      <div className="vocabulary-heading"><h4 className="tasks-label">Snippets</h4><button className="small" disabled={busy || !!draft} onClick={() => edit({ kind: 'snippet', phrase: '', value: '' })}>Add snippet</button></div>
      <p className="hint">Say a distinctive phrase, such as “my work email”, to insert your saved text exactly.</p>
      {vocabulary.snippets.length ? <ul className="vocabulary-list">{vocabulary.snippets.map(snippet => <li key={snippet.id}>
        <span><strong>{snippet.phrase}</strong><small className="snippet-preview">{snippet.text}</small></span>
        <button className="quiet-action" disabled={busy || !!draft} aria-label={`Edit snippet ${snippet.phrase}`} onClick={() => edit({ kind: 'snippet', id: snippet.id, phrase: snippet.phrase, value: snippet.text })}>Edit</button>
        <button className="quiet-action" disabled={busy || !!draft} aria-label={`Remove snippet ${snippet.phrase}`} onClick={() => void save({ kind: 'remove', id: snippet.id })}>Remove</button>
      </li>)}</ul> : <p className="hint">No snippets saved yet.</p>}
    </>}
    {draft && <form ref={openedInView} className="vocabulary-form" onSubmit={event => {
      event.preventDefault()
      void save(draft.kind === 'word' ? { kind: 'word', id: draft.id, word: draft.phrase, heardAs: draft.value } : { kind: 'snippet', id: draft.id, phrase: draft.phrase, text: draft.value })
    }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) { setDraft(undefined); setError('') } } }}>
      <span className="tasks-label">{draft.kind === 'word' ? (draft.id ? 'Change a word' : 'Add a word') : draft.id ? 'Change a snippet' : 'Add a snippet'}</span>
      <Field name={draft.kind === 'word' ? 'Spelling' : 'Phrase'}><input aria-label={draft.kind === 'word' ? 'Correct spelling' : 'Spoken phrase'} required autoFocus maxLength={80} disabled={busy} value={draft.phrase} placeholder={draft.kind === 'word' ? 'Togle' : 'my work email'} onChange={event => setDraft({ ...draft, phrase: event.target.value })} /></Field>
      {draft.kind === 'word' ? <Field name="Heard as"><input aria-label="Heard as (optional)" maxLength={80} disabled={busy} placeholder="toggle (optional)" value={draft.value} onChange={event => setDraft({ ...draft, value: event.target.value })} /></Field>
        : <Field tall name="Types this text"><textarea aria-label="Insert this text" required maxLength={4000} rows={4} disabled={busy} value={draft.value} placeholder="Your email, signature, or a reply you often use" onChange={event => setDraft({ ...draft, value: event.target.value })} /></Field>}
      <div className="row"><button className="primary small" disabled={busy || !draft.phrase.trim() || draft.kind === 'snippet' && !draft.value.trim()}>{busy ? 'Saving…' : 'Save'}</button><button type="button" className="ghost small" disabled={busy} onClick={() => { setDraft(undefined); setError('') }}>Cancel</button></div>
    </form>}
    {error && <p className="error" role="alert">{error}{!vocabulary && <button className="ghost" onClick={() => setRetry(value => value + 1)}>Try again</button>}</p>}
    {status && <p className="hint" role="status">{status}</p>}
  </div>
}
