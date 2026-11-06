import { app } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Settings, SubscriptionAccount, PlanUsage } from '@shared/types'
import { readJson, writeJson } from '../storage'
import { ChatGPTAuth } from './chatgpt'
import { ClaudeCodeAuth } from './claude-code'
import { ChatGPTProvider } from '../providers/chatgpt'
import { ClaudeSubscriptionProvider } from '../providers/claude-subscription'
import type { LLMProvider, Usage } from '../providers/types'

type Metadata = Pick<SubscriptionAccount, 'id' | 'provider' | 'label' | 'shared'>
export type AccountRuntime = { metadata: Metadata } & (
  { kind: 'chatgpt'; auth: ChatGPTAuth; provider: ChatGPTProvider } |
  { kind: 'claude'; auth: ClaudeCodeAuth; provider: ClaudeSubscriptionProvider }
)
const FILE = 'accounts/index.json'
export const defaultAccountId = (provider: 'chatgpt' | 'claude'): string => `${provider}-default`

/** Chooses an explicit profile without ever falling back from a missing work account to a personal one. */
export function accountChoice(settings: Settings, override?: string): string | undefined {
  if (override) return override
  if (settings.provider !== 'chatgpt' && !(settings.provider === 'claude' && settings.claude.auth === 'subscription')) return
  return settings.subscriptionAccountId || defaultAccountId(settings.provider as 'chatgpt' | 'claude')
}

/** Each profile owns its auth, provider, usage limits and Claude configuration. Only labels are stored here. */
export class SubscriptionAccounts {
  private entries = new Map<string, AccountRuntime>()
  private writing: Promise<void> = Promise.resolve()
  private loginId?: string
  private login?: Promise<unknown>
  onChange: (account: SubscriptionAccount) => void = () => {}
  onUsage: (usage: Usage) => void = () => {}
  onPlan: (id: string, usage: PlanUsage) => void = () => {}

  constructor(chatgpt: ChatGPTAuth, openai: ChatGPTProvider, claude: ClaudeCodeAuth, anthropic: ClaudeSubscriptionProvider) {
    this.register({ metadata: { id: defaultAccountId('chatgpt'), provider: 'chatgpt', label: 'ChatGPT', shared: true }, kind: 'chatgpt', auth: chatgpt, provider: openai })
    this.register({ metadata: { id: defaultAccountId('claude'), provider: 'claude', label: 'Claude Code', shared: true }, kind: 'claude', auth: claude, provider: anthropic })
  }

