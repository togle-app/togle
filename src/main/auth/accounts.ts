import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Settings, SubscriptionAccount, PlanUsage } from '@shared/types'
import { readJson, writeJson } from '../storage'
import { ChatGPTAuth } from './chatgpt'
import { ChatGPTProvider } from '../providers/chatgpt'
import type { LLMProvider, Usage } from '../providers/types'

type Metadata = Pick<SubscriptionAccount, 'id' | 'provider' | 'label' | 'shared'>
/** A ChatGPT plan sign-in. Togle has no other: Claude is used with an Anthropic API key (api-connections.ts). */
export type AccountRuntime = { metadata: Metadata; kind: 'chatgpt'; auth: ChatGPTAuth; provider: ChatGPTProvider }
const FILE = 'accounts/index.json'
export const defaultAccountId = (provider: 'chatgpt'): string => `${provider}-default`

/** Chooses an explicit profile without ever falling back from a missing work account to a personal one. */
export function accountChoice(settings: Settings, override?: string): string | undefined {
  if (override) return override
  if (settings.provider !== 'chatgpt') return
  return settings.subscriptionAccountId || defaultAccountId('chatgpt')
}

/** Each profile owns its auth, provider and usage limits. Only labels are stored here. */
export class SubscriptionAccounts {
  private entries = new Map<string, AccountRuntime>()
  private writing: Promise<void> = Promise.resolve()
  private loginId?: string
  private login?: Promise<unknown>
  onChange: (account: SubscriptionAccount) => void = () => {}
  onUsage: (usage: Usage) => void = () => {}
  onPlan: (id: string, usage: PlanUsage) => void = () => {}

  constructor(chatgpt: ChatGPTAuth, openai: ChatGPTProvider) {
    this.register({ metadata: { id: defaultAccountId('chatgpt'), provider: 'chatgpt', label: 'ChatGPT', shared: true }, kind: 'chatgpt', auth: chatgpt, provider: openai })
  }

  private snapshot(entry: AccountRuntime): SubscriptionAccount {
    const status = entry.auth.status()
    return { ...entry.metadata, ...status, signingIn: this.loginId === entry.metadata.id || status.signingIn === true }
  }
  private register(entry: AccountRuntime): void {
    this.entries.set(entry.metadata.id, entry)
    entry.provider.onUsage = usage => this.onUsage(usage)
    entry.auth.on('changed', () => {
      if (!entry.auth.status().signedIn) entry.provider.plan.clear()
      this.onChange(this.snapshot(entry))
    })
    entry.provider.plan.onChange = usage => this.onPlan(entry.metadata.id, usage)
  }
  private make(metadata: Metadata): AccountRuntime {
    const auth = new ChatGPTAuth(path.join('accounts', metadata.id, 'chatgpt-auth.bin'))
    return { metadata, kind: 'chatgpt', auth, provider: new ChatGPTProvider(auth) }
  }
  async load(): Promise<void> {
    const saved = await readJson<Metadata[]>(FILE, [])
    // An account an earlier Togle saved for another provider (a Claude sign-in) is not one any more: it is skipped.
    if (Array.isArray(saved)) for (const meta of saved.slice(0, 20)) {
      if (!meta || !/^[a-f0-9-]{36}$/.test(meta.id) || meta.provider !== 'chatgpt' || typeof meta.label !== 'string' || this.entries.has(meta.id)) continue
      this.register(this.make({ id: meta.id, provider: meta.provider, label: meta.label.slice(0, 60) }))
    }
    await Promise.all([...this.entries.values()].filter(entry => !entry.metadata.shared).map(entry => entry.auth.load()))
  }
  get(id: string): AccountRuntime {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('This subscription account is unavailable. Choose an account in the agent’s settings.')
    return entry
  }
  identity(id: string): SubscriptionAccount { return this.snapshot(this.get(id)) }
  /** Every account as it's known now. */
  known(): SubscriptionAccount[] { return [...this.entries.values()].map(entry => this.snapshot(entry)) }
  async list(): Promise<SubscriptionAccount[]> { return this.known() }
  async add(provider: 'chatgpt', label: string): Promise<SubscriptionAccount> {
    if (provider !== 'chatgpt') throw new Error('Only a ChatGPT plan can be added as an account. Claude is used with an Anthropic API key.')
    if (typeof label !== 'string' || !label.trim()) throw new Error('Enter an account label, such as Work or Personal.')
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
    if (this.loginId || [...this.entries.values()].some(item => item.auth.status().pending)) throw new Error('Finish or cancel the current account sign-in first.')
    this.loginId = id; this.onChange(this.snapshot(entry))
    const task = device ? entry.auth.signInWithDeviceCode() : entry.auth.signInWithBrowser()
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
    const entry = this.get(id)
    const provider: LLMProvider = entry.provider
    const pin = { initial: this.snapshot(entry), identity: entry.auth.identity() }
    const check = (): void => {
      const status = entry.auth.status()
      const { initial, identity } = pin
      if (!initial.signedIn || !status.signedIn) throw new Error(`Sign in to ${entry.metadata.label} in Settings.`)
      if (status.email !== initial.email || entry.auth.identity() !== identity) throw new Error('The subscription identity changed. Start a new call or request with the intended account.')
    }
    return { id: provider.id, supportsTools: provider.supportsTools, plan: entry.provider.plan,
      listModels: async () => { check(); return provider.listModels() },
      ...(provider.prepareText ? { prepareText: async (input, options) => {
        check(); options.signal.throwIfAborted()
        const prepared = await provider.prepareText!(input, options)
        return { close: () => prepared.close(), send: async (user: string) => {
          try { check(); options.signal.throwIfAborted(); await prepared.send(user) }
          catch (error) { prepared.close(); throw error }
        } }
      } } : {}),
      stream: async (input, options) => {
        check(); options.signal.throwIfAborted()
        const signedName = pin.initial.name
        const name = includeName && typeof signedName === 'string' ? signedName.trim() : ''
        await provider.stream(name ? { ...input, system: `${input.system}\n\nThe signed-in user's display name is ${JSON.stringify(name)}. Prefer any explicit name or identity the user provides.` } : input, options)
      }
    }
  }
}
