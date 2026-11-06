import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { homedir } from 'node:os'
import { claudeKeychainService } from './claude-speech'
import type { ClaudeAuthStatus } from '@shared/types'

const STATUS_MS = 15_000
const LOGIN_MS = 10 * 60_000
const FRESH_MS = 30_000
const OUTPUT_CHARS = 64_000

/** The official binary shipped with the Agent SDK, outside the archive in a packaged Electron app. */
export function claudeCodeExecutable(): string {
  const require = createRequire(path.join(app.getAppPath(), 'package.json'))
  const sdk = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const name = `claude-agent-sdk-${process.platform}-${process.arch}`
  for (const dir of [name, `${name}-musl`]) {
    const file = path.join(sdk, '..', dir, process.platform === 'win32' ? 'claude.exe' : 'claude').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
    if (existsSync(file)) return file
  }
  throw new Error('The Claude subscription runtime is missing. Reinstall Togle with its optional dependencies.')
}

/** Subscription requests never inherit an API key, a proxy provider, or an exported OAuth token from another app. */
export function claudeSubscriptionEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ANTHROPIC_|^CLAUDE_CODE_|^CLAUDECODE$/i.test(key)))
}

type Launch = (file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess
const launch: Launch = (file, args, env, cwd) => spawn(file, args, { env, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })

export interface ClaudeSpeechProfile { directory: string; email: string; organization?: string; keychainService?: string }

/** Sign-in, sign-out and token refresh belong to the official runtime. Speech reads its access token only in the main process. */
export class ClaudeCodeAuth {
  private current: ClaudeAuthStatus = { available: true, signedIn: false }
  private checkedAt = 0
  private checking: Promise<ClaudeAuthStatus> | null = null
  private login: Promise<ClaudeAuthStatus> | null = null
  private controller: AbortController | null = null
  private generation = 0
  private profile?: ClaudeSpeechProfile
  onChange: (status: ClaudeAuthStatus) => void = () => {}

  constructor(private binary = claudeCodeExecutable, private start: Launch = launch, private configDirectory?: string) {}

  environment(): NodeJS.ProcessEnv {
    const env = claudeSubscriptionEnv()
    if (this.configDirectory) {
      env.CLAUDE_CONFIG_DIR = this.configDirectory
      env.CLAUDE_SECURESTORAGE_CONFIG_DIR = this.configDirectory
    }
    return env
  }

  cachedStatus(): ClaudeAuthStatus { return { ...this.current } }
  identity(): string | undefined { return this.current.signedIn ? JSON.stringify([this.current.email, this.profile?.organization, this.profile?.directory]) : undefined }

  executable(): string { return this.binary() }

  async speechProfile(): Promise<ClaudeSpeechProfile> {
    const status = await this.status(true)
    if (!status.signedIn || status.signingIn || !this.profile || this.profile.email !== status.email) throw new Error('Sign in with Claude in Settings to use Claude dictation.')
    return { ...this.profile, keychainService: claudeKeychainService(this.environment()) }
  }

  async directory(): Promise<string> {
    const dir = this.configDirectory ? path.join(this.configDirectory, 'runtime') : path.join(app.getPath('userData'), 'claude-runtime')
    await fs.mkdir(dir, { recursive: true })
    return dir
  }

  private set(status: ClaudeAuthStatus): ClaudeAuthStatus {
    this.current = status
    this.onChange(status)
    return status
  }

  status(force = false): Promise<ClaudeAuthStatus> {
    if (this.login || (!force && this.checkedAt && Date.now() - this.checkedAt < FRESH_MS)) return Promise.resolve(this.current)
    if (this.checking) return this.checking
    const generation = this.generation
    const checking = this.readStatus().then((status) => generation === this.generation ? this.set(status) : this.current)
    this.checking = checking
    return checking.finally(() => { if (this.checking === checking) this.checking = null })
  }

  private async readStatus(): Promise<ClaudeAuthStatus> {
    try {
      const { code, output } = await this.run(['auth', 'status'], AbortSignal.timeout(STATUS_MS))
      const status = JSON.parse(output) as { loggedIn?: boolean; authMethod?: string; apiProvider?: string; email?: string; subscriptionType?: string; configDirectory?: string; orgId?: string }
      this.checkedAt = Date.now()
      const signedIn = code === 0 && status.loggedIn === true && status.authMethod === 'claude.ai' && status.apiProvider === 'firstParty'
      if (signedIn && this.configDirectory && (!status.configDirectory || path.resolve(status.configDirectory).toLowerCase() !== path.resolve(this.configDirectory).toLowerCase())) throw new Error('Claude opened a different account directory. Reconnect this account in Settings.')
      this.profile = signedIn && typeof status.email === 'string' && typeof status.configDirectory === 'string' && path.isAbsolute(status.configDirectory)
        ? { directory: status.configDirectory, email: status.email, organization: status.orgId } : undefined
      let name: string | undefined
      if (signedIn) {
        try {
          const override = this.environment().CLAUDE_CONFIG_DIR
          const config = JSON.parse(await fs.readFile(override ? path.join(override, '.claude.json') : path.join(homedir(), '.claude.json'), 'utf8'))
          const account = config.oauthAccount
          if (typeof account?.emailAddress === 'string' && account.emailAddress.toLowerCase() === status.email?.toLowerCase() && typeof account.displayName === 'string') name = account.displayName.trim().slice(0, 60) || undefined
        } catch { /* A subscription does not always supply a display name. */ }
      }
      return {
        available: true, signedIn,
        ...(name ? { name } : {}),
        ...(signedIn && typeof status.email === 'string' ? { email: status.email } : {}),
        ...(signedIn && typeof status.subscriptionType === 'string' ? { plan: status.subscriptionType } : {}),
        ...(status.loggedIn && !signedIn ? { error: 'Claude Code is using another billing method. Sign in with Claude to use your subscription.' } : {})
      }
    } catch (err) {
      this.checkedAt = 0
      return { available: this.available(), signedIn: false, error: (err as Error).message }
    }
  }

  private available(): boolean {
    try { this.binary(); return true } catch { return false }
  }

  signIn(): Promise<ClaudeAuthStatus> {
    if (this.login) return this.login
    const generation = ++this.generation
    const controller = this.controller = new AbortController()
    this.set({ ...this.current, signingIn: true, error: undefined, url: undefined })
    const login = (async () => {
      try {
        const { code } = await this.run(['auth', 'login'], AbortSignal.any([controller.signal, AbortSignal.timeout(LOGIN_MS)]), (output) => {
          const url = /https:\/\/(?:claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/oauth\/authorize[^\s<>"']*/.exec(output)?.[0]
          if (url && generation === this.generation && url !== this.current.url) this.set({ ...this.current, url })
        })
        if (generation !== this.generation) return this.current
        if (code !== 0) throw new Error('Claude sign-in did not finish. Try again.')
        const status = await this.readStatus()
        return generation === this.generation ? this.set(status) : this.current
      } catch (err) {
        if (generation === this.generation) this.set({ ...this.current, signingIn: false, url: undefined, error: (err as Error).name === 'TimeoutError' ? 'Claude sign-in timed out. Try again.' : (err as Error).message })
        return this.current
      } finally {
        if (this.controller === controller) {
          this.controller = null
          this.login = null
        }
      }
    })()
    this.login = login
    return login
  }

  cancel(): void {
    this.generation++
    this.checkedAt = 0
    this.controller?.abort(new Error('Sign-in cancelled'))
    this.set({ ...this.current, signingIn: false, url: undefined, error: undefined })
  }

  async signOut(): Promise<ClaudeAuthStatus> {
    this.cancel()
    await this.login
    const generation = ++this.generation
    const { code } = await this.run(['auth', 'logout'], AbortSignal.timeout(STATUS_MS))
    if (code !== 0) throw new Error('Claude could not sign out. Try again.')
    this.checkedAt = 0
    return generation === this.generation ? this.set({ available: true, signedIn: false }) : this.current
  }

  private async run(args: string[], signal: AbortSignal, onOutput?: (output: string) => void): Promise<{ code: number | null; output: string }> {
    signal.throwIfAborted()
    const file = this.binary()
    const cwd = await this.directory()
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = this.start(file, args, this.environment(), cwd)
      let output = ''
      let allOutput = ''
      let forceKill: NodeJS.Timeout | undefined
      // Wait for exit before settling: logout must not race a login still writing its own credentials.
      const abort = (): void => {
        child.kill()
        forceKill = setTimeout(() => child.kill('SIGKILL'), 2_000)
        forceKill.unref()
      }
      const clean = (): void => { signal.removeEventListener('abort', abort); clearTimeout(forceKill) }
      const read = (chunk: Buffer): void => {
        allOutput = (allOutput + chunk.toString()).slice(-OUTPUT_CHARS)
        onOutput?.(allOutput)
      }
      child.stdout?.on('data', (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_CHARS); read(chunk) })
      child.stderr?.on('data', read)
      child.once('error', () => { clean(); reject(new Error('Claude could not start. Reinstall Togle and try again.')) })
      child.once('close', (code) => { clean(); signal.aborted ? reject(signal.reason) : resolve({ code, output }) })
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}
