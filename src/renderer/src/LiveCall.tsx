import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PartialTranscript, Settings, TranscriptEntry } from '@shared/types'
import { markedLineIds, speakerLabel } from '@shared/meeting'
import { continuations } from '@shared/speakers'
import { intoCall } from './CallTranscript'
import { colorOf, initialOf } from './voices'
import type { CaptureInputs } from './audio/capture'
import { FirstCallNotice, TellOthers } from './TellOthers'
import { CallAgentsRow } from './CallAgents'
import { BackToMeetings, MeetingPeople } from './MeetingControls'

const api = window.togle
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
  /** The call's key: the agents connected to it are kept under it. */
  callKey: string
  /** How loud each side is now: read by the meters themselves, a few times a second. */
  levels: () => Partial<Record<'me' | 'them', number>>
  onMark: () => void
  onStop: () => void
  onReconnect: () => void
  onFirstCallSeen: () => void
  onBack: () => void
}

/**
 * A call being written down: its words as people speak, who said them (a name with a question mark is a guess, to
 * confirm or change), the line to tell the others until it is ticked, Mark and Stop.
 */
export function LiveCall({ settings, title, since, transcript, flags, inputs, callKey, levels, onMark, onStop, onReconnect, onFirstCallSeen, onBack }: Props) {
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
  // Which lines go on from the same voice's last one (they have no head of its own), the live captions after the lines included.
  const joins = useMemo(() => continuations([...transcript, ...partials]), [transcript, partials])
  const lines = useRef<HTMLDivElement>(null)
  const atEnd = useRef(true)
  useLayoutEffect(() => {
    const box = lines.current
    if (box && atEnd.current) box.scrollTop = box.scrollHeight
  }, [transcript.length, partials.length])

  const heard = (side: 'me' | 'them'): string => inputs[side].state === 'unavailable' ? 'off' : inputs[side].state === 'connecting' ? 'starting' : inputs[side].state === 'paused' ? 'paused' : 'on'
  return (
    <section className="live-call" aria-label="Call being written down">
      <BackToMeetings onClick={onBack} />
      <header className="live-head">
        <h2>{title || `Call on ${new Date(since || Date.now()).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`}</h2>
        <span className="live-clock" role="timer" aria-label="Time into the call">Live · <Elapsed since={since} /></span>
        <span className="spacer" />
        {/* The two stay together: on a narrow window they go under the call's name, at the right. */}
        <span className="live-actions">
          <button onClick={onMark} title="Mark this moment. The notes list marked moments first.">Mark</button>
          <button className="primary" onClick={onStop} title="Stop writing the call down">Stop</button>
        </span>
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
      <MeetingPeople callId={callKey} transcript={transcript} showYou />
      {callKey && <CallAgentsRow call={callKey} live />}
      <div className={`live-lines${!transcript.length && !partials.length ? ' waiting' : ''}`} ref={lines} onScroll={(event) => { const box = event.currentTarget; atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 40 }}>
        {!transcript.length && !partials.length && <p className="hint">Listening… The words appear as people speak.</p>}
        {transcript.map((line, index) => <LiveLine key={line.id} line={line} since={since} marked={marked.has(line.id)} continues={joins[index]} />)}
        {partials.map((partial, index) => (
          <div key={partial.segmentId} className={`live-line call-turn partial ${partial.speaker}${joins[transcript.length + index] ? ' continues' : ''}`} style={colorOf(partial)} data-initial={initialOf(speakerLabel({ speaker: partial.speaker, voiceId: partial.voiceId, voiceName: partial.voiceName, voiceNamedBy: partial.voiceNamedBy }))}>
            <span className="who">{speakerLabel({ speaker: partial.speaker, voiceId: partial.voiceId, voiceName: partial.voiceName, voiceNamedBy: partial.voiceNamedBy })}</span>
            <time dateTime={new Date(partial.at).toISOString()} title={clock.format(partial.at)}>{intoCall(partial.at - since)}</time>
            <p>{partial.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * One line said: drawn when it comes, and again only when it changes (a name given, a mark, a voice that goes on), so a long call's new
 * words and live captions don't redraw every line before them.
 */
const LiveLine = memo(function LiveLine({ line, since, marked, continues }: { line: TranscriptEntry; since: number; marked: boolean; continues: boolean }) {
  return (
    <div className={`live-line call-turn ${line.speaker}${continues ? ' continues' : ''}${marked ? ' marked' : ''}`} style={colorOf(line)} data-initial={initialOf(speakerLabel(line))}>
      {/* A long name is shortened in its column: all of it is on the pointer, and on the chips over the lines. */}
      <span className="who" title={speakerLabel(line)}>{speakerLabel(line)}</span>
      <time dateTime={new Date(line.at).toISOString()} title={clock.format(line.at)}>{intoCall(line.at - since)}</time>
      <p>{line.text}{marked && <span className="marked-tag">Marked</span>}</p>
    </div>
  )
})

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
      {/* Four bars, as the design draws them: lit up to how loud it is. */}
      <span className="bars" aria-hidden="true">{[4, 8, 10, 10].map((height, index) => <i key={index} className={index < lit ? 'on' : ''} style={{ height }} />)}</span>
    </span>
  )
}
