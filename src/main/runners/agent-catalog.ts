// What Settings → Agents → Add another agent lists, so that nobody has to know the command that starts an agent.
// - Found on this computer: agents Togle knows how to start (a short list of its own) and agents of the ACP registry that are
//   installed as a program (a binary on the search path), each with the command that starts it.
// - More agents: the registry's agents that start through `npx` or `uvx`, which fetch them the first time.
// The registry is the shared list Zed and JetBrains use (agentclientprotocol.com). It is data from the network: every word that
// ends up in a command is checked, and an entry whose command Togle would not take for ACP is left out.
import { promises as fs } from 'node:fs'
import { KNOWN_AGENTS, type AddedAgent, type AgentCatalog, type AgentChoice } from '@shared/runner'
import { commandIsAcp, whereIs as findProgram } from './acp'

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

/** What the registry lists that Togle finds by itself: they are not offered again. */
const FOUND_BY_TOGLE = new Set(['claude-acp', 'codex-acp'])

interface Known {
  id: string
  name: string
  description: string
  /** The program that has to be on this computer for the agent to be found. */
  program: string
  command: string
}

/** The agents Togle knows how to start, by the commands their docs give. Aider has no ACP: it runs in a terminal of Togle's own. */
export const KNOWN_TO_START: readonly Known[] = [
  { id: 'gemini', name: 'Gemini CLI', description: "Google's official CLI for Gemini", program: 'gemini', command: 'gemini --acp' },
  { id: 'goose', name: 'goose', description: 'A local, extensible, open source AI agent', program: 'goose', command: 'goose acp' },
  { id: 'opencode', name: 'OpenCode', description: 'The open source coding agent', program: 'opencode', command: 'opencode acp' },
  { id: 'github-copilot', name: 'GitHub Copilot', description: "GitHub's AI pair programmer", program: 'copilot', command: 'copilot --acp' },
  { id: 'qwen-code', name: 'Qwen Code', description: "Alibaba's Qwen coding assistant", program: 'qwen', command: 'qwen --acp' },
  { id: 'cursor', name: 'Cursor', description: "Cursor's coding agent", program: 'cursor-agent', command: 'cursor-agent acp' },
  { id: 'aider', name: 'Aider', description: 'AI pair programming in your terminal', program: 'aider', command: 'aider' }
]

/** One agent of the registry, checked: how it starts, by what kind of program. */
export interface RegistryEntry {
  id: string
  name: string
  description: string
  /** The words after `npx` or `uvx`: the package, then its arguments. */
  npx?: string[]
  uvx?: string[]
  /** An installed program: its name and arguments. Togle never downloads one. */
  program?: { name: string; args: string[] }
}

const PACKAGE = /^(?:@[A-Za-z0-9._~-]+\/)?[A-Za-z0-9._~-]+(?:@[A-Za-z0-9._~+-]+)?$/
const ARGUMENT = /^[A-Za-z0-9._=:@/+-]{1,80}$/
const PROGRAM = /^[A-Za-z0-9._-]{1,60}$/
const oneLine = (value: unknown, longest: number): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, longest) : '')
const argsOf = (value: unknown): string[] | null => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) return null
  const words = value.filter((word): word is string => typeof word === 'string' && ARGUMENT.test(word))
  return words.length === value.length ? words : null
}

/** The key the registry uses for this computer in a binary's list: "windows-x86_64", "darwin-aarch64", "linux-x86_64". */
export function registryPlatform(platform: string = process.platform, arch: string = process.arch): string {
  const system = platform === 'win32' ? 'windows' : platform
  return `${system}-${arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : arch}`
}

