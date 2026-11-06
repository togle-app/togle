import { useEffect, useState } from 'react'
import { skillPurpose } from '@shared/agent-learning'
import type { Agent, AgentPreview, HubListing, ShareChoice } from '@shared/types'
import { Row, Section, Toggle } from './Rows'

const api = window.togle

const errorText = (err: unknown): string => (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// The market's agents as last shown, for this run of Togle.
let lastListed: HubListing[] | null = null

/** "a, b and c": a list in a sentence (commas inside an item are left alone). */
const listed = (items: string[]): string => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/**
 * Sharing an agent: what it carries (its setup, skills, approved answers and words to recognize), the memory facts and
 * documents to add (none unless ticked), and where it goes: a .togle file, or a hub on GitHub.
 */
export function SharePanel({ agent }: { agent: Agent }) {
  const [memory, setMemory] = useState<string[]>([])
  const [docs, setDocs] = useState<string[]>([])
  const [author, setAuthor] = useState('')
  const [hubs, setHubs] = useState<string[]>([])
  const [hub, setHub] = useState('')
  const [done, setDone] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.hubNames().then((names) => {
      setHubs(names)
      setHub(names[0] ?? '')
    })
  }, [])

  const choice = (): ShareChoice => ({ memory, docs, author: author.trim() || undefined })
  const flip = (list: string[], item: string, on: boolean): string[] => (on ? [...list, item] : list.filter((x) => x !== item))
  // Work sessions are their own (often their company's) work: not offered.
  const shareable = agent.knowledge.filter((d) => d.kind !== 'session')
  const run = async (action: () => Promise<string | null>) => {
    setBusy(true)
    setError('')
    setDone('')
    try {
      const said = await action()
      if (said) setDone(said)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const save = () => run(async () => ((await api.exportAgent(agent.id, choice())) ? 'Saved. Anyone with Togle can install it from Explore agents → Import file.' : null))
  const publish = () =>
    run(async () => {
      await api.publishAgent(agent.id, choice(), hub)
      return "Its folder opened, and the hub's page in your browser: drag the folder's files onto the page, then propose the change. The hub's keepers review it before it's listed."
    })

  const assistanceCount = agent.skills.filter(skill => skillPurpose(skill) === 'assistance').length
  const referenceCount = agent.skills.filter(skill => skillPurpose(skill) === 'reference').length
  const carries = [
    'its instructions',
    assistanceCount ? `${assistanceCount} assistance skill${assistanceCount === 1 ? '' : 's'}` : '',
    referenceCount ? `${referenceCount} reference note${referenceCount === 1 ? '' : 's'}` : '',
    agent.answers.length ? `${agent.answers.length} approved answer${agent.answers.length === 1 ? '' : 's'}` : '',
    agent.vocabulary.trim() ? 'its words to recognize' : ''
  ].filter(Boolean)
  return (
    <section className="share">
      <p className="hint">Anyone with Togle can install a copy of it. It takes {listed(carries)}.</p>
      {agent.memory.length > 0 && (
        <Section title="Facts it remembers, to include">
          {agent.memory.map((fact) => (
            <Toggle key={fact} name={<span className="fact-body">{fact}</span>} checked={memory.includes(fact)} onChange={(on) => setMemory(flip(memory, fact, on))} />
          ))}
        </Section>
      )}
      {shareable.length > 0 && (
        <Section title="Documents, to include">
          {shareable.map((d) => (
            <Toggle key={d.id} name={<span className="fact-body">{d.name}</span>} checked={docs.includes(d.id)} onChange={(on) => setDocs(flip(docs, d.id, on))} />
          ))}
        </Section>
      )}
      <Section title="You" note="Never shared: your conversation with it, your calls, your work sessions, or what you told it about yourself.">
        <Row name="Your name, shown with it">
          <input value={author} placeholder="Optional" onChange={(e) => setAuthor(e.target.value)} />
        </Row>
      </Section>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Save as a file…
        </button>
      </div>
      {hubs.length > 0 && (
        <div className="share-hub">
          <strong>Or publish it to a hub</strong>
          <p className="hint">A hub is a GitHub repository of agents. Its keepers review it before it's listed.</p>
          <div className="row">
            {hubs.length > 1 && (
              <select value={hub} onChange={(e) => setHub(e.target.value)}>
                {hubs.map((h) => (
                  <option key={h} value={h}>
                    {h}
                  </option>
                ))}
              </select>
            )}
            <button className="ghost" disabled={busy || !hub} onClick={() => void publish()}>
              Publish to {hubs.length > 1 ? 'the hub' : hub}…
            </button>
          </div>
        </div>
      )}
      {done && <p className="saved">{done}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  )
}

interface PreviewProps {
  preview: AgentPreview
  onInstalled: (agent: Agent) => void
  /** Talks to the agent of mine installed from it already. */
  onTalk: (id: string) => void
  onCancel: () => void
}

/**
 * An agent someone else made, shown in full before it's installed: what it adds, and what the check found. One I
 * have already is to talk to; a second copy is a click further.
 */
export function InstallPreview({ preview, onInstalled, onTalk, onCancel }: PreviewProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const dangers = preview.findings.filter((f) => f.level === 'danger')
  const cautions = preview.findings.filter((f) => f.level === 'caution')
  const install = async () => {
    setBusy(true)
    setError('')
    try {
      onInstalled(await api.installAgent(preview.id))
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  return (
    <section className="install">
      <h3>{preview.name}</h3>
      {preview.description && <p>{preview.description}</p>}
      <p className="hint">
        {preview.author ? `By ${preview.author} · ` : ''}
        {preview.trust === 'official' ? "from Togle's market" : `from ${preview.from} · shared by someone: read what it says before you install it`}
      </p>
      {preview.installedAs && <p className="hint">You have it already, as “{preview.installedAs.name}”.</p>}
      {dangers.length > 0 && (
        <div className="guard danger">
          <strong>Togle won't install it:</strong>
          {dangers.map((f, i) => (
            <p key={i}>
              {f.where} {f.what}: <q>{f.excerpt}</q>
            </p>
          ))}
        </div>
      )}
      {cautions.length > 0 && (
        <div className="guard caution">
          <strong>Look at these first</strong>
          {cautions.map((f, i) => (
            <p key={i}>
              {f.where}, {f.what}: {f.excerpt}
            </p>
          ))}
        </div>
      )}
      <details open>
        <summary>Instructions</summary>
        <p className="pre">{preview.instructions || '(none)'}</p>
      </details>
      {preview.skills.length > 0 && (
        <details open>
          <summary>
            Assistance & reference material <span className="count">{preview.skills.length}</span>
          </summary>
          {preview.skills.map((s, i) => (
            <details key={i} className="skill">
              <summary>
                <strong>{s.name}</strong><span className="hint"> · {s.purpose === 'reference' ? 'Reference knowledge' : 'Assistance skill'}</span>
                {s.when && <span className="hint"> · {s.when}</span>}
              </summary>
              <p className="pre">{s.how}</p>
            </details>
          ))}
        </details>
      )}
      {preview.answers.length > 0 && (
        <details>
          <summary>
            Approved answers <span className="count">{preview.answers.length}</span>
          </summary>
          {preview.answers.map((a, i) => (
            <p key={i}>
              <strong>{a.question}</strong>
              <br />
              {a.answer}
            </p>
          ))}
        </details>
      )}
      {preview.memory.length > 0 && (
        <details>
          <summary>
            Memory <span className="count">{preview.memory.length}</span>
          </summary>
          <ul>
            {preview.memory.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      )}
      {preview.docs.length > 0 && (
        <details>
          <summary>
            Documents <span className="count">{preview.docs.length}</span>
          </summary>
          {preview.docs.map((d, i) => (
            <details key={i} className="skill">
              <summary>
                <strong>{d.name}</strong> <span className="hint">({d.chars.toLocaleString()} characters)</span>
              </summary>
              <p className="pre">
                {d.excerpt}
                {d.chars > d.excerpt.length && '…'}
              </p>
            </details>
          ))}
        </details>
      )}
      {preview.studies > 0 && (
        <p className="hint">
          Its documents are long: once it's installed, Togle studies each of them, a request of your plan each ({preview.studies} in all).
        </p>
      )}
      {preview.vocabulary && <p className="hint">Words to recognize: {preview.vocabulary}</p>}
      {preview.notes.map((n, i) => (
        <p key={i} className="hint">
          {n}
        </p>
      ))}
      <div className="row">
        {preview.installedAs ? (
          <>
            <button className="primary" onClick={() => onTalk(preview.installedAs!.id)}>
              Talk to {preview.installedAs.name}
            </button>
            <button className="ghost" disabled={busy || dangers.length > 0} onClick={() => void install()}>
              {busy ? 'Installing…' : 'Install another copy'}
            </button>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy || dangers.length > 0} onClick={() => void install()}>
              {busy ? 'Installing…' : 'Install'}
            </button>
            <button className="ghost" onClick={onCancel}>
              Cancel
            </button>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  )
}

/**
 * The agent market, as Hermes Agent's Skills Hub: agents made for kinds of calls, by Togle (they come with it) and by
 * people who share theirs in hubs on GitHub; by category, or searched; each checked, and shown in full, before it's
 * installed. Installing one someone sent as a file is here too, and adding a hub to list.
 */
export function Market({ agents, onPreview, onFile }: { agents: Agent[]; onPreview: (preview: AgentPreview) => void; onFile: () => Promise<void> }) {
  // As the market was last shown: there at once when it opens again, while it's read afresh.
  const [listings, setListings] = useState<HubListing[] | null>(lastListed)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [adding, setAdding] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')

  // Togle's own agents (on this PC) at once, and each added hub's as it answers: a slow hub holds up only itself.
  const load = async (): Promise<void> => {
    const shown = (came: HubListing[], order: string[]): void =>
      setListings((prev) => {
        const all = [...(prev ?? []).filter((l) => !came.some((c) => c.hub === l.hub) && (l.official || order.includes(l.hub))), ...came]
        const next = all.sort((a, b) => Number(b.official) - Number(a.official) || order.indexOf(a.hub) - order.indexOf(b.hub))
        lastListed = next
        return next
      })
    const failed = (err: unknown): void => {
      setListings((prev) => prev ?? [])
      setError(errorText(err))
    }
    const names = await api.hubNames().catch(() => [] as string[])
    await Promise.all([
      api.hubAgents('own').then((own) => shown(own, names), failed),
      ...names.map((name) => api.hubAgents(name).then((one) => shown(one, names), failed))
    ])
  }
  useEffect(() => void load(), [])

  const act = async (label: string, action: () => Promise<void>) => {
    setBusy(label)
    setError('')
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }
  const open = (hub: string, slug: string) => act(`${hub}/${slug}`, async () => onPreview(await api.previewHubAgent(hub, slug)))
  const add = () =>
    act('add', async () => {
      await api.addHub(adding)
      setAdding('')
      await load()
    })
  const remove = (hub: string) =>
    act('remove', async () => {
      await api.removeHub(hub)
      await load()
    })

  // What I installed from the market, by where each of mine came from.
  const installed = new Set(agents.flatMap((a) => (a.source?.from === 'hub' ? [a.source.ref] : [])))
  const all = (listings ?? []).flatMap((l) => l.entries.map((e) => ({ ...e, hub: l.hub, official: l.official })))
  // The categories its agents are in, the fullest first.
  const counts = new Map<string, number>()
  for (const e of all) for (const tag of e.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
  const categories = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag)
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter(
    (e) => (!category || e.tags.includes(category)) && words.every((w) => `${e.name} ${e.description} ${e.author ?? ''} ${e.tags.join(' ')}`.toLowerCase().includes(w))
  )
  const added = (listings ?? []).filter((l) => !l.official)
  return (
    <div className="market">
      {listings === null ? (
        <p className="hint">Opening the market…</p>
      ) : (
        <>
          <input className="market-search" value={query} placeholder="Search agents" aria-label="Search the market" onChange={(e) => setQuery(e.target.value)} />
          {categories.length > 1 && (
            <div className="chips" role="group" aria-label="Categories">
              <button className={`chip ${category ? '' : 'on'}`} aria-pressed={!category} onClick={() => setCategory('')}>
                All
              </button>
              {categories.map((c) => (
                <button key={c} className={`chip ${category === c ? 'on' : ''}`} aria-pressed={category === c} onClick={() => setCategory(category === c ? '' : c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <div className="market-list">
            {shown.map((e) => (
              <button key={`${e.hub}/${e.slug}`} className="market-row" disabled={!!busy} onClick={() => void open(e.hub, e.slug)}>
                <span className="market-name">
                  <strong>{e.name}</strong>
                  {installed.has(`${e.hub}/agents/${e.slug}`) && <span className="installed">Installed</span>}
                </span>
                <span className="market-about">{e.description || 'No description'}</span>
                <span className="market-meta">
                  {[
                    e.tags[0],
                    e.skills ? `${e.skills} skill${e.skills === 1 ? '' : 's'}` : '',
                    e.answers ? `${e.answers} answer${e.answers === 1 ? '' : 's'}` : '',
                    e.author && e.author !== 'Togle' ? `by ${e.author}` : '',
                    e.official ? '' : `from ${e.hub}`
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
            ))}
            {!shown.length && <p className="hint">{words.length || category ? `No agent matches${query.trim() ? ` “${query.trim()}”` : ''}.` : 'No agents here yet.'}</p>}
          </div>
          {(listings ?? [])
            .filter((l) => l.error)
            .map((l) => (
              <p key={l.hub} className="error">
                {l.hub}: {l.error}
              </p>
            ))}
        </>
      )}
      <p className="hint market-file">
        Someone sent you an agent?{' '}
        <button className="link" disabled={!!busy} onClick={() => void act('file', onFile)}>
          Import file…
        </button>
      </p>
      <details className="more">
        <summary>More sources</summary>
        <p className="hint">The market can list the agents of hubs on GitHub too: a hub is a repository of agents people share. Add one by its name, owner/repo.</p>
        {added.map((l) => (
          <div key={l.hub} className="hub-source">
            <span>{l.hub}</span>
            <button className="link" disabled={!!busy} onClick={() => void remove(l.hub)}>
              Remove
            </button>
          </div>
        ))}
        <div className="hub-add">
          <input
            value={adding}
            placeholder="owner/repo"
            aria-label="Add a hub"
            onChange={(e) => setAdding(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && adding.trim() && void add()}
          />
          <button className="ghost" disabled={!adding.trim() || !!busy} onClick={() => void add()}>
            Add
          </button>
        </div>
      </details>
      {error && <p className="error">{error}</p>}
    </div>
  )
}
