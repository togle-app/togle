import { useEffect, useState, type ReactNode } from 'react'
import type { Agent, ApiConnection, Settings, SubscriptionAccount } from '@shared/types'
import { modelSourceId, sourceLanes, type ModelSource } from '@shared/model-selection'
import { Menu } from './Menu'
import { ModelPicker, useModelCatalog } from './ModelPicker'
import { MANAGE_USAGE_URL } from '@shared/plan'

const api = window.togle
const message = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
export const providerLabel = (provider: 'claude' | 'chatgpt'): string => provider === 'claude' ? 'Claude' : 'ChatGPT'
/** OpenAI's wording for its sign-in, on the button that starts it. */
const connectLabel = (account: SubscriptionAccount): string => account.provider === 'chatgpt' ? 'Continue with ChatGPT' : 'Connect'
const accountTitle = (account: SubscriptionAccount): string => account.shared ? providerLabel(account.provider) : account.label
export const accountLabel = (account: SubscriptionAccount): string => `${accountTitle(account)}${accountTitle(account) === providerLabel(account.provider) ? '' : ` · ${providerLabel(account.provider)}`}${account.email ? ` · ${account.email}` : ''}${account.signedIn ? '' : ' · Sign in needed'}`
export const subscriptionSources = (accounts: SubscriptionAccount[]): ModelSource[] => accounts.map(account => ({
  id: account.id, provider: account.provider, label: accountLabel(account), subscription: true,
  ready: account.signedIn && !account.signingIn && !account.pending, identity: JSON.stringify([account.email, account.plan])
}))

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

/** Connecting an account never changes defaults, agent overrides, or the dictation account. */
export function AccountSettings({ settings, connections, addApi }: { settings: Settings; connections?: ReactNode; addApi?: (kind: ApiConnection['kind']) => void }) {
  const list = useAccounts()
  const [adding, setAdding] = useState(false)
  const [provider, setProvider] = useState<'claude' | 'chatgpt'>('chatgpt')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const signingIn = list.accounts.some(account => account.signingIn || account.pending)
  const run = async (id: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(id); setError('')
    try { await action() } catch (error) { setError(message(error)) } finally { setBusy('') }
  }
  return <div className="subscription-accounts">
    <div className="account-list">
      {list.accounts.map(account => <div className="account-row" key={account.id}>
        <div className="account-info"><strong>{accountTitle(account)}</strong>
          <span>{account.email || (account.shared ? 'Not connected yet' : providerLabel(account.provider))}</span>
          <span className="account-status">{account.signingIn || account.pending ? 'Waiting for sign-in…' : account.signedIn ? 'Connected' : 'Sign in needed'}{modelSourceId(settings) === account.id && ' · Default AI account'}</span>
        </div>
        {account.signingIn || account.pending ? <button className="ghost small" onClick={() => void run(account.id, () => api.cancelAccountSignIn(account.id))}>Cancel sign-in</button>
          : account.signedIn ? <Menu className="ghost small" label="Manage" ariaLabel={`Manage ${accountTitle(account)}`} align="right" items={[
            { label: 'Reconnect account', disabled: !!busy || signingIn, onSelect: () => void run(account.id, () => api.signInAccount(account.id)) },
            { label: 'Sign out', disabled: !!busy, note: account.shared && account.provider === 'claude' ? 'Also signs out Claude Code on this device.' : 'This account stays available to reconnect.', onSelect: () => void run(account.id, () => api.signOutAccount(account.id)) }
          ]} /> : <button className={account.provider === 'chatgpt' ? 'primary small continue-chatgpt' : 'ghost small'} disabled={!!busy || signingIn} onClick={() => void run(account.id, () => api.signInAccount(account.id))}>{connectLabel(account)}</button>}
        {account.signingIn && account.url && <div className="account-pending"><button className="link" onClick={() => void api.openExternal(account.url!)}>Open sign-in page</button></div>}
        {account.error && <p className="error account-pending" role="status">{account.error}</p>}
        {account.provider === 'chatgpt' && account.signedIn && <p className="hint account-pending">Using your ChatGPT plan. <button className="link" onClick={() => void api.openExternal(MANAGE_USAGE_URL)}>Manage usage</button></p>}
      </div>)}
      {connections}
    </div>
    {!adding ? <Menu className="ghost account-add-button" label="Add connection" ariaLabel="Add account or connection" items={[
      { label: 'ChatGPT account', note: 'Use your ChatGPT plan', disabled: !!busy || signingIn, onSelect: () => { setProvider('chatgpt'); setAdding(true) } },
      { label: 'Claude subscription', disabled: !!busy || signingIn, onSelect: () => { setProvider('claude'); setAdding(true) } },
      ...(addApi ? [{ label: 'API key', onSelect: () => addApi('compatible') }, { label: 'Anthropic API', onSelect: () => addApi('anthropic') }, { label: 'Local model server', onSelect: () => addApi('local') }] : [])
    ]} /> : <form className="account-add" onSubmit={event => {
      event.preventDefault()
      void run('new', async () => {
        const account = await api.addSubscriptionAccount(provider, label.trim() || providerLabel(provider))
        setAdding(false); setLabel('')
        await api.signInAccount(account.id)
      })
    }}>
      <label>Subscription<select aria-label="New account provider" value={provider} disabled={!!busy} onChange={event => setProvider(event.target.value as 'claude' | 'chatgpt')}><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select></label>
      <label>Label <span className="hint">Optional</span><input autoFocus maxLength={60} placeholder="Work or Personal" value={label} disabled={!!busy} onChange={event => setLabel(event.target.value)} /></label>
      <div className="row"><button className="primary" disabled={!!busy}>{busy ? 'Opening sign-in…' : provider === 'chatgpt' ? 'Continue with ChatGPT' : 'Connect subscription'}</button><button type="button" disabled={!!busy} onClick={() => setAdding(false)}>Cancel</button></div>
      <p className="hint">Saved separately from your other accounts. Choose where to use it below.</p>
    </form>}
    {(error || list.error) && <p className="error" role="alert">{error || list.error}{list.error && <button className="link" onClick={list.refresh}>Retry</button>}</p>}
  </div>
}

