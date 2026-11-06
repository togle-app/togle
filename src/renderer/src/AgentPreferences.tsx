import { useEffect, useState } from 'react'
import type { Agent, AgentPreferences as Preferences, Settings, SttStatus } from '@shared/types'
import type { SettingsPatch } from '@shared/api'
import { effectiveAI, effectiveSettings } from '@shared/preferences'
import { useConnections } from './Connections'
import { ModelSettings } from './ModelSettings'
import { SpeechSettings } from './Settings'
import { DictationSettings } from './DictationSettings'
import { CalendarSettings } from './Meetings'
import { Toggle } from './Rows'

const api = window.togle
const message = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function AgentPreferences({ agent, onAgent }: { agent: Agent; onAgent: (agent: Agent) => void }) {
  const connections = useConnections(), general = connections.settings
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [stt, setStt] = useState<SttStatus>({ state: 'starting' })
  useEffect(() => {
    let active = true, generation = 0
    const refresh = (): void => { const current = ++generation; void api.sttStatus(agent.id).then(value => { if (active && current === generation) setStt(value) }, () => {}) }
    refresh(); const off = api.onSttStatus(refresh)
    return () => { active = false; off() }
  }, [agent.id, agent.preferences?.transcription, general?.transcription])
  if (!general) return <p className="hint">Loading general settings…</p>
  const settings = effectiveSettings(general, agent)
  const preferences = agent.preferences || {}
  const hasAI = !!preferences.ai || !!agent.subscriptionAccountId || !!agent.model
  const change = async (next: Preferences, clearLegacy = false): Promise<void> => {
    setBusy(true); setError('')
    try { onAgent(await api.updateAgent(agent.id, { preferences: next, ...(clearLegacy ? { subscriptionAccountId: '', model: '' } : {}) })) }
    catch (error) { throw error }
    finally { setBusy(false) }
  }
  const profile = effectiveAI(general, agent, id => connections.sources.find(source => source.id === id)?.provider || general.provider)
  const setSection = (section: keyof Preferences, override: boolean): void => {
    const next = { ...preferences }
    if (!override) delete next[section]
    else if (section === 'ai') next.ai = profile
    else if (section === 'transcription') next.transcription = structuredClone(settings.transcription)
    else next.dictation = structuredClone(settings.dictation)
    void change(next, section === 'ai').catch(error => setError(message(error)))
  }
  const saveAI = async (patch: SettingsPatch): Promise<void> => { if (patch.ai) await change({ ...preferences, ai: patch.ai }, true) }
  const saveSpeech = async (patch: SettingsPatch): Promise<void> => {
    await change({ ...preferences, ...(patch.transcription ? { transcription: { ...settings.transcription, ...patch.transcription } } : {}), ...(patch.dictation ? { dictation: { ...settings.dictation, ...patch.dictation } } : {}) }).catch(error => setError(message(error)))
  }
  const saveVoice = async (patch: SettingsPatch): Promise<void> => { if (patch.dictation) await change({ ...preferences, dictation: { ...settings.dictation, ...patch.dictation } }).catch(error => setError(message(error))) }
  return <div className="settings settings-embedded agent-preferences" aria-label="Agent preferences">
    <div className="preference-scope"><Toggle name="Use general AI settings" checked={!hasAI} disabled={busy} onChange={inherit => setSection('ai', !inherit)} /></div>
    {hasAI ? <ModelSettings settings={{ ...settings, ai: profile } as Settings} save={saveAI} agent /> : <p className="inherit-note">Models and accounts follow General settings.</p>}
    <div className="preference-scope"><Toggle name="Use general speech settings" checked={!preferences.transcription} disabled={busy} onChange={inherit => setSection('transcription', !inherit)} /></div>
    {preferences.transcription ? <SpeechSettings settings={settings} save={saveSpeech} stt={stt} agent /> : <p className="inherit-note">Speech account and language follow General settings.</p>}
    <div className="preference-scope"><Toggle name="Use general voice typing settings" checked={!preferences.dictation} disabled={busy} onChange={inherit => setSection('dictation', !inherit)} /></div>
    {preferences.dictation ? <DictationSettings settings={settings} save={saveVoice} agent /> : <p className="inherit-note">F9 uses General preferences for this agent.</p>}
    <CalendarSettings agent={agent} onAgent={onAgent} />
    {error && <p className="error" role="alert">{error}</p>}
  </div>
}
