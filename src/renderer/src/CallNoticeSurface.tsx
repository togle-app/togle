import { useEffect, useState } from 'react'
import type { CallApp } from '@shared/call-apps'

const api = window.togle
// A click meant for the window under the notice must not answer it: the buttons wake up after this long.
const HOLD_MS = 700

/** The small notice in the corner when a call starts in another app: write it down, not now, or always for this app. */
export function CallNoticeSurface() {
  const [notice, setNotice] = useState<{ app: CallApp; name: string } | null>(null)
  const [held, setHeld] = useState(true)
  useEffect(() => {
    const stop = api.onCallNotice((next) => setNotice(next))
    // The first notice can be told before this page listens: it asks.
    void api.callNoticeNow().then((now) => { if (now) setNotice(now) }, () => undefined)
    return stop
  }, [])
  useEffect(() => {
    if (!notice) return
    setHeld(true)
    const timer = setTimeout(() => setHeld(false), HOLD_MS)
    return () => clearTimeout(timer)
  }, [notice?.app, notice?.name])
  if (!notice) return null
  return (
    <div className="call-notice" role="alert" aria-label={`A call started in ${notice.name}`}>
      <strong>A call started in {notice.name}</strong>
      <div className="call-notice-buttons">
        <button className="primary" disabled={held} onClick={() => api.answerCallNotice('write')}>Write it down</button>
        <button disabled={held} onClick={() => api.answerCallNotice('later')}>Not now</button>
        <button className="call-notice-always" disabled={held} onClick={() => api.answerCallNotice('always')}>Always in {notice.name}</button>
      </div>
    </div>
  )
}