  private snapshot(entry: AccountRuntime): SubscriptionAccount {
    const status = entry.kind === 'claude' ? entry.auth.cachedStatus() : entry.auth.status()
    return { ...entry.metadata, ...status, signingIn: this.loginId === entry.metadata.id || ('signingIn' in status && status.signingIn === true) }
  }
  private register(entry: AccountRuntime): void {
    this.entries.set(entry.metadata.id, entry)
    entry.provider.onUsage = usage => this.onUsage(usage)
    let previousEmail: string | undefined
    const changed = (): void => {
      const email = this.snapshot(entry).email
      if (entry.kind === 'claude' && email !== previousEmail) entry.provider.clearConnections()
      else if (entry.kind === 'chatgpt' && !entry.auth.status().signedIn) entry.provider.plan.clear()
      previousEmail = email
      this.onChange(this.snapshot(entry))
    }
    if (entry.kind === 'claude') entry.auth.onChange = changed
    else {
      entry.auth.on('changed', changed)
      entry.provider.plan.onChange = usage => this.onPlan(entry.metadata.id, usage)
    }
  }
  private make(metadata: Metadata): AccountRuntime {
    if (metadata.provider === 'claude') {
      const auth = new ClaudeCodeAuth(undefined, undefined, path.join(app.getPath('userData'), 'accounts', metadata.id, 'claude'))
      return { metadata, kind: 'claude', auth, provider: new ClaudeSubscriptionProvider(auth) }
    }
    const auth = new ChatGPTAuth(path.join('accounts', metadata.id, 'chatgpt-auth.bin'))
    return { metadata, kind: 'chatgpt', auth, provider: new ChatGPTProvider(auth) }
  }
  async load(): Promise<void> {
    const saved = await readJson<Metadata[]>(FILE, [])
    if (Array.isArray(saved)) for (const meta of saved.slice(0, 20)) {
      if (!meta || !/^[a-f0-9-]{36}$/.test(meta.id) || !['claude', 'chatgpt'].includes(meta.provider) || typeof meta.label !== 'string' || this.entries.has(meta.id)) continue
      this.register(this.make({ id: meta.id, provider: meta.provider, label: meta.label.slice(0, 60) }))
    }
    await Promise.all([...this.entries.values()].filter(entry => entry.kind === 'chatgpt' && !entry.metadata.shared).map(entry => (entry.auth as ChatGPTAuth).load()))
  }
  get(id: string): AccountRuntime {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('This subscription account is unavailable. Choose an account in the agent’s settings.')
    return entry
  }
  identity(id: string): SubscriptionAccount { return this.snapshot(this.get(id)) }
  async list(refresh = false): Promise<SubscriptionAccount[]> {
    await Promise.all([...this.entries.values()].filter(entry => entry.kind === 'claude').map(entry => (entry.auth as ClaudeCodeAuth).status(refresh)))
    return [...this.entries.values()].map(entry => this.snapshot(entry))
  }
  async add(provider: 'claude' | 'chatgpt', label: string): Promise<SubscriptionAccount> {
    if (!['claude', 'chatgpt'].includes(provider) || typeof label !== 'string' || !label.trim()) throw new Error('Choose a provider and enter an account label, such as Work or Personal.')
    if (this.entries.size >= 22) throw new Error('At most 20 additional accounts can be saved.')
    const entry = this.make({ id: randomUUID(), provider, label: label.trim().slice(0, 60) })
    this.register(entry)
    const save = this.writing.catch(() => {}).then(() => writeJson(FILE, [...this.entries.values()].filter(item => !item.metadata.shared).map(item => item.metadata)))
    this.writing = save
    await save
    this.onChange(this.snapshot(entry))
    return this.snapshot(entry)
  }
  async signIn(id: string, device = false): Promise<void> {
    const entry = this.get(id)
    if (this.loginId || [...this.entries.values()].some(item => item.kind === 'chatgpt' && item.auth.status().pending)) throw new Error('Finish or cancel the current account sign-in first.')
    this.loginId = id; this.onChange(this.snapshot(entry))
    const task = entry.kind === 'claude' ? entry.auth.signIn() : device ? entry.auth.signInWithDeviceCode() : entry.auth.signInWithBrowser()
    this.login = task
    try { await task } finally {
      if (this.login === task) { this.loginId = undefined; this.login = undefined }
      this.onChange(this.snapshot(entry))
    }
  }
  cancel(id: string): void { const entry = this.get(id); entry.auth.cancel(); this.onChange(this.snapshot(entry)) }
  async signOut(id: string): Promise<void> { await this.get(id).auth.signOut() }
  close(): void { for (const entry of this.entries.values()) entry.auth.cancel() }

  /** Pin identity for a request/call as well as its profile. Reauthentication cannot silently reroute a call. */
  pinned(id: string, includeName = true): LLMProvider {
    const entry = this.get(id), initial = this.snapshot(entry)
    const provider: LLMProvider = entry.provider
    const identity = entry.auth.identity()
    const check = async (): Promise<void> => {
      const status = entry.kind === 'claude' ? await entry.auth.status() : entry.auth.status()
      if (!initial.signedIn || !status.signedIn) throw new Error(`Sign in to ${entry.metadata.label} in Settings.`)
      if (status.email !== initial.email || entry.auth.identity() !== identity) throw new Error('The subscription identity changed. Start a new call or request with the intended account.')
    }
    return { id: provider.id, supportsTools: provider.supportsTools, plan: entry.kind === 'chatgpt' ? entry.provider.plan : undefined,
      listModels: async () => { await check(); return provider.listModels() },
      ...(provider.prepareText ? { prepareText: async (input, options) => {
        await check(); options.signal.throwIfAborted()
        const prepared = await provider.prepareText!(input, options)
        return { close: () => prepared.close(), send: async (user: string) => {
          try { await check(); options.signal.throwIfAborted(); await prepared.send(user) }
          catch (error) { prepared.close(); throw error }
        } }
      } } : {}),
      stream: async (input, options) => {
        await check(); options.signal.throwIfAborted()
        const name = includeName && typeof initial.name === 'string' ? initial.name.trim() : ''
        await provider.stream(name ? { ...input, system: `${input.system}\n\nThe signed-in user's display name is ${JSON.stringify(name)}. Prefer any explicit name or identity the user provides.` } : input, options)
      }
    }
  }
}