/** The registry's agents, each checked; what is not an agent Togle can start (or what it could not tell for ACP) is left out. */
export function registryEntries(registry: unknown, platform = registryPlatform()): RegistryEntry[] {
  const agents = (registry as { agents?: unknown } | null)?.agents
  if (!Array.isArray(agents)) return []
  const seen = new Set<string>()
  const entries: RegistryEntry[] = []
  for (const item of agents) {
    const agent = (item ?? {}) as Record<string, unknown>
    const id = oneLine(agent.id, 60)
    const name = oneLine(agent.name, 40)
    if (!id || !name || seen.has(id) || FOUND_BY_TOGLE.has(id)) continue
    if (Object.values(KNOWN_AGENTS).some((known) => known.toLowerCase() === name.toLowerCase())) continue
    const distribution = (agent.distribution ?? {}) as Record<string, unknown>
    const entry: RegistryEntry = { id, name, description: oneLine(agent.description, 110) }
    const npx = (distribution.npx ?? null) as { package?: unknown; args?: unknown } | null
    const args = npx ? argsOf(npx.args) : null
    if (npx && typeof npx.package === 'string' && PACKAGE.test(npx.package) && args) entry.npx = [npx.package, ...args]
    const uvx = (distribution.uvx ?? null) as { package?: unknown; args?: unknown } | null
    const uvxArgs = uvx ? argsOf(uvx.args) : null
    if (uvx && typeof uvx.package === 'string' && PACKAGE.test(uvx.package) && uvxArgs) entry.uvx = [uvx.package, ...uvxArgs]
    const binary = ((distribution.binary ?? {}) as Record<string, { cmd?: unknown; args?: unknown } | undefined>)[platform]
    const binaryArgs = binary ? argsOf(binary.args) : null
    if (binary && typeof binary.cmd === 'string' && binaryArgs) {
      const program = (binary.cmd.split(/[\\/]/).pop() ?? '').replace(/\.exe$/i, '')
      if (PROGRAM.test(program)) entry.program = { name: program, args: binaryArgs }
    }
    if (!entry.npx && !entry.uvx && !entry.program) continue
    // Only an agent whose command says ACP the way Togle reads it: it is talked to as a conversation, which is what it is for.
    const commands = [entry.npx && commandOf('npx', entry.npx), entry.uvx && commandOf('uvx', entry.uvx), entry.program && `${entry.program.name} ${entry.program.args.join(' ')}`.trim()].filter((line): line is string => !!line)
    if (!commands.some((line) => commandIsAcp(line))) continue
    seen.add(id)
    entries.push(entry)
  }
  return entries
}

/** The command of a package that starts through `npx` or `uvx`. `npx -y`: nobody is there to answer its question about fetching the package. */
export const commandOf = (runner: 'npx' | 'uvx', words: string[]): string => [runner, ...(runner === 'npx' ? ['-y'] : []), ...words].join(' ')

export interface CatalogOptions {
  /** The agents the person added: what they have is not offered again. */
  added: readonly AddedAgent[]
  /** The registry, read from the network. */
  fetchRegistry(): Promise<unknown>
  /** Where a program is on this computer (null when nowhere). */
  whereIs?: (program: string) => Promise<string | null>
  platform?: string
}

/** How many programs are looked for at once: each lookup starts a program (about 60 ms on Windows), and there are a few dozen. */
const LOOKUPS_AT_ONCE = 8

/**
 * A way to ask where a program is that remembers each answer for a while: the list is opened again and again, and what is
 * installed does not change between two looks a minute apart. An answer that failed is not remembered.
 */
export function rememberedWhere(where: (program: string) => Promise<string | null>, ms: number, now: () => number = Date.now): (program: string) => Promise<string | null> {
  const kept = new Map<string, { at: number; found: Promise<string | null> }>()
  return (program) => {
    const known = kept.get(program)
    if (known && now() - known.at < ms) return known.found
    const found = where(program)
    kept.set(program, { at: now(), found })
    found.catch(() => { if (kept.get(program)?.found === found) kept.delete(program) })
    return found
  }
}

