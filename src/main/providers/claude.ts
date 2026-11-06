import type Anthropic from '@anthropic-ai/sdk'
import { net } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Lane, ModelOption, ReasoningEffort } from '@shared/types'
import { getSettings } from '../settings'
import { readSecret, writeSecret } from '../storage'
import { howItEnded } from './sse'
import { runTool } from './tools'
import type { CompletionInput, LLMProvider, StreamOptions, Usage } from './types'

type Message = Anthropic.Beta.BetaMessage
type MessageParam = Anthropic.Beta.BetaMessageParam
type ContentBlock = Anthropic.Beta.BetaContentBlock
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type StreamParams = Parameters<Anthropic['beta']['messages']['stream']>[0]

const KEY_FILE = 'claude-api-key.bin'
// Always Anthropic's own: ANTHROPIC_BASE_URL in the environment is meant for other tools (a gateway for Claude
// Code, say), and Togle's saved key mustn't go there.
const BASE_URL = 'https://api.anthropic.com'
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
// An answer Claude's safety checks decline is answered again on the model Anthropic picks for the reason, in the
// same request. Haiku has no fallback.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
// Room for the model's thinking (always on, and counted here) as well as the answer.
const MAX_TOKENS: Record<Lane, number> = { quick: 8_000, deep: 32_000, vision: 8_000, background: 16_000 }
// The SDK tries a failed request again this often before it streams, waiting as long as the API says to: a quick
// answer can't wait that long, so it tries once more by itself, at once, or tells the user when to try again.
const SDK_RETRIES: Record<Lane, number> = { quick: 0, deep: 1, vision: 2, background: 2 }
// Searches a request may make on the web; Anthropic bills each one. The tools stay the same over an answer's rounds:
// changing them would throw away the cache the round before wrote.
const WEB_SEARCHES = 3
// A long web search can pause the answer, which then carries on in a new request; this many times at most.
const MAX_PAUSES = 3
// Answers wait this long at most for the model list (it says which efforts each model takes), and a list that
// couldn't be had is asked for again after this long.
const MODELS_WAIT_MS = 3_000
const MODELS_RETRY_MS = 60_000
// The SDK's timeout runs until the response's headers come, which is after the request has uploaded: a request
// with frames (1-2 MB) gets the time it needs at this slow rate (bytes a second) on top.
const HEADERS_TIMEOUT_MS = 20_000
const SLOW_UPLOAD_BYTES_PER_S = 50_000
// Once the response has started, this long without a byte means the connection is dead: the API sends pings while
// the model thinks or searches, which the SDK doesn't pass on, so the bytes are watched where they arrive.
const STREAM_IDLE_MS = 25_000
// Tags a request for that watch (taken off before it's sent).
const ROUND_HEADER = 'x-togle-round'
// A round that failed before any of its text reached the card (a dropped connection, Claude overloaded, a tool input
// that came back unreadable) is asked again, this often per answer.
const RETRIES = 1
const RETRY_AFTER_MS = 600

/** Togle's reasoning settings on Claude's effort scale: below low is low, above max is max. */
function effortFor(effort: ReasoningEffort): Effort {
  if (effort === 'none' || effort === 'minimal') return 'low'
  if (effort === 'ultra') return 'max'
  return effort
}

/** A frame's data: URL as an image block; anything else is left out. */
function imageBlock(url: string): Anthropic.Beta.BetaImageBlockParam | undefined {
  const m = /^data:(image\/(?:jpeg|png|gif|webp));base64,(.+)$/s.exec(url)
  if (!m) return undefined
  return { type: 'image', source: { type: 'base64', media_type: m[1] as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: m[2] } }
}

function count(sum: Usage, usage: Anthropic.Beta.BetaUsage): void {
  const cached = usage.cache_read_input_tokens ?? 0
  sum.rounds++
  // input_tokens is only what wasn't read from or written to the cache.
  sum.input += usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + cached
  sum.cached += cached
  // Thinking is part of the output; the API doesn't report it apart.
  sum.output += usage.output_tokens
}

/** The web pages an answer cites, once each: "Title (site)". */
function webSources(content: ContentBlock[]): string[] {
  const pages = new Map<string, string>()
  for (const block of content) {
    if (block.type !== 'text') continue
    for (const c of block.citations ?? []) {
      if (c.type !== 'web_search_result_location' || pages.has(c.url)) continue
      let site = c.url
      try {
        site = new URL(c.url).hostname.replace(/^www\./, '')
      } catch {
        // Not a URL: shown as it came.
      }
      pages.set(c.url, c.title ? `${c.title} (${site})` : site)
    }
  }
  return [...pages.values()]
}

