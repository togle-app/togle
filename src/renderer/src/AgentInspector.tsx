import { useEffect, useState } from 'react'
import type { Agent, CallLearning, CallSessionSummary, TrainingChange } from '@shared/types'
import { Markdown } from './Markdown'
import { ClaudeConnections } from './ClaudeConnections'
import { AgentPreferences } from './AgentPreferences'
import { AgentKnowledge, AgentSkills } from './AgentKnowledge'

const api = window.togle
const errorText = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Props {
  agent: Agent
  tab: 'settings' | 'knowledge' | 'skills' | 'learning'
  onAgent: (agent: Agent) => void
  onCall: (id: string) => void
  onChat: () => void
  onDelete: () => void
  deleteReason?: string
}

export function AgentInspector({ agent, tab, onAgent, onCall, onChat, onDelete, deleteReason }: Props) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({ name: agent.name, description: agent.description, instructions: agent.instructions, aboutMe: agent.aboutMe })
  const [calls, setCalls] = useState<CallSessionSummary[]>([])
  useEffect(() => {
    if (tab !== 'learning') return
    let current = true
    const load = (): void => { void api.callSessions().then(records => { if (current) setCalls(records.filter(record => record.agentId === agent.id)) }, () => {}) }
    load()
    const unsubscribe = api.onCallSessions(load)
    return () => { current = false; unsubscribe() }
  }, [agent.id, tab])
  const change = async (action: () => Promise<Agent>): Promise<void> => {
    if (busy) return
    setBusy(true); setError('')
    try { onAgent(await action()) } catch (error) { setError(errorText(error)) } finally { setBusy(false) }
  }
  const describe = (entry: TrainingChange): string => {
    const item = entry.change
    if (item.kind === 'fact') return [item.before && `Before: ${item.before}`, item.after && `After: ${item.after}`].filter(Boolean).join('\n\n')
    if (item.kind === 'skill') return item.after?.how || item.before?.how || ''
    if (item.kind === 'answer') return item.after?.answer || item.before?.answer || ''
    if (item.kind === 'field') return item.after
    return item.after.map(home => home.name).join(', ')
  }
  return <section className="agent-inspector" aria-label={tab === 'settings' ? 'Agent settings' : tab === 'knowledge' ? 'Agent knowledge' : tab === 'skills' ? 'Agent skills' : 'Agent learning'}>
    {tab === 'settings' ? <>
      <div className="inspector-section-head"><h3>Profile & instructions</h3>{!editing && <button className="ghost small" onClick={() => { setDraft({ name: agent.name, description: agent.description, instructions: agent.instructions, aboutMe: agent.aboutMe }); setEditing(true) }}>Edit profile</button>}</div>
      {editing ? <form className="agent-profile-form" onSubmit={event => { event.preventDefault(); void change(async () => { const updated = await api.updateAgent(agent.id, { ...draft, name: draft.name.trim() }); setEditing(false); return updated }) }}>
        <label>Name<input autoFocus required disabled={busy} value={draft.name} onChange={event => setDraft(previous => ({ ...previous, name: event.target.value }))} /></label>
        <label>Description<input disabled={busy} value={draft.description} onChange={event => setDraft(previous => ({ ...previous, description: event.target.value }))} /></label>
        <label>Instructions<textarea rows={5} disabled={busy} value={draft.instructions} onChange={event => setDraft(previous => ({ ...previous, instructions: event.target.value }))} /></label>
        <label>About you<textarea rows={3} disabled={busy} value={draft.aboutMe} onChange={event => setDraft(previous => ({ ...previous, aboutMe: event.target.value }))} /></label>
        <div className="row"><button className="primary" disabled={busy || !draft.name.trim()}>{busy ? 'Saving…' : 'Save changes'}</button><button type="button" disabled={busy} onClick={() => setEditing(false)}>Cancel</button></div>
      </form> : <>
        <Markdown text={agent.instructions || 'No instructions yet. Edit this profile to describe how the agent should help.'} />
        {agent.aboutMe && <details className="knowledge-item"><summary>About you</summary><Markdown text={agent.aboutMe} /></details>}
      </>}
      <AgentPreferences key={`preferences:${agent.id}`} agent={agent} onAgent={onAgent} />
      <ClaudeConnections key={`${agent.id}:${agent.subscriptionAccountId}`} agent={agent} onAgent={onAgent} />
      <div className="agent-delete"><button className="ghost danger" disabled={!!deleteReason || busy} title={deleteReason} onClick={onDelete}>Delete agent</button>{deleteReason && <p className="hint">{deleteReason}</p>}</div>
    </> : tab === 'knowledge' ? <AgentKnowledge agent={agent} onAgent={onAgent} onChat={onChat} /> : tab === 'skills' ? <AgentSkills agent={agent} onAgent={onAgent} onChat={onChat} /> : <>
      <label className="learning-mode">After calls
        <select aria-label="Learning mode" value={agent.learning} disabled={busy} onChange={event => void change(() => api.updateAgent(agent.id, { learning: event.target.value as CallLearning }))}>
          <option value="auto">Improve automatically</option><option value="ask">Ask before remembering</option><option value="off">Review only when I ask</option>
        </select>
      </label>
      <p className="hint">{agent.learning === 'auto' ? 'Keeps reusable additions automatically. Prices, deals, and changes to existing knowledge wait for approval.' : agent.learning === 'ask' ? 'Reviews ended calls and asks you to approve lessons before remembering them.' : 'No automatic review. Open a saved call and choose Learning to review it when you want.'} Every saved change can be inspected and undone.</p>
      {calls.filter(call => call.pendingLessons > 0).map(call => <button className="pending-call" key={call.id} onClick={() => onCall(call.id)}><strong>{call.title}</strong><span>{call.pendingLessons} lessons need approval</span></button>)}
      <h3>Recent improvements</h3>
      {!agent.history.length && <p className="hint">Teach a correction in chat or finish a call. Saved improvements appear here with Undo.</p>}
      {[...agent.history].reverse().slice(0, 50).map(entry => <div className={`learning-change ${entry.undone ? 'undone' : ''}`} key={entry.id}>
        <details><summary>{entry.text}</summary><Markdown text={describe(entry)} /></details>
        <span className="hint">{new Date(entry.at).toLocaleDateString()} · {entry.origin === 'auto' ? 'Learned automatically' : entry.origin === 'call' ? 'Approved from a call' : entry.origin === 'manual' ? 'Edited by you' : entry.origin === 'train' ? 'Taught by you' : 'Consolidated knowledge'}</span>
        <button className="link" disabled={busy || entry.undone} onClick={() => void change(() => api.undoChange(agent.id, entry.id))}>{entry.undone ? 'Undone' : 'Undo'}</button>
      </div>)}
    </>}
    {error && <p className="error" role="status">{error}</p>}
  </section>
}
