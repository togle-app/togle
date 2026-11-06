import { net } from 'electron'
import type { Speaker, SpeechApiId, SttStatus } from '@shared/types'
import { errorText } from '../providers/sse'
import { readSecret, writeSecret } from '../storage'
import { encodeWav } from './wav'
import { cleanTranscript, SAMPLE_RATE } from './whisper'

export const OPENAI_URL = 'https://api.openai.com/v1'
export const OPENAI_MODEL = 'gpt-transcribe'
// Past this a line has waited too long, and this PC hears it instead. A 30-second utterance is a megabyte to upload.
const REQUEST_TIMEOUT_MS = 20_000
// The words to spell right, as gpt-transcribe takes them (a list of hints): the most the vocabulary gives (600
// characters) stays well under this.
const MAX_KEYWORDS = 60
const MAX_KEYWORD_CHARS = 60
// The ChatGPT plan's dictation takes clips of a second or more (as Codex sends them): a shorter one is padded with
// silence. Codex also sends them at this peak level.
const PLAN_MIN_SAMPLES = SAMPLE_RATE
const PLAN_PEAK = 0.9
// Turned away for now (429) without a time to wait: this long before a line goes to it again.
const REST_MS = 60_000

/** Where a speech API sends clips. */
export interface SpeechTarget {
  /** Its OpenAI-compatible API, up to ".../v1". */
  baseUrl: string
  /** Empty for a server that has only one. */
  model: string
}

export interface HearOptions {
  dictation?: boolean
  signal?: AbortSignal
  /** The call's language (a Whisper code: "en", "hr"), or "auto". */
  language: string
  /** Names and jargon to spell right, comma-separated, as Whisper takes them. */
  vocabulary: string
}

/** The dictation of the ChatGPT plan Togle is signed in to: whether it is, and a clip's form sent with the sign-in. */
export interface PlanDictation {
  signedIn: () => boolean
  post?: (form: FormData, signal: AbortSignal) => Promise<Response>
  recognize?: (pcm: Float32Array, options: HearOptions) => Promise<string>
  missing?: () => string | null
}

/** gpt-transcribe (and what follows it) takes lists of languages and keywords; Whisper's API, and the servers that copy it, one language and a prompt. */
const takesKeywords = (model: string): boolean => /^gpt-transcribe/i.test(model.trim())

/** The words to spell right, one hint each, without what gpt-transcribe turns a whole request down for (<, >, a line break). */
export function keywordsOf(vocabulary: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of vocabulary.split(/[,\n]/)) {
    const word = part.replace(/[<>\r]/g, ' ').replace(/\s+/g, ' ').trim().replace(/\.$/, '')
    if (!word || word.length > MAX_KEYWORD_CHARS || seen.has(word.toLowerCase())) continue
    seen.add(word.toLowerCase())
    out.push(word)
    if (out.length === MAX_KEYWORDS) break
  }
  return out
}

/**
 * The form a clip is sent in, with the call's language and the words to spell right unless `hints` is off. A model left
 * empty is left out (a server with only one may not take a name).
 */
export function transcriptionForm(wav: Buffer, model: string, { language, vocabulary }: HearOptions, hints = true): FormData {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'clip.wav')
  if (model.trim()) form.append('model', model.trim())
  form.append('response_format', 'json')
  if (!hints) return form
  const known = !!language && language !== 'auto'
  if (takesKeywords(model)) {
    if (known) form.append('languages[]', language)
    for (const word of keywordsOf(vocabulary)) form.append('keywords[]', word)
  } else {
    if (known) form.append('language', language)
    if (vocabulary.trim()) form.append('prompt', vocabulary.trim())
  }
  return form
}

/** A clip as the ChatGPT plan's dictation takes it, the way Codex sends its own: the file alone, a second at least, at Codex's level. */
export function planForm(pcm: Float32Array): FormData {
  let peak = 0
  for (const x of pcm) peak = Math.max(peak, Math.abs(x))
  const gain = peak > 0 ? PLAN_PEAK / peak : 1
  const clip = new Float32Array(Math.max(pcm.length, PLAN_MIN_SAMPLES))
  for (let i = 0; i < pcm.length; i++) clip[i] = pcm[i] * gain
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(encodeWav(clip, SAMPLE_RATE))], { type: 'audio/wav' }), 'audio.wav')
  return form
}

