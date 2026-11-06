import { app, net } from 'electron'
import { randomUUID } from 'node:crypto'
import { EFFORT_ORDER, type ModelOption, type PlanUsage, type ReasoningEffort } from '@shared/types'
import { MANAGE_USAGE_URL, type ChatGPTAuth } from '../auth/chatgpt'
import { PlanWatch } from '../plan'
import { getSettings } from '../settings'
import { errorText, howItEnded, readSse } from './sse'
import { runTool } from './tools'
import type { CompletionInput, LLMProvider, StreamOptions, Usage } from './types'

// The public Responses API: with a Sign in with ChatGPT token, requests count against the user's ChatGPT plan.
const BACKEND = 'https://api.openai.com/v1'
// The system Togle runs on, as its requests name it.
const SYSTEM = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux'
// Attempts per request when the connection fails before an answer starts streaming.
const MAX_ATTEMPTS = 3
// On a lossy connection a request can hang without failing. The backend answers with headers at once
// (before any reasoning), so waiting longer than this means the attempt is stuck: retry it.
const HEADERS_TIMEOUT_MS = 12_000
// Headers only come back once the body has uploaded, and a request with frames is 1–2 MB. The timeout
// allows for the upload at this slow rate (bytes a second) on top.
const SLOW_UPLOAD_BYTES_PER_S = 50_000
// Answers don't wait longer than this for the model list (it only refines the reasoning setting).
const MODELS_WAIT_MS = 3_000
// Once answer text is streaming, this long without any event means the connection is dead.
const STREAM_IDLE_MS = 25_000

const TIMED_OUT = Symbol('timed out')

/** Reads what's left of a stream. */
async function drain(events: AsyncGenerator<unknown>): Promise<void> {
  try {
    while (!(await events.next()).done) {
      // Discard.
    }
  } catch {
    // The connection closed or was cut; nothing left to read.
  }
}

/** The promise's result, or TIMED_OUT if it takes longer than `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => (timer = setTimeout(() => resolve(TIMED_OUT), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * The promise's result, but stops waiting as soon as the signal aborts (rejecting with its reason): Stop
 * shouldn't wait on a shared token refresh. The promise itself carries on.
 */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => reject(signal.reason)
    signal.addEventListener('abort', stop, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Token counts as the Responses API reports them, on response.completed. */
interface RawUsage {
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
  output_tokens?: number
  output_tokens_details?: { reasoning_tokens?: number }
}

/** One round's output items, and what it cost when the backend said. */
interface Round {
  output: Record<string, unknown>[]
  usage?: RawUsage
}

/** One answer's requests (its tool rounds, retries and hedged copies), as they go out. */
type Turn = Record<string, never>

function count(sum: Usage, raw: RawUsage | undefined): void {
  if (!raw) return
  sum.rounds++
  sum.input += raw.input_tokens ?? 0
  sum.cached += raw.input_tokens_details?.cached_tokens ?? 0
  sum.output += raw.output_tokens ?? 0
  sum.reasoning += raw.output_tokens_details?.reasoning_tokens ?? 0
}

const FALLBACK_MODELS: ModelOption[] = [
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', description: 'Fast, good for live suggestions' },
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', description: 'Stronger reasoning, a bit slower' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', description: 'Most capable, slowest' }
]

interface RemoteModel {
  slug: string
  display_name?: string
  description?: string | null
  visibility?: string
  priority?: number
  default_reasoning_level?: ReasoningEffort
  supported_reasoning_levels?: { effort: ReasoningEffort }[]
  service_tiers?: { id: string; name?: string; description?: string }[]
}

// The service tier ChatGPT calls Fast.
const FAST_TIER = 'priority'

/** What a ChatGPT plan request turned down says, as the API words it (structured, or before the stream opens). */
interface PlanError { code?: string; param?: string; message: string }

