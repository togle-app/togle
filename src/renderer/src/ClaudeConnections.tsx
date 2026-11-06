import { useEffect, useState } from 'react'
import type { Agent, ClaudeConnections as Catalog } from '@shared/types'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function ClaudeConnections({ agent, onAgent }: { agent: Agent; onAgent: (agent: Agent) => void }) {
  const [editing, setEditing] = useState(false)
  const [catalog, setCatalog] = useState<Catalog>()
  const [chosen, setChosen] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const selection = agent.claudeConnections

  useEffect(() => {
    if (!editing) return
    let current = true
    setLoading(true); setError('')
    void api.claudeConnections(refresh > 0, agent.id).then(value => {
      if (!current) return
      setCatalog(value)
      setChosen(selection?.account === value.account ? selection.servers : [])
    }, error => { if (current) setError(errorText(error)) }).finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [editing, refresh, agent.id, selection])

  const save = async (): Promise<void> => {
    setSaving(true); setError('')
    try { onAgent(await api.setClaudeConnections(agent.id, chosen)); setEditing(false) }
    catch (error) { setError(errorText(error)) }
    finally { setSaving(false) }
  }
  const apps = [...(catalog?.apps ?? []), ...chosen.filter(name => !catalog?.apps.some(app => app.name === name)).map(name => ({ name, label: name.replace(/^claude\.ai\s+/, ''), status: 'failed' as const, readTools: 0 }))]
    .filter(app => (app.status === 'connected' && app.readTools > 0) || chosen.includes(app.name))
  return <section className="connected-apps" aria-label="Connected apps">
    <div className="inspector-section-head"><h3>Connected apps</h3>{!editing && <button className="ghost small" onClick={() => setEditing(true)}>{selection?.servers.length ? 'Manage apps' : 'Choose apps'}</button>}</div>
    <p className="hint">{selection?.servers.length ? `${selection.servers.map(name => name.replace(/^claude\.ai\s+/, '')).join(', ')} · ${selection.account}` : 'Let this agent search your Claude apps in chat and during calls.'}</p>
    {editing && <>
      <p className="hint">Works when this agent uses a Claude subscription. Selected apps can be searched and read; messages and tickets are not changed.</p>
      {loading ? <p role="status">Checking your Claude connections…</p> : catalog && <>
        <p className="hint">{catalog.account}</p>
        {selection && selection.account !== catalog.account && <p className="hint">The saved apps use {selection.account}. Saving replaces them with apps from this account.</p>}
        {!apps.length && <p>No apps with reading tools are connected. Connect an app in Claude, then refresh.</p>}
        {apps.map(app => <label className="connected-app-choice" key={app.name}>
          <input type="checkbox" checked={chosen.includes(app.name)} disabled={saving || (app.status !== 'connected' && !chosen.includes(app.name))} onChange={event => setChosen(names => event.target.checked ? [...names, app.name] : names.filter(name => name !== app.name))} />
          <span>{app.label}{app.status !== 'connected' && <small> · Reconnect in Claude</small>}</span>
        </label>)}
      </>}
      <div className="row wrap">
        <button className="primary" disabled={loading || saving || !catalog} onClick={() => void save()}>{saving ? 'Saving…' : 'Save apps'}</button>
        <button disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        <button className="link" disabled={loading || saving} onClick={() => setRefresh(value => value + 1)}>Refresh</button>
        <button className="link" onClick={() => api.openExternal('https://claude.ai/customize/connectors')}>Connect in Claude</button>
      </div>
    </>}
    {error && <p className="error" role="status">{error}</p>}
  </section>
}
