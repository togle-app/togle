import { useEffect, useState } from 'react'
import type { Settings, SubscriptionAccount } from '@shared/types'
import { modelSourceId } from '@shared/model-selection'

const api = window.togle
const message = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** The plan sign-ins on this computer (ChatGPT's, and Claude's where one was made before), kept up to date. */
export function useAccounts() {
  const [accounts, setAccounts] = useState<SubscriptionAccount[]>([])
  const [settings, setSettings] = useState<Settings>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true, revision = 0, settingsChanged = false
    const refresh = (): void => {
      const current = ++revision
      void api.subscriptionAccounts().then(value => { if (active && revision === current) { setAccounts(value); setError('') } }, error => { if (active && revision === current) setError(message(error)) })
    }
    refresh()
    void api.getSettings().then(value => { if (active && !settingsChanged) setSettings(value) }, () => {})
    const off = api.onAccountsChanged(refresh), changed = api.onSettingsChanged(value => { settingsChanged = true; setSettings(value) })
    return () => { active = false; off(); changed() }
  }, [retry])
  return { accounts, settings, error, globalId: settings ? modelSourceId(settings) : '', refresh: () => setRetry(value => value + 1) }
}