export function readPlanError(text: string): PlanError {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; param?: unknown; message?: unknown } | string; detail?: unknown }
    if (body.error && typeof body.error === 'object') {
      const { code, param, message } = body.error
      return { code: typeof code === 'string' ? code : undefined, param: typeof param === 'string' ? param : undefined, message: typeof message === 'string' ? message : '' }
    }
    if (typeof body.detail === 'string') return { message: body.detail }
    if (typeof body.error === 'string') return { message: body.error }
  } catch { /* Not JSON. */ }
  return { message: text.slice(0, 300) }
}

/**
 * Words for a ChatGPT plan error, with what to do: OpenAI's recovery for each code (developers.openai.com/siwc). Usage
 * limits are told apart: they pause automatic answers and point to ChatGPT's usage settings.
 */
export function planErrorText(status: number, error: PlanError): string {
  switch (error.code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return `Usage limit reached on your ChatGPT plan. Review your plan, or Togle's limit, in ChatGPT settings: ${MANAGE_USAGE_URL}`
    case 'subscription_sharing_user_not_eligible':
      return "This ChatGPT account or workspace can't use its plan in Togle. Sign in with another account, or use an API key in Settings."
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return `ChatGPT couldn't check your plan's usage right now (${status}). Try again in a moment.`
    case 'subscription_sharing_unsupported_capability':
      return `ChatGPT can't do this on your plan${error.param ? ` (${error.param})` : ''}. Choose another model in Settings.`
    case 'subscription_sharing_invalid_user':
      return 'ChatGPT could not confirm your account. Sign in with ChatGPT again in Settings.'
    case 'subscription_sharing_route_not_supported':
    case 'chatpass_v2_scope_not_authorized':
    case 'chatpass_v2_invalid_authorization_context':
      return `ChatGPT turned this request down (${error.code}). Sign in with ChatGPT again in Settings.`
  }
  if (status === 401) return 'ChatGPT did not accept the sign-in. Sign in with ChatGPT again in Settings.'
  if (status === 403) return `ChatGPT turned this request down: ${error.message || 'not allowed here'}.`
  return `ChatGPT request failed (${status}): ${error.message || 'no details'}`
}

/** Uses the user's ChatGPT plan through the public Responses API (over SSE), signed in with ChatGPT. */
export class ChatGPTProvider implements LLMProvider {
  readonly id = 'chatgpt'
  readonly supportsTools = true
  onUsage?: (usage: Usage) => void
  private models: ModelOption[] = []
  private loadingModels: Promise<ModelOption[]> | null = null
  // Prompts repeat their start (the agent's setup, the call so far). ChatGPT picks the server, and so the
  // prompt cache, by the session-id header, as it does for Codex: one key for the whole run lets those
  // parts be read from the cache instead of processed again.
  private cacheKey = randomUUID()
  /** A reached usage limit: automatic answers wait a few minutes before trying the plan again. */
  readonly plan = new PlanWatch(() => this.savingModel())
  /** Tells the window again once a reached limit's pause is over. */
  private recheck?: NodeJS.Timeout

  constructor(private auth: ChatGPTAuth) {}

