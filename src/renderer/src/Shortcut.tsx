import { useEffect, useState, type KeyboardEvent } from 'react'
import { hotkeyProblem, keysPressed } from '@shared/hotkeys'
import type { HotkeyInfo } from '@shared/types'
const api = window.togle
const ERROR_MS = 10_000
const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * A shortcut, by what it does, and its keys: clicked, the next keys pressed become its keys (checked first; while
 * they're pressed, none of the shortcuts does anything). Backspace turns it off, Esc or clicking away leaves it as it
 * was, and Reset gives it its own keys back.
 */
export function Shortcut({ hotkey }: { hotkey: HotkeyInfo }) {
  const [recording, setRecording] = useState(false)
  // The keys held so far ("Ctrl+Alt+…"), while it's recording.
  const [held, setHeld] = useState('')
  const [error, setError] = useState('')
  // Leaving Settings (or the window) while it records: the shortcuts work again.
  useEffect(() => (recording ? () => api.pauseHotkeys(false) : undefined), [recording])
  // Why keys couldn't be its, for a while: what was in the way may be gone by then.
  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(''), ERROR_MS)
    return () => clearTimeout(timer)
  }, [error])
  const start = (): void => {
    setError('')
    setHeld('')
    setRecording(true)
    api.pauseHotkeys(true)
  }
  const stop = (): void => {
    setRecording(false)
    api.pauseHotkeys(false)
  }
  const keep = async (keys: string): Promise<void> => {
    setRecording(false)
    try {
      // Kept or not, the shortcuts work again after it.
      await api.setHotkey(hotkey.id, keys)
      setError('')
    } catch (err) {
      setError(errorText(err))
      api.pauseHotkeys(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (!recording) return
    // Not Settings' Escape, nor the button's own Enter or Space.
    e.preventDefault()
    e.stopPropagation()
    const alone = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
    if (alone && e.key === 'Escape') return stop()
    if (alone && (e.key === 'Backspace' || e.key === 'Delete')) return void keep('')
    const { keys, key } = keysPressed(e)
    setHeld(key ? keys : keys ? `${keys}+…` : '')
    if (!key) return
    const problem = hotkeyProblem(keys)
    // Wrong keys: said why, and other keys can be pressed at once.
    if (problem) return setError(problem)
    void keep(keys)
  }
  return (
    <div className="setting shortcut">
      <span className="name shortcut-what">{hotkey.label}</span>
      <span className="control">
        {!recording && hotkey.keys !== hotkey.defaultKeys && (
          <button className="link reset" onClick={() => void keep(hotkey.defaultKeys)}>
            Reset
          </button>
        )}
        <button
          className={`keys ${recording ? 'recording' : ''} ${hotkey.keys ? '' : 'off'}`}
          aria-label={`${hotkey.label} shortcut`}
          title={recording ? 'Press the keys (Esc: as it was, Backspace: off)' : 'Click, then press other keys'}
          onClick={() => (recording ? stop() : start())}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => recording && e.preventDefault()}
          onBlur={() => recording && stop()}
        >
          {recording ? held || 'Press keys…' : hotkey.keys || 'Off'}
        </button>
      </span>
      {error ? (
        <p className="error">{error}</p>
      ) : (
        hotkey.keys && !hotkey.ok && <p className="error">Another app has {hotkey.keys}: pick other keys.</p>
      )}
    </div>
  )
}
