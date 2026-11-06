import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent, CallSession, CallSessionSummary } from '@shared/types'
import { lessonCount, lessonItems } from '@shared/learning'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { Menu } from './Menu'
import { SpeakerName } from './CallPeople'
import { speakerLabel } from '@shared/meeting'
import { speechTurns } from '@shared/speakers'
import { CallNotes } from './CallNotes'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
type Tab = 'overview' | 'transcript' | 'suggestions' | 'learning'
const TABS: Tab[] = ['overview', 'transcript', 'suggestions', 'learning']
const TAB_LABELS: Record<Tab, string> = { overview: 'Overview', transcript: 'Transcript', suggestions: 'Replies', learning: 'Learning' }
const CALLS_PER_PAGE = 100
const LINES_PER_PAGE = 100
const REPLIES_PER_PAGE = 25

interface Props {
  agents: Agent[]
  enabled: boolean
  onDone: () => void
  selectedId?: string
  onSelect: (id: string | undefined) => void
  /** Omitted only for the retained records of removed agents, reached through Settings. */
  ownerId?: string
  currentCallId?: string
  currentCallTitle?: string
  onOpenCurrent?: () => void
  onAgent: (agent: Agent) => void
  onAsk?: (call: CallSession, question: string) => void
  asking?: boolean
}

