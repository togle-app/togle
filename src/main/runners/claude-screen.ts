// Claude Code's own screen, in a terminal of Togle's own. The person has the program they know, with its keys and its
// commands as in any terminal; Togle adds what a window can: the task in the list, a notice when it asks or is done,
// and the answer to a command that waits, from here or from another device.
//
// What trying Claude Code 2.1.323 on Windows in a pseudo-terminal showed, which this follows:
// - The same hook Togle gives the Claude Code it runs without a screen works here. Claude Code posts a request, shows its
//   own question at the same time, and acts on whichever answer comes first. An answer from Togle closes the screen's
//   question by itself.
// - An answer on the screen does NOT end the request: Claude Code keeps the hook's connection open (for minutes, as long
//   as it was watched). What shows it is `claude agents`: the program's status is "waiting" while the question is up,
//   and "busy" about a second after it was answered. The request comes about a second before the status says waiting.
// - It also posts when a message is sent to it and when it finished its turn, with the session it is in: the screen
//   never ends by itself, so that is how the task knows it works or is done.
// - The person's own settings apply (their permission mode, their rules): nothing is forced, so Togle hears only what
//   Claude Code asks. A person whose Claude Code never asks sees no card.
// - Two programs on one session split the saved conversation in two, and a later resume follows only one: the person
//   goes on in one place at a time, and Hand back ends this one before they go on in their own terminal.
import type { IPty } from 'node-pty'
import type { HookNews, HookTarget, HookVerdict } from './claude-hooks'
import { requestOf, verdictOf } from './claude-requests'
import { rec, text } from './jsonrpc'
import { TerminalTask, type TerminalChunk } from './terminal'
import type { ScreenSide } from './types'

/** What Claude Code says of the programs it has running (`claude agents`): enough to tell whether one waits for the person. */
export type ScreenPeek = () => Promise<{ pid?: number; status?: string; state?: string }[]>

/** How often a request that waits is compared with what the program says of itself, and how often once it has waited a minute. */
const LOOK_MS = 1_500
const SLOW_LOOK_MS = 6_000
const SLOW_AFTER_MS = 60_000

/** What marks a Claude Code a person started from inside Claude Code: with it, the new program would not save its conversation. */
const NESTED = /^(CLAUDECODE|CLAUDE_CODE_CHILD_SESSION|CLAUDE_CODE_MESSAGING_.*)$/

const MODE_FLAGS = new Set(['--model', '--permission-mode', '--effort'])

/**
 * The flags a Claude Code was started with that decide what it does: its model, effort and permission mode, and the
 * flag that skips permission checks. The screen that replaces it is started with them, so that it opens the same way.
 * Read from the command line it ran under; only a plain value is taken (`opus`, `plan`, `sonnet[1m]`).
 */
export function carriedFlags(command: string): string[] {
  const words = (command.match(/"[^"]*"|\S+/g) ?? []).map((word) => word.replace(/^"|"$/g, ''))
  const carried: string[] = []
  for (let at = 0; at < words.length; at++) {
    const [name, inline] = words[at].split(/=(.*)/s)
    if (words[at] === '--dangerously-skip-permissions') carried.push(words[at])
    else if (MODE_FLAGS.has(name)) {
      const value = inline ?? words[++at]
      if (value && /^[\w.:[\]-]+$/.test(value)) carried.push(name, value)
    }
  }
  return carried
}

/** The environment Claude Code's own screen starts in: this computer's, as a terminal gives it, without those marks. */
export function screenEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) if (value !== undefined && !NESTED.test(key) && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value
  return { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
}

export class ClaudeScreenTask extends TerminalTask implements HookTarget, ScreenSide {
  protected override releases = true
  private requests = 0
  private current: string
  private looking?: NodeJS.Timeout
  private waitingSince = 0
  private sawWaiting = false

  constructor(id: string, title: string, folder: string, term: IPty, told: (chunk: TerminalChunk) => void, gone: () => void, private readonly peek: ScreenPeek) {
    super('claude', id, title, folder, 'Claude Code', term, undefined, told, gone)
    this.current = id
    // The screen opens on a conversation that waits for a message.
    this.setBase('idle')
  }

  get screen(): ScreenSide {
    return this
  }

  get pid(): number | null {
    return this.program
  }

  /** The session it is in now. Every request and every piece of news says which: the person may clear the conversation or pick another. */
  session(): string {
    return this.current
  }

  private noted(event: Record<string, unknown>): void {
    const session = text(event.session_id)
    if (session) this.current = session
  }

  async permission(event: Record<string, unknown>, gone: AbortSignal): Promise<HookVerdict> {
    this.noted(event)
    // Claude Code shows one question at a time and posts a request as its question is shown: one that comes now means the
    // one before it is over, answered on the screen, and not yet noticed.
    this.cancelRequests()
    const id = `claude-${++this.requests}`
    const { request, rule } = requestOf(id, event, this.folder)
    gone.addEventListener('abort', () => this.dropRequest(id, 'cancelled'), { once: true })
    const asked = this.ask(request)
    // Its own wait for the program to say it waits, from the start: what was seen of the one before does not count.
    this.sawWaiting = false
    this.waitingSince = Date.now()
    this.watch()
    const answer = await asked
    // Dropped (answered on the screen, the turn went on, the program ended): Claude Code has its answer, and Togle says nothing more.
    if (answer.kind === 'cancelled') return null
    return verdictOf(answer, request, rule, rec(event.tool_input)).verdict
  }

  news(what: HookNews, event: Record<string, unknown>): void {
    this.noted(event)
    // A message was sent or the turn ended: nothing can still wait on the screen's question.
    this.cancelRequests()
    if (what === 'prompt') {
      this.setBase('working')
      return
    }
    // The turn ended: what Claude Code said last is what a notice and the to-do list show.
    const said = text(event.last_assistant_message).trim()
    if (said) this.emit({ type: 'message', text: said })
    this.emit({ type: 'turn-ended', outcome: 'completed', error: null })
    this.setBase('idle')
  }

  /**
   * While a request waits, the program is asked about itself: once it said it waits and then no longer does, the screen's
   * own question was answered. Asked every second or two, and every few seconds once a card has waited a minute (a person
   * who left it for hours does not cost a program started each second).
   */
  private watch(): void {
    if (this.looking) return
    this.looking = setTimeout(() => void this.look(), LOOK_MS)
    this.looking.unref?.()
  }

  private async look(): Promise<void> {
    this.looking = undefined
    try {
      const pid = this.pid
      if (pid === null || !this.pending.length) {
        this.cancelRequests()
        return
      }
      const row = (await this.peek()).find((program) => program.pid === pid)
      if (row) {
        if (row.status === 'waiting' || row.state === 'blocked') this.sawWaiting = true
        else if (this.sawWaiting) {
          this.cancelRequests()
          return
        }
      }
    } catch {
      // Not seen this time: the end of the turn drops what is left.
    }
    if (this.pending.length && this.pid !== null) {
      this.looking = setTimeout(() => void this.look(), Date.now() - this.waitingSince > SLOW_AFTER_MS ? SLOW_LOOK_MS : LOOK_MS)
      this.looking.unref?.()
    }
  }
}
