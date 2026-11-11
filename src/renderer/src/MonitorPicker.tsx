import { useEffect, useRef } from 'react'
import type { CaptureSource } from '@shared/types'
import { CALL_NOTES_CHARS } from '@shared/workspace'
import { Icon } from './Icon'

// The last choice (a window or screen by its name, or audio only), offered first next time. Only on this computer.
const LAST_CHOICE = 'togle.lastScreenChoice'
const lastChoice = (): string | null => { try { return localStorage.getItem(LAST_CHOICE) } catch { return null } }
/** The window or screen chosen last time, by its name; null for audio only, or nothing chosen yet. */
export const lastScreenName = (): string | null => lastChoice()?.startsWith('source:') ? lastChoice()!.slice('source:'.length) : null
const remember = (choice: string): void => { try { localStorage.setItem(LAST_CHOICE, choice) } catch { /* Storage blocked: nothing to remember. */ } }

export function MonitorPicker({ sources, loading, error, startingCall, resuming = false, agentName, brief = '', group = false, onPrepare, onPick, onAudioOnly, onClose }: {
  sources: CaptureSource[]; loading: boolean; error?: string; startingCall: boolean
  /** The call that ended goes on (Resume call), rather than a new one starting: the title says which. */
  resuming?: boolean
  agentName?: string; brief?: string; group?: boolean; onPrepare?: (brief: string, group: boolean) => void
  onPick: (source: CaptureSource) => void; onAudioOnly: () => void; onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const last = lastChoice()
  useEffect(() => {
    const previous = document.activeElement
    box.current?.querySelector<HTMLButtonElement>('button.last')?.focus() ?? box.current?.querySelector<HTMLButtonElement>('button')?.focus()
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
  // The windows come in a moment later: the last one chosen takes the focus then.
  useEffect(() => { if (!loading) box.current?.querySelector<HTMLButtonElement>('.monitor-source.last')?.focus() }, [loading])
  return <div className="monitor-picker-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <div className="monitor-picker" role="dialog" aria-modal="true" aria-labelledby="monitor-picker-title" ref={box}>
      <div className="monitor-picker-head"><h2 id="monitor-picker-title">{startingCall ? `${resuming ? 'Resume the call' : 'Start a call'}${agentName ? ` with ${agentName}` : ''}` : 'What should Togle watch?'}</h2><button className="icon" aria-label="Close screen selection" onClick={onClose}><Icon name="close" /></button></div>
      {startingCall && onPrepare && <details className="call-prep-inline">
        <summary>Call notes <span className="hint">Optional</span></summary>
        <label htmlFor="call-notes">What’s this call about?</label>
        <textarea id="call-notes" value={brief} maxLength={CALL_NOTES_CHARS} placeholder="Who are you meeting? What would you like help with?" onChange={event => onPrepare(event.target.value, group)} />
        <p className="hint">Notes apply to this call.</p>
      </details>}
      {/* In sight, not folded under the notes: it changes when Togle suggests. */}
      {startingCall && onPrepare && <label className="call-group call-group-start"><input type="checkbox" checked={group} onChange={event => onPrepare(brief, event.target.checked)} />Group call<span className="hint">Suggests when you’re asked by name, or right after you spoke</span></label>}
      <p className="hint">Pick the call window or a screen. Togle keeps pictures of it with the call, on this computer, and sends one to your AI only when a suggestion needs to see the screen.</p>
      {loading ? <p className="hint" role="status">Finding screens and windows…</p> : <div className="monitor-source-grid">
        {sources.map(source => <button key={source.id} className={`monitor-source ${last === 'source:' + source.name ? 'last' : ''}`} aria-label={`Watch ${source.name}`} onClick={() => { remember('source:' + source.name); onPick(source) }}>
          {source.thumbUrl ? <img src={source.thumbUrl} alt="" /> : <span className="monitor-source-preview"><Icon name="monitor" size={32} /></span>}
          <strong>{source.name}</strong><span className="hint">{source.kind === 'window' ? 'Only this window' : 'This entire screen'}</span>
        </button>)}
      </div>}
      {!loading && !sources.length && <p className="hint">No screens or windows are available. You can continue with audio.</p>}
      {error && <p className="error" role="status">{error}</p>}
      <button className={`monitor-audio-only ${last === 'audio' ? 'last' : ''}`} onClick={() => { remember('audio'); onAudioOnly() }}>{!startingCall ? 'Continue with audio only' : resuming ? 'Resume with audio only' : 'Start with audio only'}</button>
      <p className="hint monitor-picker-footnote">Pause or change it any time. Togle stops looking when the call ends.</p>
    </div>
  </div>
}
