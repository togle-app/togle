import { useEffect, useState } from 'react'
import { describeNoise, microphoneNeedsSignIn, type NoiseReport, type TogleMicrophoneStatus } from '@shared/microphone'
import { playNoiseSample, stopNoiseSample } from './audio/playback'
import { Icon } from './Icon'

const api = window.togle

export interface NoiseFinding { report: NoiseReport; sample?: Float32Array }

/** Plays what the microphone picked up, and stops it again. */
export function PlaySample({ finding }: { finding: NoiseFinding }) {
  const [playing, setPlaying] = useState(false)
  useEffect(() => () => stopNoiseSample(), [])
  if (!finding.sample) return null
  return (
    <button className="ghost small" onClick={() => {
      if (playing) { stopNoiseSample(); return }
      setPlaying(true)
      playNoiseSample(finding.sample!, finding.report.speechDb, () => setPlaying(false))
    }}>
      <Icon name={playing ? 'stop' : 'play'} size={12} />{playing ? 'Stop' : 'Play what it picked up'}
    </button>
  )
}

/**
 * After a noisy call: what the microphone picked up while nobody spoke, and Togle Microphone, which removes it. Shown
 * only when the measurement says the background was loud enough to hear, at most every few days, never during a call.
 */
export function MicrophoneSuggestion({ finding, microphone, dismissals, onClose }: { finding: NoiseFinding; microphone?: TogleMicrophoneStatus; dismissals: number; onClose: () => void }) {
  const [error, setError] = useState('')
  const installed = !!microphone?.installed
  const signIn = microphoneNeedsSignIn(microphone)
  const close = (patch?: { suggestions?: boolean; dismissals?: number }): void => {
    stopNoiseSample()
    if (patch) void api.updateSettings({ microphone: patch }).catch(() => undefined)
    onClose()
  }
  return (
    <div className="notice microphone-suggestion" role="status" aria-label="Background noise on your microphone">
      <Icon name="mic" size={16} />
      <div className="microphone-suggestion-body">
        <strong>Your microphone picked up background noise in this call</strong>
        <p>{describeNoise(finding.report)}</p>
        <p className="hint">
          {signIn
            ? 'Togle Microphone is installed, but you’re signed out of it. Signed in, it removes noise like this on your computer, before any call app hears it.'
            : installed
            ? 'Togle Microphone is installed but was off. It removes noise like this on your computer, before any call app hears it.'
            : 'Togle Microphone removes noise like this on your computer, before Zoom, Meet, Teams or any other call app hears it.'}
        </p>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <PlaySample finding={finding} />
          {signIn
            ? <button className="primary small" onClick={() => void api.showMicrophone().then(() => close(), err => setError((err as Error).message))}>Sign in to Togle Microphone</button>
            : installed
            ? <button className="primary small" onClick={() => void api.turnOnMicrophone().then(() => close(), err => setError((err as Error).message))}>Turn on Togle Microphone</button>
            : <button className="primary small" onClick={() => { void api.openMicrophonePage('after-call'); close() }}>Get Togle Microphone</button>}
          <button className="ghost small" onClick={() => close({ dismissals: dismissals + 1 })}>Not now</button>
          <span className="spacer" />
          <button className="link" onClick={() => close({ suggestions: false })}>Don’t show this again</button>
        </div>
      </div>
    </div>
  )
}
