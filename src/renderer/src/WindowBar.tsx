import { useEffect, useState } from 'react'
import { Icon } from './Icon'

const api = window.togle

/** Togle's mark, as on its icon: a T with its dot, on its blue tile. Drawn here, so it is sharp at any size. */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 1024 1024" aria-hidden="true">
      <defs>
        <linearGradient id="togle-mark-tile" x1="180" y1="80" x2="850" y2="980" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6878FF" />
          <stop offset="1" stopColor="#414DD0" />
        </linearGradient>
      </defs>
      <rect x="48" y="48" width="928" height="928" rx="220" fill="url(#togle-mark-tile)" />
      <rect x="434" y="352" width="156" height="414" rx="78" fill="#F8FAFF" />
      <rect x="232" y="250" width="560" height="156" rx="78" fill="#F8FAFF" />
      <circle cx="724" cy="328" r="94" fill="#91EED0" />
    </svg>
  )
}

/** Whether the window is maximized, as main says: its button, a double click on the bar, or the system can change it. */
function useMaximized(): boolean {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let live = true
    void api.isMaximized().then((now) => { if (live) setMaximized(now === true) }, () => undefined)
    const off = api.onMaximized((now) => setMaximized(now))
    return () => {
      live = false
      off()
    }
  }, [])
  return maximized
}

/** The window's own buttons, as on any window of the system: minimize, maximize (or restore), and close. */
export function WindowButtons({ closeTitle, closeLabel, onClose }: { closeTitle: string; closeLabel: string; onClose: () => void }) {
  const maximized = useMaximized()
  return (
    <div className="window-buttons">
      <button className="icon" title="Minimize" aria-label="Minimize" onClick={() => api.minimize()}><Icon name="minimize" /></button>
      <button className="icon" title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => api.maximize()}>
        <Icon name={maximized ? 'restore' : 'maximize'} />
      </button>
      <button className="icon close" title={closeTitle} aria-label={closeLabel} onClick={onClose}><Icon name="close" /></button>
    </div>
  )
}
