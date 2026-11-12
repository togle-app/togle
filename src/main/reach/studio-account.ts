// Togle Studio's account inside Togle: sign in with a code sent by email, and stay signed in. Only the first computer of a
// person's devices needs it: it shows Studio's courier, once, that the devices are that account's. The session is kept
// encrypted by the system's keystore (see storage.ts), never in plain text.

export interface SessionStore {
  read(): Promise<StudioSession | null>
  write(session: StudioSession | null): Promise<void>
}

export interface StudioSession { access: string; refresh: string; expiresAt: number; email: string; user: string }

export interface StudioPlan { plan: 'pro' | 'trial' | 'free'; trialEnds?: number; proEnds?: number }

export interface StudioAccountOptions {
  url: string
  /** The public key a sign-in page may hold (anon or publishable), never the service role's. */
  publicKey: string
  store: SessionStore
  fetch?: typeof fetch
  now?: () => number
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class StudioAccount {
  private readonly options: StudioAccountOptions
  private session?: StudioSession
  private loaded = false
  private refreshing?: Promise<StudioSession | undefined>

  constructor(options: StudioAccountOptions) {
    this.options = options
  }

  private get now(): number { return (this.options.now ?? Date.now)() }

  private async call(path: string, body: unknown, token?: string): Promise<Response> {
    const fetcher = this.options.fetch ?? fetch
    return fetcher(`${this.options.url.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { apikey: this.options.publicKey, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try { this.session = (await this.options.store.read()) ?? undefined } catch { this.session = undefined }
  }

  /** Who is signed in, if anyone. */
  who(): { email: string; user: string } | undefined {
    return this.session ? { email: this.session.email, user: this.session.user } : undefined
  }

  /** Emails a six-digit code (and a link) to the address. */
  async sendCode(email: string): Promise<void> {
    const address = email.trim()
    if (!EMAIL.test(address)) throw new Error('Type the email address to sign in with.')
    const response = await this.call('/auth/v1/otp', { email: address, create_user: true })
    if (response.status === 429) throw new Error('Too many emails just now. Wait a minute and try again.')
    if (!response.ok) throw new Error('Togle Studio couldn’t send the code. Check the address and try again.')
  }

  /** Signs in with the code from the email. */
  async verify(email: string, code: string): Promise<{ email: string }> {
    const token = code.replace(/\s/g, '')
    if (!/^\d{6,10}$/.test(token)) throw new Error('Type the code from the email: its six digits.')
    const response = await this.call('/auth/v1/verify', { type: 'email', email: email.trim(), token })
    if (!response.ok) throw new Error('That code didn’t work. Check it, or send a new one.')
    await this.keep(await response.json())
    return { email: this.session!.email }
  }

  /** A current access token, renewed when it is about to run out; undefined when nobody is signed in. */
  async token(): Promise<string | undefined> {
    await this.load()
    if (!this.session) return undefined
    if (this.session.expiresAt - this.now > 60_000) return this.session.access
    this.refreshing ??= this.renew().finally(() => { this.refreshing = undefined })
    return (await this.refreshing)?.access
  }

  /** The account's plan, as Togle Studio counts it. */
  async plan(): Promise<StudioPlan | undefined> {
    const token = await this.token()
    if (!token) return undefined
    const response = await this.call('/rest/v1/rpc/my_plan', {}, token)
    if (!response.ok) return undefined
    const rows = await response.json() as { plan?: string; trial_ends?: string | null; pro_ends?: string | null }[]
    const row = rows?.[0]
    if (!row || (row.plan !== 'pro' && row.plan !== 'trial' && row.plan !== 'free')) return undefined
    return { plan: row.plan, ...(row.trial_ends ? { trialEnds: Date.parse(row.trial_ends) } : {}), ...(row.pro_ends ? { proEnds: Date.parse(row.pro_ends) } : {}) }
  }

  async signOut(): Promise<void> {
    const access = this.session?.access
    this.session = undefined
    await this.options.store.write(null)
    if (access) await this.call('/auth/v1/logout', {}, access).catch(() => undefined)
  }

  private async renew(): Promise<StudioSession | undefined> {
    const refresh = this.session?.refresh
    if (!refresh) return undefined
    const response = await this.call('/auth/v1/token?grant_type=refresh_token', { refresh_token: refresh }).catch(() => undefined)
    if (!response) return this.session
    if (response.status === 400 || response.status === 401) {
      // The sign-in ended (signed out elsewhere, or too long unused).
      this.session = undefined
      await this.options.store.write(null)
      return undefined
    }
    if (!response.ok) return this.session
    await this.keep(await response.json())
    return this.session
  }

  private async keep(body: unknown): Promise<void> {
    const given = body as { access_token?: string; refresh_token?: string; expires_in?: number; user?: { id?: string; email?: string } }
    if (!given?.access_token || !given.refresh_token || !given.user?.id) throw new Error('Togle Studio answered without a sign-in.')
    this.session = {
      access: given.access_token,
      refresh: given.refresh_token,
      expiresAt: this.now + (given.expires_in ?? 3600) * 1000,
      email: given.user.email ?? '',
      user: given.user.id
    }
    await this.options.store.write(this.session)
  }
}