export async function agentCatalog(options: CatalogOptions): Promise<AgentCatalog> {
  const where = options.whereIs ?? findProgram
  let registry: RegistryEntry[] | null = null
  try {
    registry = registryEntries(await options.fetchRegistry(), options.platform)
  } catch {
    registry = null
  }
  // Every program the list asks about, looked for together and once each: one after the other they took a second and a half.
  const wanted = new Set<string>(KNOWN_TO_START.map((known) => known.program))
  for (const entry of registry ?? []) {
    if (entry.program) wanted.add(entry.program.name)
    if (entry.npx) wanted.add('npx')
    else if (entry.uvx) wanted.add('uvx')
  }
  const present = new Map<string, boolean>()
  const queue = [...wanted]
  await Promise.all(Array.from({ length: Math.min(LOOKUPS_AT_ONCE, queue.length) }, async () => {
    for (let program = queue.shift(); program !== undefined; program = queue.shift()) present.set(program, await where(program).then((found) => !!found, () => false))
  }))
  const has = (program: string): boolean => present.get(program) === true
  const taken = new Set([...options.added.map((agent) => agent.name.toLowerCase()), ...options.added.map((agent) => agent.command.trim())])
  const isTaken = (name: string, command: string): boolean => taken.has(name.toLowerCase()) || taken.has(command)
  const found: AgentChoice[] = []
  const names = new Set<string>()
  const offer = (list: AgentChoice[], choice: AgentChoice): void => {
    if (isTaken(choice.name, choice.command) || names.has(choice.name.toLowerCase())) return
    names.add(choice.name.toLowerCase())
    list.push(choice)
  }
  for (const known of KNOWN_TO_START) if (has(known.program)) offer(found, { id: `known:${known.id}`, name: known.name, description: known.description, command: known.command })
  const more: AgentChoice[] = []
  for (const entry of registry ?? []) {
    if (entry.program && has(entry.program.name)) {
      offer(found, { id: `registry:${entry.id}`, name: entry.name, description: entry.description, command: `${entry.program.name} ${entry.program.args.join(' ')}`.trim() })
      continue
    }
    const runner = entry.npx ? 'npx' : entry.uvx ? 'uvx' : null
    if (!runner) continue
    const words = (runner === 'npx' ? entry.npx : entry.uvx) as string[]
    const command = commandOf(runner, words)
    if (!commandIsAcp(command)) continue
    offer(more, { id: `registry:${entry.id}`, name: entry.name, description: entry.description, command, ...(has(runner) ? {} : { needs: runner }) })
  }
  const byName = (a: AgentChoice, b: AgentChoice): number => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  return { found: found.sort(byName), more: more.sort(byName), registry: registry !== null }
}

// The registry is read once in a while: a list that changes a few times a month.
const KEEP_MS = 6 * 60 * 60_000
/** The most of a registry that is read, from the network or from the copy on disk. */
const REGISTRY_MOST = 4_000_000

/**
 * The registry, kept. What was read lately answers at once. A copy that is old (a few hours, or the one on disk from before Togle
 * started) answers at once too, and a fresh one is read behind it for the next time: the list does not wait for the network every
 * time it opens. Only when there is no copy at all (the first time) does it wait for the network; a read that fails then is an
 * error. `file` keeps the last copy on disk; `get` and `now` are the network and the clock (for tests).
 */
export class RegistryKeeper {
  private kept: { at: number; value: unknown } | null = null
  private reading: Promise<unknown> | null = null

  constructor(
    private readonly file?: string,
    private readonly get: typeof fetch = (url, init) => fetch(url, init),
    private readonly now: () => number = Date.now
  ) {}

  /** The registry from the network, now: kept in memory and on disk. A read that fails is not kept. */
  private read(): Promise<unknown> {
    this.reading ??= (async () => {
      try {
        const answer = await this.get(REGISTRY_URL, { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } })
        if (!answer.ok) throw new Error(`The registry answered ${answer.status}.`)
        const length = Number(answer.headers.get('content-length') ?? 0)
        if (length > REGISTRY_MOST) throw new Error('The registry is larger than expected.')
        const body = await answer.text()
        if (body.length > REGISTRY_MOST) throw new Error('The registry is larger than expected.')
        const value: unknown = JSON.parse(body)
        this.kept = { at: this.now(), value }
        if (this.file) await fs.writeFile(this.file, body).catch(() => undefined)
        return value
      } finally {
        this.reading = null
      }
    })()
    return this.reading
  }

  /** The copy on disk, when there is one that is not too large and reads. */
  private async copy(): Promise<unknown> {
    if (!this.file) return undefined
    try {
      if ((await fs.stat(this.file)).size > REGISTRY_MOST) return undefined
      return JSON.parse(await fs.readFile(this.file, 'utf8')) as unknown
    } catch {
      return undefined
    }
  }

  async registry(): Promise<unknown> {
    if (this.kept && this.now() - this.kept.at < KEEP_MS) return this.kept.value
    if (!this.kept) {
      const copy = await this.copy()
      if (copy !== undefined && copy !== null) this.kept = { at: Number.NEGATIVE_INFINITY, value: copy }
    }
    if (this.kept) {
      void this.read().catch(() => undefined)
      return this.kept.value
    }
    return this.read()
  }
}

const keepers = new Map<string, RegistryKeeper>()

/** The registry, by the keeper of this copy on disk (one for the program's life). */
export function fetchRegistry(file = ''): Promise<unknown> {
  let keeper = keepers.get(file)
  if (!keeper) keepers.set(file, (keeper = new RegistryKeeper(file || undefined)))
  return keeper.registry()
}
