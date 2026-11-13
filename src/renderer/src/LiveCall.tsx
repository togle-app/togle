import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PartialTranscript, Settings, TranscriptEntry } from '@shared/types'
import { markedLineIds, speakerLabel } from '@shared/meeting'
import type { CaptureInputs } from './audio/capture'
import { FirstCallNotice, TellOthers } from './TellOthers'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })

/** How long the call has been going: "12:41", "1:05:20". It ticks by itself. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60)
  return <>{hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:{String(seconds % 60).padStart(2, '0')}</>
}

interface Props {
  settings: Settings
  title: string
  since: number
  transcript: TranscriptEntry[]
  flags: { toldOthers: number; marks: number[] }
  inputs: CaptureInputs
  /** How loud each side is now: read by the meters themselves, a few times a second. */
  levels: () => Partial<Record<'me' | 'them', number>>
  onMark: () => void
  onStop: () => void
  onReconnect: () => void
  onFirstCallSeen: () => void
}

/**
 * A call being written down: its words as people speak, who said them (a name with a question mark is a guess, to
 * confirm or change), the line to tell the others until it is ticked, Mark and Stop.
 */
export function LiveCall({ settings, title, since, transcript, flags, inputs, levels, onMark, onStop, onReconnect, onFirstCallSeen }: Props) {
  const [partials, setPartials] = useState<PartialTranscript[]>([])
  const finished = useRef(new Set<string>())
  useEffect(() => {
    const subs = [
      api.onPartialTranscript((partial) => {
        if (finished.current.has(partial.segmentId)) return
        setPartials((previous) => {
          const rest = previous.filter((item) => item.segmentId !== partial.segmentId)
          return partial.text ? [...rest, partial].sort((a, b) => a.at - b.at) : rest
        })
      }),
      // The final line replaces its live caption.
      api.onTranscript((entry) => {
        if (!entry.segmentId) return
        finished.current.add(entry.segmentId)
        if (finished.current.size > 400) finished.current.delete(finished.current.values().next().value!)
        setPartials((previous) => previous.filter((item) => item.segmentId !== entry.segmentId))
      })
    ]
    return () => { for (const stop of subs) stop() }
  }, [])

  const marked = useMemo(() => markedLineIds({ transcript, marks: flags.marks }), [transcript, flags.marks])
  // Who has spoken: you first, then each voice of the call in the order it first spoke.
  const people = useMemo(() => {
    const voices = new Map<string, TranscriptEntry>()
    for (const line of transcript) if (line.speaker === 'them' && line.voiceId && !voices.has(line.voiceId)) voices.set(line.voiceId, line)
    for (const line of transcript) if (line.voiceId && voices.has(line.voiceId) && line.voiceName) voices.set(line.voiceId, line)
    return [...voices.values()]
  }, [transcript])
  const lines = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    const box = lines.current
    if (box && atEnd.current) box.scrollTop = box.scrollHeight
  }, [transcript.length, partials.length])

  const heard = (side: 'me' | 'them'): string => inputs[side].state === 'unavailable' ? 'off' : inputs[side].state === 'connecting' ? 'starting' : inputs[side].state === 'paused' ? 'paused' : 'on'
  return (
    <section className="live-call" aria-label="Call being written down">
      <header className="live-head">
        <h2>{title || 'Call'}</h2>
        <span className="live-clock" role="timer" aria-label="Time into the call">Live · <Elapsed since={since} /></span>
        <span className="spacer" />
        <button onClick={onMark} title="Mark this moment. The notes list marked moments first.">Mark</button>
        <button className="primary" onClick={onStop} title="Stop writing the call down">Stop</button>
      </header>
      <div className="live-sources" aria-label="What is heard">
        <Meter label="You" title="Your microphone" state={heard('me')} level={() => levels().me} />
        <Meter label="Call" title="The call's sound, from this computer" state={heard('them')} level={() => levels().them} />
      </div>
      {(inputs.me.state === 'unavailable' || inputs.them.state === 'unavailable') && (
        <div className="live-problem" role="status">
          <span>{inputs.them.state === 'unavailable' ? (inputs.me.state === 'unavailable' ? "Togle can't hear your microphone or the call's sound." : "Togle can't hear the call's sound. It still hears you.") : "Togle can't hear your microphone. It still hears the call."} {(inputs.them.state === 'unavailable' ? inputs.them.detail : inputs.me.detail) ?? ''}</span>
          <button onClick={onReconnect}>Reconnect audio</button>
        </div>
      )}
      {!settings.meetings.introSeen && <FirstCallNotice settings={settings} onDone={onFirstCallSeen} />}
      {!flags.toldOthers && <TellOthers transcription={settings.transcription} onTold={() => api.setToldOthers(true)} />}
      <div className="live-people" aria-label="Who spoke">
        <span className="person-chip ok">You</span>
        {people.map((line) => <PersonChip key={line.voiceId} line={line} />)}
      </div>
      <div className="live-lines" ref={lines} onScroll={(event) => { const box = event.currentTarget; atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40 }}>
        {!transcript.length && !partials.length && <p className="hint">Listening… The words appear as people speak.</p>}
        {transcript.map((line) => <LiveLine key={line.id} line={line} marked={marked.has(line.id)} />)}
        {partials.map((partial) => (
          <div key={partial.segmentId} className="live-line partial">
            <span className="who">{speakerLabel({ speaker: partial.speaker, voiceId: partial.voiceId, voiceName: partial.voiceName, voiceNamedBy: partial.voiceNamedBy })}</span>
            <time dateTime={new Date(partial.at).toISOString()}>{clock.format(partial.at)}</time>
            <p>{partial.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * One line said: drawn when it comes, and again only when it changes (a name given, a mark), so a long call's new
 * words and live captions don't redraw every line before them.
 */
const LiveLine = memo(function LiveLine({ line, marked }: { line: TranscriptEntry; marked: boolean }) {
  return (
    <div className={`live-line ${line.speaker} ${marked ? 'marked' : ''}`}>
      <span className="who">{speakerLabel(line)}</span>
      <time dateTime={new Date(line.at).toISOString()}>{clock.format(line.at)}</time>
      <p>{line.text}{marked && <span className="marked-tag">Marked</span>}</p>
    </div>
  )
})

/** One voice of the call: a click names it, or confirms the name guessed from what was said. */
function PersonChip({ line }: { line: TranscriptEntry }) {
  const label = speakerLabel(line)
  const guessed = line.voiceNamedBy === 'suggested' || line.voiceNamedBy === 'remembered'
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const save = async (value: string): Promise<void> => {
    if (!value.trim() || !line.voiceId) return
    setError('')
    try {
      await api.renameVoice(line.voiceId, value.trim())
      setNaming(false)
    } catch (failure) {
      setError(errorText(failure))
    }
  }
  if (naming) {
    return (
      <form className="person-chip naming" onSubmit={(event) => { event.preventDefault(); void save(name) }}>
        <input aria-label={`Name for ${label}`} autoFocus value={name} maxLength={60} placeholder="Who is this?" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setNaming(false) }} />
        <button className="primary small" disabled={!name.trim()}>Save</button>
        {error && <span className="error">{error}</span>}
      </form>
    )
  }
  return (
    <button className={`person-chip ${guessed ? 'guess' : line.voiceName ? 'ok' : 'unnamed'}`} title={guessed ? 'A guess from what was said: click to confirm or change it' : 'Click to name this voice'} onClick={() => { setName(line.voiceName ?? ''); setNaming(true) }}>
      {label}
    </button>
  )
}

/** How loud one side is, as four bars, read a few times a second. Off or paused, the bars stay dark. */
function Meter({ label, title, state, level }: { label: string; title: string; state: string; level: () => number | undefined }) {
  const [lit, setLit] = useState(0)
  useEffect(() => {
    if (state !== 'on') { setLit(0); return }
    const timer = setInterval(() => {
      const rms = level() ?? 0
      setLit(rms > 0.08 ? 4 : rms > 0.035 ? 3 : rms > 0.012 ? 2 : rms > 0.003 ? 1 : 0)
    }, 120)
    return () => clearInterval(timer)
  }, [state, level])
  return (
    <span className="live-meter" data-state={state} title={state === 'on' ? title : `${title}: ${state}`}>
      {label}
      <span className="bars" aria-hidden="true">{[4, 7, 10, 13].map((height, index) => <i key={height} className={index < lit ? 'on' : ''} style={{ height }} />)}</span>
    </span>
  )
}
