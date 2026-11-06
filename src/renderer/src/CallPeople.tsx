import { useEffect, useMemo, useState } from 'react'
import { groupCue, speakerLabel } from '@shared/meeting'
import type { TranscriptEntry } from '@shared/types'
import type { RememberedVoice } from '@shared/voices'
import { useRememberedVoices } from './VoiceMemory'

const api = window.togle

export function SpeakerName({ line, people, remembered = [], remember = false, save, merge, onSaved }: {
  line: TranscriptEntry; people: TranscriptEntry[]; remembered?: RememberedVoice[]; remember?: boolean; save?: (name: string) => Promise<void>; merge?: (into: string) => Promise<void>; onSaved?: () => void
}) {
  const [name, setName] = useState(line.voiceName ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [into, setInto] = useState('')
  const [identity, setIdentity] = useState('')
  const others = people.filter(person => person.speaker === 'them' && person.voiceId && person.voiceId !== line.voiceId)
  return <form className="speaker-name" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setError('')
    try { if (save) await save(name); else await api.renameVoice(line.voiceId!, name, identity || undefined); onSaved?.() }
    catch { setError('Could not save this name. Try again.') }
    finally { setBusy(false) }
  }}>
    <label>{line.speaker === 'me' ? 'You' : `Speaker ${line.voiceId?.split(':').at(-1)}`}<input aria-label={`Name for ${line.speaker === 'me' ? 'you' : `speaker ${line.voiceId?.split(':').at(-1)}`}`} maxLength={60} value={name} placeholder="Name" onChange={event => { setName(event.target.value); setIdentity('') }} /></label>
    <button className="ghost small" disabled={busy || !name.trim()}>{busy ? 'Saving…' : line.voiceNamedBy === 'suggested' || line.voiceNamedBy === 'remembered' ? 'Confirm' : 'Save'}</button>
    {line.voiceNamedBy === 'suggested' && <span className="hint">{line.speaker === 'me' ? 'Your name · you can correct it here' : 'Suggested from an introduction'}</span>}
    {line.voiceNamedBy === 'remembered' && <span className="hint">Recognized from a previous call</span>}
    {!save && line.voiceNamedBy === 'user' && remembered.some(person => person.id === line.voiceIdentityId) && <span className="hint">Voice remembered</span>}
    {!save && remember && line.speaker === 'them' && line.voiceNamedBy === 'user' && !line.voiceIdentityId && <span className="hint">Name confirmed. More clear speech may be needed to remember this voice.</span>}
    {!save && line.speaker === 'them' && remembered.length > 0 && <details className="speaker-merge">
      <summary>Choose remembered person</summary>
      <select aria-label={`Remembered person for speaker ${line.voiceId?.split(':').at(-1)}`} value={identity} disabled={busy} onChange={event => {
        const person = remembered.find(person => person.id === event.target.value)
        setIdentity(person?.id ?? ''); if (person) setName(person.name)
      }}>
        <option value="">Choose person</option>
        {remembered.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
      </select>
      {identity && <p className="hint">Save to confirm this person and learn their current voice.</p>}
    </details>}
    {line.speaker === 'them' && others.length > 0 && <details className="speaker-merge">
      <summary>Same person as…</summary>
      <div><select aria-label={`Combine ${speakerLabel(line)} with`} value={into} disabled={busy} onChange={event => setInto(event.target.value)}>
        <option value="">Choose speaker</option>
        {others.map(person => <option key={person.voiceId} value={person.voiceId}>{speakerLabel(person)}{person.voiceName ? ` (Speaker ${person.voiceId!.split(':').at(-1)})` : ''}</option>)}
      </select><button type="button" className="ghost small" disabled={busy || !others.some(person => person.voiceId === into)} onClick={async () => {
        setBusy(true); setError('')
        try { if (merge) await merge(into); else await api.mergeVoices(line.voiceId!, into); onSaved?.() }
        catch { setError('Could not combine these speakers. Try again.') }
        finally { setBusy(false) }
      }}>Combine</button></div>
    </details>}
    {error && <span className="error" role="status">{error}</span>}
  </form>
}

