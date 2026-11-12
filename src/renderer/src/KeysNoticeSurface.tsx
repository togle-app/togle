import { useEffect, useState } from 'react'
import type { KeysOffer } from '@shared/types'

const api = window.togle
// A click meant for the window under the notice must not answer it: the buttons wake up after this long.
const HOLD_MS = 700

/**
 * The one-time notice in the corner when one of Togle's keys was pressed in a code editor that uses it too: change
 * Togle's keys, or keep them. Shown once, ever.
 */
export function KeysNoticeSurface() {
  const [offer, setOffer] = useState<KeysOffer | null>(null)
  const [held, setHeld] = useState(true)
  useEffect(() => {
    const stop = api.onKeysNotice((next) => setOffer(next))
    // It opens for the first time with the offer, which can be told before this page listens: it asks.
    void api.keysNoticeNow().then((now) => { if (now) setOffer(now) }, () => undefined)
    return stop
  }, [])
  useEffect(() => {
    if (!offer) return
    setHeld(true)
    const timer = setTimeout(() => setHeld(false), HOLD_MS)
    return () => clearTimeout(timer)
  }, [offer?.key, offer?.editor])
  if (!offer) return null
  return (
    <div className="call-notice" role="alert" aria-label={`${offer.key} is also a key in ${offer.editor}`}>
      <strong>
        {offer.key} is also a key in {offer.editor}
      </strong>
      <span>Togle takes it while it runs. Keep it, or change Togle's keys.</span>
      <div className="call-notice-buttons">
        <button className="primary" disabled={held} onClick={() => api.answerKeysNotice('change')}>
          Change keys
        </button>
        <button disabled={held} onClick={() => api.answerKeysNotice('keep')}>
          Keep {offer.key}
        </button>
      </div>
    </div>
  )
}