const hostOf = (url: string): string => {
  try {
    return new URL(url.trim()).host
  } catch {
    return url.trim()
  }
}

/**
 * Hears a side of the call in place of this PC's models: through OpenAI's speech API (/audio/transcriptions), OpenAI's
 * own models or any server that speaks the same API (a model run on this PC with speaches, LocalAI or vLLM, or a
 * service's); or through the dictation of the ChatGPT plan Togle is signed in to. Each finished utterance goes as it
 * ends, in a request of its own.
 */
export class SpeechApi {
  private key: string | null = null
  /** The servers and models ("<address> <model>") that turned down the language or the words to spell: asked without them from then on. */
  private hintsRefusedBy = new Set<string>()
  /** Why it didn't hear the last line it was given; null once it hears one. */
  problem: string | null = null
  /**
   * It turned down what it was asked with (401: the key, or the sign-in; 403 from the ChatGPT plan, which shuts out a
   * client it won't serve): that won't change by itself, so no lines go to it until the key or what it's sent to does.
   */
  refused = false
  /** Turned away for now ("too many requests"): no lines go to it before then (epoch ms). */
  private restUntil = 0
  private restTimer: NodeJS.Timeout | undefined
  /** Called when it gets a problem, or no longer has one. */
  onChange: () => void = () => {}

  constructor(
    readonly id: SpeechApiId,
    private keyFile: string,
    private target: () => SpeechTarget,
    /** Subscription speech uses its account's sign-in rather than an API key. */
    private plan?: PlanDictation
  ) {}

  async load(): Promise<void> {
    if (!this.plan) this.key = await readSecret<string>(this.keyFile)
  }

  hasKey(): boolean {
    return !!this.key
  }
  pinned(target: SpeechTarget): SpeechApi {
    const snapshot = structuredClone(target), api = new SpeechApi(this.id, this.keyFile, () => snapshot, this.plan)
    api.key = this.key
    return api
  }

  async setKey(key: string): Promise<void> {
    // The ChatGPT plan's goes with the sign-in: there's no key of its own to keep.
    if (this.plan) return
    this.key = key.trim() || null
    await writeSecret(this.keyFile, this.key)
    // What it needs may be there now, and the last line may have been turned down for the old key: the window hears
    // of it either way.
    this.problem = null
    this.refused = false
    this.restUntil = 0
    this.onChange()
  }

  /**
   * What it needs before it can hear anything, in words ("an OpenAI API key"); null when it has it. OpenAI's needs a
   * key, a server only its address, the ChatGPT plan a sign-in.
   */
  missing(): string | null {
    if (this.plan) return !this.plan.signedIn() ? `a ${this.id === 'claude' ? 'Claude' : 'ChatGPT'} sign-in` : this.plan.missing?.() ?? null
    if (this.id === 'openai') return this.key ? null : 'an OpenAI API key'
    return /^https?:\/\/[^\s/]/i.test(this.target().baseUrl.trim()) ? null : "the speech server's address"
  }

  /** Whether lines can go to it now: it has what it needs, didn't turn it down, and isn't turning requests away for now. */
  canHear(): boolean {
    return !this.missing() && !this.refused && !this.restingUntil()
  }

  /** Until when it's turning requests away (epoch ms); 0 when it isn't. */
  restingUntil(): number {
    return Date.now() < this.restUntil ? this.restUntil : 0
  }

  /** What hears, as the window says it: "OpenAI gpt-transcribe", "whisper-large-v3 at localhost:8000". */
  label(): string {
    const { baseUrl, model } = this.target()
    if (this.plan) return this.id === 'claude' ? 'Claude speech' : "the ChatGPT plan's dictation"
    return this.id === 'openai' ? `OpenAI ${model}` : `${model.trim() || 'the speech server'} at ${hostOf(baseUrl)}`
  }

  /** Who it is, to begin a sentence with: "OpenAI". */
  who(): string {
    return this.plan ? this.id === 'claude' ? 'Claude' : 'ChatGPT' : this.id === 'openai' ? 'OpenAI' : 'The speech server'
  }

