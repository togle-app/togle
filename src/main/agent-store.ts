import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { validatePreferences } from '@shared/preferences'
import { vocabularyTerms } from '@shared/speech-words'
import type { Agent, AgentPatch } from '@shared/types'
import { writeFileAtomic } from './storage'

// An agent's id, as it can be part of a file's name: as Togle makes them (UUIDs), or the name of an agent's own file.
const SAFE_ID = /^[\w-]{1,100}$/
// The words speech recognition is given for a call, at most this long.
const HINT_CHARS = 600

/**
 * What a call belongs to, as Togle has kept it since its first versions: an agent, with a name, the words its calls are
 * heard with, and preferences an earlier version may have saved for it. Togle makes one when there is none. Whatever else
 * an earlier version kept in an agent's file (the call assistant's documents, skills, training) stays in the file as it
 * was, and is not read.
 */
export class AgentStore extends EventEmitter {
  private agents = new Map<string, Agent>()
  /** Per-agent chain of file writes, so concurrent saves land in order. */
  private writes = new Map<string, Promise<void>>()

  private get dir(): string {
    return path.join(app.getPath('userData'), 'agents')
  }

  async load(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    for (const file of await fs.readdir(this.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const stored = JSON.parse(await fs.readFile(path.join(this.dir, file), 'utf8')) as Partial<Agent> | null
        if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error("it isn't an agent")
        // Its id names its file: one that couldn't (a path) leaves the agent out, rather than write elsewhere.
        const fileId = file.slice(0, -'.json'.length)
        const id = typeof stored.id === 'string' && SAFE_ID.test(stored.id) ? stored.id : SAFE_ID.test(fileId) ? fileId : undefined
        if (!id) throw new Error("its id can't name a file")
        const now = Date.now()
        this.agents.set(id, {
          ...stored,
          id,
          name: typeof stored.name === 'string' && stored.name.trim() ? stored.name : 'Agent',
          vocabulary: typeof stored.vocabulary === 'string' ? stored.vocabulary : '',
          createdAt: typeof stored.createdAt === 'number' ? stored.createdAt : now,
          updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : now
        })
      } catch (err) {
        console.warn(`[agents] skipping ${file}:`, (err as Error).message)
      }
    }
    if (!this.agents.size) {
      const now = Date.now()
      await this.save({ id: randomUUID(), name: 'General', vocabulary: '', createdAt: now, updatedAt: now })
    }
  }

  list(): Agent[] {
    return [...this.agents.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): Agent {
    return this.agents.get(id) ?? this.list()[0]
  }

  /** Changes the agent: its name, its words, its preferences or the account it uses. */
  async update(id: string, patch: AgentPatch): Promise<Agent> {
    const current = this.agents.get(id)
    if (!current) throw new Error('Agent not found')
    const next: Agent = { ...current }
    if (patch.name !== undefined) next.name = String(patch.name).trim().slice(0, 80) || current.name
    if (patch.vocabulary !== undefined) next.vocabulary = String(patch.vocabulary)
    if ('preferences' in patch) next.preferences = validatePreferences(patch.preferences)
    if ('subscriptionAccountId' in patch) next.subscriptionAccountId = patch.subscriptionAccountId || undefined
    return this.save(next)
  }

  /** The words speech recognition is given for the agent's calls: its own, as one line ("Flatbooks, SAP."). */
  vocabularyFor(given: Agent): string {
    const agent = this.agents.get(given.id) ?? given
    let out = ''
    for (const term of vocabularyTerms(agent.vocabulary)) {
      if (out.length + term.length + 2 > HINT_CHARS) break
      out += (out ? ', ' : '') + term
    }
    return out ? `${out}.` : ''
  }

  /**
   * Stores the agent. The in-memory copy updates at once, so a read after this sees it; disk writes are chained per
   * agent so the newest state wins.
   */
  private async save(agent: Agent): Promise<Agent> {
    agent = { ...agent, updatedAt: Date.now() }
    this.agents.set(agent.id, agent)
    const json = JSON.stringify(agent, null, 2)
    const file = path.join(this.dir, `${agent.id}.json`)
    const write = (this.writes.get(agent.id) ?? Promise.resolve()).then(() => writeFileAtomic(file, json))
    this.writes.set(agent.id, write.catch(() => undefined))
    await write
    this.emit('changed', agent)
    return agent
  }
}
