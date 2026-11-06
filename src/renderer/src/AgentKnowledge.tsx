import { useRef, useState } from 'react'
import { FACT_LIMIT, MEMORY_LIMIT, SKILL_LIMITS, type Agent, type KnowledgeDoc, type Skill, type SkillDraft } from '@shared/types'
import { skillPurpose, sourceLabel } from '@shared/agent-learning'
import { speechWords, vocabularyTerms } from '@shared/speech-words'
import { Markdown } from './Markdown'

const api = window.togle
type Props = { agent: Agent; onAgent: (agent: Agent) => void; onChat: () => void }
const message = (error: unknown): string => (error as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function useEdit(onAgent: Props['onAgent']) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const pending = useRef(false)
  const change = async (action: () => Promise<Agent>): Promise<boolean> => {
    if (pending.current) return false
    pending.current = true; setBusy(true); setError('')
    try { onAgent(await action()); return true }
    catch (error) { setError(message(error)); return false }
    finally { pending.current = false; setBusy(false) }
  }
  return { busy, error, setError, change }
}

export function AgentKnowledge({ agent, onAgent, onChat }: Props) {
  const { busy, error, setError, change } = useEdit(onAgent)
  const [fact, setFact] = useState<{ text: string; before?: string }>()
  const [note, setNote] = useState<{ name: string; text: string }>()
  const [removing, setRemoving] = useState<KnowledgeDoc>()
  return <div className="agent-knowledge">
    <div className="inspector-section-head"><h3>Knowledge</h3><button className="ghost small" onClick={onChat}>Teach in chat</button></div>
    <p className="hint">What {agent.name} knows: remembered facts, reference documents, and answers you approved.</p>
    <details className="agent-words"><summary>Words and names · {vocabularyTerms(agent.vocabulary).length}</summary>
      <p className="hint">Teach project names and spellings in this agent’s chat. They apply to its meeting transcripts and voice typing. Changes can be undone in Learning.</p>
      {speechWords(agent.vocabulary).map(word => <p key={word.id}>{word.heardAs} → <strong>{word.word}</strong></p>)}
      {vocabularyTerms(agent.vocabulary).length > 0 && <p className="hint">{vocabularyTerms(agent.vocabulary).join(', ')}</p>}
    </details>
    <div className="inspector-section-head"><h4>Remembered facts <span className="count">{agent.memory.length}</span></h4><button className="ghost small" disabled={busy || !!fact} onClick={() => { setError(''); setFact({ text: '' }) }}>Add fact</button></div>
    <p className="hint">Facts stay saved here. Live answers use up to {MEMORY_LIMIT.toLocaleString()} characters of relevant facts to stay fast.</p>
    {fact && <form className="training-form" aria-label={fact.before === undefined ? 'Add fact' : 'Edit fact'} onSubmit={event => {
      event.preventDefault()
      void change(() => api.saveAgentFact(agent.id, fact.text, fact.before)).then(saved => { if (saved) setFact(undefined) })
    }}>
      <label>Fact<textarea autoFocus required rows={3} maxLength={FACT_LIMIT} disabled={busy} value={fact.text} onChange={event => setFact({ ...fact, text: event.target.value })} /></label>
      <div className="row"><button className="primary" disabled={busy || !fact.text.trim()}>{busy ? 'Saving…' : 'Save fact'}</button><button type="button" disabled={busy} onClick={() => { setFact(undefined); setError('') }}>Cancel</button></div>
    </form>}
    {!agent.memory.length && !fact && <p className="hint">No remembered facts yet. Add one or teach the agent in chat.</p>}
    {agent.memory.map(value => <div className="knowledge-item fact-item" key={value}>
      <div className="knowledge-body"><Markdown text={value} /><small className="hint">{sourceLabel(agent.factSources?.[value])}</small></div>
      <div className="training-actions"><button className="link" disabled={busy || !!fact} aria-label={`Edit fact: ${value}`} onClick={() => { setError(''); setFact({ text: value, before: value }) }}>Edit</button><button className="link" disabled={busy} aria-label={`Forget fact: ${value}`} onClick={() => void change(() => api.removeAgentFact(agent.id, value))}>Forget</button></div>
    </div>)}
    <div className="inspector-section-head"><h4>Documents <span className="count">{agent.knowledge.length}</span></h4><div className="training-actions"><button className="ghost small" disabled={busy || !!note} onClick={() => { setError(''); setNote({ name: '', text: '' }) }}>Add text</button><button className="ghost small" disabled={busy} onClick={() => void change(async () => { const result = await api.importAgentFiles(agent.id); if (result.errors.length) setError(result.errors.join('\n')); return result.agent })}>Import files</button></div></div>
    <p className="hint">Longer reference material is searched when an answer needs it. Add websites and work sessions from the chat attachment menu.</p>
    {note && <form className="training-form" aria-label="Add reference text" onSubmit={event => {
      event.preventDefault()
      void change(() => api.addAgentText(agent.id, note.name.trim(), note.text)).then(saved => { if (saved) setNote(undefined) })
    }}>
      <label>Title<input autoFocus required maxLength={200} disabled={busy} value={note.name} onChange={event => setNote({ ...note, name: event.target.value })} /></label>
      <label>Reference text<textarea required rows={6} maxLength={60000} disabled={busy} value={note.text} onChange={event => setNote({ ...note, text: event.target.value })} /></label>
      <div className="row"><button className="primary" disabled={busy || !note.name.trim() || !note.text.trim()}>{busy ? 'Adding…' : 'Add document'}</button><button type="button" disabled={busy} onClick={() => { setNote(undefined); setError('') }}>Cancel</button></div>
    </form>}
    {!agent.knowledge.length && <p className="hint">No documents yet. Add text or import files for this agent.</p>}
    {agent.knowledge.map(document => <details className="knowledge-item document-item" key={document.id}>
      <summary>{document.name}<span className="count"> · {document.status === 'studying' ? 'Studying…' : document.error ? 'Available for search' : 'Ready'}</span></summary>
      {document.source && <div className="knowledge-source"><Markdown text={document.source} /></div>}
      {document.digest ? <Markdown text={document.digest} /> : <p className="hint">{document.status === 'studying' ? 'Preparing a summary. This document can already be searched.' : 'Available as reference material for this agent.'}</p>}
      {document.error && <p className="hint">Summary unavailable: {document.error}</p>}
      {removing?.id === document.id ? <div className="training-confirm"><span>Remove this document from {agent.name}?</span><div className="training-actions"><button disabled={busy} onClick={() => void change(() => api.removeAgentDoc(agent.id, document.id)).then(saved => { if (saved) setRemoving(undefined) })}>Remove document</button><button disabled={busy} onClick={() => setRemoving(undefined)}>Cancel</button></div></div> : <button className="link" disabled={busy} aria-label={`Remove document: ${document.name}`} onClick={() => { setError(''); setRemoving(document) }}>Remove</button>}
    </details>)}
    {!!agent.skills.filter(skill => skillPurpose(skill) === 'reference').length && <><h4>Learned reference knowledge</h4><p className="hint">Procedures discussed in earlier calls. These provide context when relevant. Assistance skills describe how Togle should help you during a call.</p>
      {agent.skills.filter(skill => skillPurpose(skill) === 'reference').map(reference => <details className="knowledge-item reference-item" key={reference.id}><summary>{reference.name}</summary><p className="hint">{sourceLabel(reference.source)}</p><Markdown text={reference.how} /></details>)}
    </>}
    <div className="inspector-section-head"><h4>Approved answers <span className="count">{agent.answers.length}</span></h4></div>
    <p className="hint">Exact answers for recurring questions. Add or improve them by teaching the agent in chat.</p>
    {agent.answers.map(answer => <details className="knowledge-item" key={answer.id}><summary>{answer.question}</summary><Markdown text={answer.answer} /></details>)}
    {error && <p className="error" role="alert">{error}</p>}
  </div>
}

