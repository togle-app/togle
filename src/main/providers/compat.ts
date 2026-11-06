import { net } from 'electron'
import type { ModelOption, Settings } from '@shared/types'
import { getSettings } from '../settings'
import { readSecret, writeSecret } from '../storage'
import { errorText, howItEnded, readSse } from './sse'
import { runTool } from './tools'
import type { CompletionInput, LLMProvider, StreamOptions, Tool, Usage } from './types'

const KEY_FILE = 'compat-api-key.bin'

/** A tool call as the stream gives it, in pieces: the name, then the arguments' JSON a few characters at a time. */
interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** The server or model turned down being given tools (Ollama: "does not support tools"). */
class ToolsRefused extends Error {}

/** Whether an error says the model can't take tools; not one that only names them, like a prompt too long with them. */
const refusesTools = (text: string): boolean =>
  /\btools?\b|function/i.test(text) && !/context|too long|too many tokens|reduce the length/i.test(text)

const THINK = '<think>'
const THOUGHT = '</think>'
// A server that took the request but doesn't answer: a model on this PC can take this long to load on its first
// request; once it streams, this long without a word is stuck. ChatGPT's and Claude's have their own.
const HEADERS_TIMEOUT_MS = 60_000
const STALL_TIMEOUT_MS = 30_000

/** A request the server turned down, in words for the window; what it said goes to the log (an HTML error page, ids). */
function turnedDown(status: number, text: string): Error {
  console.warn(`[compat] ${status}: ${text.slice(0, 500)}`)
  if (status === 401 || status === 403) return new Error(`The AI service turned down the API key (${status}). Check it in Settings.`)
  if (status === 429) return new Error('The AI service is at its limit right now. Try again in a moment.')
  if (status >= 500) return new Error('The AI service had a problem. Try again.')
  const said = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return new Error(`The AI service turned the request down (${status})${said ? `: ${said.slice(0, 200)}` : '.'}`)
}

/**
 * Passes on the answer text without the thinking a reasoning model writes before it (`<think>…</think>`, as DeepSeek R1
 * and Qwen 3 do on servers that don't set it apart), which arrives a few characters at a time like the rest.
 */
function withoutThinking(onDelta: (text: string) => void): { write: (text: string) => void; end: () => void } {
  let state: 'start' | 'thinking' | 'answer' = 'start'
  let held = ''
  return {
    write: (text) => {
      if (state === 'answer') return onDelta(text)
      held += text
      if (state === 'start') {
        const lead = held.trimStart()
        // Still possibly the start of the tag.
        if (THINK.startsWith(lead)) return
        if (!lead.startsWith(THINK)) {
          state = 'answer'
          return onDelta(held)
        }
        state = 'thinking'
      }
      const end = held.indexOf(THOUGHT)
      if (end < 0) {
        // Enough to find the closing tag when it comes split.
        held = held.slice(-THOUGHT.length)
        return
      }
      state = 'answer'
      const rest = held.slice(end + THOUGHT.length).trimStart()
      held = ''
      if (rest) onDelta(rest)
    },
    // An answer that ended as what could have been the tag's start ("<").
    end: () => {
      if (state === 'start' && held.trim()) onDelta(held)
    }
  }
}

/**
 * Any OpenAI-compatible Chat Completions endpoint: OpenAI API, OpenRouter, Anthropic's compatibility
 * endpoint, Groq, Ollama, LM Studio... Local servers work without an API key.
 */
export class CompatProvider implements LLMProvider {
  constructor(private config: () => Settings['compat'] = () => getSettings().compat, private keyFile = KEY_FILE) {}
  readonly id = 'compat'
  onUsage?: (usage: Usage) => void
  private apiKey: string | null = null
  private keyRevision = 0
  identity(): number { return this.keyRevision }
  pinned(): CompatProvider {
    const config = structuredClone(this.config())
    const provider = new CompatProvider(() => config, this.keyFile)
    provider.apiKey = this.apiKey; provider.onUsage = this.onUsage
    return provider
  }
  /** The server (by its address) that turned down being asked for each request's tokens. */
  private usageRefusedBy: string | null = null
  /** The servers and models ("<address> <model>") that turned down tools: asked without them from then on. */
  private toolsRefusedBy = new Set<string>()
  /**
   * The servers and models that call tools when told to answer (Ollama doesn't take tool_choice): their last round
   * lists none.
   */
  private answerRefusedBy = new Set<string>()

