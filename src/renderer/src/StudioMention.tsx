import { useState } from 'react'
import { isMicrophoneOn, microphoneNeedsSignIn, type NoiseReport, type TogleMicrophoneStatus } from '@shared/microphone'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** What the microphone picked up during a call, measured on this computer while nobody spoke: levels only. */
export interface NoiseFinding { report: NoiseReport }

/**
 * Togle Studio, mentioned where the need shows up: after a call in a loud room, on that call's page, one line with one
 * link. Never during a call, never a pop-up; "Mention Togle Studio" in Settings turns it off (main decides it is time).
 */
export function NoisyMicrophone({ finding, minutes, microphone }: { finding: NoiseFinding; minutes: number; microphone?: TogleMicrophoneStatus }) {
  const [error, setError] = useState('')
  const noisy = Math.max(1, Math.round(finding.report.noisyMs / 60_000))
  const of = Math.max(noisy, Math.round(minutes), Math.round(finding.report.analyzedMs / 60_000))
  if (isMicrophoneOn(microphone)) return null
  // The one link does what Togle Studio needs next: get it, sign in to it, or turn it on.
  const clean = (): Promise<unknown> => !microphone?.installed ? api.openMicrophonePage('after-call') : microphoneNeedsSignIn(microphone) ? api.showMicrophone() : api.turnOnMicrophone()
  return (
    <div className="studio-mention" role="status">
      <span>Your microphone picked up room noise for {noisy} of {of} minutes.</span>
      <button className="small" onClick={() => { setError(''); void clean().catch((failure) => setError(errorText(failure))) }}>Clean my microphone</button>
      {error && <span className="error">{error}</span>}
    </div>
  )
}