const contentOf = (skill: Skill): SkillDraft => ({ name: skill.name, when: skill.when, how: skill.how, purpose: skillPurpose(skill) })

export function AgentSkills({ agent, onAgent, onChat }: Props) {
  const { busy, error, setError, change } = useEdit(onAgent)
  const [editing, setEditing] = useState<{ value: SkillDraft; before?: Skill }>()
  const [removing, setRemoving] = useState<Skill>()
  const skills = agent.skills.filter(skill => skillPurpose(skill) === 'assistance')
  return <div className="agent-skills">
    <div className="inspector-section-head"><h3>Skills <span className="count">{skills.length}</span></h3><div className="training-actions"><button className="link" onClick={onChat}>Teach in chat</button><button className="ghost small" disabled={busy || !!editing} onClick={() => { setError(''); setEditing({ value: { name: '', when: '', how: '' } }) }}>Add skill</button></div></div>
    <p className="hint">How Togle should assist you during a call: what to suggest, check or clarify, and when to stay quiet. Workflows discussed in meetings are under Knowledge.</p>
    {editing && <form className="training-form" aria-label={editing.before ? 'Edit skill' : 'Add skill'} onSubmit={event => {
      event.preventDefault()
      void change(() => api.saveSkill(agent.id, editing.value, editing.before?.id, editing.before && contentOf(editing.before))).then(saved => { if (saved) setEditing(undefined) })
    }}>
      <label>Skill name<input autoFocus required maxLength={SKILL_LIMITS.name} disabled={busy} value={editing.value.name} onChange={event => setEditing({ ...editing, value: { ...editing.value, name: event.target.value } })} /></label>
      <label>When to use it<input maxLength={SKILL_LIMITS.when} disabled={busy} placeholder="For example: when someone reports a production incident" value={editing.value.when} onChange={event => setEditing({ ...editing, value: { ...editing.value, when: event.target.value } })} /></label>
      <label>Instructions<textarea required rows={8} maxLength={SKILL_LIMITS.how} disabled={busy} placeholder="Describe how Togle should help you, which evidence it needs, and when it should stay quiet." value={editing.value.how} onChange={event => setEditing({ ...editing, value: { ...editing.value, how: event.target.value } })} /></label>
      <div className="row"><button className="primary" disabled={busy || !editing.value.name.trim() || !editing.value.how.trim()}>{busy ? 'Saving…' : 'Save skill'}</button><button type="button" disabled={busy} onClick={() => { setEditing(undefined); setError('') }}>Cancel</button></div>
    </form>}
    {!skills.length && !editing && <p className="hint">No assistance skills yet. Describe how Togle should help you in chat, or add a skill here. General call assistance works without custom skills.</p>}
    {skills.map(skill => <details className="knowledge-item skill-item" key={skill.id}>
      <summary>{skill.name}</summary>
      <p className="hint skill-trigger">{skill.when || 'Applies whenever its instructions are relevant.'}</p>
      <Markdown text={skill.how} />
      <p className="hint skill-origin">{sourceLabel(skill.source)} · version {skill.revision ?? 1}{skill.uses ? ` · Matched ${skill.uses} time${skill.uses === 1 ? '' : 's'}` : ''}</p>
      {removing?.id === skill.id ? <div className="training-confirm"><span>Remove “{removing.name}”? You can restore it under Learning.</span><div className="training-actions"><button disabled={busy} onClick={() => void change(() => api.removeSkill(agent.id, removing.id, contentOf(removing))).then(saved => { if (saved) setRemoving(undefined) })}>Remove skill</button><button disabled={busy} onClick={() => { setRemoving(undefined); setError('') }}>Cancel</button></div></div> : <div className="training-actions"><button className="link" disabled={busy || !!editing} aria-label={`Edit skill: ${skill.name}`} onClick={() => { setError(''); setRemoving(undefined); setEditing({ value: contentOf(skill), before: skill }) }}>Edit</button><button className="link" disabled={busy} aria-label={`Remove skill: ${skill.name}`} onClick={() => { setError(''); setRemoving(skill) }}>Remove</button></div>}
    </details>)}
    {error && <p className="error" role="alert">{error}</p>}
  </div>
}