export function AgentAccount({ agent, onAgent }: { agent: Agent; onAgent: (agent: Agent) => void }) {
  const list = useAccounts(), global = list.accounts.find(account => account.id === list.globalId)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const id = agent.subscriptionAccountId || '', sourceId = id || list.globalId
  const chosen = list.accounts.find(account => account.id === sourceId)
  const sources = subscriptionSources(list.accounts)
  if (list.settings && !global && !id) sources.push({ id: sourceId, provider: list.settings.provider, label: 'Default API connection', ready: true, subscription: false })
  const catalog = useModelCatalog(sources)
  const source = sources.find(source => source.id === sourceId)
  const defaultModel = list.settings && source ? sourceLanes(list.settings, source)?.deep.model || list.settings.compat.model : ''
  const change = async (patch: { subscriptionAccountId?: string; model?: string }): Promise<void> => {
    setBusy(true); setError('')
    try { onAgent(await api.updateAgent(agent.id, patch)) } catch (error) { setError(message(error)) } finally { setBusy(false) }
  }
  return <section className="agent-account" aria-label="Agent subscription">
    <div className="inspector-section-head"><h3>AI for this agent</h3>{(id || agent.model) && <button className="link" disabled={busy} onClick={() => void change({ subscriptionAccountId: '', model: '' })}>Use global defaults</button>}</div>
    <label>Account<select aria-label="Agent subscription account" value={id} disabled={busy} onChange={event => void change({ subscriptionAccountId: event.target.value, model: '' })}>
      <option value="">Use global default{global ? ` (${accountLabel(global)})` : ''}</option>
      {id && !chosen && <option value={id}>Account unavailable — choose another</option>}
      {list.accounts.map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
    </select></label>
    <label>Model for chat & detailed answers<ModelPicker label="Agent model" groups={catalog.groups} sourceId={sourceId} model={agent.model} disabled={busy}
      inherit={`Use default${defaultModel ? ` (${defaultModel})` : ''}`} onInherit={() => void change({ model: '' })}
      onSelect={(source, model) => void change({ subscriptionAccountId: source.subscription ? source.id : '', model: model.id })} /></label>
    <p className="hint">{!id && !agent.model ? 'Follows global settings.' : 'Overrides global settings for this agent.'} Quick live suggestions use the fast task settings. Account changes apply to the next call.</p>
    {chosen && (!chosen.signedIn || chosen.signingIn || chosen.pending) && <div className="row">
      {chosen.signingIn || chosen.pending ? <><span className="hint">Finish signing in in your browser.</span><button className="ghost" onClick={() => void api.cancelAccountSignIn(chosen.id)}>Cancel sign-in</button></> : <button className="primary" disabled={busy} onClick={async () => {
        setBusy(true); setError('')
        try { await api.signInAccount(chosen.id) } catch (error) { setError(message(error)) } finally { setBusy(false) }
      }}>{chosen.provider === 'chatgpt' ? 'Continue with ChatGPT' : `Sign in to ${accountTitle(chosen)}`}</button>}
    </div>}
    {catalog.groups.find(group => group.source.id === sourceId)?.error && <p className="error" role="status">Could not load this account’s models. <button className="link" onClick={catalog.refresh}>Retry</button></p>}
    {(error || list.error) && <p className="error" role="alert">{error || list.error}</p>}
  </section>
}
