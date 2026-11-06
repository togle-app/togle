import { talkOf, type SavedConversation, type TalkTurn } from '@shared/chat'
import { readSecret, writeSecret, writeSecretJson } from '../storage'

// What one agent's conversation may hold on disk; the window keeps it well under (its latest entries).
const MAX_CHARS = 8_000_000

/**
 * Each agent's conversation, as the window last saved it: kept across restarts, as Hermes Agent keeps its sessions,
 * encrypted on this PC (DPAPI), and deleted with the agent.
 */
export class Conversations {
  /** Per-agent chain of file writes, so they land in order. */
  private writes = new Map<string, Promise<void>>()
  /** Agents deleted: a save still on its way keeps nothing. */
  private gone = new Set<string>()
  /** What was said with each agent lately (talkOf), as its conversation was last loaded or saved: its calls read it. */
  private talks = new Map<string, TalkTurn[]>()

  /** An agent's file: only for an id as Togle makes them (a path from the window, "../..", names nothing). */
  private file(agentId: string): string {
    if (typeof agentId !== 'string' || !/^[\w-]{1,100}$/.test(agentId)) throw new Error('No such agent.')
    return `conversations/${agentId}.bin`
  }

  async load(agentId: string): Promise<SavedConversation | null> {
    const file = this.file(agentId)
    // A save still on its way lands first: read before it, the window would get the older conversation (and save it back).
    await this.writes.get(agentId)
    const saved = await readSecret<SavedConversation>(file)
    const kept = saved && Array.isArray(saved.entries) && saved.cards && typeof saved.cards === 'object' ? saved : null
    if (!this.gone.has(agentId)) this.talks.set(agentId, kept ? talkOf(kept.entries) : [])
    return kept
  }

  /** What was said with an agent lately (talkOf), for its call's answers: as last loaded or saved, else read now. */
  async talk(agentId: string): Promise<TalkTurn[]> {
    if (!this.talks.has(agentId)) await this.load(agentId)
    return this.talks.get(agentId) ?? []
  }

  /** Keeps it as given; one that has grown past what a conversation holds is refused, not cut. */
  async save(agentId: string, conversation: SavedConversation): Promise<void> {
    const file = this.file(agentId)
    if (this.gone.has(agentId)) return
    if (!Array.isArray(conversation?.entries) || !conversation.cards || typeof conversation.cards !== 'object') throw new Error('Not a conversation.')
    // Turned into text once, to measure and to keep: a conversation with its calls' suggestions runs to megabytes.
    const json = JSON.stringify(conversation)
    if (json.length > MAX_CHARS) throw new Error('The conversation is too long to keep.')
    this.talks.set(agentId, talkOf(conversation.entries))
    const write = (this.writes.get(agentId) ?? Promise.resolve()).then(() => (this.gone.has(agentId) ? undefined : writeSecretJson(file, json)))
    this.writes.set(
      agentId,
      write.catch(() => undefined)
    )
    await write
  }

  /** The agent was deleted: its conversation goes with it. */
  async forget(agentId: string): Promise<void> {
    const file = this.file(agentId)
    this.gone.add(agentId)
    this.talks.delete(agentId)
    await this.writes.get(agentId)
    await writeSecret(file, null)
  }
}
