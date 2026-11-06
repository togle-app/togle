import { useEffect, useState } from 'react'
import { dueMeeting, type CalendarMeeting, type CalendarStatus } from '@shared/meeting'
import type { Agent } from '@shared/types'
import { Row, Section, Toggle } from './Rows'
import { accountLabel, useAccounts } from './Accounts'

const api = window.togle
const EMPTY: CalendarStatus = { state: 'off', events: [] }

function useCalendar(agentId?: string): CalendarStatus {
  const [status, setStatus] = useState<CalendarStatus>(EMPTY)
  useEffect(() => {
    let active = true, received = false
    const unsub = api.onCalendarStatus(value => { if (value.agentId !== agentId) return; received = true; if (active) setStatus(value) })
    void api.calendarStatus(agentId).then(value => { if (active && !received && value && Array.isArray(value.events)) setStatus(value) }).catch(() => {})
    return () => { active = false; unsub() }
  }, [agentId])
  return status
}

export function MeetingNotice({ listening, onStart }: { listening: boolean; onStart: (event: CalendarMeeting) => void }) {
  const status = useCalendar()
  const [now, setNow] = useState(Date.now())
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer) }, [])
  const event = dueMeeting(status.events, now, dismissed)
  if (listening || !event || status.state === 'off' || status.state === 'needs-connection') return null
  return <div className="meeting-notice" role="status">
    <span><strong>{event.title}</strong><span className="hint">{event.agentName && `${event.agentName} · `}{event.start > now ? `Starts in ${Math.max(1, Math.ceil((event.start - now) / 60_000))} min` : 'Scheduled now'}</span></span>
    <button className="primary small" onClick={() => onStart(event)}>Start assistance</button>
    <button className="link" onClick={() => { setDismissed(previous => new Set([...previous, event.id])); void api.dismissMeeting(event.id) }}>Dismiss</button>
  </div>
}

export function CalendarSettings({ agent, onAgent }: { agent: Agent; onAgent: (agent: Agent) => void }) {
  const status = useCalendar(agent.id), accounts = useAccounts()
  const [settingUp, setSettingUp] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const enabled = agent.calendar?.enabled === true, accountId = agent.calendar?.accountId || ''
  const save = async (enabled: boolean, id = accountId): Promise<void> => {
    if (enabled && !id) { setSettingUp(true); return }
    setSaving(true); setError('')
    try { onAgent(await api.updateAgent(agent.id, { calendar: { enabled, accountId: id } })); setSettingUp(false) }
    catch (error) { setError((error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')) }
    finally { setSaving(false) }
  }
  const checking = refreshing || status.state === 'checking'
  const needsConnection = status.state === 'needs-connection'
  const upcoming = status.events.filter(event => event.end > Date.now()).sort((a, b) => a.start - b.start)
  const refresh = async (): Promise<void> => {
    if (refreshing) return
    setError(''); setRefreshing(true)
    try { await api.refreshCalendar(agent.id) }
    catch { setError('Could not refresh the calendar. Try again.') }
    finally { setRefreshing(false) }
  }
  return <Section id="agent-calendar" title="Meeting reminders">
    <Toggle name="Remind me before meetings" note={`Offer ${agent.name} five minutes before a meeting. You choose when assistance starts.`} checked={enabled} disabled={saving} onChange={value => { if (!value) setSettingUp(false); void save(value) }} />
    {(enabled || settingUp) && <>
      <Row stacked name="Calendar account" note="This agent reads the calendar connected to this Claude account."><select aria-label="Agent calendar account" value={accountId} disabled={saving} onChange={event => void save(true, event.target.value)}>
        <option value="" disabled>Choose a Claude account to enable reminders</option>
        {accountId && !accounts.accounts.some(account => account.id === accountId) && <option value={accountId}>Account unavailable — choose another</option>}
        {accounts.accounts.filter(account => account.provider === 'claude').map(account => <option key={account.id} value={account.id}>{accountLabel(account)}</option>)}
      </select></Row>
      {!enabled && <p className="hint model-status">Choose an account to turn reminders on for this agent.</p>}
      {enabled && <>
      <div className="calendar-connection" aria-busy={checking && !needsConnection}>
        <div role="status"><strong>{needsConnection ? 'Connect your calendar' : checking ? 'Checking calendar…' : status.state === 'off' ? 'Check your calendar' : status.state === 'error' ? 'Calendar needs attention' : 'Calendar connected'}</strong>
          <span>{status.account ? `${status.account} · via Claude` : 'Uses your calendar connection in Claude.'}</span>
          {!checking && status.state === 'ready' && <span>{upcoming.length ? `${upcoming.length} upcoming meeting${upcoming.length === 1 ? '' : 's'}` : 'No meetings in the next 24 hours.'}</span>}
        </div>
        {!needsConnection && <button className="link" aria-label="Refresh calendar" disabled={checking} onClick={() => void refresh()}>{status.state === 'error' ? 'Retry' : 'Refresh'}</button>}
      </div>
      {needsConnection && <div className="calendar-setup"><button className="ghost" onClick={() => void api.openExternal('https://claude.ai/customize/connectors')}>Connect calendar in Claude</button><button className="link" disabled={refreshing} onClick={() => void refresh()}>Check connection</button></div>}
      {status.state === 'error' && <p className="error" role="alert">{error || status.error || 'Could not read your calendar.'}</p>}
      {!!upcoming.length && <ul className="calendar-upcoming" aria-label={status.state === 'error' ? 'Last synced meetings' : 'Upcoming meetings'}>
        {status.state === 'error' && <li className="hint">Last synced meetings</li>}
        {upcoming.slice(0, 3).map(event => <li key={event.id}><span>{event.title}</span><time dateTime={new Date(event.start).toISOString()}>{new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(event.start)}</time></li>)}
      </ul>}
      <details className="more calendar-details"><summary>Calendar connection</summary><p className="hint">Uses your Claude plan to check every 15 minutes while idle. Checks pause during calls.</p><button className="link" onClick={() => void api.openExternal('https://claude.ai/customize/connectors')}>Manage connection in Claude</button></details>
      </>}
    </>}
    {error && status.state !== 'error' && <p className="error" role="alert">{error}</p>}
  </Section>
}
