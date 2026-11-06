import { useEffect, useState } from 'react'
import type { RememberedVoice } from '@shared/voices'
import type { Settings } from '@shared/types'
import type { SettingsPatch } from '@shared/api'
import { Row, Section, Toggle } from './Rows'

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

export function VoiceMemorySettings({ settings, save }: { settings: Settings; save: (patch: SettingsPatch) => Promise<unknown> }) {
  const { people, error: loadError } = useRememberedVoices()
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  return <Section id="settings-speakers" title="Speakers">
    <Toggle name="Recognize speakers" note="Match voices locally and suggest names from introductions. Confirm or correct them under People during a call." checked={settings.assist.voiceLabels !== false} onChange={voiceLabels => void save({ assist: { voiceLabels } })} />
    <Toggle name="Remember confirmed people" note="Recognize them in future calls. Confirming a name saves an encrypted voice profile on this device. No recordings are saved." checked={settings.assist.rememberVoices !== false} onChange={rememberVoices => void save({ assist: { rememberVoices } })} />
    <details className="more remembered-people"><summary>Remembered people{people.length ? ` · ${people.length}` : ''}</summary>
      {!people.length && !loadError && <p className="hint">Confirm a speaker’s name during a call to remember their voice.</p>}
      {people.map(person => <Row key={person.id} name={person.name} label={false} note={`Remembered ${new Date(person.createdAt).toLocaleDateString()}`}>
        <button className="ghost small" aria-label={`Forget ${person.name}'s voice`} disabled={!!busy} onClick={async () => {
          setBusy(person.id); setError('')
          try { await api.forgetVoice(person.id) }
          catch { setError('Could not forget this voice. Try again.') }
          finally { setBusy('') }
        }}>{busy === person.id ? 'Forgetting…' : 'Forget'}</button>
      </Row>)}
      {!!people.length && <p className="hint">Forgetting a voice keeps the names already written in call history.</p>}
      {(loadError || error) && <p className="error" role="status">{loadError || error}</p>}
    </details>
  </Section>
}
