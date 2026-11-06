import { randomUUID } from 'node:crypto'
import type { ApiConnection, ApiConnectionInput } from '@shared/types'
import { modelSourceId } from '@shared/model-selection'
import { getSettings } from '../settings'
import { readJson, writeJson, writeSecret } from '../storage'
import { ClaudeProvider } from '../providers/claude'
import { CompatProvider } from '../providers/compat'
import type { LLMProvider, Usage } from '../providers/types'

type Metadata = Omit<ApiConnection, 'hasKey' | 'legacy'>
type Entry = { metadata: Metadata; provider: ClaudeProvider | CompatProvider }
const FILE = 'connections/index.json'
const isLocal = (value: string): boolean => { try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname) } catch { return false } }
const keyFile = (id: string): string => `connections/${id.slice('connection:'.length)}/key.bin`

function inputOf(input: ApiConnectionInput): ApiConnectionInput {
  if (!input || !['anthropic', 'compatible', 'local'].includes(input.kind) || typeof input.label !== 'string' || !input.label.trim()) throw new Error('Choose a connection type and enter a name.')
  let url: URL
  try { url = new URL(input.kind === 'anthropic' ? 'https://api.anthropic.com' : input.baseUrl) } catch { throw new Error('Enter a valid server URL, including http:// or https://.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP or HTTPS server URL. Put credentials in the API key field.')
  if (input.key !== undefined && typeof input.key !== 'string') throw new Error('Enter an API key.')
  return { kind: input.kind, label: input.label.trim().slice(0, 60), baseUrl: url.toString().replace(/\/+$/, ''), model: typeof input.model === 'string' ? input.model.trim().slice(0, 200) : '', ...(input.key !== undefined ? { key: input.key.trim() } : {}) }
}

/** Named API/local connections have separate encrypted keys and immutable request snapshots. */
export class ApiConnections {
  private entries = new Map<string, Entry>()
  private writing: Promise<unknown> = Promise.resolve()
  onChange: () => void = () => {}
  onUsage: (usage: Usage) => void = () => {}
  constructor(private legacyClaude: ClaudeProvider, private legacyCompat: CompatProvider) {}
  private make(metadata: Metadata): Entry {
    const provider = metadata.kind === 'anthropic' ? new ClaudeProvider(undefined, keyFile(metadata.id)) : new CompatProvider(() => metadata, keyFile(metadata.id))
    provider.onUsage = usage => this.onUsage(usage)
    return { metadata, provider }
  }
  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const task = this.writing.catch(() => {}).then(run)
    this.writing = task
    return task
  }
  private persist(entries: Map<string, Entry>): Promise<void> { return writeJson(FILE, [...entries.values()].map(entry => entry.metadata)) }
  async load(): Promise<void> {
    const stored = await readJson<Metadata[]>(FILE, [])
    if (!Array.isArray(stored)) return
    for (const data of stored.slice(0, 30)) {
      if (!data || !/^connection:[a-f0-9-]{36}$/.test(data.id)) continue
      try {
        const input = inputOf(data), metadata = { id: data.id, kind: input.kind, label: input.label, baseUrl: input.baseUrl, model: input.model, revision: Number.isSafeInteger(data.revision) ? data.revision : 1 }
        const entry = this.make(metadata); await entry.provider.load(); this.entries.set(metadata.id, entry)
      } catch { /* A malformed entry cannot change another connection or its credentials. */ }
    }
  }
  private legacy(id: string): Entry {
    if (id === 'api:claude') return { metadata: { id, kind: 'anthropic', label: 'Anthropic API', baseUrl: 'https://api.anthropic.com', model: '', revision: this.legacyClaude.identity() }, provider: this.legacyClaude }
    if (id === 'api:compat') { const config = getSettings().compat; return { metadata: { id, ...config, kind: isLocal(config.baseUrl) ? 'local' : 'compatible', label: isLocal(config.baseUrl) ? 'Local server' : 'API connection', revision: this.legacyCompat.identity() }, provider: this.legacyCompat } }
    throw new Error('This AI connection is unavailable. Choose another in Settings → Accounts.')
  }
  get(id: string): Entry { return this.entries.get(id) || this.legacy(id) }
  list(): ApiConnection[] {
    const entries = [...this.entries.values()]
    if (this.legacyClaude.hasApiKey() || getSettings().ai && Object.values(getSettings().ai!.tasks).some(task => task.sourceId === 'api:claude') || modelSourceId(getSettings()) === 'api:claude') entries.unshift(this.legacy('api:claude'))
    const compat = getSettings().compat
    if (this.legacyCompat.hasApiKey() || isLocal(compat.baseUrl) || compat.model || modelSourceId(getSettings()) === 'api:compat' || getSettings().ai && Object.values(getSettings().ai!.tasks).some(task => task.sourceId === 'api:compat')) entries.unshift(this.legacy('api:compat'))
    return entries.map(({ metadata, provider }) => ({ ...metadata, hasKey: provider.hasApiKey(), ...(metadata.id.startsWith('api:') ? { legacy: true } : {}) }))
  }
  add(input: ApiConnectionInput): Promise<ApiConnection> {
    return this.serialize(async () => {
      if (this.entries.size >= 30) throw new Error('At most 30 API and local connections can be saved.')
      const value = inputOf(input), id = `connection:${randomUUID()}`
      if (value.kind === 'anthropic' && !value.key) throw new Error('Enter an Anthropic API key to connect this account.')
      const { key, ...fields } = value, entry = this.make({ id, ...fields, revision: 1 })
      if (key) await entry.provider.setApiKey(key)
      const next = new Map(this.entries); next.set(id, entry)
      try { await this.persist(next) } catch (error) { await writeSecret(keyFile(id), null).catch(() => {}); throw error }
      this.entries = next; this.onChange()
      return this.list().find(item => item.id === id)!
    })
  }
  update(id: string, input: ApiConnectionInput): Promise<ApiConnection> {
    return this.serialize(async () => {
      const before = this.get(id)
      if (id.startsWith('api:')) throw new Error('Add a named connection to change a legacy endpoint.')
      const { key, ...fields } = inputOf(input)
      if (before.provider.hasApiKey() && key === undefined && (before.metadata.kind !== fields.kind || new URL(before.metadata.baseUrl).origin !== new URL(fields.baseUrl).origin)) throw new Error('Enter a new API key, or explicitly clear it, when changing the server or connection type.')
      const entry = this.make({ id, ...fields, revision: before.metadata.revision + 1 }); await entry.provider.load()
      const next = new Map(this.entries); next.set(id, entry)
      // Persist metadata before changing the key; a failed metadata write keeps the old connection usable.
      await this.persist(next)
      try { if (key !== undefined) await entry.provider.setApiKey(key) } catch (error) { await this.persist(this.entries); throw error }
      this.entries = next; this.onChange()
      return this.list().find(item => item.id === id)!
    })
  }
  remove(id: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.entries.has(id)) throw new Error('Only named connections can be removed here.')
      const next = new Map(this.entries); next.delete(id); await this.persist(next)
      this.entries = next; this.onChange(); await writeSecret(keyFile(id), null)
    })
  }
  pinned(id: string): LLMProvider {
    const entry = this.get(id), snapshot = structuredClone(entry.metadata), keyIdentity = entry.provider.identity(), provider = entry.provider.pinned()
    const check = (): void => {
      const current = this.get(id)
      if (current.metadata.revision !== snapshot.revision || current.metadata.baseUrl !== snapshot.baseUrl || current.provider.identity() !== keyIdentity) throw new Error('The AI connection changed. Start a new call or request with the intended connection.')
    }
    return { id: provider.id, supportsTools: provider.supportsTools,
      listModels: async () => { check(); const models = await provider.listModels(); check(); return models },
      stream: async (input, options) => { check(); await provider.stream(input, options); check() }
    }
  }
}
