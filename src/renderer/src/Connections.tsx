import { useEffect, useState } from 'react'
import type { ApiConnection, ApiConnectionInput, Settings } from '@shared/types'
import type { ModelSource } from '@shared/model-selection'
import { modelSourceId } from '@shared/model-selection'
import { subscriptionSources, useAccounts } from './Accounts'
import { Menu } from './Menu'
import { Row } from './Rows'

const api = window.togle
const message = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const apiSource = (connection: ApiConnection): ModelSource => ({ id: connection.id, provider: connection.kind === 'anthropic' ? 'claude' : 'compat', subscription: false,
  label: `${connection.label} · ${connection.kind === 'local' ? 'Local' : 'API'}`, ready: connection.kind !== 'anthropic' || connection.hasKey,
  identity: JSON.stringify([connection.baseUrl, connection.revision]) })

export function useConnections() {
  const subscriptions = useAccounts(), [connections, setConnections] = useState<ApiConnection[]>([]), [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true, generation = 0
    const refresh = (): void => { const request = ++generation; void api.apiConnections().then(value => { if (active && request === generation) { setConnections(value); setError('') } }, error => { if (active && request === generation) setError(message(error)) }) }
    refresh(); const off = api.onApiConnectionsChanged(refresh)
    return () => { active = false; off() }
  }, [revision])
  return { ...subscriptions, connections, sources: [...subscriptionSources(subscriptions.accounts), ...connections.map(apiSource)], error: error || subscriptions.error, refresh: () => { subscriptions.refresh(); setRevision(value => value + 1) } }
}

export function ConnectionRows({ connections, settings, edit }: { connections: ApiConnection[]; settings: Settings; edit: (connection: ApiConnection) => void }) {
  const [busy, setBusy] = useState(''), [result, setResult] = useState<Record<string, string>>({}), [error, setError] = useState('')
  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => { setBusy(id); setError(''); try { await action() } catch (error) { setError(message(error)) } finally { setBusy('') } }
  return <>
    {connections.map(connection => <div className="account-row" key={connection.id}>
      <div className="account-info"><strong>{connection.label}</strong><span>{connection.kind === 'anthropic' ? 'Anthropic API' : connection.baseUrl}</span>
        <span className="account-status">{result[connection.id] || (connection.kind === 'local' ? 'Local model server' : connection.hasKey ? 'API key saved · separate billing' : 'API connection · no key')}{modelSourceId(settings) === connection.id && ' · Default AI account'}</span></div>
      <Menu label={busy === connection.id ? 'Checking…' : 'Manage'} className="ghost small" ariaLabel={`Manage ${connection.label}`} align="right" items={[
        { label: 'Test connection', disabled: !!busy, onSelect: () => void run(connection.id, async () => { const models = await api.listModels(connection.id); setResult(value => ({ ...value, [connection.id]: `${models.length} models available` })) }) },
        { label: connection.legacy ? 'Add a named connection' : 'Edit connection', disabled: !!busy, onSelect: () => edit(connection) },
        ...(!connection.legacy ? [{ label: 'Remove connection', disabled: !!busy, onSelect: () => void run(connection.id, () => api.removeApiConnection(connection.id)) }] : [])
      ]} />
    </div>)}
    {error && <p className="error model-status" role="alert">{error}</p>}
  </>
}

export function ConnectionEditor({ kind, connection, close }: { kind: ApiConnection['kind']; connection?: ApiConnection; close: () => void }) {
  const [draft, setDraft] = useState<ApiConnectionInput>({ kind, label: connection?.legacy ? '' : connection?.label || '', baseUrl: connection?.baseUrl || (kind === 'local' ? 'http://localhost:1234/v1' : kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'), model: connection?.model || '' })
  const [key, setKey] = useState(''), [clearKey, setClearKey] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const editing = connection && !connection.legacy
  return <form className="connection-editor" aria-label={editing ? 'Edit AI connection' : 'Add AI connection'} onSubmit={event => {
    event.preventDefault(); setBusy(true); setError('')
    const input = { ...draft, ...(key.trim() || clearKey ? { key: clearKey ? '' : key.trim() } : {}) }
    void (async () => { try { if (editing) await api.updateApiConnection(connection.id, input); else await api.addApiConnection(input); close() } catch (error) { setError(message(error)) } finally { setBusy(false) } })()
  }}>
    <h4>{editing ? 'Edit connection' : kind === 'local' ? 'Connect a local model' : 'Connect an API'}</h4>
    <Row stacked name="Name"><input aria-label="Connection name" required autoFocus maxLength={60} value={draft.label} onChange={event => setDraft(value => ({ ...value, label: event.target.value }))} placeholder={kind === 'local' ? 'LM Studio' : 'Work API'} /></Row>
    {kind !== 'anthropic' && <Row stacked name="Server URL"><input aria-label="Connection server URL" type="url" required value={draft.baseUrl} onChange={event => setDraft(value => ({ ...value, baseUrl: event.target.value }))} /></Row>}
    <Row stacked name="API key" note={kind === 'local' ? 'Optional for a local server.' : editing && connection.hasKey ? 'Leave blank to keep the saved key.' : 'API usage is billed separately from subscriptions.'}><input aria-label="Connection API key" type="password" autoComplete="off" required={kind === 'anthropic' && !editing} value={key} disabled={clearKey} onChange={event => setKey(event.target.value)} placeholder={editing && connection.hasKey ? 'Key saved' : kind === 'anthropic' ? 'Paste your Anthropic API key' : 'Optional if your server needs no key'} /></Row>
    {editing && connection.hasKey && <label className="connection-clear-key"><input type="checkbox" checked={clearKey} onChange={event => setClearKey(event.target.checked)} />Remove saved API key</label>}
    <Row stacked name="Model ID" note="Optional when the server publishes its models."><input aria-label="Connection model ID" value={draft.model} onChange={event => setDraft(value => ({ ...value, model: event.target.value }))} placeholder="Choose a model after connecting" /></Row>
    <div className="row"><button className="primary" disabled={busy || !draft.label.trim()}>{busy ? 'Saving…' : 'Save connection'}</button><button type="button" className="ghost" disabled={busy} onClick={close}>Cancel</button></div>
    {error && <p className="error" role="alert">{error}</p>}
  </form>
}
