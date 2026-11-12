import { useEffect, useRef, useState } from 'react'
import type { CallSession } from '@shared/types'
import { namesToConfirm, type ConfirmVoice } from '@shared/confirm-names'
import { playVoiceClip, stopNoiseSample } from './audio/playback'

const api = window.togle
const SAMPLE_RATE = 16000
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * After a call: each voice that is worth a question, with one thing it said to play, a guess at who it is and why.
 * The person says yes, gives the name, or leaves it. The sound is deleted after the last answer, or when they skip the
 * rest, or the next day.
 */
export function ConfirmNames({ record, onRecord }: { record: CallSession; onRecord: (record: CallSession) => void }) {
  const confirm = record.confirm
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState('')
  const stopPlaying = useRef<() => void>(() => undefined)
  useEffect(() => () => { stopPlaying.current(); stopNoiseSample() }, [])
  if (!confirm || confirm.closed || confirm.until <= Date.now()) return null
  const waiting = namesToConfirm(confirm, Date.now())
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
      <div className="confirm-head"><h4>Who spoke?</h4><span className="hint">{waiting} of {confirm.voices.length} to confirm</span></div>
      {confirm.voices.map((voice, index) => (
        <ConfirmRow key={voice.id} voice={voice} index={index} busy={!!busy} playing={playing === voice.id} onPlay={() => void play(voice)}
          onAnswer={name => void run(voice.id, () => api.confirmAnswer(record.id, voice.id, name))} />
      ))}
      <p className="hint">Closes after your last answer. The sound is deleted then, or tomorrow at the latest.</p>
      <button className="link" disabled={!!busy} onClick={() => void run('skip', () => api.confirmFinish(record.id))}>Skip the rest and delete the sound</button>
      {error && <p className="error" role="status">{error}</p>}
    </section>
  )
}

function ConfirmRow({ voice, index, busy, playing, onPlay, onAnswer }: { voice: ConfirmVoice; index: number; busy: boolean; playing: boolean; onPlay: () => void; onAnswer: (name: string | null) => void }) {
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const answered = voice.answered !== undefined
  const label = voice.guess ? `${voice.guess}?` : `Voice ${index + 1}`
  const save = (): void => { if (name.trim()) onAnswer(name.trim()) }
  return (
    <div className={`confirm-voice ${answered ? 'answered' : ''}`}>
      <div className="confirm-voice-head">
        <strong>{answered ? voice.answered || 'No name' : label}</strong>
        {voice.clip && !answered && <button className="ghost small" aria-label={`${playing ? 'Stop' : 'Play'} ${label}`} onClick={onPlay}>{playing ? 'Stop' : 'Play'}</button>}
        {!answered && voice.guess && !naming && <>
          <button className="primary small" disabled={busy} onClick={() => onAnswer(voice.guess!)}>Yes</button>
          <button className="ghost small" disabled={busy} onClick={() => setNaming(true)}>No</button>
        </>}
      </div>
      {voice.said && <p className="confirm-said">“{voice.said}”</p>}
      {!answered && voice.reason && <p className="hint confirm-reason">{voice.reason}</p>}
      {!answered && (!voice.guess || naming) && (
        <form className="confirm-name" onSubmit={event => { event.preventDefault(); save() }}>
          <input aria-label={`Name for ${label}`} placeholder="Who is this?" value={name} maxLength={60} onChange={event => setName(event.target.value)} />
          <button className="primary small" disabled={busy || !name.trim()}>Save</button>
          <button type="button" className="link" disabled={busy} onClick={() => onAnswer(null)}>Not sure</button>
        </form>
      )}
    </div>
  )
}