/** "in 20 s", from a turned-down request's retry-after header, when it has one. */
function retryIn(err: InstanceType<typeof Anthropic.APIError>): string {
  const seconds = Number(err.headers?.get('retry-after'))
  return seconds > 0 ? ` in ${Math.ceil(seconds)} s` : ' in a moment'
}

// The SDK, loaded the first time Claude is used: loading it as Togle starts costs every start about 70 ms.
let sdk: typeof Anthropic | undefined
const loadSdk = async (): Promise<typeof Anthropic> => (sdk ??= (await import('@anthropic-ai/sdk')).default)

/** Overloaded or failing, before or while streaming: worth one more try. */
function transient(err: unknown): boolean {
  // Before the SDK is loaded, nothing it throws can have come.
  if (!sdk) return false
  if (err instanceof sdk.APIConnectionError || err instanceof sdk.InternalServerError) return true
  // An error that arrived in the stream carries its type, and no status.
  if (err instanceof sdk.APIError) return err.status === undefined && (err.type === 'overloaded_error' || err.type === 'api_error')
  // The SDK's own: a tool input it couldn't read, or the connection cut while streaming.
  return err instanceof sdk.AnthropicError
}

/** What an API error means for the user, in words; anything else as it was. */
function plain(err: unknown): unknown {
  const Anthropic = sdk
  if (!Anthropic) return err
  if (err instanceof Anthropic.AuthenticationError) return new Error('Anthropic turned down the API key. Check it in Settings.', { cause: err })
  if (err instanceof Anthropic.PermissionDeniedError) return new Error(`This API key can't use that model: ${err.message}`, { cause: err })
  if (err instanceof Anthropic.NotFoundError) return new Error(`Anthropic doesn't know that model: pick another in Settings. (${err.message})`, { cause: err })
  if (err instanceof Anthropic.RateLimitError) return new Error(`Your Anthropic API key hit its rate limit. Try again${retryIn(err)}.`, { cause: err })
  if (err instanceof Anthropic.BadRequestError) return new Error(`Anthropic turned the request down: ${err.message}`, { cause: err })
  if (err instanceof Anthropic.APIConnectionError) return new Error("Can't reach Anthropic. Check your internet connection.", { cause: err })
  if (err instanceof Anthropic.InternalServerError) {
    return new Error(err.status === 529 ? 'Claude is overloaded right now. Try again in a moment.' : `Anthropic had a problem (${err.status}). Try again.`, { cause: err })
  }
  if (err instanceof Anthropic.APIError && err.status === undefined) {
    if (err.type === 'overloaded_error') return new Error('Claude is overloaded right now. Try again in a moment.', { cause: err })
    if (err.type === 'rate_limit_error') return new Error('Your Anthropic API key hit its rate limit. Try again in a moment.', { cause: err })
    return new Error(`Anthropic had a problem${err.type ? ` (${err.type})` : ''}. Try again.`, { cause: err })
  }
  return err
}

/** Builds the client without what the environment sets for other tools: the SDK reads it only here. */
function withoutForeignEnvironment<T>(build: () => T): T {
  const saved = process.env.ANTHROPIC_CUSTOM_HEADERS
  delete process.env.ANTHROPIC_CUSTOM_HEADERS
  try {
    return build()
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_CUSTOM_HEADERS = saved
  }
}

/**
 * Claude through the user's own Anthropic API key, with the official SDK over Chromium's network stack. Each job
 * has its own model and effort (Settings). The agent's setup goes first and is cached, so the requests after the
 * first read it from the cache; deep answers can search the web.
 */
export class ClaudeProvider implements LLMProvider {
  readonly id = 'claude'
  readonly supportsTools = true
  onUsage?: (usage: Usage) => void
  private apiKey: string | null = null
  private keyRevision = 0
  identity(): number { return this.keyRevision }
  pinned(): ClaudeProvider {
    const provider = new ClaudeProvider(this.idleMs, this.keyFile)
    provider.apiKey = this.apiKey; provider.models = [...this.models]; provider.onUsage = this.onUsage
    return provider
  }
  private client: Anthropic | null = null
  /** The models the key can use, with the efforts each takes, once listed. */
  private models: ModelOption[] = []
  private loadingModels: Promise<ModelOption[]> | null = null
  /** For each request being streamed (by its ROUND_HEADER tag): told whenever bytes of its response arrive. */
  private alive = new Map<string, () => void>()
  /** When the list was last asked for without a list to show for it (a key that may not list models: once a minute). */
  private modelsAskedAt = 0

