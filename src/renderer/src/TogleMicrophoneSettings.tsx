import { useEffect, useRef, useState } from 'react'
import type { SettingsPatch } from '@shared/api'
import type { Settings } from '@shared/types'
import { describeNoise, isMicrophoneOn, microphoneNeedsSignIn, type TogleMicrophoneStatus } from '@shared/microphone'
import { checkMicrophone } from './audio/capture'
import { PlaySample, type NoiseFinding } from './MicrophoneSuggestion'
import { Row, Section, Toggle } from './Rows'

const api = window.togle

/** How Togle Microphone is doing, in a few words. */
export function microphoneSummary(status: TogleMicrophoneStatus | undefined): string {
  if (!status?.installed) return 'Not installed'
  if (!status.running || !status.state) return 'Installed · not running'
  const state = status.state
  if (state.account === 'signed-out') return 'Signed out · sign in to use it'
  if (state.setup === 'restart') return 'Restart your computer to finish installing it'
  if (state.setup === 'missing') return 'Its audio driver is missing: open it to repair'
  if (state.phase === 'on') return `On${state.input ? ` · cleaning ${state.input}` : ''}${status.forCall ? ' · for this call' : ''}`
  if (state.phase === 'starting') return 'Starting…'
  if (state.phase === 'error') return `Stopped${state.error ? `: ${state.error}` : ''}`
  return 'Off'
}

type Check = { phase: 'quiet' | 'speak' } | { phase: 'done'; finding: NoiseFinding } | { phase: 'failed'; error: string }

const VERDICT: Record<string, string> = {
  noisy: 'Noisy.',
  some: 'Some background noise.',
  quiet: 'Quiet.',
  unknown: 'Couldn’t measure it: stay quiet when asked, then speak.'
}

/**
 * Settings → Togle Microphone: the separate app that cleans the microphone for every call app. Its status when it's on
 * this computer, turning it on for calls, the suggestions after noisy calls, and a microphone check that measures (and
 * plays back) what the microphone picks up.
 */
export function TogleMicrophoneSettings({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<void> }) {
  const [status, setStatus] = useState<TogleMicrophoneStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [check, setCheck] = useState<Check>()
  const stopCheck = useRef<AbortController | null>(null)
  useEffect(() => {
    void api.microphoneStatus().then(setStatus, () => undefined)
    const off = api.onMicrophone(setStatus)
    return () => { off(); stopCheck.current?.abort() }
  }, [])
  const act = (action: () => Promise<unknown>): void => {
    setBusy(true); setError('')
    void action().catch(err => setError((err as Error).message)).finally(() => setBusy(false))
  }
  const runCheck = (): void => {
    stopCheck.current?.abort()
    const controller = new AbortController()
    stopCheck.current = controller
    setCheck({ phase: 'quiet' })
    void checkMicrophone(phase => setCheck({ phase }), controller.signal).then(
      ({ quietSample, ...report }) => { if (!controller.signal.aborted) setCheck({ phase: 'done', finding: { report, sample: quietSample } }) },
      err => { if (!controller.signal.aborted) setCheck({ phase: 'failed', error: (err as Error).message }) }
    )
  }
  const on = isMicrophoneOn(status)
  const signIn = microphoneNeedsSignIn(status)
  const microphone = settings.microphone
  return (
    <Section id="settings-microphone" title="Togle Microphone"
      note={<>A separate app that removes background noise from your voice in every call app, on your computer. Togle finds it by itself. <button className="link" onClick={() => void api.openMicrophonePage('settings')}>Learn more</button></>}>
      <Row name="Status" note={status?.running && status.state?.phase === 'on' ? 'Calls on your default microphone get the clean sound. An app set to a specific microphone needs “Togle Microphone” chosen in it.' : undefined} label={false}>
        <span className="microphone-status" data-on={on || undefined}>{microphoneSummary(status)}</span>
        {!status?.installed && <button className="primary small" onClick={() => void api.openMicrophonePage('settings')}>Get Togle Microphone</button>}
        {status?.running && status.state && (on
          ? <button className="ghost small" disabled={busy} onClick={() => act(() => api.turnOffMicrophone())}>Turn off</button>
          : signIn
            ? <button className="primary small" disabled={busy} onClick={() => act(() => api.showMicrophone())}>Sign in</button>
            : <button className="ghost small" disabled={busy || status.state.setup === 'missing' || status.state.setup === 'restart'} onClick={() => act(() => api.turnOnMicrophone())}>Turn on</button>)}
        {status?.installed && !signIn && <button className="link" disabled={busy} onClick={() => act(() => api.showMicrophone())}>Open</button>}
      </Row>
      {error && <p className="error" role="alert">{error}</p>}
      <Toggle name="Turn on during calls" note="When a call starts, Togle turns Togle Microphone on, and off again when the call ends." checked={microphone.autoStart} disabled={!status?.installed} onChange={autoStart => void save({ microphone: { autoStart } })} />
      <Toggle name="Show what my microphone picks up" note="After a noisy call, Togle shows what your microphone picked up while nobody spoke, and a link to Togle Microphone. It measures levels only; nothing is saved or sent." checked={microphone.suggestions} onChange={suggestions => void save({ microphone: { suggestions, ...(suggestions ? { dismissals: 0 } : {}) } })} />
      <Row name="Check my microphone" note={check?.phase === 'quiet' ? 'Stay quiet for a few seconds…' : check?.phase === 'speak' ? 'Now say a sentence, as you would in a call…' : 'Measures your background, then your voice. About ten seconds.'} label={false}>
        {check?.phase === 'quiet' || check?.phase === 'speak'
          ? <button className="ghost small" onClick={() => { stopCheck.current?.abort(); setCheck(undefined) }}>Cancel</button>
          : <button className="ghost small" onClick={runCheck}>{check ? 'Check again' : 'Check'}</button>}
      </Row>
      {check?.phase === 'failed' && <p className="error" role="alert">{check.error}</p>}
      {check?.phase === 'done' && (
        <div className="microphone-check" role="status">
          <p><strong>{VERDICT[check.finding.report.verdict]}</strong> {check.finding.report.verdict !== 'unknown' && describeNoise(check.finding.report)}</p>
          <div className="row">
            <PlaySample finding={check.finding} />
            {!on && (check.finding.report.verdict === 'noisy' || check.finding.report.verdict === 'some') && (status?.installed
              ? signIn
                ? <button className="primary small" onClick={() => act(() => api.showMicrophone())}>Sign in to Togle Microphone</button>
                : <button className="primary small" onClick={() => act(() => api.turnOnMicrophone())}>Turn on Togle Microphone</button>
              : <button className="primary small" onClick={() => void api.openMicrophonePage('microphone-check')}>Get Togle Microphone</button>)}
          </div>
        </div>
      )}
    </Section>
  )
}
