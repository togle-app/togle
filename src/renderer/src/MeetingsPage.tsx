import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, CallSearchHit, CallSession, CallSessionSummary } from '@shared/types'
import { namesToConfirm } from '@shared/confirm-names'
import { CallNotes } from './CallNotes'
import { callLength, HistoryTranscript } from './CallHistory'
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
}

/**
 * The calls Togle wrote down, newest first, with what is left to do for each: names to confirm, notes to read. Search
 * looks in what was said. A call opens to its notes and its transcript, and can be given to an agent or shared.
 */
export function MeetingsPage({ agents, liveId, onOpenLive, onWriteDown, focus, noise, microphone }: Props) {
  const [calls, setCalls] = useState<CallSessionSummary[] | null>(null)
  const [openId, setOpenId] = useState<string>()
  const [openTab, setOpenTab] = useState<'notes' | 'transcript'>('notes')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<CallSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const open = openId
  useEffect(() => {
    let current = true
    const load = (): void => { void api.callSessions().then(list => { if (current) setCalls(list) }).catch(failure => { if (current) setError(errorText(failure)) }) }
    load()
    const stop = api.onCallSessions(() => load())
    return () => { current = false; stop() }
  }, [])
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
  if (open) return <MeetingDetail id={open} noise={noise?.callId === open ? noise.finding : undefined} microphone={microphone} agents={agents} tab={openTab} onTab={setOpenTab} onBack={() => setOpenId(undefined)} onDeleted={() => setOpenId(undefined)} />
  return (
    <div className="meetings call-history">
      <div className="page-head"><h2>Meetings</h2><span className="spacer" /><button className="primary" disabled={!!liveId} title={liveId ? 'A call is being written down' : 'Start writing down a call now'} onClick={onWriteDown}>Write down now</button></div>
      <p className="hint">Togle hears both sides of a call on this computer and writes it down. Your AI writes the notes when the call ends.</p>
      <div className="history-filters"><input className="history-search" aria-label="Search what was said" placeholder="Search what was said" value={query} onChange={event => setQuery(event.target.value)} /></div>
      {hits ? (
        <div className="call-history-list" aria-label="Search results">
          {searching && <p className="hint" role="status">Searching…</p>}
          {hits.map(hit => (
            <button key={hit.id} className="past-call-row meeting-row" aria-label={`Open call: ${meetingTitle(hit)}`} onClick={() => { setOpenId(hit.id); setOpenTab(hit.lines.length ? 'transcript' : 'notes') }}>
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

function MeetingDetail({ id, noise, microphone, agents, tab, onTab, onBack, onDeleted }: { id: string; noise?: NoiseFinding; microphone?: TogleMicrophoneStatus; agents: Agent[]; tab: 'notes' | 'transcript'; onTab: (tab: 'notes' | 'transcript') => void; onBack: () => void; onDeleted: () => void }) {
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
      <div className="page-head call-breadcrumb"><button className="ghost" aria-label="Back to Meetings" onClick={onBack}><Icon name="back" size={14} />Meetings</button></div>
      {!record ? <p className="hint" role="status">{error || 'Loading call…'}</p> : <>
        <div className="call-detail-head">
          <h2>{meetingTitle(record)}</h2>
          <p className="hint">{whenText(record.startedAt)} · {record.status === 'live' ? 'live' : callLength((record.endedAt ?? record.transcript.at(-1)?.at ?? record.startedAt) - record.startedAt)}{ended && ` · ${record.toldOthers ? 'you told the others it was written down' : 'you did not tick “I told them”'}`}</p>
          <div className="call-record-actions">
            <button className="primary" disabled={busy || !ended} title={ended ? 'Start a task for a coding agent with this call attached' : 'End the call first'} onClick={() => void run(() => api.giveCallToAgent(record.id))}>Give to an agent</button>
            <Menu className="ghost" ariaLabel="Share" title="Share this call" label={<>Share <Icon name="chevron" size={12} /></>} items={[
              { label: copied ? 'Copied' : 'Copy the notes', disabled: busy || !record.summary, keepOpen: false, onSelect: () => void navigator.clipboard.writeText(record.summary).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, failure => setError(errorText(failure))) },
              { label: 'Save as a file', disabled: busy, onSelect: () => void run(async () => { await api.exportCallSession(record.id) }) }
            ]} />
            <Menu className="ghost" ariaLabel="Call options" title="Call options" label={<>More <Icon name="chevron" size={12} /></>} items={[
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
          {tab === 'notes' ? <CallNotes key={`notes-${record.id}`} record={record} onRecord={setRecord} canGenerate /> : <HistoryTranscript key={record.id} record={record} onRecord={setRecord} />}
        </section>
      </>}
      {error && record && <p className="error" role="status">{error}</p>}
    </div>
  )
}
