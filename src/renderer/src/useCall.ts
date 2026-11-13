import { useCallback, useEffect, useRef, useState } from 'react'
import type { CurrentCall, Settings, TranscriptEntry } from '@shared/types'
import { isMicrophoneOn } from '@shared/microphone'
import { CallCapture, warmUpAudio, type CaptureInputs } from './audio/capture'
import type { NoiseFinding } from './StudioMention'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export interface CallView {
  listening: boolean
  starting: boolean
  /** When the call began (epoch ms), 0 when there is none. */
  since: number
  transcript: TranscriptEntry[]
  /** Whether the person told the others (when: 0 is not yet), and the moments they marked. */
  flags: { toldOthers: number; marks: number[] }
  inputs: CaptureInputs
  /** How loud each side is now (read when asked, so it never redraws the call). */
  levels(): Partial<Record<'me' | 'them', number>>
  /** The call's id: its saved record in Meetings. */
  callKey: string
  /** What the call is, when a calendar or a brief named it. */
  title: string
  /** After a call: what the microphone picked up, when the room was loud. */
  noise: NoiseFinding | null
  warning: string
  start(): Promise<void>
  stop(): Promise<void>
  toggle(): Promise<void>
  reconnect(): Promise<void>
  clearNoise(): void
  clearWarning(): void
}

/**
 * Writing a call down: the microphone is you, the computer's sound is the call. A new call each time, heard on this
 * computer; nothing is asked of the AI while it goes on.
 */
export function useCall(settings: Settings | null): CallView {
  const capture = useRef<CallCapture | null>(null)
  const busy = useRef(false)
  const settingsNow = useRef(settings)
  settingsNow.current = settings
  const [listening, setListening] = useState(false)
  const [starting, setStarting] = useState(false)
  const [since, setSince] = useState(0)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [flags, setFlags] = useState<{ toldOthers: number; marks: number[] }>({ toldOthers: 0, marks: [] })
  const [inputs, setInputs] = useState<CaptureInputs>({ me: { state: 'off' }, them: { state: 'off' } })
  const [callKey, setCallKey] = useState('')
  const [title, setTitle] = useState('')
  const [noise, setNoise] = useState<NoiseFinding | null>(null)
  const [warning, setWarning] = useState('')

  const load = useCallback((call: CurrentCall | void) => {
    if (!call) return
    setTranscript(call.transcript)
    setFlags({ toldOthers: call.toldOthers ?? 0, marks: call.marks ?? [] })
    setCallKey(call.key || call.session?.id || '')
    setTitle(call.session?.meeting?.title || '')
    setSince(call.session?.status === 'live' ? call.session.startedAt : 0)
  }, [])

  useEffect(() => {
    void api.currentCall().then(load, () => undefined)
    // Opening the audio engine once makes the first call start sooner; once the window is idle, not before it is drawn.
    const warm = requestIdleCallback(() => { if (!capture.current) warmUpAudio().catch(() => undefined) }, { timeout: 3000 })
    const subs = [
      api.onCallReset((call) => load(call)),
      api.onCallFlags(setFlags),
      // In time order: a line that ends after a later one began comes in later, and goes before it.
      api.onTranscript((entry) => setTranscript((previous) => (!previous.length || previous[previous.length - 1].at <= entry.at ? [...previous, entry] : [...previous, entry].sort((a, b) => a.at - b.at)))),
      api.onTranscriptRemoved((ids) => setTranscript((previous) => previous.filter((entry) => !ids.includes(entry.id)))),
      api.onTranscriptUpdated((entries) => setTranscript((previous) => {
        const byId = new Map(entries.map((entry) => [entry.id, entry]))
        return previous.map((entry) => byId.get(entry.id) ?? entry)
      }))
    ]
    return () => {
      cancelIdleCallback(warm)
      for (const stop of subs) stop()
    }
  }, [load])

  const start = useCallback(async () => {
    if (busy.current || capture.current) return
    busy.current = true
    setStarting(true)
    setWarning('')
    try {
      // A new call: the one before stays in Meetings.
      load(await api.clearTranscript())
      const session = new CallCapture()
      session.onState = setInputs
      session.onNotice = setWarning
      setNoise(null)
      try {
        for (const speaker of ['me', 'them'] as const) await api.pauseCallInput(speaker, false)
        // Togle Studio first, when it is installed and set to: the call then hears the clean microphone.
        const studio = await api.prepareCallMicrophone().catch(() => undefined)
        const measureNoise = settingsNow.current?.microphone?.suggestions !== false && !isMicrophoneOn(studio)
        await session.start((speaker, pcm, startedAt, segmentId, kind) => api.pushAudio(speaker, pcm, startedAt, segmentId, kind), [], { measureNoise })
        const info = await api.setListening(true)
        capture.current = session
        setListening(true)
        setSince(info?.startedAt ?? Date.now())
        if (info?.id) setCallKey(info.id)
      } catch (error) {
        session.stop()
        capture.current = null
        setListening(false)
        await api.setListening(false).catch(() => undefined)
        setWarning(errorText(error))
      }
    } catch (error) {
      setWarning(`Could not start writing the call down: ${errorText(error)}`)
    } finally {
      busy.current = false
      setStarting(false)
    }
  }, [load])

  const stop = useCallback(async () => {
    const session = capture.current
    if (!session || busy.current) return
    busy.current = true
    try {
      session.stop()
      const report = session.takeNoiseReport()
      capture.current = null
      // A loud room: what the microphone picked up, offered once the call is over (main decides whether it is time).
      if (report && report.verdict === 'noisy') {
        const { sample: _sample, ...measured } = report
        void api.noiseMeasured(measured).then((show) => { if (show) setNoise({ report: measured }) }, () => undefined)
      }
      setListening(false)
      setSince(0)
      await api.setListening(false).catch((error) => setWarning(errorText(error)))
    } finally {
      busy.current = false
    }
  }, [])

  const toggle = useCallback(() => (capture.current ? stop() : start()), [start, stop])
  const levels = useCallback(() => capture.current?.levels ?? {}, [])
  // A microphone or call sound that could not be opened is tried again, and the call goes on.
  const reconnect = useCallback(async () => { setWarning(''); await capture.current?.retryMissing() }, [])

  return {
    listening, starting, since, transcript, flags, inputs, callKey, title, noise, warning,
    levels, start, stop, toggle, reconnect,
    clearNoise: () => setNoise(null),
    clearWarning: () => setWarning('')
  }
}