export function CallHistory({ agents, enabled, onDone, selectedId, onSelect, ownerId, currentCallId, currentCallTitle = 'Current call', onOpenCurrent, onAgent, onAsk, asking }: Props) {
  const [calls, setCalls] = useState<CallSessionSummary[] | null>(null)
  const selected = selectedId ?? null
  const setSelected = (id: string | null): void => onSelect(id ?? undefined)
  const [record, setRecord] = useState<CallSession | null>(null)
  const [tab, setTab] = useState<Tab>(selectedId ? 'learning' : 'overview')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(CALLS_PER_PAGE)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [exported, setExported] = useState(false)
  const selection = useRef(selected)
  selection.current = selected
  useEffect(() => {
    let current = true
    let request = 0
    const load = async (): Promise<void> => {
      const seq = ++request
      try {
        const id = selection.current
        // An open record doesn't need the whole list again. Another live call changing doesn't redraw this transcript.
        const [list, detail] = await Promise.all([id ? null : api.callSessions(), id ? api.callSession(id) : null])
        if (!current || seq !== request) return
        if (list) setCalls(list)
        if (id) {
          const owned = detail && (!ownerId || detail.agentId === ownerId) ? detail : null
          setRecord(owned)
          if (!owned) setError('This call is no longer available for this agent.')
        }
      } catch (error) { if (current) setError(errorText(error)) }
    }
    void load()
    const unsubscribe = api.onCallSessions(change => {
      if (!selection.current || !change?.id || change.id === selection.current) void load()
    })
    return () => { current = false; unsubscribe() }
  }, [selected, ownerId])
  useEffect(() => {
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      if (deleting) setDeleting(false)
      else if (editing) setEditing(false)
      else if (selected) { setSelected(null); setRecord(null) }
      else onDone()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [selected, deleting, editing, onDone])
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  const open = (id: string): void => { setRecord(null); setSelected(id); setTab('overview'); setEditing(false); setDeleting(false); setExported(false); setError('') }
  const installedIds = useMemo(() => new Set(agents.map(agent => agent.id)), [agents])
  const matching = useMemo(() => {
    const search = query.trim().toLocaleLowerCase()
    return (calls ?? []).filter(call => (ownerId ? call.agentId === ownerId : !installedIds.has(call.agentId)) && (!search || `${call.title} ${call.brief} ${call.summary} ${call.agentName}`.toLocaleLowerCase().includes(search))).sort((a, b) => Number(b.status === 'live') - Number(a.status === 'live') || b.startedAt - a.startedAt)
  }, [calls, ownerId, query, installedIds])
  const agent = record ? agents.find(agent => agent.id === record.agentId) : undefined
  const localRuntime = !!ownerId && !!currentCallId && !!onOpenCurrent && calls !== null && !calls.some(call => call.id === currentCallId)
  const matchingRuntime = localRuntime && (!query.trim() || currentCallTitle.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const hasOwnedCalls = localRuntime || !!calls?.some(call => ownerId ? call.agentId === ownerId : !installedIds.has(call.agentId))
  const ownerName = agents.find(agent => agent.id === ownerId)?.name ?? record?.agentName ?? 'Agent'
  const named = (call: Pick<CallSessionSummary, 'title'>): boolean => !!call.title.trim() && call.title !== 'Untitled call'
  const callTitle = (call: Pick<CallSessionSummary, 'title' | 'startedAt'>): string => named(call) ? call.title : `Call on ${new Date(call.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
  return <div className="call-history agent-calls">
    {!ownerId && !selected && <><div className="page-head"><button className="icon" aria-label="Back to Settings" onClick={onDone}><Icon name="back" /></button><h2>Calls from removed agents</h2></div><p className="hint">These records remain available after their agent is deleted.</p></>}
    {selected && <div className="page-head call-breadcrumb">
      <button className="ghost" aria-label={ownerId ? `Back to ${ownerName} calls` : 'Back to archived calls'} onClick={() => { setSelected(null); setRecord(null); setError('') }}><Icon name="back" size={14} />{ownerId ? `${ownerName} / Calls` : 'Calls from removed agents'}</button>
    </div>}
    {selected ? record ? <>
      <div className="call-detail-head">
        <h2>{callTitle(record)}</h2>
        <p className="hint">{new Date(record.startedAt).toLocaleString()} · {!ownerId && `${record.agentName} · `}{record.status === 'live' ? 'Live' : record.status === 'interrupted' ? 'Interrupted' : 'Ended'}</p>
        <div className="call-record-actions">
          {record.id === currentCallId && onOpenCurrent && <button className="primary" disabled={busy} onClick={onOpenCurrent}>{record.status === 'live' ? 'Return to live call' : 'Ask about call'}</button>}
          <Menu className="ghost" ariaLabel="Call options" title="Call options" label={<>More <Icon name="chevron" size={12} /></>} items={[
            { label: 'Rename', disabled: busy, onSelect: () => { setTitle(record.title); setEditing(!editing) } },
            { label: 'Export', disabled: busy, onSelect: () => void run(async () => { if (await api.exportCallSession(record.id)) setExported(true) }) },
            'divider',
            { label: 'Delete call', danger: true, disabled: busy || record.status === 'live' || record.learning.state === 'reviewing', onSelect: () => setDeleting(!deleting) }
          ]} />
          {exported && <span className="hint" role="status">Exported</span>}
        </div>
      </div>
      {editing && <form className="rename-call" onSubmit={event => { event.preventDefault(); void run(async () => { setRecord(await api.renameCallSession(record.id, title)); setEditing(false); setCalls(await api.callSessions()) }) }}>
        <label>Call title<input aria-label="Call title" value={title} maxLength={140} onChange={event => setTitle(event.target.value)} autoFocus /></label>
        <button className="primary" disabled={busy || !title.trim()}>Save title</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button>
      </form>}
      {deleting && <div className="notice ask"><span>Delete this call’s saved transcript, suggestions, and summary? Knowledge already kept by its agent stays until you undo it under Learning.</span><div className="row"><button disabled={busy} onClick={() => setDeleting(false)}>Keep call</button><button className="primary stop" disabled={busy} onClick={() => void run(async () => { await api.deleteCallSession(record.id); setSelected(null); setRecord(null); setDeleting(false); setCalls(await api.callSessions()) })}>Delete call</button></div></div>}
      <div className="tabs call-detail-tabs" role="tablist" aria-label="Call details" onKeyDown={event => {
        const index = TABS.indexOf(tab)
        const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : undefined
        if (next === undefined) return
        event.preventDefault()
        setTab(TABS[next])
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
      }}>
        {TABS.map(name => <button key={name} id={`call-tab-${name}`} role="tab" aria-controls="call-detail-panel" tabIndex={tab === name ? 0 : -1} aria-label={TAB_LABELS[name]} aria-selected={tab === name} onClick={() => setTab(name)}>{TAB_LABELS[name]}{name === 'learning' && lessonCount(record.learning.pending) > 0 ? ` (${lessonCount(record.learning.pending)})` : ''}</button>)}
      </div>
      <section className="call-detail-content" id="call-detail-panel" role="tabpanel" aria-labelledby={`call-tab-${tab}`}>
        {tab === 'overview' && <>
          {record.legacy && <p className="hint">This older call has a saved summary. Its full transcript was not retained.</p>}
          {record.brief && record.brief.trim() !== record.title.trim() && <><h4>Call context</h4><Markdown text={record.brief} /></>}
          <CallNotes key={`notes-${record.id}`} record={record} onRecord={setRecord} canGenerate={!!agent} />
          {onAsk && agent && record.status !== 'live' && (record.transcript.length > 0 || !!record.summary) && <CallQuestions key={`questions-${record.id}`} record={record} onAsk={onAsk} busy={!!asking} />}
          <p className="hint">{record.transcript.length} transcript lines · {record.suggestions.length} replies · {record.learning.changes.length} improvements</p>
          {record.status !== 'live' && !!record.transcript.length && record.learning.state !== 'reviewed' && <button className="primary" disabled={busy || record.learning.state === 'reviewing' || !agent} onClick={() => setTab('learning')}>Review and learn</button>}
        </>}
        {tab === 'transcript' && <HistoryTranscript key={record.id} record={record} onRecord={setRecord} />}
        {tab === 'suggestions' && <HistorySuggestions key={record.id} suggestions={record.suggestions} />}
        {tab === 'learning' && <CallLearningPanel record={record} agent={agent} onRecord={setRecord} onAgent={onAgent} />}
      </section>
    </> : <p className="hint" role="status">{error ? 'This call could not be opened.' : 'Loading call…'}</p> : <>
      {!enabled && <p className="hint">Call history is off. Existing calls are still available.</p>}
      {hasOwnedCalls && <div className="history-filters"><input className="history-search" aria-label="Search calls" placeholder={ownerId ? 'Search this agent’s calls…' : 'Search retained calls or agent names…'} value={query} onChange={event => { setQuery(event.target.value); setShown(CALLS_PER_PAGE) }} /></div>}
      {calls === null ? <p className="hint" role="status">Loading calls…</p> : <div className="call-history-list">
        {matchingRuntime && <button className="past-call-row current-call-row" aria-label="Open current call" onClick={onOpenCurrent}><strong>{currentCallTitle}</strong><span>Available in this workspace</span><span className="past-call-preview">{enabled ? 'Not yet in history.' : 'Not saved to history.'}</span></button>}
        {matching.slice(0, shown).map(call => <button key={call.id} className={`past-call-row ${call.status === 'live' ? 'live-record' : ''}`} aria-label={`Open call: ${callTitle(call)}`} onClick={() => call.id === currentCallId && call.status === 'live' && onOpenCurrent ? onOpenCurrent() : open(call.id)}><strong>{callTitle(call)}</strong>{!ownerId && <span>{call.agentName}</span>}{(named(call) || call.status !== 'ended') && <span>{named(call) ? new Date(call.startedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}{named(call) && call.status !== 'ended' ? ' · ' : ''}{call.status === 'live' ? 'In progress — return to call' : call.status === 'interrupted' ? 'Interrupted' : ''}</span>}<span className="past-call-preview">{call.summary.replace(/^# [^\r\n]+\r?\n/u, '').trim() || (call.lines || call.replies ? `${call.lines} transcript lines · ${call.replies} replies` : call.status === 'live' ? 'Listening for the conversation…' : 'No speech was captured.')}</span>{call.pendingLessons > 0 && <span className="pending-badge">{call.pendingLessons} lessons to approve</span>}</button>)}
        {matching.length > shown && <button className="history-more" onClick={() => setShown(previous => previous + CALLS_PER_PAGE)}>Show more calls</button>}
        {!hasOwnedCalls && <div className="history-empty"><h3>{ownerId ? 'No calls yet' : 'No retained calls'}</h3><p>{!ownerId ? 'There are no saved calls from removed agents. Existing agents keep their history in Calls.' : enabled ? 'Start a call above. Its transcript, replies, and notes will appear here.' : 'Turn on Remember calls in Settings to save future calls.'}</p></div>}
        {hasOwnedCalls && !matching.length && !matchingRuntime && <p className="hint">No calls match this search.</p>}
      </div>}
    </>}
    {error && <p className="error" role="status">{error}</p>}
  </div>
}

function CallQuestions({ record, onAsk, busy }: { record: CallSession; onAsk: (call: CallSession, question: string) => void; busy: boolean }) {
  const [question, setQuestion] = useState('')
  return <div className="call-questions">
    <h4>Ask about this call</h4>
    <p className="hint">Continue in this agent’s chat, using the saved transcript.</p>
    <div className="call-question-prompts">
      <button className="ghost" disabled={busy} onClick={() => onAsk(record, 'List the action items from this call, with an owner and deadline only when explicitly stated. Cite transcript timestamps.')}>Action items</button>
      <button className="ghost" disabled={busy} onClick={() => onAsk(record, 'Draft a concise follow-up message for this call, covering decisions and next steps. Do not invent commitments. Put supporting transcript timestamps after the draft. Do not send it.')}>Draft follow-up</button>
    </div>
    <form onSubmit={event => { event.preventDefault(); if (!busy && question.trim()) onAsk(record, question.trim()) }}>
      <input aria-label="Question about this call" placeholder="What was decided?" value={question} maxLength={4000} disabled={busy} onChange={event => setQuestion(event.target.value)} />
      <button disabled={busy || !question.trim()}>Ask in chat</button>
    </form>
    {busy && <p className="hint" role="status">This agent is replying in chat. Wait for it to finish or stop the reply there.</p>}
  </div>
}

const HistoryTranscript = memo(function HistoryTranscript({ record, onRecord }: { record: CallSession; onRecord: (record: CallSession) => void }) {
  const lines = useMemo(() => speechTurns(record.transcript), [record.transcript])
  const people = useMemo(() => [...new Map(lines.filter(line => line.voiceId).map(line => [line.voiceId!, line])).values()], [lines])
  const [query, setQuery] = useState('')
  const search = useDeferredValue(query.trim().toLocaleLowerCase())
  const [shown, setShown] = useState(LINES_PER_PAGE)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const clock = useMemo(() => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }), [])
  const matching = useMemo(() => search ? lines.filter(line => line.text.toLocaleLowerCase().includes(search)) : lines, [lines, search])
  return <>
    {people.length > 0 && <details className="call-people"><summary>People · Correct speakers</summary><p className="hint">Confirm names or combine duplicate speakers with “Same person as…”.</p>{people.map(line => <SpeakerName key={`${line.voiceId}:${line.voiceName}:${line.voiceNamedBy}`} line={line} people={people} save={async name => onRecord(await api.renameCallSpeaker(record.id, line.voiceId!, name))} merge={async into => onRecord(await api.mergeCallSpeakers(record.id, line.voiceId!, into))} />)}</details>}
    <div className="transcript-tools"><input aria-label="Search transcript" placeholder="Find something said…" value={query} onChange={event => { setQuery(event.target.value); setShown(LINES_PER_PAGE) }} /><button disabled={!lines.length} onClick={() => void navigator.clipboard.writeText(lines.map(line => `${speakerLabel(line)}: ${line.text}`).join('\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, error => setError(errorText(error)))}>{copied ? 'Copied' : 'Copy transcript'}</button></div>
    {!lines.length ? <p className="hint">No transcript was saved for this call.</p> : <p className="hint" role="status">{matching.length ? `Showing ${Math.min(shown, matching.length)} of ${matching.length} lines${search ? ' matching your search' : ''}.` : 'No transcript lines match this search.'}</p>}
    {matching.slice(0, shown).map(line => <div className="history-transcript-line" key={line.id}><span className="who">{speakerLabel(line)} <time>{clock.format(line.at)}</time></span><p>{line.text}</p></div>)}
    {matching.length > shown && <button className="history-more" onClick={() => setShown(previous => previous + LINES_PER_PAGE)}>Show {LINES_PER_PAGE} more lines</button>}
    {error && <p className="error" role="status">{error}</p>}
  </>
})

const HistorySuggestions = memo(function HistorySuggestions({ suggestions }: { suggestions: CallSession['suggestions'] }) {
  const [shown, setShown] = useState(REPLIES_PER_PAGE)
  const sorted = useMemo(() => [...suggestions].sort((a, b) => a.at - b.at), [suggestions])
  return <>
    {!suggestions.length && <p className="hint">No suggestions were saved for this call.</p>}
    {sorted.slice(0, shown).map(card => <article className="history-suggestion" key={card.id}><h4>{card.question || (card.kind === 'summary' ? 'Summary' : 'Suggested reply')}</h4><Markdown text={card.text} />{card.deep && <details><summary>Deeper answer</summary><Markdown text={card.deep} /></details>}</article>)}
    {sorted.length > shown && <button className="history-more" onClick={() => setShown(previous => previous + REPLIES_PER_PAGE)}>Show more suggestions</button>}
  </>
})

function CallLearningPanel({ record, agent, onRecord, onAgent }: { record: CallSession; agent?: Agent; onRecord: (record: CallSession) => void; onAgent: (agent: Agent) => void }) {
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => setSelected([]), [record.learning.reviewId])
  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  const items = lessonItems(record.learning.pending)
  return <div className="session-learning">
    <p className="hint">{!agent ? 'This call’s agent is no longer installed.' : agent.learning === 'auto' ? 'The agent keeps reusable additions automatically. Sensitive changes wait for your approval.' : agent.learning === 'ask' ? 'The agent asks before keeping anything from a call.' : 'Automatic review is off for this agent. You can review this call explicitly.'}</p>
    {record.learning.state === 'reviewing' ? <p className="thinking" role="status">Reviewing this call for useful lessons…</p> : <>
      {record.learning.state !== 'reviewed' && <button className="primary" disabled={busy || !agent || record.status === 'live' || !record.transcript.length} onClick={() => void run(async () => { const result = await api.reviewCallSession(record.id); onRecord(result.session); onAgent(result.agent) })}>{busy ? 'Reviewing…' : record.learning.state === 'error' ? 'Retry review' : 'Review this call'}</button>}
      {record.status === 'live' && <p className="hint">End this call to review what the agent can learn.</p>}
      {record.learning.changes.length > 0 && <><h4>What the agent learned</h4>{record.learning.changes.map(change => {
        const entry = agent?.history.find(entry => entry.id === change.id)
        return <div className={`learning-change ${entry?.undone ? 'undone' : ''}`} key={change.id}><p>{change.text}</p>{entry && <button className="link" disabled={busy || entry.undone} onClick={() => void run(async () => onAgent(await api.undoChange(record.agentId, change.id)))}>{entry.undone ? 'Undone' : 'Undo'}</button>}</div>
      })}</>}
      {items.length > 0 && <><h4>Needs your approval</h4><p className="hint">Choose only the lessons you want this agent to reuse on future calls.</p><div className="pending-lessons">{items.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={busy || !agent} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.id] : previous.filter(id => id !== item.id))} /><span>{item.label}</span></label>)}</div><div className="row"><button className="primary" disabled={busy || !agent || !selected.length} onClick={() => void run(async () => { const result = await api.approveCallLearning(record.id, record.learning.reviewId!, selected); onRecord(result.session); onAgent(result.agent) })}>Keep selected{selected.length ? ` (${selected.length})` : ''}</button><button disabled={busy} onClick={() => void run(async () => onRecord(await api.dismissCallLearning(record.id, record.learning.reviewId!)))}>Dismiss remaining</button></div></>}
      {record.learning.state === 'reviewed' && !items.length && !record.learning.changes.length && <p className="hint">The review found no new reusable knowledge to keep.</p>}
    </>}
    {record.learning.error && <p className="error">{record.learning.error}</p>}
    {error && <p className="error" role="status">{error}</p>}
  </div>
}
