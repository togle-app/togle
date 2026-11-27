import { useState } from 'react'
import { isMicrophoneOn, type NoiseReport, type TogleMicrophoneStatus } from '@shared/microphone'

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
  const ready = microphone?.running && microphone.state?.account === 'signed-in' && microphone.state.phase === 'off' && microphone.state.setup === 'ready'
  const label = !microphone?.installed ? 'See Studio' : ready ? 'Turn on noise cancellation' : 'Open Studio'
  const clean = (): Promise<unknown> => !microphone?.installed ? api.openMicrophonePage('after-call') : ready ? api.turnOnMicrophone() : api.showMicrophone()
  return (
    <div className="studio-mention" role="status">
      <span>Your microphone picked up room noise for {noisy} of {of} minutes.</span>
      <button className="small" onClick={() => { setError(''); void clean().catch((failure) => setError(errorText(failure))) }}>{label}</button>
      {error && <span className="error">{error}</span>}
    </div>
  )
}
