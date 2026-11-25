// Shared Togle account. Tokens stay in the desktop main process and the operating system's keystore.

export interface SessionStore {
  read(): Promise<StudioSession | null>
  write(session: StudioSession | null): Promise<void>
}

export interface StudioSession { access: string; refresh: string; expiresAt: number; email: string; user: string; origin?: string }

export interface StudioPlan { plan: 'pro' | 'trial' | 'free'; trialEnds?: number; proEnds?: number }

export interface StudioAccountOptions {
  url: string
  /** The public key a sign-in page may hold (anon or publishable), never the service role's. */
  publicKey: string
  changed?: () => void
  store: SessionStore
  fetch?: typeof fetch
  now?: () => number
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export class StudioAccount {
  private readonly options: StudioAccountOptions
  private session?: StudioSession
  private loaded?: Promise<void>
  private operations = Promise.resolve()

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
    }).catch(() => { throw new Error('Couldn’t reach the Togle account service. Check your connection and try again.') })
  }

  load(): Promise<void> {
    this.loaded ??= this.options.store.read().then(saved => {
      if (!saved?.access || !saved.refresh || !saved.user || !EMAIL.test(saved.email) || !Number.isFinite(saved.expiresAt)) return
      const origin = new URL(this.options.url).origin
      // Older preview sessions used the same file. Recover only a token issued by this backend.
      if (saved.origin ? saved.origin !== origin : !this.hasIssuer(saved.access, origin)) return
      this.session = saved
    })
    return this.loaded
  }

  private hasIssuer(token: string, origin: string): boolean {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      return payload.iss === origin + '/auth/v1'
    } catch { return false }
  }

  /** Serialize refresh-token rotation, login, logout and membership changes across every window. */
  private run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.operations.then(() => this.load()).then(work)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  /** Who is signed in, if anyone. */
  who(): { email: string; user: string } | undefined {
    return this.session ? { email: this.session.email, user: this.session.user } : undefined
  }

  /** Request the Togle email template, which shows the code to enter in the desktop app. */
  async sendCode(email: string): Promise<void> {
    const address = email.trim()
    if (address.length > 254 || !EMAIL.test(address)) throw new Error('Type the email address to sign in with.')
    const response = await this.call('/auth/v1/otp?redirect_to=https%3A%2F%2Ftogle.app', { email: address, create_user: true })
    if (response.status === 429) throw new Error('Too many emails just now. Wait a minute and try again.')
    if (!response.ok) throw new Error('We couldn’t send the sign-in code. Check the address and try again.')
  }

  /** Signs in with the code from the email. */
  async verify(email: string, code: string): Promise<{ email: string }> {
    const token = code.replace(/\s/g, '')
    const address = email.trim()
    if (address.length > 254 || !EMAIL.test(address)) throw new Error('Type the email address to sign in with.')
    if (!/^\d{6,10}$/.test(token)) throw new Error('Type the code from the email.')
    return this.run(async () => {
      const response = await this.call('/auth/v1/verify', { type: 'email', email: address, token })
      if (!response.ok) throw new Error('That code didn’t work. Check it, or send a new one.')
      const session = await this.keep(await response.json())
      this.options.changed?.()
      return { email: session.email }
    })
  }

  token(): Promise<string | undefined> {
    return this.run(async () => (await this.current())?.access)
  }

  private current(): Promise<StudioSession | undefined> {
    if (!this.session || this.session.expiresAt - this.now > 60_000) return Promise.resolve(this.session)
    return this.renew()
  }

  waitlist(user: string, action: 'status' | 'join' | 'leave'): Promise<boolean> {
    const names = { status: 'my_pro_waitlist', join: 'join_pro_waitlist', leave: 'leave_pro_waitlist' }
    return this.run(async () => {
      let session = await this.current()
      if (!session || session.user !== user) throw new Error('Sign in to your Togle account again.')
      const path = '/rest/v1/rpc/' + names[action]
      let response = await this.call(path, {}, session.access)
      if (response.status === 401) {
        session = await this.renew()
        if (!session || session.user !== user) throw new Error('Sign in to your Togle account again.')
        response = await this.call(path, {}, session.access)
      }
      if (!response.ok) throw new Error('The Togle Pro waitlist is unavailable. Try again.')
      const joined: unknown = await response.json()
      if (typeof joined !== 'boolean') throw new Error('The waitlist could not confirm your status. Try again.')
      return joined
    })
  }

  /** The plan on this Togle account. */
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

  signOut(): Promise<void> {
    return this.run(async () => {
      const access = this.session?.access
      await this.clear()
      if (access) await this.call('/auth/v1/logout?scope=local', {}, access).catch(() => undefined)
    })
  }

  private async clear(): Promise<void> {
    await this.options.store.write(null)
    this.session = undefined
    this.options.changed?.()
  }

  private async renew(): Promise<StudioSession | undefined> {
    const previous = this.session
    if (!previous) return undefined
    const response = await this.call('/auth/v1/token?grant_type=refresh_token', { refresh_token: previous.refresh })
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      await this.clear()
      return undefined
    }
    if (!response.ok) throw new Error('Couldn’t reach the Togle account service. Try again.')
    return this.keep(await response.json(), previous.user)
  }

  private async keep(body: unknown, expectedUser?: string): Promise<StudioSession> {
    const given = body as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; user?: { id?: unknown; email?: unknown } }
    if (typeof given?.access_token !== 'string' || !given.access_token || typeof given.refresh_token !== 'string' || !given.refresh_token ||
        typeof given.user?.id !== 'string' || !given.user.id || typeof given.user.email !== 'string' || !EMAIL.test(given.user.email) ||
        (expectedUser && given.user.id !== expectedUser)) throw new Error('We couldn’t sign you in to your Togle account.')
    const session = {
      access: given.access_token, refresh: given.refresh_token,
      expiresAt: this.now + (typeof given.expires_in === 'number' ? given.expires_in : 3600) * 1000,
      email: given.user.email, user: given.user.id, origin: new URL(this.options.url).origin
    }
    await this.options.store.write(session)
    this.session = session
    return session
  }
}