  private async request(path: string, init: RequestInit = {}, retried = false): Promise<Response> {
    const access = this.auth.getAccess(retried)
    const { accessToken } = await (init.signal ? unlessAborted(access, init.signal) : access)
    let res: Response
    try {
      // Chromium's network stack rather than Node's: it shares one HTTP/2 (or QUIC) connection between
      // parallel requests, so the deep answer doesn't need a second handshake. On a lossy connection
      // that's the difference between every request getting through and some failing to connect.
      res = await net.fetch(`${BACKEND}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': `Togle/${app.getVersion()} (${SYSTEM})`
        }
      })
    } catch (err) {
      // A lost connection shows up as a TypeError or a net::ERR_… error; a stopped request as an abort.
      if ((err instanceof TypeError || /net::ERR_/.test((err as Error).message)) && !init.signal?.aborted) {
        throw new Error("Can't reach ChatGPT. Check your internet connection.", { cause: err })
      }
      throw err
    }
    if (res.status === 401 && !retried) return this.request(path, init, true)
    return res
  }

  /** The models this plan can use. Concurrent callers share one request. */
  listModels(): Promise<ModelOption[]> {
    this.loadingModels ??= this.fetchModels().finally(() => (this.loadingModels = null))
    return this.loadingModels
  }

  private async fetchModels(): Promise<ModelOption[]> {
    try {
      // The signed-in account's own catalog, in the server's order; only models meant for a picker.
      const res = await this.request('/models', { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(await errorText(res))
      const data = (await res.json()) as { models?: RemoteModel[]; data?: { id?: string }[] }
      const listed: RemoteModel[] = data.models ?? (data.data ?? []).flatMap((m) => (m.id ? [{ slug: m.id }] : []))
      const models = listed
        .filter((m) => typeof m.slug === 'string' && m.slug && (m.visibility === undefined || m.visibility === 'list'))
        .map((m) => ({
          id: m.slug,
          label: m.display_name || m.slug,
          description: m.description ?? undefined,
          reasoningLevels: m.supported_reasoning_levels?.map((l) => l.effort),
          defaultReasoning: m.default_reasoning_level,
          fast: m.service_tiers?.find((t) => t.id === FAST_TIER)?.description
        }))
      if (models.length) this.models = models
    } catch (err) {
      console.warn('[chatgpt] model list unavailable, using fallback:', (err as Error).message)
    }
    return this.models.length ? this.models : FALLBACK_MODELS
  }

  /**
   * What's known of the plan's usage: only whether a usage limit was reached. ChatGPT shows the usage itself, in its
   * settings (MANAGE_USAGE_URL); the plan's figures aren't part of Sign in with ChatGPT.
   */
  async refreshUsage(): Promise<PlanUsage> {
    return this.plan.usage()
  }

  /** Once a reached limit's pause is over, the window hears it, so automatic answers come back without waiting for one. */
  private recheckAt(until: number): void {
    clearTimeout(this.recheck)
    // A delay past what a timer holds (about 24 days) would fire at once, and again, and again.
    this.recheck = setTimeout(() => this.plan.update(), Math.min(until - Date.now() + 1_000, 2 ** 31 - 1))
    this.recheck.unref?.()
  }

  /** A usage limit was reached: automatic answers pause, and the window says where to look. */
  private limitReached(text: string): string {
    const message = this.plan.refused(text)
    const until = this.plan.limited()
    if (until) this.recheckAt(until)
    return message
  }

  /** The model every job uses near the plan's limit (the quick answers' one), unless that's turned off. */
  private savingModel(): string | undefined {
    const { lanes, saveNearLimit } = getSettings().chatgpt
    if (saveNearLimit === false) return undefined
    return (this.models.length ? this.models : FALLBACK_MODELS).find((m) => m.id === lanes.quick.model)?.label ?? lanes.quick.model
  }

  /**
   * Picks an effort the model accepts (the backend rejects unsupported levels): the wanted one, else the
   * strongest supported level below it, else the model's weakest.
   */
  private effortFor(model: string, wanted: ReasoningEffort): ReasoningEffort | undefined {
    const info = this.models.find((m) => m.id === model)
    if (!info?.reasoningLevels?.length) return wanted === 'none' ? undefined : wanted
    if (info.reasoningLevels.includes(wanted)) return wanted
    const rank = (effort: ReasoningEffort): number => EFFORT_ORDER.indexOf(effort)
    const supported = [...info.reasoningLevels].sort((a, b) => rank(a) - rank(b))
    return supported.findLast((effort) => rank(effort) <= rank(wanted)) ?? supported[0]
  }

  /**
   * Streams the answer. With tools, the model may call them first: each round's output items (reasoning,
   * function calls) go back into the next request with the tool results, the way Codex continues a turn
   * with store=false. On the last allowed round tools are switched off so the model has to answer.
   */
  async stream(input: CompletionInput, { signal, onDelta, onToolCall, onAccepted, onUsage }: StreamOptions): Promise<void> {
    const { lanes } = getSettings().chatgpt
    const lane = lanes[input.lane]
    // Near the plan's limit every job uses the quick answers' model, at its own effort, so what's left lasts.
    const saving = !!this.plan.saving()
    if (!this.models.length) await Promise.race([this.listModels(), new Promise((r) => setTimeout(r, MODELS_WAIT_MS))])
    // The agent's own model for deep answers, when it's one of this plan's (not another provider's, picked while it
    // answered).
    const known = this.models.length ? this.models : FALLBACK_MODELS
    const agentModel = input.model && known.some((m) => m.id === input.model) ? input.model : undefined
    if (input.fixedModel && !agentModel) throw new Error('The selected model is no longer available on this ChatGPT account. Choose another model in Settings.')
    const model = input.fixedModel ? agentModel! : saving ? lanes.quick.model : agentModel || lane.model
    const effort = this.effortFor(model, input.effort ?? lane.effort)
    // The Fast tier when the lane asks for it and the plan offers it for this model (not near the limit: for some
    // models it uses more of it).
    const tier = (input.fast ?? lane.fast) && !saving && this.models.find((m) => m.id === model)?.fast ? FAST_TIER : undefined
    const tools = input.tools ?? []
    const maxRounds = tools.length ? (input.maxToolRounds ?? 2) : 0

    const items: unknown[] = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: input.system }] },
      ...(input.history ?? []).map((turn) =>
        turn.role === 'user'
          ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn.text }] }
          : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turn.text }] }
      ),
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: input.user },
          ...(input.images ?? []).flatMap((img) => [
            ...(img.label ? [{ type: 'input_text', text: img.label }] : []),
            { type: 'input_image', image_url: img.url }
          ])
        ]
      }
    ]

    const started = performance.now()
    const used: Usage = { lane: input.lane, model, input: 0, cached: 0, output: 0, reasoning: 0, rounds: 0, ms: 0 }
    let turn: Turn = {}
    // The plan's route takes function tools grouped in a namespace; calls come back with their own name.
    const toolSpecs = tools.length
      ? [{ type: 'namespace', name: 'functions', description: "Togle's tools", tools: tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })) }]
      : []
    const text = (delta: string): void => {
      if (delta) used.firstTextMs ??= performance.now() - started
      onDelta(delta)
    }
    used.end = 'done'
    try {
      for (let round = 0; ; round++) {
        // Only fields the plan's route accepts: no temperature, output limits, metadata or stored state
        // (store: false and stream: true on every request, the whole context in `input`).
        const body = {
          model,
          stream: true,
          ...(tier ? { service_tier: tier } : {}),
          input: items,
          ...(tools.length ? { tools: toolSpecs, tool_choice: round >= maxRounds ? 'none' : 'auto', parallel_tool_calls: !!input.parallelTools } : {}),
          ...(effort ? { reasoning: { effort } } : {}),
          store: false,
          ...(tools.length ? { include: ['reasoning.encrypted_content'] } : {}),
          prompt_cache_key: this.cacheKey
        }
        let result: Round
        if (round === 0 && input.hedgeAfterMs) {
          const kept = await this.hedged(input.hedgeAfterMs, signal, text, (copySignal, copyTurn, onText, onBusy) =>
            this.roundWithRetry(body, copyTurn, copySignal, onText, onAccepted, onBusy)
          )
          ;({ result, turn } = kept)
          if (kept.copies > 1) used.hedged = true
        } else {
          result = await this.roundWithRetry(body, turn, signal, text, round === 0 ? onAccepted : undefined)
        }
        const { output, usage } = result
        count(used, usage)
        const calls = output.filter((item) => item.type === 'function_call') as { name: string; arguments: string; call_id: string }[]
        if (!calls.length || round >= maxRounds) return

        items.push(...output)
        for (const call of calls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.arguments || '{}')
          } catch {
            // Leave args empty; the tool reports what's missing.
          }
          signal.throwIfAborted()
          onToolCall?.(call.name, args)
          items.push({ type: 'function_call_output', call_id: call.call_id, output: (await runTool(tools, call.name, args)).text })
        }
      }
    } catch (err) {
      used.end = howItEnded(signal)
      throw err
    } finally {
      used.ms = performance.now() - started
      // Stopped and failed requests too: they cost the plan as well.
      this.onUsage?.(used)
      if (used.rounds) onUsage?.(used)
    }
  }

  /**
   * A round that has written nothing after `after` ms gets a second copy, and whichever writes first is kept
   * (the other is stopped): now and then a request waits on a slow server where a copy wouldn't. It costs a
   * request only for those slow answers, and the usage counted is the kept copy's. One already at work on its
   * answer (calling a tool, or saying what it's doing) isn't waiting: a copy would only start over behind it.
   */
  private hedged(
    after: number,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    send: (signal: AbortSignal, turn: Turn, onDelta: (text: string) => void, onBusy: () => void) => Promise<Round>
  ): Promise<{ result: Round; turn: Turn; copies: number }> {
    return new Promise((resolve, reject) => {
      const copies: { stop: AbortController; turn: Turn }[] = []
      let kept: number | undefined
      let failed = 0
      let busy = false
      const keep = (i: number): void => {
        kept = i
        clearTimeout(timer)
        copies.forEach((copy, j) => j !== i && copy.stop.abort())
      }
      const start = (): void => {
        const i = copies.length
        const copy = { stop: new AbortController(), turn: {} }
        copies.push(copy)
        send(
          AbortSignal.any([signal, copy.stop.signal]),
          copy.turn,
          (text) => {
            if (text && kept === undefined) keep(i)
            if (kept === i) onDelta(text)
          },
          () => (busy = true)
        ).then(
          (result) => {
            // Finished without writing (tool calls only): the first to finish is kept.
            if (kept === undefined) keep(i)
            if (kept === i) resolve({ result, turn: copy.turn, copies: copies.length })
          },
          (err) => {
            if (kept === i) return reject(err)
            if (kept !== undefined) return
            // While another copy is still on its way, it may answer.
            if (++failed === copies.length) {
              clearTimeout(timer)
              reject(err)
            }
          }
        )
      }
      const timer = setTimeout(() => {
        if (kept === undefined && failed === 0 && !busy && !signal.aborted) start()
      }, after)
      start()
    })
  }

  /**
   * A round, retried when the connection fails before any answer text arrived (dropped Wi-Fi, a reset,
   * a 5xx from the backend). Once text is on screen a retry would repeat it, so then the error stands.
   */
  private async roundWithRetry(
    body: { model: string; service_tier?: string },
    turn: Turn,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onAccepted?: () => void,
    onBusy?: () => void
  ): Promise<Round> {
    for (let attempt = 1; ; attempt++) {
      let streamed = false
      try {
        return await this.round(
          body,
          turn,
          signal,
          (text) => {
            streamed = true
            onDelta(text)
          },
          onAccepted,
          onBusy
        )
      } catch (err) {
        const message = (err as Error).message
        const transient = /Can't reach ChatGPT|didn't respond in time|stopped responding|terminated|ECONNRESET|socket|fetch failed|net::ERR_|couldn't check your plan|\((502|503|504)\)/i.test(message)
        if (streamed || signal.aborted || !transient || attempt >= MAX_ATTEMPTS) throw err
        console.warn(`[chatgpt] attempt ${attempt} failed (${message}); retrying`)
        await new Promise((r) => setTimeout(r, 600 * attempt))
      }
    }
  }

  /**
   * One streamed request; returns the completed output items, and the usage the backend reported. `onBusy`: it's at
   * work on the answer without writing it yet (a tool call, or commentary).
   */
  private async round(
    body: { model: string; service_tier?: string },
    turn: Turn,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onAccepted?: () => void,
    onBusy?: () => void
  ): Promise<Round> {
    // A token refresh near expiry is its own request; it doesn't count against this one's timeout.
    await unlessAborted(this.auth.getAccess(), signal)
    const payload = JSON.stringify(body)
    const stuck = new AbortController()
    const timer = setTimeout(() => stuck.abort(), HEADERS_TIMEOUT_MS + (payload.length / SLOW_UPLOAD_BYTES_PER_S) * 1000)
    let res: Response
    try {
      res = await this.request('/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: payload,
        signal: AbortSignal.any([signal, stuck.signal])
      })
    } catch (err) {
      if (stuck.signal.aborted && !signal.aborted) throw new Error("ChatGPT didn't respond in time.", { cause: err })
      throw err
    } finally {
      clearTimeout(timer)
    }
    // An answer means no usage limit is reached (any more).
    this.plan.seen(res.headers, res.ok)
    if (res.status === 429) throw new Error(this.limitReached(await res.text().catch(() => '')))
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw new Error(planErrorText(res.status, readPlanError(text)))
    }
    void turn
    onAccepted?.()

    // Newer models may send a "commentary" message (progress narration) before the answer; only the
    // answer belongs on screen. Messages without a phase are treated as answer text.
    const phases = new Map<string, string | undefined>()
    const output: Record<string, unknown>[] = []
    // Items started but not finished. Reasoning can be silent for minutes, but once text flows the events
    // come steadily, so a long gap after that means the connection died without closing.
    const open = new Set<string>()
    let watchIdle = false
    let completed = false
    const events = readSse(res.body)
    try {
      for (;;) {
        const next = await (watchIdle ? withTimeout(events.next(), STREAM_IDLE_MS) : events.next())
        if (next === TIMED_OUT) {
          // Everything it started is finished (the answer text is complete): only the closing event got lost.
          if (output.length && !open.size) return { output }
          throw new Error('ChatGPT stopped responding. Try again.')
        }
        if (next.done) {
          // Closed without the closing event. If everything it started is finished, only that event got
          // lost; otherwise the answer was cut off (or never came), and it mustn't look finished.
          if (output.length && !open.size) {
            completed = true
            return { output }
          }
          throw new Error('ChatGPT stopped responding before the answer finished. Try again.')
        }
        const event = next.value
        switch (event.type) {
          case 'response.output_item.added':
            if (event.item?.id) open.add(event.item.id)
            if (event.item?.type === 'message') phases.set(event.item.id, event.item.phase)
            // Silent thinking could still be a slow server; a tool call or commentary is the answer under way.
            if (event.item?.type === 'function_call' || (event.item?.type === 'message' && event.item.phase === 'commentary')) onBusy?.()
            break
          case 'response.output_item.done':
            if (event.item?.id) open.delete(event.item.id)
            if (event.item) output.push(event.item)
            if (event.item?.type !== 'reasoning') watchIdle = true
            break
          case 'response.output_text.delta':
            watchIdle = true
            if (phases.get(event.item_id) !== 'commentary') onDelta(event.delta ?? '')
            break
          case 'response.failed':
          case 'response.incomplete': {
            // A usage limit can be reached after the stream opened: it fails the response.
            const error = event.response?.error as { code?: string; message?: string; param?: string } | undefined
            if (error?.code === 'subscription_sharing_usage_limit_exceeded') throw new Error(this.limitReached(JSON.stringify({ error })))
            if (error?.code) throw new Error(planErrorText(event.type === 'response.failed' ? 400 : 200, { code: error.code, param: error.param, message: error.message ?? '' }))
            throw new Error(error?.message ?? event.response?.incomplete_details?.reason ?? 'Response failed')
          }
          case 'error':
            if (event.code === 'subscription_sharing_usage_limit_exceeded' || event.error?.code === 'subscription_sharing_usage_limit_exceeded') throw new Error(this.limitReached(JSON.stringify({ error: event.error ?? event })))
            throw new Error(event.message ?? event.error?.message ?? 'Stream error')
          case 'response.completed':
            completed = true
            // Let the stream end by itself so the connection can be reused (a new TLS handshake costs
            // seconds on a slow network); cut it only if it lingers.
            void withTimeout(drain(events), 3_000).then((r) => r === TIMED_OUT && stuck.abort())
            return { output, usage: event.response?.usage }
        }
      }
    } finally {
      // Leaving early (stalled, failed or stopped): close the connection.
      if (!completed) stuck.abort()
    }
  }
}