  /** `idleMs`: how long a started response may go without a byte (STREAM_IDLE_MS; tests make it short). */
  constructor(private idleMs = STREAM_IDLE_MS, private keyFile = KEY_FILE) {}

  async load(): Promise<void> {
    this.apiKey = await readSecret<string>(this.keyFile)
    this.client = null
  }

  hasApiKey(): boolean {
    return !!this.apiKey
  }

  async setApiKey(key: string): Promise<void> {
    this.keyRevision++
    this.apiKey = key.trim() || null
    this.client = null
    this.models = []
    this.loadingModels = null
    this.modelsAskedAt = 0
    await writeSecret(this.keyFile, this.apiKey)
  }

  private async api(): Promise<Anthropic> {
    if (!this.apiKey) throw new Error('Add your Anthropic API key first, in Settings.')
    const apiKey = this.apiKey
    const Sdk = await loadSdk()
    // A new key saved while the SDK loaded: the client is for that one.
    if (this.apiKey !== apiKey) return this.api()
    // ANTHROPIC_CUSTOM_HEADERS and ANTHROPIC_AUTH_TOKEN in the environment are someone else's too: merged after the
    // SDK's own headers, they would replace Togle's key or its beta header.
    this.client ??= withoutForeignEnvironment(
      () =>
        new Sdk({
          apiKey,
          baseURL: BASE_URL,
          authToken: null,
          // Chromium's network stack, as for ChatGPT: it keeps one connection for parallel requests and copes with lossy links.
          fetch: (input, init) => this.fetch(input, init)
        })
    )
    return this.client
  }

