import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { Agent } from '@shared/types'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

export type SidebarPage = 'agents' | 'settings' | 'new'

interface Props {
  agents: Agent[]
  selectedId?: string
  callingId?: string
  page: string
  expanded: boolean
  onSelect: (id: string) => void
  onNavigate: (page: SidebarPage) => void
  onClose: () => void
}

/** Agent switching is navigation. It never reassigns the owner of a running call. */
export const AgentSidebar = memo(function AgentSidebar({ agents, selectedId, callingId, page, expanded, onSelect, onNavigate, onClose }: Props) {
  const [query, setQuery] = useState('')
  const search = useDeferredValue(query.trim().toLocaleLowerCase())
  const matching = useMemo(() => agents.filter(agent => !search || `${agent.name} ${agent.description}`.toLocaleLowerCase().includes(search)), [agents, search])
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!expanded) return
    const previous = document.activeElement
    const items = (): HTMLElement[] => [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input') ?? [])].filter(element => element.getClientRects().length > 0)
    const controls = items()
    const first = controls.find(element => element.getAttribute('aria-current') === 'page') ?? controls[0]
    first?.focus()
    const keys = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return }
      if (event.key !== 'Tab') return
      const controls = items(), index = controls.indexOf(document.activeElement as HTMLElement)
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus() }
      else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) { event.preventDefault(); controls[0]?.focus() }
    }
    window.addEventListener('keydown', keys, true)
    return () => {
      window.removeEventListener('keydown', keys, true)
      const trigger = document.querySelector<HTMLButtonElement>('.sidebar-toggle')
      if (trigger?.getClientRects().length) trigger.focus()
      else if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [expanded, onClose])

  return <aside ref={panel} className={`agent-sidebar ${expanded ? 'expanded' : ''}`} aria-label="Agents" role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined}>
    <div className="sidebar-heading"><span>Agents</span><button className="icon new-agent-button" aria-label="New agent" title="New agent" onClick={() => onNavigate('new')}><Icon name="plus" size={16} /></button></div>
    {agents.length > 6 && <div className="sidebar-search"><Icon name="search" size={14} /><input aria-label="Search agents" placeholder="Find an agent…" value={query} onChange={event => setQuery(event.target.value)} /></div>}
    <nav className="sidebar-agents" aria-label="Your agents">
      {matching.map(agent => <button key={agent.id} className={`sidebar-agent ${selectedId === agent.id && (page === 'agent' || page === 'main' || page === 'share') ? 'selected' : ''}`} aria-label={`Chat with ${agent.name}`} aria-current={selectedId === agent.id && (page === 'agent' || page === 'main' || page === 'share') ? 'page' : undefined} title={agent.name} onClick={() => { setQuery(''); onSelect(agent.id) }}>
        <Avatar agent={agent} size={30} />
        <span className="sidebar-agent-copy"><strong>{agent.name}</strong><span>{callingId === agent.id ? 'In a call' : agent.description || 'Ready to help'}</span></span>
        {callingId === agent.id && <span className="sidebar-call-dot" aria-label="Call in progress" />}
      </button>)}
      {!matching.length && <p className="sidebar-empty">{agents.length ? 'No agents found.' : 'Loading agents…'}</p>}
    </nav>
    <div className="sidebar-footer">
      <nav className="workspace-nav" aria-label="Workspace">
        <button aria-label="Explore agents" aria-current={page === 'agents' ? 'page' : undefined} title="Explore agents" onClick={() => onNavigate('agents')}><Icon name="store" size={16} /><span>Explore agents</span></button>
      </nav>
      <button className={`sidebar-settings ${page === 'settings' ? 'selected' : ''}`} aria-label="Settings" title="Settings" onClick={() => onNavigate('settings')}><Icon name="settings" size={16} /><span>Settings</span></button>
    </div>
  </aside>
})
