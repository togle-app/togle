import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { Frame, PartialTranscript, Speaker, TranscriptEntry } from '@shared/types'
import type { CallCapture, CaptureInputs } from './audio/capture'
import type { TogleMicrophoneStatus } from '@shared/microphone'
import { Icon } from './Icon'
import { openSettings } from './open-settings'
import { Timeline } from './Timeline'

const api = window.togle

// How long Copy says "Copied".
const COPIED_MS = 1500

const METERS: { speaker: Speaker; label: string; title: string }[] = [
  { speaker: 'me', label: 'Mic', title: 'Microphone' },
  { speaker: 'them', label: 'Call audio', title: 'Call audio' }
]

/**
 * Input levels, two thin lines: it hears you, and the call. Paints them itself, so the whole window doesn't re-render
 * 10 times a second.
 */
function Meters({ capture, listening, inputs, onPause }: { capture: RefObject<CallCapture | null>; listening: boolean; inputs: CaptureInputs; onPause: (speaker: Speaker) => void }) {
  const meters = useRef<Partial<Record<Speaker, HTMLButtonElement | null>>>({})
  useEffect(() => {
    const paint = (): void => {
      const levels = capture.current?.levels ?? {}
      for (const { speaker } of METERS) {
        const meter = meters.current[speaker]
        const bar = meter?.querySelector<HTMLElement>('.bar > span')
        if (!meter || !bar) continue
        const level = levels[speaker]
        meter.classList.toggle('off', level === undefined)
        bar.style.transform = `scaleX(${level === undefined ? 0 : Math.max(0.08, Math.min(1, Math.sqrt(level) * 2.6)).toFixed(3)})`
      }
    }
    paint()
    if (!listening) return
    const timer = setInterval(paint, 100)
    return () => clearInterval(timer)
  }, [capture, listening])
  return (
    <div className="meters" aria-label="Audio inputs">
      {METERS.map(({ speaker, label, title }) => (
        <button type="button"
          key={speaker}
          ref={(el) => {
            meters.current[speaker] = el
          }}
          className={`meter off ${speaker}`}
          data-state={inputs[speaker].state}
          aria-label={`${title}: ${inputs[speaker].state}`}
          aria-pressed={inputs[speaker].state === 'paused'}
          onClick={() => onPause(speaker)}
          title={`${inputs[speaker].state === 'paused' ? 'Resume' : 'Pause'} Togle’s ${title.toLowerCase()} listening`}
        >
          <span>{inputs[speaker].state === 'paused' ? speaker === 'me' ? 'Mic off' : 'Call off' : label}</span>
          <span className="bar"><span /></span>
        </button>
      ))}
    </div>
  )
}

/**
 * Togle Microphone during the call, when it's on this computer: on, or off with a way to turn it on. Nothing when it
 * isn't installed: the call isn't the place to suggest it.
 */
function CleanMicrophone({ status }: { status?: TogleMicrophoneStatus }) {
  const [busy, setBusy] = useState(false)
  if (!status?.installed) return null
  const state = status.running ? status.state : undefined
  if (state?.phase === 'on' || state?.phase === 'starting') {
    return <span className="clean-mic-chip on" title={`Togle Microphone is cleaning ${state.input ?? 'your microphone'} for every call app`}><span className="dot" />{state.phase === 'on' ? 'Clean mic' : 'Clean mic…'}</span>
  }
  if (state?.account === 'signed-out') {
    return (
      <button className="link clean-mic-chip" disabled={busy} title="You’re signed out of Togle Microphone: your microphone goes to the call as it is"
        onClick={() => { setBusy(true); void api.showMicrophone().catch(() => undefined).finally(() => setBusy(false)) }}>
        Clean mic · Sign in
      </button>
    )
  }
  const problem = state?.phase === 'error' ? state.error || 'Togle Microphone stopped.' : undefined
  return (
    <button className="link clean-mic-chip" disabled={busy} title={problem ?? 'Togle Microphone is off: your microphone goes to the call as it is'}
      onClick={() => { setBusy(true); void api.turnOnMicrophone().catch(() => api.showMicrophone()).catch(() => undefined).finally(() => setBusy(false)) }}>
      {problem ? 'Clean mic stopped · Fix' : 'Clean mic off · Turn on'}
    </button>
  )
}

interface Props {
  /** Togle Microphone, when it's on this computer. */
  microphone?: TogleMicrophoneStatus
  listening: boolean
  capture: RefObject<CallCapture | null>
  inputs: CaptureInputs
  onRetryAudio: () => void
  onPauseInput: (speaker: Speaker) => void
  transcript: TranscriptEntry[]
  frames: Frame[]
  /** What was said and shown, unfolded above it. */
  open: boolean
  onOpen: (open: boolean) => void
  /** During the call: what to ask for, the screen, recording, the plan. After it, the strip only shows what was said. */
  tools?: ReactNode
  /** Why nothing of the call can be heard (no speech recognition): said, with a way to set it up, instead of Listening. */
  deaf?: string
}

