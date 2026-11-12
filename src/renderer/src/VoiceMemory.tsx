import { useEffect, useState } from 'react'
import type { RememberedVoice } from '@shared/voices'

const api = window.togle

export function useRememberedVoices(enabled = true): { people: RememberedVoice[]; error: string } {
  const [people, setPeople] = useState<RememberedVoice[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) { setPeople([]); setError(''); return }
    let active = true, request = 0
    const refresh = (): void => {
      const current = ++request
      void api.rememberedVoices().then(people => {
        if (active && current === request) { setPeople(people); setError('') }
      }, () => { if (active && current === request) setError('Saved voice profiles could not be opened.') })
    }
    refresh()
    const unsubscribe = api.onRememberedVoicesChanged(refresh)
    return () => { active = false; unsubscribe() }
  }, [enabled])
  return { people, error }
}
