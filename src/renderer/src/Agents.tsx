import { memo, useEffect, useState } from 'react'
import type { Agent, AgentPreview, AgentTemplate } from '@shared/types'
import { InstallPreview, Market, SharePanel } from './AgentHub'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

const api = window.togle

const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** What the conversation asks to show: your agents, the market, or sharing one. `seq` tells one ask from the next. */
export interface AgentsRequest {
  share?: string
  create?: boolean
  seq: number
}

interface Props {
  agents: Agent[]
  request: AgentsRequest
  /** Changes the list from its latest state: a slow action finishes after other changes have come in. */
  onChange: (update: (agents: Agent[]) => Agent[]) => void
  /** The agent to talk to, and that answers on calls: its conversation opens. */
  onTalk: (id: string) => void
  /** A new agent set up from a description: its conversation opens, starting with what it made of it. */
  onDrafted: (agent: Agent, said: string) => void
  onDone: () => void
  onSection: (section: 'agents' | 'new' | 'share') => void
  /** On screen: Escape does what its Back does. */
  shown: boolean
}

/** Creation, discovery and sharing. Installed agents are listed only in the persistent sidebar. */
export const Agents = memo(function Agents({ agents, request, onChange, onTalk, onDrafted, onDone, onSection, shown }: Props) {
  const [sharing, setSharing] = useState<string | null>(null)
  const [making, setMaking] = useState(false)
  // An agent from the market (or a file) shown before it's installed.
  const [preview, setPreview] = useState<AgentPreview | null>(null)
  useEffect(() => { if (shown) onSection(sharing ? 'share' : making ? 'new' : 'agents') }, [shown, sharing, making, onSection])

  useEffect(() => {
    if (!request.seq) return
    setMaking(!!request.create)
    setPreview(null)
    setSharing(request.share ?? null)
  }, [request.seq])

  // Escape does what the Back of the page showing does (a list or picker open takes it first).
  useEffect(() => {
    if (!shown) return
    const back = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (sharing || making) onDone()
      else if (preview) setPreview(null)
      else onDone()
    }
    window.addEventListener('keydown', back)
    return () => window.removeEventListener('keydown', back)
  }, [shown, sharing, preview, making, onDone])

  /** A new agent: it's the one to talk to now; one set up from a description starts its conversation with what it made of it. */
  const created = (agent: Agent, said?: string) => {
    // Its "changed" messages may have added it already, as it was partway.
    onChange((prev) =>
      prev.some((a) => a.id === agent.id) ? prev.map((a) => (a.id === agent.id && agent.updatedAt >= a.updatedAt ? agent : a)) : [...prev, agent]
    )
    setMaking(false)
    setPreview(null)
    if (said) onDrafted(agent, said)
    else onTalk(agent.id)
  }
  const blank = async () => created(await api.createAgent('blank'))
  const fromTemplate = async (id: string) => created(await api.createAgent(id))
  const draft = async (said: string) => created(await api.draftAgent(said), said)
  // An agent someone sent as a file, shown in full before it's installed.
  const fromFile = async () => {
    const picked = await api.openAgentPackage()
    if (picked) setPreview(picked)
  }

  const shared = agents.find((a) => a.id === sharing)
  if (shared) {
    return (
      <div className="settings agents">
        <div className="page-head">
          <button className="icon" title="Back" aria-label="Back" onClick={onDone}>
            <Icon name="back" />
          </button>
          <Avatar agent={shared} size={24} />
          <h2 className="agent-title">Share {shared.name}</h2>
        </div>
        <SharePanel key={shared.id} agent={shared} />
      </div>
    )
  }

  if (preview) {
    return (
      <div className="settings agents">
        <div className="page-head">
          <button className="icon" title="Back" aria-label="Back" onClick={() => setPreview(null)}>
            <Icon name="back" />
          </button>
          <h2>Install an agent</h2>
        </div>
        <InstallPreview
          preview={preview}
          onInstalled={(agent) => created(agent)}
          onTalk={(id) => {
            setPreview(null)
            onTalk(id)
          }}
          onCancel={() => setPreview(null)}
        />
      </div>
    )
  }

  if (making) {
    return (
      <div className="settings agents">
        <div className="page-head">
          <button className="icon" title="Back" aria-label="Back" onClick={onDone}>
            <Icon name="back" />
          </button>
          <h2>New agent</h2>
        </div>
        <NewAgent
          onTemplate={fromTemplate}
          onDraft={draft}
          onBlank={blank}
          onMarket={() => {
            setMaking(false)
          }}
        />
      </div>
    )
  }

  return (
    <div className="settings agents">
      <div className="page-head">
        <button className="icon" title="Back to the conversation" aria-label="Back" onClick={onDone}>
          <Icon name="back" />
        </button>
        <h2>Explore agents</h2>
      </div>
      {shown && <Market agents={agents} onPreview={setPreview} onFile={fromFile} />}
    </div>
  )
})

/**
 * A new agent, for any kind of call: described in a sentence or two, it sets itself up (one request), as Hermes Agent
 * is shaped by talking to it; or it starts blank, or is one from the market.
 */
function NewAgent({ onDraft, onBlank, onMarket, onTemplate }: { onDraft: (said: string) => Promise<void>; onBlank: () => Promise<void>; onMarket: () => void; onTemplate: (id: string) => Promise<void> }) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([])
  const [selected, setSelected] = useState('general')
  const [said, setSaid] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void api.agentTemplates().then(setTemplates, err => setError(errorText(err))) }, [])
  const create = async (blank = false): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try { await (blank ? onBlank() : onTemplate(selected)) }
    catch (err) { setError(errorText(err)); setBusy(false) }
  }
  const draft = async () => {
    if (!said.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      await onDraft(said.trim())
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <div className="new-agent">
      <p className="hint">Start from a template, then make it your own. Templates are included on this PC and use no AI requests.</p>
      <div className="template-grid" aria-label="Agent templates">
        {templates.filter(template => template.id !== 'blank').map(template => (
          <button key={template.id} className={`template-card ${selected === template.id ? 'selected' : ''}`} aria-label={`Use ${template.name} template`} aria-pressed={selected === template.id} disabled={busy} onClick={() => setSelected(template.id)}>
            <strong>{template.name}</strong><span>{template.description}</span>
          </button>
        ))}
      </div>
      {templates.find(template => template.id === selected) && <details className="template-instructions"><summary>Preview instructions</summary><p>{templates.find(template => template.id === selected)!.instructions}</p></details>}
      <button className="primary" disabled={busy || !templates.length} onClick={() => void create()}>{busy ? 'Creating…' : 'Create agent'}</button>
      <details className="custom-agent"><summary>Create from a description instead</summary>
      <p className="hint">Your selected AI can draft a custom agent from a sentence.</p>
      <textarea
        rows={3}
        value={said}
        disabled={busy}
        placeholder="e.g. Guitar lessons I give online, mostly to beginners"
        onChange={(e) => setSaid(e.target.value)}
        // Enter makes it, as in the conversation's box; Shift+Enter adds a line.
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
          e.preventDefault()
          void draft()
        }}
      />
      <div className="row">
        <button className="primary" disabled={busy || !said.trim()} onClick={() => void draft()}>
          {busy ? 'Setting it up…' : 'Create'}
        </button>
      </div>
      </details>
      {error && <p className="error">{error}</p>}
      <p className="hint others">
        Or{' '}
        <button className="link" disabled={busy} onClick={onMarket}>
          explore shared agents
        </button>
        , or{' '}
        <button className="link" disabled={busy} onClick={() => void create(true)}>
          start blank
        </button>
        .
      </p>
    </div>
  )
}
