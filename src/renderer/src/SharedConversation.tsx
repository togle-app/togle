import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PhoneActivity, PhoneSessionReport, PhoneUsage } from '@shared/phone-report'
import { splitQuote } from '@shared/quote'
import { userMessageMarkdown } from '@shared/rich-text'
import { resetCountdown } from '@shared/runner-usage'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { QuoteBlock } from './Quote'
import { realTime, When } from './TaskThread'
import { Ticks } from './Ticks'

/** Only the open conversation is read. Finish the current read before refreshing it again. */
export function useSharedConversation(device: string, task: string, revision: number, enabled: boolean) {
  const [report, setReport] = useState<PhoneSessionReport | null>()
  const request = useRef<() => void>(undefined)
  const previousRevision = useRef(revision)
  useEffect(() => {
    setReport(undefined)
    if (!enabled) return
    let active = true
    let pending = false
    let refreshAgain = false
    const refresh = async () => {
      if (!active || document.hidden) return
      if (pending) {
        refreshAgain = true
        return
      }
      pending = true
      refreshAgain = false
      try {
        const value = await window.togle.reachSession(device, task)
        if (active) setReport(value)
      } catch {
        if (active) setReport(null)
      } finally {
        pending = false
        if (refreshAgain) void refresh()
      }
    }
    const read = () => { void refresh() }
    request.current = read
    read()
    const timer = window.setInterval(read, 60_000)
    document.addEventListener('visibilitychange', read)
    return () => {
      active = false
      request.current = undefined
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', read)
    }
  }, [device, task, enabled])
  useEffect(() => {
    if (previousRevision.current === revision) return
    previousRevision.current = revision
    request.current?.()
  }, [revision])
  return { report: enabled ? report : undefined, retry: () => request.current?.() }
}

export function SharedUsage({ usage, now }: { usage: PhoneUsage; now: number }) {
  return (
    <span className="task-agent-usage" role="group" aria-label="Agent usage">
      <span className="usage-session">
        <span className="usage-caption"><Icon name="usage" size={13} />This session</span>
        <span className="usage-value">{usage.readings.length ? usage.readings.join(' · ') : 'Not reported'}</span>
      </span>
      {usage.limits.length > 0 && (
        <span className="usage-account" role="group" aria-label="Account limits">
          <span className="usage-caption"><Icon name="clock" size={13} />Account limits</span>
          <span className="usage-windows">
            {usage.limits.map((limit, index) => (
              <span className="usage-window" key={index}>
                <span className="window-name">{limit.label}</span>
                <strong>{Number(limit.usedPercent.toFixed(1))}% used</strong>
                {limit.resetsAt && <small>{resetCountdown(limit.resetsAt, now)}</small>}
              </span>
            ))}
          </span>
        </span>
      )}
    </span>
  )
}

function Message({ entry }: { entry: PhoneActivity }) {
  const time = realTime(entry.at) ? <When at={entry.at} /> : null
  if (entry.kind === 'work') return <p className="hint shared-work">{entry.text}</p>
  if (entry.kind === 'agent') return (
    <div className="turn">
      <div className="task-agent"><Markdown text={entry.text} /></div>
      {time}
    </div>
  )
  const quoted = splitQuote(entry.text)
  return (
    <div className="you-row">
      <div className="you-head">
        <span className="you-label">You</span>
        {time}
        {entry.delivery && <Ticks state={entry.delivery === 'delivered' ? 'taken' : 'sent'}
          label={entry.delivery === 'delivered' ? 'Delivered to agent' : 'Sent to host'} />}
      </div>
      <div className="task-you whole">
        {quoted && <QuoteBlock text={quoted.quote} />}
        <Markdown text={userMessageMarkdown(quoted?.reply ?? entry.text)} />
      </div>
    </div>
  )
}

export function SharedConversation({ activity }: { activity: PhoneActivity[] }) {
  const log = useRef<HTMLDivElement>(null)
  const followsLatest = useRef(true)
  useLayoutEffect(() => {
    if (log.current && followsLatest.current) log.current.scrollTop = log.current.scrollHeight
  }, [activity])
  if (!activity.length) return <p className="hint">No messages shared for this session.</p>
  return (
    <div ref={log} className="task-log thread" role="log" aria-label="Conversation" aria-live="off" tabIndex={0}
      onScroll={({ currentTarget: box }) => { followsLatest.current = box.scrollHeight - box.clientHeight - box.scrollTop < 48 }}>
      {activity.map((entry, index) => <Message key={entry.id ?? index} entry={entry} />)}
    </div>
  )
}
