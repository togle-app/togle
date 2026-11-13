import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, CallSearchHit, CallSession, CallSessionSummary } from '@shared/types'
import { namesToConfirm } from '@shared/confirm-names'
import { CallNotes } from './CallNotes'
import { callLength, CallTranscript } from './CallTranscript'
import { ConfirmNames } from './ConfirmNames'
import { Icon } from './Icon'
import { Menu } from './Menu'
import { NoisyMicrophone, type NoiseFinding } from './StudioMention'
import type { TogleMicrophoneStatus } from '@shared/microphone'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`
const day = 24 * 3600_000

/** When a call was, the way a person says it: today's time, "Yesterday", a weekday this week, else the date. */
export function whenText(startedAt: number, now = Date.now()): string {
  const start = new Date(startedAt), today = new Date(now)
  const midnight = (date: Date): number => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((midnight(today) - midnight(start)) / day)
  if (days <= 0) return `Today ${start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
  if (days === 1) return 'Yesterday'
  if (days < 7) return start.toLocaleDateString([], { weekday: 'long' })
  return start.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const named = (call: Pick<CallSessionSummary, 'title'>): boolean => !!call.title.trim() && call.title !== 'Untitled call'
export const meetingTitle = (call: Pick<CallSessionSummary, 'title' | 'startedAt'>): string => named(call) ? call.title : `Call on ${new Date(call.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`

/** What a row says about a call after when it was: how long, and what is left to do with it. */
export function meetingState(call: CallSessionSummary, now = Date.now()): string {
  if (call.status === 'live') return 'live'
  const length = callLength((call.endedAt ?? call.startedAt) - call.startedAt)
  const toConfirm = namesToConfirm(call.confirm, now)
  const state = call.status === 'interrupted' ? 'interrupted' : toConfirm ? `${plural(toConfirm, 'name', 'names')} to confirm` : call.minutes?.state === 'generating' ? 'writing the notes' : 'done'
  return `${length} · ${state}`
}

/** A call's dot, as the design colors it: indigo while live, amber while something is left for you, green when done. */
export function meetingDot(call: CallSessionSummary, now = Date.now()): 'work' | 'wait' | 'done' | 'gone' {
  if (call.status === 'live') return 'work'
  if (call.status === 'interrupted') return 'gone'
  return namesToConfirm(call.confirm, now) || call.minutes?.state === 'generating' ? 'wait' : 'done'
}

interface Props {
  agents: Agent[]
  /** The call going on now, if any. */
  liveId?: string
  onOpenLive: () => void
  /** Starts writing a call down at once. */
  onWriteDown: () => void
  /** A call to open (from outside, such as a row on the to-do list): `seq` makes the same call open again. */
  focus?: { id: string; seq: number }
  /** After a call in a loud room: what the microphone picked up, for that call's page. */
  noise?: { callId: string; finding: NoiseFinding }
  microphone?: TogleMicrophoneStatus
  /** Meetings was pressed in the sidebar: the list shows again. */
  home?: number
}

/**
 * The calls Togle wrote down, newest first, with what is left to do for each: names to confirm, notes to read. Search
 * looks in what was said. A call opens to its notes and its transcript, and can be given to an agent or shared.
 */
export function MeetingsPage({ agents, liveId, onOpenLive, onWriteDown, focus, noise, microphone, home }: Props) {
  const [calls, setCalls] = useState<CallSessionSummary[] | null>(null)
  const [openId, setOpenId] = useState<string>()
  const [openTab, setOpenTab] = useState<'notes' | 'transcript'>('notes')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CallSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const open = openId
  // The list, kept up to date while it shows. With a call open, other calls changing don't reload it: going back does.
  useEffect(() => {
    if (open) return
    let current = true
    const load = (): void => { void api.callSessions().then(list => { if (current) setCalls(list) }).catch(failure => { if (current) setError(errorText(failure)) }) }
    load()
    const stop = api.onCallSessions(() => load())
    return () => { current = false; stop() }
  }, [open])
  useEffect(() => { setOpenId(undefined) }, [home])
  useEffect(() => { if (focus?.id) { setOpenId(focus.id); setOpenTab('notes') } }, [focus?.id, focus?.seq])
  useEffect(() => {
    const text = query.trim()
    if (!text) { setHits(null); setSearching(false); return }
    let current = true
    setSearching(true)
    const timer = setTimeout(() => {
      void api.searchCalls(text).then(found => { if (current) { setHits(found); setError('') } }).catch(failure => { if (current) setError(errorText(failure)) }).finally(() => { if (current) setSearching(false) })
    }, 250)
    return () => { current = false; clearTimeout(timer) }
  }, [query])
  const now = Date.now()
  const rows = useMemo(() => [...(calls ?? [])].sort((a, b) => Number(b.status === 'live') - Number(a.status === 'live') || b.startedAt - a.startedAt), [calls])
  if (open) return <MeetingDetail id={open} noise={noise?.callId === open ? noise.finding : undefined} microphone={microphone} agents={agents} tab={openTab} onTab={setOpenTab} onDeleted={() => setOpenId(undefined)} />
  return (
    <div className="meetings call-history">
      <div className="meetings-top">
        <input className="history-search" aria-label="Search what was said" placeholder="Search what was said" value={query} onChange={event => setQuery(event.target.value)} />
        <button className="primary" disabled={!!liveId} title={liveId ? 'A call is being written down' : 'Start writing down a call now'} onClick={onWriteDown}>Write down now</button>
      </div>
      {hits ? (
        <div className="call-history-list" aria-label="Search results">
          {searching && <p className="hint" role="status">Searching…</p>}
          {hits.map(hit => (
            <button key={hit.id} className="past-call-row meeting-row" aria-label={`Open call: ${meetingTitle(hit)}`} onClick={() => { setOpenId(hit.id); setOpenTab(hit.lines.length ? 'transcript' : 'notes') }}>
              <span className="meeting-dot done" aria-hidden="true" />
              <strong>{meetingTitle(hit)}</strong>
              <span>{whenText(hit.startedAt, now)}</span>
              {hit.lines.map(line => <span key={line.at} className="past-call-preview"><b>{line.who}:</b> {line.text}</span>)}
            </button>
          ))}
          {!hits.length && !searching && <p className="hint">Nothing said in your recent calls has these words.</p>}
        </div>
      ) : calls === null ? <p className="hint" role="status">Loading calls…</p> : (
        <div className="call-history-list">
          {rows.map(call => (
            <button key={call.id} className={`past-call-row meeting-row ${call.status === 'live' ? 'live-record' : ''}`} aria-label={`Open call: ${meetingTitle(call)}`} onClick={() => call.status === 'live' && call.id === liveId ? onOpenLive() : (setOpenId(call.id), setOpenTab('notes'))}>
              <span className={`meeting-dot ${meetingDot(call, now)}`} aria-hidden="true" />
              <strong>{meetingTitle(call)}</strong>
              <span>{whenText(call.startedAt, now)} · {meetingState(call, now)}</span>
            </button>
          ))}
          {!rows.length && <div className="history-empty"><h3>No calls yet</h3><p>Write down a call and it shows here, with its notes and who spoke.</p></div>}
        </div>
      )}
      {error && <p className="error" role="status">{error}</p>}
    </div>
  )
}

function MeetingDetail({ id, noise, microphone, tab, onTab, onDeleted }: { id: string; noise?: NoiseFinding; microphone?: TogleMicrophoneStatus; agents: Agent[]; tab: 'notes' | 'transcript'; onTab: (tab: 'notes' | 'transcript') => void; onDeleted: () => void }) {
  const [record, setRecord] = useState<CallSession | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [copied, setCopied] = useState(false)
  const selected = useRef(id)
  selected.current = id
  const load = useCallback(() => { void api.callSession(id).then(found => { if (selected.current === id) { setRecord(found); if (!found) setError('This call is no longer available.') } }).catch(failure => setError(errorText(failure))) }, [id])
  useEffect(() => {
    setRecord(null); setError(''); load()
    const stop = api.onCallSessions(change => { if (!change?.id || change.id === id) load() })
    return stop
  }, [id, load])
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (failure) { setError(errorText(failure)) } finally { setBusy(false) }
  }
  const ended = !!record && record.status !== 'live'
  return (
    <div className="meetings meeting-detail call-history">
      {!record ? <p className="hint" role="status">{error || 'Loading call…'}</p> : <>
        <div className="call-detail-head">
          <h2 title={`${whenText(record.startedAt)} · ${callLength((record.endedAt ?? record.transcript.at(-1)?.at ?? record.startedAt) - record.startedAt)}`}>{meetingTitle(record)}</h2>
          <div className="call-record-actions">
            <Menu className="ghost" ariaLabel="Share" title="Share this call" label="Share" items={[
              { label: copied ? 'Copied' : 'Copy the notes', disabled: busy || !record.summary, keepOpen: false, onSelect: () => void navigator.clipboard.writeText(record.summary).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, failure => setError(errorText(failure))) },
              { label: 'Save as a file', disabled: busy, onSelect: () => void run(async () => { await api.exportCallSession(record.id) }) }
            ]} />
            <button className="primary" disabled={busy || !ended} title={ended ? 'Start a task for a coding agent with this call attached' : 'End the call first'} onClick={() => void run(() => api.giveCallToAgent(record.id))}>Give to an agent</button>
            <Menu className="ghost icon-menu" ariaLabel="Call options" title="Rename or delete this call" label="⋯" items={[
              { label: 'Rename', disabled: busy, onSelect: () => { setTitle(record.title); setEditing(!editing) } },
              'divider',
              { label: 'Delete call', danger: true, disabled: busy || record.status === 'live', onSelect: () => setDeleting(!deleting) }
            ]} />
          </div>
        </div>
        {editing && <form className="rename-call" onSubmit={event => { event.preventDefault(); void run(async () => { setRecord(await api.renameCallSession(record.id, title)); setEditing(false) }) }}>
          <label>Call title<input aria-label="Call title" value={title} maxLength={140} onChange={event => setTitle(event.target.value)} autoFocus /></label>
          <button className="primary" disabled={busy || !title.trim()}>Save title</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
        </form>}
        {deleting && <div className="notice ask"><span>Delete this call’s notes and transcript from this computer? This can’t be undone.</span><div className="row"><button disabled={busy} onClick={() => setDeleting(false)}>Keep call</button><button className="primary stop" disabled={busy} onClick={() => void run(async () => { await api.deleteCallSession(record.id); onDeleted() })}>Delete call</button></div></div>}
        {ended && noise && <NoisyMicrophone finding={noise} microphone={microphone} minutes={((record.endedAt ?? record.startedAt) - record.startedAt) / 60_000} />}
        {ended && <ConfirmNames key={`confirm-${record.id}`} record={record} onRecord={setRecord} />}
        <div className="tabs call-detail-tabs" role="tablist" aria-label="Call details">
          {(['notes', 'transcript'] as const).map(name => <button key={name} role="tab" id={`meeting-tab-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} onClick={() => onTab(name)}>{name === 'notes' ? 'Notes' : 'Transcript'}</button>)}
        </div>
        <section className="call-detail-content" role="tabpanel" aria-labelledby={`meeting-tab-${tab}`}>
          {tab === 'notes' ? <CallNotes key={`notes-${record.id}`} record={record} onRecord={setRecord} /> : <CallTranscript key={record.id} record={record} />}
        </section>
      </>}
      {error && record && <p className="error" role="status">{error}</p>}
    </div>
  )
}
