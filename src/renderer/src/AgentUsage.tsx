import { useEffect, useState } from 'react'
import type { RunnerStatus } from '@shared/runner'
import { formatAgentMoney, resetCountdown, type RunnerUsage, type UsageWindow } from '@shared/runner-usage'
import { AgentMark } from './AgentMark'
import { Icon } from './Icon'
import { KeptDetails, useKeptState } from './kept'

const watchers = new Set<() => void>()
let timer: number | undefined
function refreshVisible() {
  if (!document.hidden) for (const refresh of watchers) refresh()
}
function watchMinute(refresh: () => void) {
  if (!watchers.size) {
    timer = window.setInterval(refreshVisible, 60_000)
    document.addEventListener('visibilitychange', refreshVisible)
  }
  watchers.add(refresh)
  if (!document.hidden) refresh()
  return () => {
    watchers.delete(refresh)
    if (!watchers.size) {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }
}

function useAgentUsage(runner: string, sessionId?: string) {
  const [reading, setReading] = useKeptState<RunnerUsage | undefined>('usage:' + JSON.stringify([runner, sessionId]), undefined)
  useEffect(() => {
    let active = true, busy = false
    const unsubscribe = watchMinute(async () => {
      if (busy) return
      busy = true
      try {
        const value = await window.togle.runnerUsage(runner, sessionId)
        if (value.kind === 'unavailable' && value.reason === 'temporary') throw new Error('Temporarily unavailable')
        if (active) setReading(value)
      } catch {
        if (active) setReading(old => old ?? { kind: 'unavailable', reason: 'temporary' })
      }
      finally { busy = false }
    })
    return () => { active = false; unsubscribe() }
  }, [runner, sessionId, setReading])
  return reading
}

const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const exact = new Intl.NumberFormat()
const costScope = { session: 'API cost reported for this session', 'api-tasks': 'API cost for tasks this agent started in Togle',
  'agent-sessions': 'Cost this agent reported to Togle for its sessions', 'hermes-history': 'API cost from Hermes session history' }

export function AgentUsage({ runner, sessionId, hideUnavailable = false }: { runner: string; sessionId?: string; hideUnavailable?: boolean }) {
  const value = useAgentUsage(runner, sessionId)
  if (!value) return null
  if (value.kind === 'providers') return <span className="usage-sources" aria-label={value.period === 'session' ? 'Providers used in this session' : 'Providers used by this agent'}>
    {value.sources.map(source => <span className="usage-source" key={JSON.stringify([source.provider, source.billing])}>
      <span>{source.provider}{source.billing === 'subscription' ? ' subscription' : source.billing === 'api' ? ' API' : ''}</span>
      <strong title={exact.format(source.tokens) + ' recorded tokens'}>{source.cost ? (source.estimated ? '≈ ' : '') + formatAgentMoney(source.cost) : compact.format(source.tokens) + ' tokens'}</strong>
    </span>)}
  </span>
  if (value.kind === 'tokens') {
    const scope = value.period === '7d' ? 'Last 7 days' : value.period === 'all' ? 'All time' : 'This session'
    const estimate = value.period === 'all' && value.apiEstimate ? '≈ ' + formatAgentMoney(value.apiEstimate) + (value.partial ? ' partial API estimate' : ' estimated API cost') : ''
    const api = value.period === 'all' ? undefined : value.trackedApi
    const detail = [scope + ' · ' + exact.format(value.total) + ' recorded tokens',
      'Includes cached input reported by the agent.', estimate].filter(Boolean).join('\n')
    return <span className="usage-value" title={detail}>
      <span className="usage-count">{value.period === '7d' && <small>7d </small>}<span><strong>{compact.format(value.total)}</strong> tokens</span></span>
      {value.period === 'all' && <small>All time{estimate && ' · ' + estimate}</small>}
      {api && <small title={costScope[api.scope]}>{api.estimated && '≈ '}{api.amounts.map(formatAgentMoney).join(' + ')} tracked API cost{api.partial && ' · partial'}</small>}
    </span>
  }
  if (value.kind === 'cost' && value.amounts.length) {
    const money = value.amounts.map(formatAgentMoney).join(' + ')
    return <span className="usage-value" title={[costScope[value.scope], value.estimated && 'Estimate', value.partial && 'Partial total'].filter(Boolean).join(' · ')}>
      <strong>{value.estimated && '≈ '}{money}</strong><small>{value.scope === 'agent-sessions' || runner.startsWith('acp-') ? 'Reported cost' : 'API cost'}{value.partial && ' · partial'}</small>
    </span>
  }
  return hideUnavailable ? null : <span className="usage-empty" title="No usage reading is available for this scope">Not reported</span>
}

export function AccountLimits({ runner, folded = false }: { runner: string; folded?: boolean }) {
  const [value, setWindows] = useKeptState<UsageWindow[] | undefined>('account-limits:' + runner, undefined)
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    let live = true, received = false
    const off = window.togle.onRunnerLimitsChanged(event => {
      if (event.runner === runner) { received = true; setWindows(event.windows); setNow(Date.now()) }
    })
    void window.togle.runnerLimits(runner).then(windows => {
      if (live && !received) setWindows(windows)
    }).catch(() => undefined)
    const stopClock = watchMinute(() => setNow(Date.now()))
    return () => { live = false; off(); stopClock() }
  }, [runner, setWindows])
  if (!value?.length) return null
  const windows = value.toSorted((a, b) => Number(b.label === 'weekly') - Number(a.label === 'weekly'))
  const limits = <span className="usage-windows">{windows.map((w, i) =>
    <span className="usage-window" key={w.label + i} title={w.resetsAt ? 'Account limit resets ' + new Date(w.resetsAt).toLocaleString() : undefined}>
      {w.provider && <span>{w.provider}</span>} <span className="window-name">{w.label}</span> <strong>{Number(w.usedPercent.toFixed(1))}% used</strong>
      {w.resetsAt && <small>{resetCountdown(w.resetsAt, now)}</small>}
    </span>)}</span>
  return folded ? <KeptDetails name={'agents.limits:' + runner} className="usage-account-fold" summary={<>Account limits <Icon name="chevron" size={11} /></>}>{limits}</KeptDetails>
    : <span className="usage-account" role="group" aria-label="Account limits"><span className="usage-caption"><Icon name="clock" size={13} />Account limits</span>{limits}</span>
}

export function AgentUsageList({ agents }: { agents: RunnerStatus[] }) {
  if (!agents.length) return null
  return <KeptDetails name="agents.usage" className="agent-usage-list" summary={<><Icon name="usage" size={16} /><span>Agent usage</span><Icon name="chevron" size={14} /></>}>
    <div className="agent-usage-rows">{agents.map(agent => <div className="agent-usage-row" key={agent.runner}>
      <AgentMark runner={agent.runner} name={agent.name} /><AgentUsage runner={agent.runner} />
      <AccountLimits runner={agent.runner} folded />
    </div>)}</div>
  </KeptDetails>
}
