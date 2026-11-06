import type { ClaudeConnectionSelection, Lane, LaneModel, ModelOption, ReasoningEffort } from '@shared/types'

/** Something the model can call while answering, like searching the agent's knowledge. */
export interface Tool {
  name: string
  description: string
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<string>
  /** How long it may take before it's given up on, when longer than a lookup (reading a web page). */
  timeoutMs?: number
}

export interface CompletionInput {
  system: string
  user: string
  /** Earlier messages of a conversation (the Train chat), oldest first; `user` is the newest one. */
  history?: { role: 'user' | 'assistant'; text: string }[]
  /**
   * Where `user` may be cut into blocks, in characters, in order: up to the last cut it's the same in the call's next
   * requests (the call so far, but its newest lines), so a provider that caches by block (Claude) caches up to there.
   * The others cache any start that repeats, and send `user` whole.
   */
  userCuts?: number[]
  /** data: URLs (JPEG/PNG), each optionally introduced by a label like "Frame F7 (shown 12:03:01)". */
  images?: { url: string; label?: string }[]
  /** Which job this is; picks the model and reasoning effort from the lane settings. */
  lane: Lane
  /** ChatGPT model chosen by the active agent, replacing the lane's model; other providers use their own setting. */
  model?: string
  /** Replaces the lane's reasoning effort, e.g. to think harder when asked again. */
  effort?: ReasoningEffort
  fast?: boolean
  /** A task profile explicitly pins this model rather than using provider-wide preferences. */
  fixedModel?: boolean
  tools?: Tool[]
  /**
   * There's no answer without the tools (Train changes the agent only through them): a model that can't call tools
   * is an error. Otherwise it answers without them, from what the prompt holds.
   */
  toolsRequired?: boolean
  /** Tool-calling rounds allowed before the model must answer. */
  maxToolRounds?: number
  /** Let the model call several tools at once (e.g. read three files in one round). */
  parallelTools?: boolean
  /**
   * For an answer someone is waiting for: when it hasn't written anything after this long, a second copy is
   * sent and whichever writes first is kept. Providers that can't may ignore it.
   */
  hedgeAfterMs?: number
  /** May look things up on the web (a deep answer; not Train, which edits the agent): providers that can, offer it. */
  webSearch?: boolean
  /** Apps selected for this agent; only the matching Claude subscription can read them. */
  claudeConnections?: ClaudeConnectionSelection
}

export interface StreamOptions {
  signal: AbortSignal
  onDelta: (text: string) => void
  /** Final answer without intermediate tool commentary, when the backend exposes it separately. */
  onFinal?: (text: string) => void
  onToolCall?: (name: string, args: Record<string, unknown>) => void
  /** The backend accepted the request (its response started); called once. */
  onAccepted?: () => void
  /** What this request cost, once it has ended. Providers that can't tell don't call it. */
  onUsage?: (usage: Usage) => void
}

/** A prompt-free runtime prepared for one later text request, never shared across jobs. */
export interface PreparedText {
  send(user: string): Promise<void>
  close(): void
}

/** What one request cost: tokens over all its tool rounds, and how long it took. */
export interface Usage {
  lane: Lane
  model: string
  input: number
  /** Input tokens the backend served from its prompt cache. */
  cached: number
  output: number
  /** Output tokens spent thinking, before any answer text. */
  reasoning: number
  rounds: number
  /** A second copy was sent because the first was slow to write (see CompletionInput.hedgeAfterMs). */
  hedged?: boolean
  /** Until the first answer text arrived; undefined when none did (tool calls only, or it failed). */
  firstTextMs?: number
  /** Provider preparation, separate from generation; timings contain no call content. */
  phases?: { setupMs: number; discoveryMs: number; runtimeMs: number; connectionsMs: number }
  ms: number
  /** How it ended: answered, stopped because it wasn't needed any more, or failed. */
  end?: 'done' | 'stopped' | 'failed'
}

/** A plan with usage limits (the ChatGPT plan): what it allows right now. */
export interface PlanLimits {
  /** Until when (epoch ms) the backend turns requests down, while it does. */
  limited(now?: number): number | undefined
  /** Near the limit: the model every job uses meanwhile, to make the rest last. */
  saving(): string | undefined
}

export interface LLMProvider {
  readonly id: string
  /** Whether `tools` are honored; providers without support answer from the prompt alone. */
  readonly supportsTools: boolean
  /** For a provider whose plan has usage limits. */
  readonly plan?: PlanLimits
  planFor?(lane: Lane): PlanLimits | undefined
  task?(lane: Lane): LaneModel & { provider: string }
  /** Told about every request as it ends, stopped and failed ones too, with what it cost if the provider knows. */
  onUsage?: (usage: Usage) => void
  listModels(): Promise<ModelOption[]>
  stream(input: CompletionInput, opts: StreamOptions): Promise<void>
  prepareText?(input: CompletionInput, opts: StreamOptions): Promise<PreparedText>
}
