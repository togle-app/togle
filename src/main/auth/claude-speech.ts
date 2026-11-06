import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ClaudeSpeechProfile } from './claude-code'

const execute = promisify(execFile)
const POLICY_FRESH_MS = 5 * 60_000
const REFRESH_WINDOW_MS = 60_000
interface SpeechStore { accessToken: string; expiresAt: number; voiceAllowed: boolean }
type ProfileSource = { speechProfile(): Promise<ClaudeSpeechProfile> }
type StoreReader = (profile: ClaudeSpeechProfile, signal: AbortSignal) => Promise<SpeechStore>

/** The same keychain service name used by Claude Code, including custom account directories. */
export function claudeKeychainService(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR
  return 'Claude Code-credentials' + (override ? '-' + createHash('sha256').update(override.normalize('NFC')).digest('hex').slice(0, 8) : '')
}

export function claudeSpeechStore(credentials: unknown, policy: unknown): SpeechStore {
  const data = credentials as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } } | null
  const token = data?.claudeAiOauth
  if (typeof token?.accessToken !== 'string' || !token.accessToken || typeof token.expiresAt !== 'number' || !Number.isFinite(token.expiresAt)) throw new Error('Claude speech could not read your sign-in. Sign in again in Settings.')
  const limits = policy as { restrictions?: Record<string, { allowed?: unknown }> } | null
  if (!limits?.restrictions || typeof limits.restrictions !== 'object' || Array.isArray(limits.restrictions)) throw new Error('Could not verify Claude voice permissions. Try again or sign in with Claude in Settings.')
  const voice = limits.restrictions.allow_voice_mode
  if (voice !== undefined && typeof voice?.allowed !== 'boolean') throw new Error('Could not verify Claude voice permissions. Try again in Settings.')
  return { accessToken: token.accessToken, expiresAt: token.expiresAt, voiceAllowed: voice?.allowed !== false }
}

async function readStore(profile: ClaudeSpeechProfile, signal: AbortSignal): Promise<SpeechStore> {
  let credentials: string, policy: string
  try {
    if (process.platform === 'darwin') {
      const username = process.env.USER || userInfo().username
      const account = /^[a-zA-Z0-9._-]+$/.test(username) ? username : 'claude-code-user'
      try {
        credentials = (await execute('/usr/bin/security', ['find-generic-password', '-a', account, '-s', profile.keychainService ?? claudeKeychainService(), '-w'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, signal })).stdout
      } catch (error) {
        if ((error as { code?: number }).code !== 44) throw error
        credentials = await fs.readFile(path.join(profile.directory, '.credentials.json'), { encoding: 'utf8', signal })
      }
    } else credentials = await fs.readFile(path.join(profile.directory, '.credentials.json'), { encoding: 'utf8', signal })
    policy = await fs.readFile(path.join(profile.directory, 'policy-limits.json'), { encoding: 'utf8', signal })
  } catch {
    signal.throwIfAborted()
    throw new Error('Claude speech could not access your sign-in or voice permissions. Sign in again in Settings.')
  }
  let parsed: unknown, limits: unknown
  // JSON and OS errors can contain credential contents. Never forward those errors to logs or the renderer.
  try { parsed = JSON.parse(credentials); limits = JSON.parse(policy) } catch { throw new Error('Claude speech could not read your sign-in or voice permissions. Sign in again in Settings.') }
  return claudeSpeechStore(parsed, limits)
}

const identity = (profile: ClaudeSpeechProfile): string => JSON.stringify([profile.directory, profile.email.toLowerCase(), profile.organization ?? ''])

/** Short-lived access only: no credential copy, refresh-token handling, or credential writes in Togle. */
export class ClaudeSpeechAccess {
  private initialized?: { identity: string; at: number }
  private refreshing?: Promise<unknown>
  constructor(private auth: ProfileSource, private refresh: () => Promise<unknown>, private read: StoreReader = readStore, private now = Date.now) {}

  async prepare(email: string, signal: AbortSignal): Promise<ClaudeSpeechProfile> {
    signal.throwIfAborted()
    const profile = await this.auth.speechProfile()
    if (profile.email.toLowerCase() !== email.toLowerCase()) throw new Error('The Claude account changed. Start dictation again.')
    await this.token(profile, signal)
    return profile
  }

  async token(profile: ClaudeSpeechProfile, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const key = identity(profile)
    const check = async (): Promise<void> => {
      signal.throwIfAborted()
      if (identity(await this.auth.speechProfile()) !== key) throw new Error('The Claude account or workspace changed. Start dictation again.')
      signal.throwIfAborted()
    }
    await check()
    let store: SpeechStore | undefined
    const fresh = this.initialized?.identity === key && this.now() - this.initialized.at < POLICY_FRESH_MS
    if (fresh) store = await this.read(profile, signal)
    if (!store || store.expiresAt <= this.now() + REFRESH_WINDOW_MS) {
      // A prompt-free official SDK startup refreshes OAuth and organization policy using its own storage/locking.
      this.refreshing ??= this.refresh().finally(() => { this.refreshing = undefined })
      await this.refreshing
      await check()
      store = await this.read(profile, signal)
      this.initialized = { identity: key, at: this.now() }
    }
    await check()
    if (!store.voiceAllowed) throw new Error('Claude voice dictation is disabled by your organization.')
    if (store.expiresAt <= this.now()) throw new Error('Your Claude sign-in expired. Sign in again in Settings.')
    return store.accessToken
  }
}
