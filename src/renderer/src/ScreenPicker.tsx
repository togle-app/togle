import { useEffect } from 'react'
import type { ScreenOption } from '@shared/types'
import { PickerDialog } from './PickerDialog'

const details = (s: ScreenOption): string => [s.primary && 'Main', s.togle && 'Togle is here'].filter(Boolean).join(' · ')

/**
 * Which screen to take a picture of: a button per screen, with a small picture of what's on it. Enter takes the
 * one picked last time, or else the first one Togle isn't on. A modal keeps selection inside the picker.
 */
export function ScreenPicker({
  title,
  screens,
  last,
  onPick,
  onClose
}: {
  title: string
  screens: ScreenOption[]
  last?: number
  onPick: (id: number) => void
  onClose: () => void
}) {
  useEffect(() => {
    // Switching to another app closes it too.
    const away = (): void => onClose()
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('blur', away)
    }
  }, [onClose])

  const first = screens.find((s) => s.id === last) ?? screens.find((s) => !s.togle) ?? screens[0]
  return (
    <PickerDialog title={title} onClose={onClose} initialFocus=".screen-choice[data-preferred=true]">
    <div className="screen-picker">
      <div className="screens">
        {screens.map((s) => (
          <button key={s.id} type="button" className="screen-choice" data-preferred={s === first} onClick={() => onPick(s.id)}>
            {s.thumbUrl ? <img src={s.thumbUrl} alt="" /> : <span className="no-thumb" />}
            <strong>{s.name}</strong>
            <span className="screen-detail">{details(s)}</span>
          </button>
        ))}
      </div>
    </div>
    </PickerDialog>
  )
}
