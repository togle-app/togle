import { useEffect, useRef, useState } from 'react'
import { longDoneMessage, type DictationState } from '@shared/dictation'
import { DictationCapture, microphoneProblem, type DictationMicrophone } from './audio/dictation'
import { useHotkeys } from './hotkeys'
import { Icon } from './Icon'
import { isTogleMicrophoneLabel } from '@shared/microphone-link'
import './dictation.css'

const api = window.togle

export function DictationBar() {
  const [state, setState] = useState<DictationState>({ phase: 'idle' })
  const [expanded, setExpanded] = useState(false)
  const [hold, setHold] = useState(api.platform === 'win32')
  const [micReady, setMicReady] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copying, setCopying] = useState(false)
  const [actionError, setActionError] = useState('')
  const [preview, setPreview] = useState<{ file: string; src: string | null } | null>(null)
  const [microphone, setMicrophone] = useState<DictationMicrophone>({ name: 'Microphone', muted: false })
  const [heardSound, setHeardSound] = useState(false)
  const heard = useRef(false)
  const micMuted = useRef(false)
  const [quiet, setQuiet] = useState(false)
  const capture = useRef<DictationCapture | null>(null)
  const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const job = useRef<string | undefined>(undefined)
  const wave = useRef<HTMLSpanElement>(null)
  const levels = useRef<number[]>(Array(13).fill(0))
  const peak = useRef(0)
  const nextFrame = useRef(0)
  const nextHover = useRef(0)
  const shortcut = useHotkeys().find(item => item.id === (state.show && state.phase !== 'idle' ? 'show' : 'dictate'))
  const keys = shortcut?.ok ? shortcut.keys : ''
  const shortcutBlocked = !!shortcut?.keys && !shortcut.ok
  const current = useRef(state)
  const drag = useRef<{ x: number; y: number; moved: boolean; active: boolean } | undefined>(undefined)
  current.current = state

  const drawLevel = (level: number): void => {
    if (micMuted.current) level = 0
    if (level > .1 && !heard.current) { heard.current = true; setHeardSound(true) }
    // Paint at most 16 times a second without re-rendering React or the rest of Togle.
    peak.current = Math.max(peak.current, level)
    const now = performance.now()
    if (now < nextFrame.current) return
    nextFrame.current = now + 64
    const previous = levels.current[levels.current.length - 1]
    const weight = peak.current > previous ? .8 : .28
    const smoothed = previous + (peak.current - previous) * weight
    levels.current.shift(); levels.current.push(smoothed); peak.current = 0
    const bars = wave.current?.children
    if (bars) for (let i = 0; i < bars.length; i++) (bars[i] as HTMLElement).style.transform = `scaleY(${0.2 + levels.current[i] * 0.8})`
  }

  useEffect(() => {
    let received = false, live = true
    let modeReceived = false
    void api.getSettings().then(value => { if (live && !modeReceived) setHold(value.dictation.mode === 'hold') }).catch(() => {})
    const offSettings = api.onSettingsChanged(value => { modeReceived = true; setHold(value.dictation.mode === 'hold') })
    const off = api.onDictation(value => { received = true; setState(value) })
    const offExpanded = api.onDictationExpanded(setExpanded)
    void api.dictationStatus().then(value => { if (live && !received) setState(value) })
    return () => { live = false; off(); offSettings(); offExpanded(); clearTimeout(startTimer.current); capture.current?.stop(false); capture.current = null }
  }, [])

  useEffect(() => { setCopied(false); setCopying(false); setActionError('') }, [state.id, state.text, state.phase, state.message])
  useEffect(() => {
    const file = state.picture
    setPreview(null)
    if (!file) return
    let live = true
    void api.pastedPicture(file).catch(() => null).then(src => { if (live) setPreview({ file, src }) })
    return () => { live = false }
  }, [state.picture])

  useEffect(() => {
    if (state.phase === 'recording' && state.id && job.current !== state.id) {
      capture.current?.stop(false)
      const id = state.id, mic = capture.current = new DictationCapture()
      job.current = id; setMicReady(false); setCopied(false)
      heard.current = false; setHeardSound(false); micMuted.current = false
      setMicrophone({ name: 'Microphone', muted: false })
      levels.current.fill(0); peak.current = 0; nextFrame.current = 0; drawLevel(0)
      const timeout = startTimer.current = setTimeout(() => {
        if (capture.current === mic) { mic.stop(false); api.dictationCaptureFailed(id, 'The microphone did not start. Check microphone access in your system settings.') }
      }, 12_000)
      void mic.start(pcm => api.pushDictationAudio(id, pcm), message => api.dictationCaptureFailed(id, message), drawLevel,
        { deviceId: state.microphoneId, streaming: state.streaming, virtualDelay: async label => {
          // Togle Studio's cleaned audio comes this much later: dictation waits for the last words.
          const status=await api.microphoneStatus().catch(()=>undefined), state=status?.running?status.state:undefined
          return state?.phase==='on' && isTogleMicrophoneLabel(label)?Math.max(90,Math.min(400,(state.bufferMs??128)+40)):90
        }, microphone: value => {
          if (capture.current !== mic) return
          micMuted.current = value.muted
          if (value.muted) { levels.current.fill(0); peak.current = 0; nextFrame.current = 0; drawLevel(0) }
          setMicrophone(value)
        } }).then(() => {
        clearTimeout(timeout); if (capture.current === mic) setMicReady(true)
      }).catch(error => {
        clearTimeout(timeout)
        if (capture.current === mic) api.dictationCaptureFailed(id, microphoneProblem(error))
      })
    } else if (state.phase === 'finishing' && state.id) {
      clearTimeout(startTimer.current)
      const mic = capture.current, id = state.id
      job.current = undefined
      void (mic?.finish() ?? Promise.resolve()).then(() => { if (capture.current === mic) capture.current = null; return api.finishDictationCapture(id) })
    } else if (state.phase !== 'recording') {
      clearTimeout(startTimer.current)
      capture.current?.stop(false); capture.current = null; job.current = undefined; setMicReady(false)
    }
  }, [state.phase, state.id])

  useEffect(() => {
    setQuiet(false)
    if (state.phase !== 'recording' || !micReady || heardSound) return
    const timer = setTimeout(() => setQuiet(true), 4000)
    return () => clearTimeout(timer)
  }, [state.phase, state.id, micReady, heardSound])

  const recording = state.phase === 'recording'
  const recovery = state.phase === 'ready' || state.phase === 'error'
  const idle = state.phase === 'idle'
  const busy = !idle && !recording && !recovery && state.phase !== 'done'
  const hasStatus = !idle && !recording
  const pasteKey = window.togle.platform === 'darwin' ? '⌘V' : 'Ctrl+V'
  const held = !!state.picture && recovery
  const onClipboard = recovery && state.outcome === 'copied'
  const copyLabel = onClipboard ? 'Copy again' : held ? state.text ? 'Copy both' : 'Copy screenshot' : 'Copy text'
  const resultName = held ? state.text ? 'Screenshot and text' : 'Screenshot' : 'Text'
  const recoveryTitle = onClipboard ? resultName + ' copied' : held ? resultName + ' ready' : state.text ? 'Your text is ready' : 'Try dictation again'
  const recoveryStage = actionError ? 'Copy failed' : onClipboard || copied ? `Copied · ${pasteKey}`
    : held ? 'Screenshot ready' : state.text ? 'Copy text' : state.phase === 'ready' ? 'No speech' : 'Try again'
  // One word while it works ("Typing…"), not a flicker of six steps; the panel still says each step.
  const stage = state.phase === 'starting' ? 'Getting ready'
    : busy ? state.show ? 'Finishing…' : 'Typing…'
      : state.phase === 'done' ? state.outcome === 'copied' ? `Copied · ${pasteKey}` : 'Inserted' : recoveryStage
  const muted = recording && micReady && microphone.muted
  const noSound = recording && micReady && !microphone.muted && quiet
  const micAttention = muted || noSound
  // A line under the title while listening (what to do about the microphone, or that the call hears you too): the
  // open panel is taller for it, or the line is cut off under the handle.
  const note = recording && (micAttention || !!state.inCall)
  // Done, the title can be a sentence or two (why the words were copied and not typed): the open panel is taller for
  // one that does not fit on a line, and shows all of it.
  const longDone = longDoneMessage(state)
  // Trouble shows in the bar itself, not only on hover: a muted mic, no sound, the shortcut taken.
  const takenKeys = shortcut?.keys ?? ''
  const alert = idle && shortcutBlocked ? takenKeys && takenKeys.length <= 6 ? `${takenKeys} is taken` : 'Shortcut taken' : muted ? 'Mic muted' : noSound ? 'No sound' : ''
  const callHears = recording && !!state.inCall && !alert
  // The resting pill grows while listening (so it's clearly on), and taller with words in it; main keeps clicks on all of it.
  const [pillWidth, pillHeight] = callHears ? [176, 44] : alert ? [128, 44] : recording ? [96, 28] : [64, 28]
  useEffect(() => { api.setDictationPill(pillWidth, pillHeight) }, [pillWidth, pillHeight])
  const title = idle ? shortcutBlocked ? `${shortcut?.keys ?? 'The shortcut'} is used by another app` : 'Ready to dictate'
    : recording ? !micReady ? 'Opening microphone…' : muted ? 'Your microphone is muted' : noSound ? 'No sound yet' : 'Listening'
      : state.phase === 'starting' ? 'Getting ready…' : state.phase === 'done' ? state.message || 'Text entered'
        : recovery ? recoveryTitle : state.message ?? 'Finishing…'
  const fold = (): void => { setExpanded(false); api.expandDictation(false, true) }
  const dismiss = (): void => { fold(); void api.cancelDictation(state.id) }
  const openSettings = (): void => { fold(); void api.openDictationSettings() }
  const copy = async (): Promise<void> => {
    if (copying) return
    fold()
    const unchanged = (): boolean => current.current.id === state.id && current.current.text === state.text && current.current.phase === state.phase
    setActionError(''); setCopying(true)
    try { await api.copyDictationText(state.id); if (unchanged()) setCopied(true) }
    catch { if (unchanged()) setActionError('Could not copy. Your result is still here.') }
    finally { if (unchanged()) setCopying(false) }
  }
  const closeLabel = recording ? 'Cancel dictation' : busy ? 'Collapse voice bar' : 'Close result'
  const cancel = <button className="dictation-icon" title={closeLabel} aria-label={closeLabel} onClick={busy ? fold : dismiss}><Icon name="close" size={14} /></button>
  const recoveryHandle = held ? 'Show captured screenshot' : onClipboard ? 'Show dictated text' : state.text ? 'Copy dictated text' : 'Show dictation recovery'
  const handleLabel = state.waitingForPaste ? 'Show copied result' : idle ? 'Start dictation' : recording ? 'Stop dictation' : recovery ? recoveryHandle : state.phase === 'done' ? 'Dismiss dictation' : title
  const clickHandle = (): void => {
    if (state.waitingForPaste) api.expandDictation(true, true)
    else if (idle || recording) { fold(); void api.toggleDictation() }
    // "Copy text" on the bar copies: opening a panel instead left people pasting whatever was on the clipboard.
    else if (held || onClipboard || (recovery && !state.text)) api.expandDictation(!expanded, true)
    else if (recovery) void copy()
    else if (state.phase === 'done') dismiss()
  }

  return <main className="dictation-shell" aria-label="Togle dictation">
    <div className={`dictation-hit ${expanded ? 'is-expanded' : ''} ${hasStatus ? 'has-status' : ''} ${recording ? 'is-recording' : ''} ${recovery ? 'is-recovery' : recording && state.inCall ? 'is-in-call' : ''} ${note || longDone ? 'has-note' : ''}`} style={!expanded && !hasStatus ? { width: pillWidth, height: pillHeight } : undefined} onMouseEnter={() => api.expandDictation(true)} onMouseLeave={() => api.expandDictation(false)}
      onMouseMove={() => { if (!expanded && performance.now() >= nextHover.current) { nextHover.current = performance.now()+100; api.expandDictation(true) } }}
      onPointerDown={event => {
        if (event.button !== 0 || !(event.target as HTMLElement).closest('.dictation-handle')) return
        drag.current = { x: event.screenX, y: event.screenY, moved: false, active: true }
      }}
      onPointerMove={event => {
        const point = drag.current
        if (!point?.active) return
        if (!point.moved && Math.hypot(event.screenX - point.x, event.screenY - point.y) >= 4) { point.moved = true; api.dragDictation('start', point.x, point.y); try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Synthetic pointer. */ } }
        if (point.moved) api.dragDictation('move', event.screenX, event.screenY)
      }}
      onPointerUp={event => {
        const point = drag.current
        if (!point?.active) return
        point.active = false
        if (point.moved) api.dragDictation('end', event.screenX, event.screenY)
        try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* No captured pointer. */ }
      }}
      onPointerCancel={event => {
        if (drag.current?.active && drag.current.moved) api.dragDictation('end', event.screenX, event.screenY)
        drag.current = undefined
      }}
      onClickCapture={event => { if (drag.current?.moved && (event.target as HTMLElement).closest('.dictation-handle')) { event.preventDefault(); event.stopPropagation() }; drag.current = undefined }}>
    <div className={`dictation-bar ${idle ? 'is-idle' : recovery ? 'is-recovery' : recording ? 'is-recording' : state.phase === 'done' ? 'is-done' : 'is-busy'} ${expanded ? 'is-expanded' : ''} ${micAttention || shortcutBlocked ? 'needs-attention' : ''}`} data-phase={state.phase} data-expanded={expanded}>
      <span className="dictation-announcement" role="status">{title}</span>
      <div className="dictation-details" inert={!expanded} aria-hidden={!expanded}>
        {recovery ? <>
          <div className="dictation-top"><strong>{title}</strong>{cancel}</div>
          <p className="dictation-note">{state.message}</p>
          {(state.text || held) && <div className={'dictation-result' + (held ? ' with-picture' : '')} aria-label={held ? 'Captured result' : 'Dictated text'}>
            {held && (preview?.file === state.picture && preview?.src ? <img src={preview.src} alt="Captured screenshot" /> : <span>{preview?.file === state.picture ? 'Screenshot preview unavailable' : 'Screenshot'}</span>)}
            {state.text && <span>{state.text}</span>}
          </div>}
          <div className="dictation-actions">
            {state.text || held ? <button className="primary" disabled={copying} onClick={() => void copy()}>{copying ? 'Copying…' : copyLabel}</button> : <button className="primary" onClick={() => { fold(); void api.toggleDictation() }}>Try again</button>}
            <button className="ghost" onClick={dismiss}>Dismiss</button>
          </div>
          {actionError && <p className="dictation-action-error" role="alert">{actionError}</p>}
        </> : <>
          <div className="dictation-top">
            {/* The way out stays in view: with long keys the sentence is shortened, never the link after it. */}
            {idle ? <span className={`dictation-prompt ${shortcutBlocked ? 'has-link' : ''}`}>{shortcutBlocked ? <><span className="dictation-cut" title={title}>{shortcut?.keys ?? 'The shortcut'} is taken.</span> <button className="link" onClick={openSettings}>Change key</button></> : keys ? <>{hold ? 'Hold' : 'Press'} <kbd>{keys}</kbd>{keys.length <= 12 ? ' to speak' : ''}</> : 'Click to speak'}</span>
              : <><strong title={recording ? state.destination ? `Into ${state.destination} · ${microphone.name}` : microphone.name : state.message}>{title}</strong>
                {recording && keys && !micAttention && <span className="dictation-shortcut">{state.hold ? 'Release' : 'Press'} <kbd>{keys}</kbd></span>}</>}
            {!idle && cancel}
          </div>
          {muted && <p className="dictation-call-note">Unmute it on your headset or in your computer’s sound settings.</p>}
          {noSound && <p className="dictation-call-note">Listening to {microphone.name || 'your microphone'}. <button className="link" onClick={openSettings}>Change microphone</button></p>}
          {/* Muted or silent, the call doesn't hear you either: the microphone's line says what to do instead. */}
          {recording && state.inCall && !micAttention && <p className="dictation-call-note">Your call can hear you too.</p>}
        </>}
      </div>
      <button className={`dictation-handle ${hasStatus || alert ? 'has-status' : ''} ${alert ? 'has-alert' : ''} ${callHears ? 'has-label' : ''}`} aria-label={alert ? `${alert}. ${handleLabel}` : handleLabel} title="Drag to move the voice bar" onClick={clickHandle}>
        {hasStatus ? <>
          {busy ? <span className="dictation-spinner" aria-hidden="true" /> : state.phase === 'done' || onClipboard ? <Icon name="check" size={12} /> : <span className="dictation-attention-dot" aria-hidden="true" />}
          <span className="dictation-stage" aria-hidden="true">{stage}</span>
        </> : alert ? <>
          <span className="dictation-attention-dot" aria-hidden="true" />
          <span className="dictation-stage" aria-hidden="true">{alert}</span>
        </> : <>
          <span ref={wave} className="dictation-wave" role="img" aria-label={recording ? 'Microphone audio level' : title}>{Array.from({ length: 13 }, (_, i) => <span key={i} />)}</span>
          {callHears && <span className="dictation-stage dictation-call-label" aria-hidden="true">Call hears you</span>}
        </>}
      </button>
    </div>
    </div>
  </main>
}
