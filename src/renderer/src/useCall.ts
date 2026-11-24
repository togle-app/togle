import { useCallback, useEffect, useRef, useState } from 'react'
import type { CurrentCall, Settings, TranscriptEntry } from '@shared/types'
import { callAppName, type MeetingCaptureState } from '@shared/call-apps'
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
  speaking(): boolean
  manualMic: boolean
  toggleMic(): void
  /** The call's id: its saved record in Meetings. */
  callKey: string
  /** What the call is, when a calendar or a brief named it. */
  title: string
  /** After a call: what the microphone picked up, when the room was loud. */
  noise: NoiseFinding | null
  warning: string
  start(meeting?: string | false): Promise<void>
  stop(): Promise<void>
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
  const stopAfterStart = useRef(false)
  const stopCurrent = useRef<() => Promise<void>>(async () => {})
  const followed = useRef<MeetingCaptureState | null>(null)
  const latestMeeting = useRef<MeetingCaptureState | null>(null)
  const [meetingState, setMeetingState] = useState<MeetingCaptureState | null>(null)
  const manualMicPaused = useRef(false)
  const pendingMeeting = useRef<string | null>(null)
  const startCurrent = useRef<(meeting: string) => Promise<void>>(async () => {})
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

  const start = useCallback(async (meeting?: string | false) => {
    if (busy.current || capture.current) {
      if (busy.current && typeof meeting === 'string' && (!capture.current || followed.current?.ended)) pendingMeeting.current = meeting
      return
    }
    busy.current = true
    stopAfterStart.current = false
    setStarting(true)
    setWarning('')
    try {
      const bound = await api.followMeeting(meeting)
      const recent = latestMeeting.current
      followed.current = bound && recent?.id === bound.id && recent.revision > bound.revision ? recent : bound ?? followed.current
      setMeetingState(followed.current)
      manualMicPaused.current = !bound && meeting === false
      if (followed.current?.ended) { await api.followMeeting(false); return }
      // A new call: the one before stays in Meetings.
      load(await api.clearTranscript())
      const session = new CallCapture()
      capture.current = session
      session.onState = setInputs
      session.onNotice = setWarning
      setNoise(null)
      try {
        await Promise.all([api.pauseCallInput('them', false), api.pauseCallInput('me', manualMicPaused.current || !!followed.current && followed.current.mic !== 'open')])
        // Togle Studio first, when it is installed and set to: the call then hears the clean microphone.
        const studio = await api.prepareCallMicrophone().catch(() => undefined)
        const measureNoise = settingsNow.current?.microphone?.suggestions !== false && !isMicrophoneOn(studio)
        if (stopAfterStart.current || followed.current?.ended) throw new Error('The meeting has ended.')
        const paused = manualMicPaused.current || !!followed.current && followed.current.mic !== 'open'
        await session.start((speaker, pcm, startedAt, segmentId, kind) => api.pushAudio(speaker, pcm, startedAt, segmentId, kind), paused ? ['me'] : [], { measureNoise })
        if (stopAfterStart.current || followed.current?.ended) throw new Error('The meeting has ended.')
        const info = await api.setListening(true)
        api.setToldOthers(true)
        capture.current = session
        setListening(true)
        setSince(info?.startedAt ?? Date.now())
        if (info?.id) setCallKey(info.id)
      } catch (error) {
        session.stop()
        capture.current = null
        setListening(false)
        await api.setListening(false).catch(() => undefined)
        if (!stopAfterStart.current) setWarning(errorText(error))
      }
    } catch (error) {
      if (!capture.current) await api.followMeeting(false).catch(() => undefined)
      setWarning(`Could not start writing the call down: ${errorText(error)}`)
    } finally {
      busy.current = false
      setStarting(false)
      if (stopAfterStart.current && capture.current) void stopCurrent.current()
      if (!capture.current) {
        followed.current = null
        setMeetingState(null)
        const next = pendingMeeting.current
        pendingMeeting.current = null
        if (next) void startCurrent.current(next)
      }
    }
  }, [load])
  startCurrent.current = start

  const stop = useCallback(async () => {
    const session = capture.current
    if (busy.current) { stopAfterStart.current = true; return }
    if (!session) return
    busy.current = true
    try {
      session.stop()
      const report = session.takeNoiseReport()
      capture.current = null
      followed.current = null
      setMeetingState(null)
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
      const next = pendingMeeting.current
      pendingMeeting.current = null
      if (next) void startCurrent.current(next)
    }
  }, [])
  stopCurrent.current = stop
  useEffect(() => api.onMeetingCapture(state => {
    latestMeeting.current = state
    if (followed.current ? followed.current.id !== state.id || state.revision <= followed.current.revision : !capture.current && !busy.current) return
    followed.current = state
    setMeetingState(state)
    void capture.current?.setPaused('me', state.mic !== 'open' || state.ended).catch(error => setWarning(errorText(error)))
    if (state.ended) void stopCurrent.current()
  }), [])

  const levels = useCallback(() => capture.current?.levels ?? {}, [])
  const speaking = useCallback(() => capture.current?.speaking ?? false, [])
  const toggleMic = useCallback(() => {
    const session = capture.current
    if (!session || followed.current || busy.current) return
    const paused = !manualMicPaused.current
    manualMicPaused.current = paused
    void api.pauseCallInput('me', paused, true).then(meeting => {
      if (session !== capture.current) return
      if (meeting && (!followed.current || meeting.revision >= followed.current.revision)) {
        followed.current = meeting
        setMeetingState(meeting)
      }
      const state = followed.current
      return session.setPaused('me', state ? state.ended || state.mic !== 'open' : manualMicPaused.current)
    }).catch(error => setWarning(errorText(error)))
  }, [])
  // A microphone or call sound that could not be opened is tried again, and the call goes on.
  const reconnect = useCallback(async () => { setWarning(''); await capture.current?.retryMissing() }, [])

  return {
    listening, starting, since, transcript, flags,
    inputs: meetingState && meetingState.mic !== 'open' ? { ...inputs, me: { state: 'paused', detail: meetingState.mic === 'muted' ? (meetingState.app === 'other' ? 'Muted in call' : 'Muted in ' + callAppName(meetingState.app)) : 'Mic paused · call controls unavailable' } } : inputs,
    callKey, title, noise, warning,
    levels, speaking, manualMic: !meetingState, toggleMic, start, stop, reconnect,
    clearNoise: () => setNoise(null),
    clearWarning: () => setWarning('')
  }
}