  /** Sends a request; a tagged one's response bytes are reported as they arrive (see STREAM_IDLE_MS). */
  private async fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers)
    const alive = this.alive.get(headers.get(ROUND_HEADER) ?? '')
    headers.delete(ROUND_HEADER)
    const res = await net.fetch(input instanceof URL ? input.href : input, { ...init, headers })
    if (!alive || !res.body) return res
    alive()
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          alive()
          controller.enqueue(chunk)
        }
      })
    )
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }

  /** The models this key can use. Concurrent callers share one request. */
  listModels(): Promise<ModelOption[]> {
    this.loadingModels ??= this.fetchModels().finally(() => (this.loadingModels = null))
    return this.loadingModels
  }

  private async fetchModels(): Promise<ModelOption[]> {
    const models: ModelOption[] = []
    try {
      for await (const m of (await this.api()).models.list({ limit: 100 })) {
        const effort = m.capabilities?.effort
        // No capabilities listed: not known which efforts it takes. Listed without effort: it takes none.
        const reasoningLevels = !m.capabilities ? undefined : effort?.supported ? EFFORTS.filter((level) => effort[level]?.supported) : []
        models.push({ id: m.id, label: m.display_name, reasoningLevels })
      }
    } catch (err) {
      throw plain(err)
    }
    this.models = models
    return models
  }

  /** A model id this provider can send: one of its listed models, or before they're listed, a Claude one. */
  private own(id: string | undefined): id is string {
    if (!id) return false
    return this.models.length ? this.models.some((m) => m.id === id) : /^claude-/i.test(id)
  }

  /**
   * An effort the model takes: the wanted one, else the strongest it takes below it, else its weakest; none for a
   * model that takes none. Before the models are listed, the wanted one.
   */
  private effortOf(model: string, wanted: Effort): Effort | undefined {
    const levels = this.models.find((m) => m.id === model)?.reasoningLevels as Effort[] | undefined
    if (!levels) return wanted
    if (!levels.length) return undefined
    if (levels.includes(wanted)) return wanted
    const rank = (e: Effort): number => EFFORTS.indexOf(e)
    return levels.findLast((e) => rank(e) <= rank(wanted)) ?? levels[0]
  }

  /**
   * Streams the answer. With tools, the model may call them first: each round's content (its thinking included)
   * goes back with the tool results, and on the last allowed round tools are switched off so it has to answer.
   */
  async stream(input: CompletionInput, { signal, onDelta, onToolCall, onAccepted, onUsage }: StreamOptions): Promise<void> {
    const settings = getSettings().claude
    const lane = settings.lanes[input.lane]
    if (input.fixedModel && !this.own(input.model)) throw new Error('The selected Claude API model is no longer available. Choose another model in Settings.')
    // The agent's own model for deep answers, when it's one of Claude's.
    const model = this.own(input.model) ? input.model : lane.model
    // Which efforts each model takes: listed before the first request (a model that takes none fails with one), a few
    // seconds at most.
    if (!this.models.length && Date.now() - this.modelsAskedAt > MODELS_RETRY_MS) {
      this.modelsAskedAt = Date.now()
      await Promise.race([this.listModels().catch(() => undefined), new Promise((r) => setTimeout(r, MODELS_WAIT_MS))])
    }
    const effort = this.effortOf(model, effortFor(input.effort ?? lane.effort))
    const tools = input.tools ?? []
    const maxRounds = tools.length ? (input.maxToolRounds ?? 2) : 0
    const web = !!input.webSearch && settings.webSearch !== false
    const custom = tools.map(
      (t): Anthropic.Beta.BetaTool => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema, eager_input_streaming: true })
    )
    const history = (input.history ?? []).map((turn): MessageParam => ({ role: turn.role, content: turn.text }))
    // The conversation has to open with my turn: a chat that starts with Togle's says so.
    if (history[0]?.role === 'assistant') history.unshift({ role: 'user', content: '(This chat so far:)' })
    // The call so far in blocks that repeat in its next requests, and the newest of them marked for the cache: the next
    // request reads up to there from it (Anthropic looks back over the 20 blocks before a mark), though more was said.
    const cuts = (input.userCuts ?? []).filter((cut, i, all) => cut > 0 && cut < input.user.length && (i === 0 || cut > all[i - 1]))
    const pieces = [0, ...cuts].map((from, i) => input.user.slice(from, cuts[i] ?? input.user.length))
    const messages: MessageParam[] = [
      ...history,
      {
        role: 'user',
        content: [
          ...pieces.map((text, i): Anthropic.Beta.BetaTextBlockParam => ({ type: 'text', text, ...(i === cuts.length - 1 ? { cache_control: { type: 'ephemeral' } } : {}) })),
          ...(input.images ?? []).flatMap((img) => {
            const image = imageBlock(img.url)
            return image ? [...(img.label ? [{ type: 'text' as const, text: img.label }] : []), image] : []
          })
        ]
      }
    ]

    const toolDefs: Anthropic.Beta.BetaToolUnion[] = [...custom, ...(web ? [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: WEB_SEARCHES }] : [])]

    const started = performance.now()
    const used: Usage = { lane: input.lane, model, input: 0, cached: 0, output: 0, reasoning: 0, rounds: 0, ms: 0, end: 'done' }
    const cited: ContentBlock[] = []
    let accepted = false
    let pauses = 0
    let retries = 0
    try {
      for (let round = 0; ; round++) {
        const params: StreamParams = {
          model,
          max_tokens: MAX_TOKENS[input.lane],
          // The agent's setup is the same for every request of the call: after the first, it's read from the cache.
          system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
          messages,
          ...(toolDefs.length
            ? {
                tools: toolDefs,
                // The same in every round, as the tools are: past the lookups allowed, the model is told to answer instead.
                tool_choice: { type: 'auto', disable_parallel_tool_use: !input.parallelTools },
                // A lookup brings another round: the conversation so far is cached too, for that round to read.
                cache_control: { type: 'ephemeral' }
              }
            : {}),
          ...(effort ? { output_config: { effort } } : {}),
          ...(input.fixedModel || /haiku/i.test(model) ? {} : { betas: [FALLBACK_BETA], fallbacks: 'default' as const })
        }
        let wrote = false
        let message: Message
        try {
          message = await this.round(
            params,
            { signal, maxRetries: SDK_RETRIES[input.lane], timeout: Math.round(HEADERS_TIMEOUT_MS + (JSON.stringify(params).length / SLOW_UPLOAD_BYTES_PER_S) * 1000) },
            (text) => {
              if (!text) return
              wrote = true
              used.firstTextMs ??= performance.now() - started
              onDelta(text)
            },
            () => {
              if (accepted) return
              accepted = true
              onAccepted?.()
            },
            onToolCall
          )
        } catch (err) {
          // Nothing of this round reached the card: it can be asked again. Once text is on screen, a retry would
          // write it twice.
          if (wrote || signal.aborted || retries++ >= RETRIES || !transient(err)) throw err
          console.warn(`[claude] round failed (${(err as Error).message}); trying again`)
          await new Promise((r) => setTimeout(r, RETRY_AFTER_MS))
          round--
          continue
        }
        count(used, message.usage)
        cited.push(...message.content)
        // Declined by Claude's safety checks (and by the fallback model too, if one ran).
        if (message.stop_reason === 'refusal') throw new Error('Claude declined to answer this.')
        // A long web search paused the turn: the same turn carries on in the next request.
        if (message.stop_reason === 'pause_turn' && pauses++ < MAX_PAUSES) {
          messages.push({ role: 'assistant', content: message.content })
          round--
          continue
        }
        const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
        if (!calls.length) {
          const pages = webSources(cited)
          if (pages.length) onDelta(`\n\nFrom the web: ${pages.join(' · ')}`)
          return
        }
        // Cut off while writing a call: its input can't be trusted.
        if (message.stop_reason === 'max_tokens') throw new Error('The answer ran out of room while looking something up. Try again.')
        // Told to answer and still looking things up.
        if (round > maxRounds) throw new Error('Claude kept looking things up instead of answering. Try again.')
        messages.push({ role: 'assistant', content: message.content })
        signal.throwIfAborted()
        // Past the lookups allowed: no more of them, the next round answers with what it has.
        if (round >= maxRounds) {
          messages.push({
            role: 'user',
            content: calls.map((call): Anthropic.Beta.BetaToolResultBlockParam => ({ type: 'tool_result', tool_use_id: call.id, content: 'No more lookups: answer now with what you have.' }))
          })
          continue
        }
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = []
        const runCall = async (call: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> => {
          const args = call.input
          // Streamed as it was written, the input may not be the object the tool expects.
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            return { type: 'tool_result', tool_use_id: call.id, is_error: true, content: `Invalid input: ${JSON.stringify(args)}` }
          }
          onToolCall?.(call.name, args as Record<string, unknown>)
          const { text, failed } = await runTool(tools, call.name, args as Record<string, unknown>)
          return { type: 'tool_result', tool_use_id: call.id, content: text, ...(failed ? { is_error: true } : {}) }
        }
        if (input.parallelTools) results.push(...(await Promise.all(calls.map(runCall))))
        else for (const call of calls) results.push(await runCall(call))
        messages.push({ role: 'user', content: results })
      }
    } catch (err) {
      used.end = howItEnded(signal)
      // Stopped, or out of time: the reason says which (a TimeoutError reads as "took too long").
      throw signal.aborted ? (signal.reason ?? err) : plain(err)
    } finally {
      used.ms = performance.now() - started
      // Stopped and failed requests too: they cost as well.
      this.onUsage?.(used)
      if (used.rounds) onUsage?.(used)
    }
  }

  /** One streamed request: its text as it comes, a web search as it starts, and the whole message at the end. */
  private async round(
    params: StreamParams,
    options: Anthropic.RequestOptions,
    onText: (text: string) => void,
    onStarted: () => void,
    onToolCall?: (name: string, args: Record<string, unknown>) => void
  ): Promise<Message> {
    const tag = randomUUID()
    // 0 until the response starts: the time it takes to come is the SDK's timeout's to judge.
    let lastBytes = 0
    this.alive.set(tag, () => (lastBytes = performance.now()))
    const stream = (await this.api()).beta.messages.stream(params, { ...options, headers: { [ROUND_HEADER]: tag } })
    let stalled = false
    const watch = setInterval(() => {
      if (lastBytes && performance.now() - lastBytes > this.idleMs) {
        stalled = true
        stream.abort()
      }
    }, Math.min(1_000, this.idleMs / 4))
    watch.unref?.()
    stream.on('connect', onStarted)
    stream.on('text', onText)
    stream.on('contentBlock', (block) => {
      if (block.type === 'server_tool_use' && block.name === 'web_search') onToolCall?.('web_search', block.input as Record<string, unknown>)
    })
    try {
      return await stream.finalMessage()
    } catch (err) {
      if (stalled) throw new Error('Claude stopped responding. Try again.', { cause: err })
      throw err
    } finally {
      clearInterval(watch)
      this.alive.delete(tag)
    }
  }
}
