import { useEffect, useState } from 'react'
import type { CallStripState } from '@shared/call-strip'

const api = window.togle

/** The time into a call: "3:07", "1:05:20". */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), seconds = total % 60
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** The strip at the top of the screen during a call, with Togle's window closed: the clock, Mark, Stop, tell the others. */
export function CallStripSurface() {
  const [state, setState] = useState<CallStripState | null>(null)
  const [now, setNow] = useState(Date.now())
  // The line to tell the others was copied: the button then says they were told.
  const [copied, setCopied] = useState(false)
  useEffect(() => api.onCallStrip((next) => setState(next)), [])
  // Another call starts with the line not copied yet.
  useEffect(() => setCopied(false), [state?.since])
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  if (!state) return null
  return (
    <div className="call-strip-bar" role="group" aria-label="Call being written down">
      <span className="call-strip-live" aria-hidden="true" />
      <span className="call-strip-clock" aria-label="Time into the call">{clockText(now - state.since)}</span>
      <button onClick={() => api.callStripAction('mark')} title="Mark this moment">Mark{state.marks > 0 ? ` ${state.marks}` : ''}</button>
      <button className="stop" onClick={() => api.callStripAction('stop')} title="End the call">Stop</button>
      {!state.told && (copied
        ? <button className="primary" onClick={() => api.callStripAction('told')} title="Click when you have told the others the call is written down">I told them</button>
        : <button onClick={() => { api.callStripAction('copy'); setCopied(true) }} title="Copies the line to say or paste in the chat">Tell the others</button>)}
    </div>
  )
}