export function CallPeople({ transcript, group, onGroup, auto, onAuto, remember }: {
  transcript: TranscriptEntry[]; group: boolean; onGroup: (value: boolean) => void; auto: boolean; onAuto: () => void; remember: boolean
}) {
  const [dismissed, setDismissed] = useState(false)
  const [autoDismissed, setAutoDismissed] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState<string>()
  const [status, setStatus] = useState<{ state: string; error?: string; memoryError?: string }>({ state: 'off' })
  const known = useRememberedVoices(remember)
  useEffect(() => {
    let active = true
    void api.voiceStatus().then(value => { if (active && value) setStatus(value) }).catch(() => {})
    const unsubscribe = api.onVoiceStatus(setStatus)
    return () => { active = false; unsubscribe() }
  }, [])
  const people = useMemo(() => [...new Map(transcript.filter(line => line.voiceId).map(line => [line.voiceId!, line])).values()], [transcript])
  const unassigned = transcript.filter(line => line.speaker === 'them' && !line.voiceId).length
  const likelyGroup = people.filter(line => line.speaker === 'them').length > 1 || groupCue(transcript)
  return <div className="call-awareness">
    {!group && likelyGroup && !dismissed && <div className="call-offer" role="status"><span>This may be a group call.</span><button className="link" onClick={() => onGroup(true)}>Turn on group mode</button><button className="link" onClick={() => setDismissed(true)}>Not now</button></div>}
    {!auto && transcript.length >= 2 && !autoDismissed && <div className="call-offer"><span>Automatic suggestions are off.</span><button className="link" onClick={onAuto}>Turn on suggestions</button><button className="link" onClick={() => setAutoDismissed(true)}>Not now</button></div>}
    <section className="call-people" aria-label="People in this call">
      <button className="people-toggle" aria-expanded={expanded} aria-controls="call-people-list" onClick={() => setExpanded(value => !value)}>
        <span>People{people.length > 0 ? ` · ${people.length}` : ''}</span><span>{unassigned > 0 ? 'Some labels pending · ' : ''}{expanded ? 'Hide' : 'Show'}</span>
      </button>
      {expanded && <div id="call-people-list" className="people-list">
      {status.state === 'loading' && <p className="hint" role="status">Preparing local speaker recognition… Transcription continues.</p>}
      {status.state === 'error' && <p className="error" role="status">{status.error}</p>}
      {(status.memoryError || known.error) && <p className="error" role="status">Voice memory: {status.memoryError || known.error}</p>}
      {!people.length && <p className="hint">Names appear as people speak and introduce themselves.</p>}
      {people.map(line => <div className="person-row" key={line.voiceId}>
        <button className="person-toggle" aria-expanded={editing === line.voiceId} onClick={() => setEditing(current => current === line.voiceId ? undefined : line.voiceId)}>
          <span><strong>{speakerLabel(line)}</strong>{line.speaker === 'me' && line.voiceName ? ' (you)' : ''}<small>{line.voiceNamedBy === 'remembered' ? 'Recognized · confirm name' : line.voiceNamedBy === 'suggested' && line.speaker !== 'me' ? 'Suggested name' : !line.voiceName ? 'Add a name' : 'Edit name or combine'}</small></span>
          <span>{editing === line.voiceId ? 'Close' : 'Edit'}</span>
        </button>
        {editing === line.voiceId && <SpeakerName key={line.voiceId} line={line} people={people} remembered={known.people} remember={remember} onSaved={() => setEditing(undefined)} />}
      </div>)}
      {unassigned > 0 && <p className="hint" role="status">Some transcript passages don’t have a confident speaker label yet. They are not additional people.</p>}
      {remember && <p className="hint">Confirm a name to remember that voice for future calls.</p>}
      </div>}
    </section>
  </div>
}