/**
 * The call as it goes, under the conversation: the levels, its latest words (what was said and shown, unfolded on a
 * click), and what to ask for. Live captions are its own: as they come in, only the strip is drawn again.
 */
export function CallStrip({ microphone, listening, capture, inputs, onRetryAudio, onPauseInput, transcript, frames, open, onOpen, tools, deaf }: Props) {
  const [partials, setPartials] = useState<PartialTranscript[]>([])
  const finished = useRef(new Set<string>())
  useEffect(() => {
    if (!listening) setPartials([])
    const subs = [
      api.onPartialTranscript((partial) => {
        if (!listening || finished.current.has(partial.segmentId)) return
        setPartials((prev) => {
          const rest = prev.filter((p) => p.segmentId !== partial.segmentId)
          return partial.text ? [...rest, partial].sort((a, b) => a.at - b.at) : rest
        })
      }),
      // The final line replaces its live caption.
      api.onTranscript((entry) => {
        if (entry.segmentId) {
          finished.current.add(entry.segmentId)
          setPartials((prev) => prev.filter((p) => p.segmentId !== entry.segmentId))
        }
      })
    ]
    return () => subs.forEach((unsub) => unsub())
  }, [listening])
  // The call's latest words, and whose: a caption still being spoken, or its last line.
  const partial = partials.at(-1)
  const final = transcript.at(-1)
  const latest = partial && (!final || partial.at >= final.at) ? partial : final
  const caption = latest?.text
  // What was said, copied as lines ("Them: …"), for notes or an email after the call.
  const [copied, setCopied] = useState(false)
  const copyAll = (): void =>
    void navigator.clipboard.writeText(transcript.map((e) => `${e.speaker === 'me' ? 'Me' : 'Them'}: ${e.text}`).join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), COPIED_MS)
    }, () => undefined)
  const timeline = open && (
    <div className="timeline-panel">
      <Timeline transcript={transcript} partials={partials} frames={frames} empty={listening ? 'Listening…' : 'Nothing was said.'} />
    </div>
  )
  if (!tools) {
    return (
      <section className="call-strip">
        <div className="strip-row">
          <span className="strip-title">Transcript</span>
          <span className="spacer" />
          {transcript.length > 0 && (
            <button className="link" title="Copy what was said, a line each" onClick={copyAll}>
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          <button className="link" onClick={() => onOpen(false)}>
            Close transcript
          </button>
        </div>
        {timeline}
      </section>
    )
  }
  return (
    <section className="call-strip">
      {timeline}
      <div className="strip-row audio-row">
          <span className="strip-title">Transcript</span>
          <span className="spacer" />
          {listening && <CleanMicrophone status={microphone} />}
          {listening && <Meters capture={capture} listening={listening} inputs={inputs} onPause={onPauseInput} />}
          {(inputs.me.state === 'connecting' || inputs.them.state === 'connecting') ? (
            <span className="audio-status" role="status">Reconnecting audio…</span>
          ) : (inputs.me.state === 'unavailable' || inputs.them.state === 'unavailable') ? (
            <button className="link reconnect-audio" onClick={onRetryAudio}>Reconnect audio</button>
          ) : null}
        </div>
      {listening && (inputs.me.state === 'unavailable' || inputs.them.state === 'unavailable') && (
        <p className="audio-help" role="status" title={inputs.them.detail ?? inputs.me.detail}>
          {inputs.them.state === 'unavailable' ? "Call audio is disconnected. Togle can't hear the other side." : "Your microphone is disconnected. Togle can still hear the call."}
        </p>
      )}
      <div className="strip-row">
        {deaf && listening && !caption ? (
          <p className="strip-deaf">
            {deaf}{' '}
            <button className="link" onClick={() => openSettings('speech')}>
              Set it up
            </button>
          </p>
        ) : (
        <button
          className="caption"
          aria-label={open ? 'Hide transcript' : 'Show transcript'}
          title={open ? 'Hide what was said and shown' : 'Show what was said and shown'}
          aria-expanded={open}
          onClick={() => onOpen(!open)}
        >
          <Icon name="chevron" size={12} />
          {/* Open, the panel above has the latest words: the caption says how to fold it. */}
          {open ? (
            <span>Hide transcript</span>
          ) : caption ? (
            // The newest words of a long sentence stay in sight: cut at its start, not its end.
            <span className="said-line">
              <span className="who">{latest && 'voiceName' in latest && latest.voiceName ? `${latest.voiceName}${latest.voiceNamedBy === 'suggested' ? '?' : ''}` : latest?.speaker === 'me' ? 'You' : latest && 'voiceId' in latest && latest.voiceId ? `Speaker ${latest.voiceId.split(':').at(-1)}` : 'Them'}</span>
              <span className="said">
                <bdi>{caption}</bdi>
              </span>
            </span>
          ) : (
            <span>{listening ? 'Listening…' : 'Nothing said yet'}</span>
          )}
        </button>
        )}
      </div>
      {tools}
    </section>
  )
}
