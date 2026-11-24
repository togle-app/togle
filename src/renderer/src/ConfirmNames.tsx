import { useEffect, useMemo, useRef, useState } from 'react'
import type { CallSession, TranscriptEntry } from '@shared/types'
import { namesToConfirm, type ConfirmVoice } from '@shared/confirm-names'
import { playVoiceClip, stopNoiseSample } from './audio/playback'
import { MeetingPeople } from './MeetingControls'

const api = window.togle
const SAMPLE_RATE = 16000
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** A call is at its second stage, Who spoke?, while a voice waits for an answer and its sound is kept. */
export function confirmOpen(record: CallSession, now = Date.now()): boolean {
  const confirm = record.confirm
  return record.status !== 'live' && !!confirm && !confirm.closed && confirm.until > now && confirm.voices.some(voice => voice.answered === undefined)
}

/**
 * After a call: who is confirmed, then each voice that is worth a question, with one thing it said to play, a guess at
 * who it is and why. The person says yes, or gives the name. It closes after the last answer; the sound is deleted then,
 * or the next day at the latest, and a voice never answered keeps its guess.
 */
export function ConfirmNames({ record, onRecord }: { record: CallSession; onRecord: (record: CallSession) => void }) {
  const confirm = record.confirm
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState('')
  const stopPlaying = useRef<() => void>(() => undefined)
  useEffect(() => () => { stopPlaying.current(); stopNoiseSample() }, [])
  // Everyone in the call: you, then each voice by its latest name.
  const voices = useMemo(() => {
    const found = new Map<string, TranscriptEntry>()
    for (const line of record.transcript) if (line.speaker === 'them' && line.voiceId) found.set(line.voiceId, line)
    return [...found.values()]
  }, [record.transcript])
  if (!confirm || confirm.closed || confirm.until <= Date.now()) return null
  const waiting = confirm.voices.filter(voice => voice.answered === undefined)
  const asked = new Set(waiting.map(voice => voice.id))
  const named = record.transcript.filter(line => line.speaker === 'me' || (line.voiceId && line.voiceName && !asked.has(line.voiceId)))
  const run = async (key: string, work: () => Promise<CallSession>): Promise<void> => {
    if (busy) return
    setBusy(key); setError('')
    try { onRecord(await work()) } catch (failure) { setError(errorText(failure)) } finally { setBusy('') }
  }
  const play = async (voice: ConfirmVoice): Promise<void> => {
    if (playing === voice.id) { stopPlaying.current(); return }
    setError('')
    try {
      const pcm = await api.confirmSound(record.id, voice.clip!)
      if (!pcm) { setError('The sound of this voice is not kept any more.'); return }
      setPlaying(voice.id)
      stopPlaying.current = playVoiceClip(pcm, SAMPLE_RATE, () => setPlaying(current => current === voice.id ? '' : current))
    } catch (failure) { setError(errorText(failure)) }
  }
  return (
    <section className="confirm-names" aria-label="Who spoke?">
      <div className="confirm-head"><h4>Who spoke?</h4><span className="hint">{namesToConfirm(confirm, Date.now())} of {voices.length + 1} to confirm</span></div>
      <MeetingPeople callId={record.id} transcript={named} onRecord={onRecord} showYou />
      {waiting.map(voice => (
        <ConfirmRow key={voice.id} voice={voice} busy={!!busy} playing={playing === voice.id} onPlay={() => void play(voice)}
          onAnswer={name => void run(voice.id, () => api.confirmAnswer(record.id, voice.id, name))} />
      ))}
      <p className="hint confirm-end">Closes after your last answer. The sound is deleted then, or tomorrow at the latest.</p>
      {error && <p className="error" role="status">{error}</p>}
    </section>
  )
}

function ConfirmRow({ voice, busy, playing, onPlay, onAnswer }: { voice: ConfirmVoice; busy: boolean; playing: boolean; onPlay: () => void; onAnswer: (name: string | null) => void }) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const label = voice.guess ? `${voice.guess}?` : `Voice ${voice.id.split(':').at(-1)}`
  const save = (): void => { if (name.trim()) onAnswer(name.trim()) }
  return (
    <div className={`confirm-voice ${voice.guess ? 'guess' : ''}`}>
      <div className="confirm-voice-head">
        <strong>{label}</strong>
        {voice.clip && <button className="small" aria-label={`${playing ? 'Stop' : 'Play'} ${label}`} onClick={onPlay}>{playing ? 'Stop' : 'Play'}</button>}
        {voice.guess && !naming && <>
          <button className="primary small" disabled={busy} onClick={() => onAnswer(voice.guess!)}>Yes</button>
          <button className="small" disabled={busy} onClick={() => setNaming(true)}>No</button>
        </>}
        {!voice.guess && !naming && <button className="small" disabled={busy} onClick={() => setNaming(true)}>Name</button>}
      </div>
      {voice.said && <p className="confirm-said">“{voice.said}”</p>}
      {voice.reason && <p className="hint confirm-reason">{voice.reason}</p>}
      {naming && (
        <form className="confirm-name" onSubmit={event => { event.preventDefault(); save() }}>
          <input aria-label={`Name for ${label}`} placeholder="Who is this?" autoFocus value={name} maxLength={60} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setNaming(false) }} />
          <button className="primary small" disabled={busy || !name.trim()}>Save</button>
        </form>
      )}
    </div>
  )
}