  /**
   * Lookups (knowledge, code) and Train go through the server's function calling, until this server and model turn
   * tools down: then answers come from what the prompt holds, and Train, which can't do without, says so.
   */
  get supportsTools(): boolean {
    const { baseUrl, model } = this.config()
    return !this.toolsRefusedBy.has(`${baseUrl} ${model}`)
  }

  async load(): Promise<void> {
    this.apiKey = await readSecret<string>(this.keyFile)
  }

  hasApiKey(): boolean {
    return !!this.apiKey
  }

  async setApiKey(key: string): Promise<void> {
    this.keyRevision++
    this.apiKey = key.trim() || null
    await writeSecret(this.keyFile, this.apiKey)
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      // OpenRouter attribution headers; ignored elsewhere.
      'HTTP-Referer': 'https://github.com/togle-app/togle',
      'X-Title': 'Togle'
    }
  }

  private url(path: string): string {
    return this.config().baseUrl.replace(/\/+$/, '') + path
  }

  async listModels(): Promise<ModelOption[]> {
    const res = await net.fetch(this.url('/models'), { headers: this.headers(), signal: AbortSignal.timeout(10_000) })
    if (!res.ok) throw new Error(`Could not list models (${res.status}): ${await errorText(res)}`)
    const data = (await res.json()) as { data?: { id: string; name?: string }[] }
    return (data.data ?? []).map((m) => ({ id: m.id, label: m.name ?? m.id })).sort((a, b) => a.id.localeCompare(b.id))
  }

  /**
   * Streams the answer. With tools, the model may call them first: their results go back in the next request,
   * and on the last allowed round it's told to answer instead.
   */
  async stream(input: CompletionInput, { signal, onDelta, onToolCall, onAccepted, onUsage }: StreamOptions): Promise<void> {
    const { baseUrl } = this.config(), model = input.model || this.config().model
    if (!model) throw new Error('Pick a model first, in Settings.')
    const where = `${baseUrl} ${model}`
    // Said as Train says it when a model has no tools at all: one message, whichever finds out first.
    const refused = (): Error => new Error("This model can't change your agent, so I can't learn from what you tell me. Pick another in Settings → AI: your ChatGPT plan or a Claude API key both work.")
    if (input.toolsRequired && this.toolsRefusedBy.has(where)) throw refused()
    let tools = this.toolsRefusedBy.has(where) ? [] : (input.tools ?? [])
    const maxRounds = input.maxToolRounds ?? 2
    const started = performance.now()
    const used: Usage = { lane: input.lane, model, input: 0, cached: 0, output: 0, reasoning: 0, rounds: 0, ms: 0, end: 'done' }
    const text = (delta: string): void => {
      used.firstTextMs ??= performance.now() - started
      onDelta(delta)
    }
    const userContent = input.images?.length
      ? [
          { type: 'text', text: input.user },
          ...input.images.flatMap((img) => [
            ...(img.label ? [{ type: 'text', text: img.label }] : []),
            { type: 'image_url', image_url: { url: img.url } }
          ])
        ]
      : input.user
    const messages: unknown[] = [
      { role: 'system', content: input.system },
      ...(input.history ?? []).map((turn) => ({ role: turn.role, content: turn.text })),
      { role: 'user', content: userContent }
    ]
    try {
      for (let round = 0; ; round++) {
        const last = round >= maxRounds
        const ask = (listed: Tool[]): Promise<{ text: string; calls: ToolCall[] }> =>
          this.request(messages, listed, last, model, signal, text, used, round === 0 ? onAccepted : undefined)
        let result: { text: string; calls: ToolCall[] }
        try {
          result = await ask(last && this.answerRefusedBy.has(where) ? [] : tools)
        } catch (err) {
          if (!(err instanceof ToolsRefused)) throw err
          this.toolsRefusedBy.add(where)
          if (input.toolsRequired) throw refused()
          tools = []
          result = await ask(tools)
        }
        if (!result.calls.length) return
        if (last) {
          // Told to answer, it looked something up instead: asked again with no tools listed, it can only answer.
          if (result.text.trim()) return
          this.answerRefusedBy.add(where)
          await ask([])
          return
        }
        messages.push({
          role: 'assistant',
          // Only the calls: an empty text is no text (some servers turn down an empty message).
          content: result.text || null,
          tool_calls: result.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments || '{}' } }))
        })
        for (const call of result.calls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.arguments || '{}')
          } catch {
            // Left empty; the tool says what's missing.
          }
          signal.throwIfAborted()
          onToolCall?.(call.name, args)
          messages.push({ role: 'tool', tool_call_id: call.id, content: (await runTool(tools, call.name, args)).text })
        }
      }
    } catch (err) {
      used.end = howItEnded(signal)
      throw err
    } finally {
      used.ms = performance.now() - started
      this.onUsage?.(used)
      if (used.rounds) onUsage?.(used)
    }
  }

  /**
   * One streamed request (`last`: tools are listed, but it has to answer). What it cost goes into `used` when the
   * server says (many send it with the last chunk).
   */
  private async request(
    messages: unknown[],
    tools: Tool[],
    last: boolean,
    model: string,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    used: Usage,
    onAccepted?: () => void
  ): Promise<{ text: string; calls: ToolCall[] }> {
    // Stopped by Togle when the server takes too long, apart from a stop asked for (a newer question, Stop).
    const late = new AbortController()
    let timer = setTimeout(() => late.abort(), HEADERS_TIMEOUT_MS)
    try {
      return await this.answer(messages, tools, last, model, AbortSignal.any([signal, late.signal]), onDelta, used, onAccepted, () => {
        clearTimeout(timer)
        timer = setTimeout(() => late.abort(), STALL_TIMEOUT_MS)
      })
    } catch (err) {
      if (late.signal.aborted && !signal.aborted) throw new Error("The AI didn't answer in time. Try again.")
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  /** The request itself; `alive` is told as the server answers and with each piece it sends. */
  private async answer(
    messages: unknown[],
    tools: Tool[],
    last: boolean,
    model: string,
    signal: AbortSignal,
    onDelta: (text: string) => void,
    used: Usage,
    onAccepted: (() => void) | undefined,
    alive: () => void
  ): Promise<{ text: string; calls: ToolCall[] }> {
    const send = (withUsage: boolean): Promise<Response> =>
      net.fetch(this.url('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model,
          stream: true,
          // OpenAI's API reports a streamed request's tokens only when asked.
          ...(withUsage ? { stream_options: { include_usage: true } } : {}),
          messages,
          ...(tools.length
            ? {
                tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })),
                tool_choice: last ? 'none' : 'auto'
              }
            : {})
        }),
        signal
      })
    const server = this.config().baseUrl
    const askUsage = this.usageRefusedBy !== server
    let res = await send(askUsage)
    if ((res.status === 400 || res.status === 422) && askUsage) {
      const text = await errorText(res)
      if (/stream_options|include_usage/i.test(text)) {
        // A server that doesn't know the option: from now on it's asked without it.
        this.usageRefusedBy = server
        res = await send(false)
      } else if (tools.length && refusesTools(text)) throw new ToolsRefused(text)
      else throw turnedDown(res.status, text)
    }
    if (!res.ok || !res.body) {
      const text = await errorText(res)
      if (tools.length && [400, 404, 422].includes(res.status) && refusesTools(text)) throw new ToolsRefused(text)
      throw turnedDown(res.status, text)
    }
    alive()
    onAccepted?.()

    let written = ''
    const answer = withoutThinking((text) => {
      written += text
      onDelta(text)
    })
    const calls: ToolCall[] = []
    for await (const event of readSse(res.body)) {
      alive()
      if (event.error) throw new Error(event.error.message ?? 'Stream error')
      const delta = event.choices?.[0]?.delta
      if (delta?.content) answer.write(delta.content)
      for (const piece of delta?.tool_calls ?? []) {
        // Most servers number the calls; one that doesn't starts a new call with each id.
        const at = piece.index ?? (piece.id || !calls.length ? calls.length : calls.length - 1)
        const call = (calls[at] ??= { id: '', name: '', arguments: '' })
        if (piece.id) call.id = piece.id
        if (piece.function?.name) call.name += piece.function.name
        if (piece.function?.arguments) call.arguments += piece.function.arguments
      }
      if (event.usage) {
        used.rounds++
        used.input += event.usage.prompt_tokens ?? 0
        used.cached += event.usage.prompt_tokens_details?.cached_tokens ?? 0
        used.output += event.usage.completion_tokens ?? 0
        used.reasoning += event.usage.completion_tokens_details?.reasoning_tokens ?? 0
      }
    }
    answer.end()
    // A call the server gave no id still needs one, to pair it with its result.
    calls.forEach((call, i) => (call.id ||= `call_${messages.length}_${i}`))
    return { text: written, calls: calls.filter((call) => call.name) }
  }
}
