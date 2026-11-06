import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Agent, SessionHome, WorkSessionInfo } from '@shared/types'
import { PickerDialog } from './PickerDialog'

const api = window.togle

const TOOLS: Record<WorkSessionInfo['tool'], string> = { 'claude-code': 'Claude Code', codex: 'Codex', 'claude-ai': 'claude.ai', chatgpt: 'ChatGPT' }
const onWeb = (home: SessionHome): boolean => home.tool === 'claude-ai' || home.tool === 'chatgpt'
// Typing pauses this long before the sessions are searched again.
const SEARCH_MS = 150
const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** When it was last worked on, as a list says it: "just now", "5 min ago", "3 h ago", "yesterday", "Oct 3". */
export function ago(at: number, now = Date.now()): string {
  const since = now - at
  if (since < MINUTE) return 'just now'
  if (since < HOUR) return `${Math.floor(since / MINUTE)} min ago`
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  if (at >= day.getTime()) return `${Math.floor(since / HOUR)} h ago`
  if (at >= day.getTime() - 24 * HOUR) return 'yesterday'
  const sameYear = new Date(at).getFullYear() === day.getFullYear()
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** What was asked in it last (else first), where the title doesn't say it: titles can be as plain as "Codebase". */
const asked = (s: WorkSessionInfo): string => {
  const said = s.last || s.first || ''
  return said && said !== s.title ? said : ''
}

/** One of their Claude Code and Codex folders, however its path was written. */
const placeKey = (dir: string): string => dir.replace(/[\\/]+$/, '').toLowerCase()

/** A folder by its last part ("togle" for C:\Users\me\togle). */
const folderName = (cwd?: string): string => (cwd ? (cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? cwd) : '')

/**
 * A work session with Claude Code or Codex on this PC, or a chat of theirs on claude.ai or ChatGPT (from the export of
 * them they downloaded), to give the agent: the latest first, or found by what it was about (its title, its folder,
 * what was asked in it). Picked, it goes into the agent's documents. Arrows and Enter pick from the search box; a click
 * elsewhere, Escape or switching apps closes it. With two accounts of a tool (one for work, say), they
 * pick the agent's own here: it then looks only in those.
 */
export function SessionPicker({
  agent,
  onPick,
  onAgent,
  onClose
}: {
  agent: Agent
  onPick: (session: WorkSessionInfo) => void
  onAgent: (agent: Agent) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<WorkSessionInfo[] | null>(null)
  const [homes, setHomes] = useState<SessionHome[]>([])
  // The one Enter picks.
  const [at, setAt] = useState(0)
  // An export of their chats picked here: what it said, and the list read again with its chats.
  const [picked, setPicked] = useState('')
  const [reads, setReads] = useState(0)
  // While the window to pick it in is open, this one stays (that window takes the focus).
  const choosing = useRef(false)
  const box = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const own = new Set(agent.workHomes.map((h) => placeKey(h.dir)))
  const ownKey = [...own].sort().join('|')

  useEffect(() => {
    void api.sessionHomes().then(setHomes, () => setHomes([]))
  }, [reads])

  const pickExport = async (): Promise<void> => {
    choosing.current = true
    try {
      const given = await api.pickChatExport()
      input.current?.focus()
      if (!given) return
      setPicked(
        given.chats
          ? `${given.chats} ${given.chats === 1 ? 'chat' : 'chats'} from ${given.home}${given.newer ? `: a newer export of it is in Downloads, and that one is read` : ''}.`
          : `That export from ${given.home} holds no chats.`
      )
      setReads((n) => n + 1)
    } catch (err) {
      setPicked((err as Error).message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''))
    } finally {
      choosing.current = false
    }
  }
  const exported = homes.some(onWeb)

  const toggle = async (home: SessionHome): Promise<void> => {
    const dirs = agent.workHomes.map((h) => h.dir).filter((dir) => placeKey(dir) !== placeKey(home.dir))
    // Back to the search box, where arrows and Enter pick.
    input.current?.focus()
    onAgent(await api.setSessionHomes(agent.id, own.has(placeKey(home.dir)) ? dirs : [...dirs, home.dir]))
  }
  const everywhere = async (): Promise<void> => {
    input.current?.focus()
    if (own.size) onAgent(await api.setSessionHomes(agent.id, []))
  }
  // Its own ones are gone (a folder deleted or renamed): it finds nothing until they pick again.
  const gone = homes.length > 0 && own.size > 0 && !homes.some((h) => own.has(placeKey(h.dir)))
  // Its own are to pick with two accounts of a tool (one for work, say), or once some are picked: else it's all of them.
  const picksOwn = own.size > 0 || homes.some((h) => homes.filter((o) => o.tool === h.tool).length > 1)

  useEffect(() => {
    const away = (): void => {
      if (!choosing.current) onClose()
    }
    window.addEventListener('blur', away)
    return () => {
      window.removeEventListener('blur', away)
    }
  }, [onClose])

  useEffect(() => {
    let current = true
    const timer = setTimeout(
      () =>
        void api.findWorkSessions(query, agent.id).then(
          (list) => {
            if (!current) return
            setFound(list)
            setAt(0)
          },
          () => current && setFound([])
        ),
      query ? SEARCH_MS : 0
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
    // Its own ones picked again: the list is theirs. An export picked: its chats are in it.
  }, [query, agent.id, ownKey, reads])

  useEffect(() => {
    box.current?.querySelector('.session-choice.at')?.scrollIntoView({ block: 'nearest' })
  }, [at, found])

  const added = new Set(agent.knowledge.filter((d) => d.kind === 'session').map((d) => d.source))
  const keys = (e: KeyboardEvent<HTMLInputElement>): void => {
    // Enter here picks, or does nothing: it's in the box to write in's form, and mustn't send what's written there.
    if (e.key === 'Enter') e.preventDefault()
    if (!found?.length) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setAt((i) => Math.max(0, Math.min(found.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))))
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) onPick(found[Math.min(at, found.length - 1)])
  }

  return (
    <PickerDialog title="Import an AI chat" onClose={onClose}>
    <div className="session-picker" ref={box}>
      {picksOwn && (
        <div className="session-homes" role="group" aria-label="Where it looks: this agent's own Claude Code, Codex and chats">
          <span className="hint">{gone ? 'Its own aren’t on this PC any more. Look in:' : 'Look in:'}</span>
          <button type="button" className={`home-choice all ${own.size ? '' : 'on'}`} aria-pressed={!own.size} onClick={() => void everywhere()}>
            All
          </button>
          {homes.map((h) => (
            <button
              key={h.dir}
              type="button"
              className={`home-choice ${own.has(placeKey(h.dir)) ? 'on' : ''}`}
              aria-pressed={own.has(placeKey(h.dir))}
              title={h.from ? `From your export: ${h.from}` : h.dir}
              onClick={() => void toggle(h)}
            >
              {h.name}
            </button>
          ))}
        </div>
      )}
      <input
        ref={input}
        autoFocus
        value={query}
        placeholder="Search: what it was about, or its folder"
        aria-label="Search your work sessions"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={keys}
      />
      <div className="sessions" role="listbox" aria-label="Work sessions">
        {found === null ? (
          <p className="hint">Looking for them…</p>
        ) : !found.length ? (
          <p className="hint">{query.trim() ? `No session or chat matches “${query.trim()}”.` : own.size ? 'None in its own yet.' : 'No work sessions or chats here yet.'}</p>
        ) : (
          found.map((s, i) => (
            <button
              key={s.file}
              type="button"
              role="option"
              aria-selected={i === at}
              className={`session-choice ${i === at ? 'at' : ''}`}
              title={s.first && s.first !== s.title ? `First asked: ${s.first}` : undefined}
              onMouseEnter={() => setAt(i)}
              onClick={() => onPick(s)}
            >
              <strong>{s.title}</strong>
              <span className="session-detail">{[s.home ?? TOOLS[s.tool], folderName(s.cwd), ago(s.updatedAt), added.has(s.file) && 'added'].filter(Boolean).join(' · ')}</span>
              {asked(s) && <span className="session-asked">{asked(s)}</span>}
            </button>
          ))
        )}
      </div>
      {picked && (
        <p className="hint" role="status">
          {picked}
        </p>
      )}
      <p className="hint">
        {exported
          ? 'Your chats are as of your last export of them. '
          : 'For your chats on claude.ai or ChatGPT, export them (their Settings › Export data): the zip shows up here once it’s downloaded. '}
        <button type="button" className="link" onClick={() => void pickExport()}>
          {exported ? 'A newer export…' : 'Choose an export…'}
        </button>
      </p>
    </div>
    </PickerDialog>
  )
}
