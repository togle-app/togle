import { useEffect, useRef } from 'react'
import type { CaptureSource } from '@shared/types'
import { CALL_NOTES_CHARS } from '@shared/workspace'
import { Icon } from './Icon'

export function MonitorPicker({ sources, loading, error, startingCall, agentName, brief = '', group = false, onPrepare, onPick, onAudioOnly, onClose }: {
  sources: CaptureSource[]; loading: boolean; error?: string; startingCall: boolean
  agentName?: string; brief?: string; group?: boolean; onPrepare?: (brief: string, group: boolean) => void
  onPick: (source: CaptureSource) => void; onAudioOnly: () => void; onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    box.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const keys = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab') return
      const buttons = [...(box.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),summary') ?? [])].filter(element => element.getClientRects().length > 0)
      const index = buttons.indexOf(document.activeElement as HTMLElement)
      if (!buttons.length) return
      if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1)?.focus() }
      else if (!event.shiftKey && (index < 0 || index === buttons.length - 1)) { event.preventDefault(); buttons[0].focus() }
    }
    window.addEventListener('keydown', keys, true)
    return () => { window.removeEventListener('keydown', keys, true); if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [onClose])
  return <div className="monitor-picker-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="monitor-picker" role="dialog" aria-modal="true" aria-labelledby="monitor-picker-title" ref={box}>
      <div className="monitor-picker-head"><h2 id="monitor-picker-title">{startingCall ? `Start a call${agentName ? ` with ${agentName}` : ''}` : 'What should Togle watch?'}</h2><button className="icon" aria-label="Close screen selection" onClick={onClose}><Icon name="close" /></button></div>
      {startingCall && onPrepare && <details className="call-prep-inline">
        <summary>Call notes <span className="hint">Optional</span></summary>
        <label htmlFor="call-notes">What’s this call about?</label>
        <textarea id="call-notes" value={brief} maxLength={CALL_NOTES_CHARS} placeholder="Who are you meeting? What would you like help with?" onChange={event => onPrepare(event.target.value, group)} />
        <label className="call-group"><input type="checkbox" checked={group} onChange={event => onPrepare(brief, event.target.checked)} />Group call</label>
        <p className="hint">Notes apply to this call.</p>
      </details>}
      <p className="hint">Choose the call window or screen. Togle keeps a short local buffer and sends pictures to your AI only when it needs visual context.</p>
      {loading ? <p className="hint" role="status">Finding screens and windows…</p> : <div className="monitor-source-grid">
        {sources.map(source => <button key={source.id} className="monitor-source" aria-label={`Watch ${source.name}`} onClick={() => onPick(source)}>
          {source.thumbUrl ? <img src={source.thumbUrl} alt="" /> : <span className="monitor-source-preview"><Icon name="monitor" size={32} /></span>}
          <strong>{source.name}</strong><span className="hint">{source.kind === 'window' ? 'Only this window' : 'This entire screen'}</span>
        </button>)}
      </div>}
      {!loading && !sources.length && <p className="hint">No screens or windows are available. You can continue with audio.</p>}
      {error && <p className="error" role="status">{error}</p>}
      <button className="monitor-audio-only" onClick={onAudioOnly}>{startingCall ? 'Start with audio only' : 'Continue with audio only'}</button>
      <p className="hint monitor-picker-footnote">You can pause or change the source at any time. Monitoring stops when the call ends.</p>
    </div>
  </div>
}
