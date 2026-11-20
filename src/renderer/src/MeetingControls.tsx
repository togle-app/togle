import { useMemo, useState } from 'react'
import { speakerLabel } from '@shared/meeting'
import type { CallSession, TranscriptEntry } from '@shared/types'
import { useKeptState } from './kept'
import { Icon } from './Icon'

export function BackToMeetings({ onClick }: { onClick: () => void }) {
  return <button type="button" className="meeting-back" aria-label="Back to meetings" onClick={onClick}><Icon name="back" size={14} />All meetings</button>
}

interface PeopleProps {
  callId: string
  transcript: TranscriptEntry[]
  onRecord?: (record: CallSession) => void
  showYou?: boolean
  heading?: boolean
}

/** The microphone is one speaker even in saved transcripts that predate voice IDs. */
export function MeetingPeople({ callId, transcript, onRecord, showYou, heading }: PeopleProps) {
  const people = useMemo(() => {
    const voices = new Map<string, TranscriptEntry>()
    for (const line of transcript) {
      const id = line.voiceId ?? (line.speaker === 'me' ? 'me' : undefined)
      if (id && (!voices.has(id) || line.voiceName)) voices.set(id, line)
    }
    return [...voices.entries()].sort(([, a], [, b]) => Number(b.speaker === 'me') - Number(a.speaker === 'me'))
  }, [transcript])
  if (!showYou && !people.length) return null
  const save = async (id: string, name: string): Promise<void> => {
    if (onRecord) onRecord(await window.togle.renameCallSpeaker(callId, id, name))
    else await window.togle.renameVoice(id, name)
  }
  return <div className="live-people meeting-people" aria-label="Who spoke">
    {heading && <span className="meeting-people-label">Speakers</span>}
    {showYou && !people.some(([, line]) => line.speaker === 'me') && <span className="person-chip ok">You</span>}
    {people.map(([id, line]) => <PersonChip key={id} callId={callId} id={id} line={line} save={save} />)}
  </div>
}

function PersonChip({ callId, id, line, save }: { callId: string; id: string; line: TranscriptEntry; save: (id: string, name: string) => Promise<void> }) {
  const mine = line.speaker === 'me'
  const label = speakerLabel(line) + (mine && line.voiceName ? ' (you)' : '')
  const guessed = !!line.voiceName && (line.voiceNamedBy === 'suggested' || line.voiceNamedBy === 'remembered')
  const [draft, setDraft] = useKeptState<string | null>('call.voice-name:' + JSON.stringify([callId, id]), null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const submit = async (value: string): Promise<void> => {
    if (busy || !value.trim()) return
    setBusy(true); setError('')
    try { await save(id, value.trim()); setDraft(null) }
    catch { setError('Couldn’t save the speaker name. Try again.') }
    finally { setBusy(false) }
  }
  return <>
    {draft !== null ? <form className="person-chip naming" onSubmit={event => { event.preventDefault(); void submit(draft) }}>
      <input aria-label={'Name for ' + label} autoFocus value={draft} maxLength={60} placeholder="Speaker name" onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setDraft(null) }} />
      <button className="primary small" disabled={busy || !draft.trim()}>Save</button>
      <button type="button" className="ghost small" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
    </form> : <span className="meeting-person">
      <button type="button" className={'person-chip ' + (guessed ? 'guess' : line.voiceName || mine ? 'ok' : 'unnamed')} title={'Edit name for ' + label}
        disabled={busy} onClick={() => { setError(''); setDraft(line.voiceName ?? '') }}>{label}</button>
      {guessed && <button type="button" className="confirm-person" aria-label={mine ? 'Confirm your name as ' + line.voiceName : 'Confirm ' + line.voiceName}
        disabled={busy} onClick={() => void submit(line.voiceName!)}>Confirm</button>}
    </span>}
    {error && <span className="error" role="alert">{error}</span>}
  </>
}
