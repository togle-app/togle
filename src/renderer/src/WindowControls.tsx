import { useEffect, useState } from 'react'
import { MIN_OPACITY } from '@shared/types'

const STEP = 5

/** Window opacity in percent. Shows the dragged value until the saved one catches up, so the thumb never jumps back. */
export function OpacitySlider({ value, onChange }: { value: number; onChange: (opacity: number) => void }) {
  const saved = Math.round(value * 100)
  const [dragged, setDragged] = useState<number | null>(null)
  useEffect(() => {
    if (dragged === saved) setDragged(null)
  }, [dragged, saved])
  const shown = dragged ?? saved
  return (
    <div className="opacity-slider">
      <input
        type="range"
        aria-label="Opacity"
        min={Math.round(MIN_OPACITY * 100)}
        max={100}
        step={STEP}
        value={shown}
        onChange={(e) => {
          const percent = Number(e.target.value)
          setDragged(percent)
          onChange(percent / 100)
        }}
      />
      <span>{shown}%</span>
    </div>
  )
}