  /** Forgets why the last line wasn't heard, now that what it's sent to has changed. */
  reset(): void {
    this.refused = false
    this.restUntil = 0
    clearTimeout(this.restTimer)
    this.setProblem(null)
  }

  private setProblem(problem: string | null): void {
    if (problem === this.problem) return
    this.problem = problem
    this.onChange()
  }

  /** Why a request failed, in words: "it turned down the API key". */
  private reason(err: unknown, status?: number, text = ''): string {
    if (status === 401) return this.plan ? 'it turned down the sign-in' : 'it turned down the API key'
    // What chatgpt.com sends a client it won't serve is a web page, not a message.
    if (status === 403 && this.plan) return this.id === 'claude' ? 'Claude speech refused this account or workspace' : 'chatgpt.com turned the request down'
    if (status === 429) return /quota|billing|credit/i.test(text) ? 'the account has no credit left' : 'too many requests just now'
    if (status) return `it answered ${status}${text ? `: ${text.slice(0, 160)}` : ''}`
    const message = (err as Error).message ?? String(err)
    const host = hostOf(this.target().baseUrl)
    if ((err as Error).name === 'TimeoutError') return `no answer in ${REQUEST_TIMEOUT_MS / 1000} s`
    if (/CONNECTION_REFUSED|ECONNREFUSED/i.test(message)) return `nothing answers at ${host}`
    if (/NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ENOTFOUND|NETWORK_CHANGED|fetch failed|can't reach/i.test(message))
      return `couldn't reach ${host}`
    return message
  }

  /** The words of a finished utterance (empty when nothing was said). Rejects when it couldn't hear it, with why, which `problem` keeps. */
  async transcribe(pcm: Float32Array, options: HearOptions): Promise<string> {
    const lack = this.missing()
    if (lack) throw new Error(`It needs ${lack} first`)
    const { baseUrl, model } = this.target()
    const where = `${baseUrl} ${model}`
    const send = (hints: boolean): Promise<Response> => {
      const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
      if (this.plan?.post) return this.plan.post(planForm(pcm), signal)
      return net.fetch(`${baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: this.key ? { Authorization: `Bearer ${this.key}` } : {},
        body: transcriptionForm(encodeWav(pcm, SAMPLE_RATE), model, options, hints),
        signal
      })
    }
    let said: unknown
    try {
      if (this.plan?.recognize) {
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        said = await this.plan.recognize(pcm, { ...options, signal })
        signal.throwIfAborted()
        if (!this.plan.signedIn()) throw new Error('The speech account changed. Start a new call or dictation with the intended account.')
        this.refused = false; this.restUntil = 0; clearTimeout(this.restTimer)
        this.setProblem(null)
        return cleanTranscript(typeof said === 'string' ? said : '', pcm.length / SAMPLE_RATE, options.language, options.dictation)
      }
      // The plan's dictation takes the audio alone: no language, no words to spell.
      const hints = !this.plan && !this.hintsRefusedBy.has(where)
      let res = await send(hints)
      if (hints && (res.status === 400 || res.status === 422)) {
        const text = await errorText(res)
        if (!/keyword|prompt|language/i.test(text)) throw this.failed(undefined, res.status, text)
        // A language it doesn't know, or words it won't take: from now on it's asked without them.
        this.hintsRefusedBy.add(where)
        res = await send(false)
      }
      if (!res.ok) throw this.failed(undefined, res.status, await errorText(res), res.headers.get('retry-after'))
      said = (res.headers.get('content-type') ?? '').includes('json') ? ((await res.json()) as { text?: unknown }).text : await res.text()
      options.signal?.throwIfAborted()
      if (this.plan && !this.plan.signedIn()) throw new Error('The speech account changed. Start a new call or dictation with the intended account.')
    } catch (err) {
      if (options.signal?.aborted) throw options.signal.reason
      throw err instanceof HeardNothing ? err : this.failed(err, typeof (err as { status?: unknown })?.status === 'number' ? (err as { status: number }).status : undefined)
    }
    // Heard: whatever it turned down or turned away before is over.
    this.refused = false
    this.restUntil = 0
    clearTimeout(this.restTimer)
    this.setProblem(null)
    return cleanTranscript(typeof said === 'string' ? said : '', pcm.length / SAMPLE_RATE, options.language, options.dictation)
  }

  /** The error a line it couldn't hear rejects with; the window says why. */
  private failed(err: unknown, status?: number, text?: string, retryAfter?: string | null): HeardNothing {
    const reason = this.reason(err, status, text)
    if (status === 401 || (status === 403 && this.plan)) this.refused = true
    if (status === 429) this.rest(Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : REST_MS)
    this.setProblem(reason)
    return new HeardNothing(reason)
  }

  /** No lines go to it for a while; the window hears when that's over. */
  private rest(ms: number): void {
    this.restUntil = Date.now() + ms
    clearTimeout(this.restTimer)
    this.restTimer = setTimeout(() => this.onChange(), ms + 50)
    this.restTimer.unref?.()
  }
}

class HeardNothing extends Error {}

const SIDES: { speaker: Speaker; name: string }[] = [
  { speaker: 'me', name: 'your voice' },
  { speaker: 'them', name: 'other people' }
]

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

/** "14:05", for saying until when. */
const clock = (at: number): string => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * Speech recognition's state for the window, with the API picked to hear each side (null: this PC's models). A side
 * whose API lacks what it needs (a key, an address, a sign-in), turned it down, or is turning requests away for now is
 * heard on this PC meanwhile, and so is a line the API didn't hear: `problem` says which. Without this PC's models
 * (not installed, or stopped), `problem` says the side isn't heard, and an API that only lacks what it needs is
 * `needs`, for the window to ask for: nothing went wrong. When APIs that can hear both sides do, nothing waits on this
 * PC's models, which only caption then.
 */
export function hearingStatus(local: SttStatus, picked: Record<Speaker, SpeechApi | null>): SttStatus {
  const apis = [...new Set(SIDES.flatMap((s) => picked[s.speaker] ?? []))]
  if (!apis.length) return local
  // The API that hears a side, while it can; null while this PC does.
  const hearer = (speaker: Speaker): SpeechApi | null => {
    const api = picked[speaker]
    return api?.canHear() ? api : null
  }
  const state = SIDES.every((s) => hearer(s.speaker)) ? 'ready' : local.state
  const detail =
    state === 'ready'
      ? SIDES.map((s) => `${capital(s.name)}: ${hearer(s.speaker)?.label() ?? `this PC${local.detail ? ` (${local.detail})` : ''}`}`).join('. ')
      : local.detail
  const sides = (api: SpeechApi): string =>
    SIDES.filter((s) => picked[s.speaker] === api)
      .map((s) => s.name)
      .join(' and ')
  // Who hears an API's sides while it can't: this PC, when its models are there; else no one.
  const standIn = local.state === 'ready' || local.state === 'starting'
  const meanwhile = (api: SpeechApi): string =>
    standIn ? `this PC hears ${sides(api)}` : `Togle can't hear ${SIDES.every((s) => picked[s.speaker] === api) ? 'the call' : sides(api)}`
  let problem: string | undefined
  let needs: string | undefined
  const lacking = apis.find((api) => api.missing())
  const refused = apis.find((api) => api.refused)
  const resting = apis.find((api) => api.restingUntil())
  const failing = apis.find((api) => api.problem)
  if (lacking) {
    if (standIn) problem = `Add ${lacking.missing()} in Settings: until then ${meanwhile(lacking)}.`
    else needs = lacking.missing() ?? undefined
  } else if (refused) {
    problem =
      refused.id === 'chatgpt' || refused.id === 'claude'
        ? `${refused.who()}'s dictation turned Togle down (${refused.problem}): until you sign in again or pick it again in Settings, ${meanwhile(refused)}.`
        : refused.hasKey()
          ? `${refused.who()} turned down the API key: until there's another in Settings, ${meanwhile(refused)}.`
          : `${refused.who()} needs an API key: until there's one in Settings, ${meanwhile(refused)}.`
  } else if (resting) problem = `${resting.who()} is turning requests away for now: ${meanwhile(resting)} until ${clock(resting.restingUntil())}.`
  else if (failing) {
    problem = `${failing.who()} didn't hear a line: ${failing.problem}.`
    if (local.state === 'ready') problem += ' This PC heard it instead.'
  }
  return { state, ...(detail ? { detail } : {}), ...(problem ? { problem } : {}), ...(needs ? { needs } : {}) }
}
