import type { ScreenMonitorStatus } from '@shared/types'
import { screenClock, screenRange } from '@shared/screen-time'

/** Requested speech time and actual sample time remain separate, including a failed historical lookup. */
export function ScreenTiming({ status }: { status: ScreenMonitorStatus }) {
  const { lastLook: look, lastReference: reference } = status
  if (!look && !reference) return null
  return <details className="screen-timing">
    <summary>{look ? `${look.unavailable ? 'Missing screen context' : 'Screen context'}: ${screenRange(look.requested.from, look.requested.to)}` : `Screen reference: ${screenRange(reference!.from, reference!.to)}`}</summary>
    {reference && <p><strong>Spoken reference:</strong> {screenRange(reference.from, reference.to)}<br /><q>{reference.text}</q></p>}
    {look && <>
      <p><strong>Requested:</strong> {look.requested.mode === 'live' ? 'Live view' : screenRange(look.requested.from, look.requested.to)}</p>
      <p><strong>Captured samples:</strong> {look.capturedAt.length ? look.capturedAt.map(screenClock).join(', ') : 'None available for that time.'}</p>
      {!!look.availableSamples && look.availableSamples > look.capturedAt.length && <p>Selected {look.capturedAt.length} of {look.availableSamples} recorded samples in this interval.</p>}
      {!!look.gaps.length && <p>Sampling gaps: {look.gaps.map(gap => screenRange(gap.from, gap.to)).join(', ')}.</p>}
      {look.unavailable && <p>{look.unavailable}</p>}
      <p className="hint">Screen samples are recorded about every 0.5 seconds. These timestamps show the recorded view used by the AI.</p>
    </>}
  </details>
}
