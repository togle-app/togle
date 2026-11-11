// The `togle` command: starts a task from a terminal, and lists the tasks, through the running Togle. It asks over the
// local channel, so a task started this way shows in Togle's Tasks and asks before every command like any other.
// Plain Node: it loads nothing of Electron, and starts as fast as Node does.
import path from 'node:path'
import { askChannel, ChannelRefused, ChannelUnavailable } from '../channel/client'
import { channelAddress, defaultDataFolder, readSecret } from '../channel/paths'

export interface CliIo {
  cwd: string
  env: NodeJS.ProcessEnv
  /** Everything piped in, or null when nothing is. */
  stdin: () => Promise<string | null>
  out: (text: string) => void
  err: (text: string) => void
}

const AGENTS = ['claude', 'codex', 'hermes'] as const
const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' }

export const USAGE = `togle run [--agent claude|codex|hermes] [--folder <folder>] [--title <name>] <what to do>
    Starts a task in the running Togle. It asks before every command and every change.
    The folder is the current one when left out, and the agent is Claude Code. Piped text is the task when none is given.
togle tasks
    Lists the tasks Togle can see, the ones waiting for you first.
`

interface RunArgs {
  agent: string
  folder: string
  title?: string
  prompt: string
}

/** What follows `togle run`. Throws a sentence for what cannot be understood. */
export function parseRun(args: string[], cwd: string): RunArgs {
  let agent = 'claude'
  let folder = cwd
  let title: string | undefined
  const words: string[] = []
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]
    if (arg === '--') {
      words.push(...args.slice(at + 1))
      break
    }
    const flag = /^--(agent|folder|title)(?:=(.*))?$/.exec(arg)
    if (!flag) {
      if (arg.startsWith('--')) throw new Error(`Togle does not know ${arg}.`)
      words.push(arg)
      continue
    }
    const value = flag[2] ?? args[++at]
    if (value === undefined || value === '') throw new Error(`${flag[0].split('=')[0]} needs a value.`)
    if (flag[1] === 'agent') agent = value.toLowerCase()
    else if (flag[1] === 'folder') folder = value
    else title = value
  }
  if (!(AGENTS as readonly string[]).includes(agent)) throw new Error('Pick an agent: claude, codex or hermes.')
  return { agent, folder: path.resolve(cwd, folder), ...(title ? { title } : {}), prompt: words.join(' ').trim() }
}

const STATE_WORDS: Record<string, string> = { waiting: 'waiting', working: 'working', idle: 'done', stopped: 'stopped', failed: 'stopped by an error' }

/** Runs the command. Returns the exit code: 0 when it worked, 1 when Togle could not do it, 2 when it was not understood. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE)
    return command ? 0 : 2
  }
  if (command !== 'run' && command !== 'tasks') {
    io.err(`Togle does not know "${command}".\n${USAGE}`)
    return 2
  }
  let kind: string
  let body: string
  if (command === 'run') {
    let parsed: RunArgs
    try {
      parsed = parseRun(rest, io.cwd)
    } catch (error) {
      io.err(`${(error as Error).message}\n${USAGE}`)
      return 2
    }
    const prompt = parsed.prompt || (await io.stdin())?.trim() || ''
    if (!prompt) {
      io.err(`Say what the task is.\n${USAGE}`)
      return 2
    }
    kind = 'run'
    body = JSON.stringify({ runner: parsed.agent, folder: parsed.folder, prompt, ...(parsed.title ? { title: parsed.title } : {}) })
  } else {
    kind = 'tasks'
    body = '{}'
  }
  try {
    const data = defaultDataFolder(io.env)
    const answer = await askChannel({ address: channelAddress(data), secret: await readSecret(data), kind, body, timeoutMs: 120_000 })
    if (!answer.ok) {
      io.err(`${answer.result}\n`)
      return 1
    }
    const result = JSON.parse(answer.result) as unknown
    if (command === 'run') {
      const started = result as { title: string; runner: string; folder: string }
      io.out(`Started in Togle: ${started.title} (${NAMES[started.runner] ?? started.runner}, ${started.folder}). It asks before every command. Answer in Togle's Tasks.\n`)
    } else {
      const tasks = result as { title: string; runner: string; folder: string; state: string; line: string }[]
      if (!tasks.length) io.out('No tasks.\n')
      for (const task of tasks) io.out(`${(STATE_WORDS[task.state] ?? task.state).padEnd(10)} ${(NAMES[task.runner] ?? task.runner).padEnd(12)} ${task.title}${task.line ? `  (${task.line})` : ''}\n`)
    }
    return 0
  } catch (error) {
    if (error instanceof ChannelUnavailable || (error as NodeJS.ErrnoException).code === 'ENOENT') io.err('Togle is not running, so it cannot do that. Start Togle and try again.\n')
    else if (error instanceof ChannelRefused) io.err('What answered is not this Togle (it could not prove it), so nothing was sent.\n')
    else io.err(`${(error as Error).message}\n`)
    return 1
  }
}
