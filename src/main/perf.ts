import { promises as fs } from 'node:fs'
import type { AssistKind, PlanUsage, SpeechApiId } from '@shared/types'
import type { Usage } from './providers/types'

export type AutoDismissal = 'quiet' | 'answered' | 'superseded' | 'stopped'

/**
 * One answer's timeline in milliseconds, counted from the caller's last word for an automatic suggestion, and
 * from when it was asked otherwise (a typed question, a hotkey).
 */
export interface AnswerTiming {
  at: string
  kind: AssistKind
  auto: boolean
  /** Automatic work kept off screen; older logs and visible answers omit this. */
  dismissed?: AutoDismissal
  from: 'speech' | 'asked'
  /** Started at their pause, before the end of speech was confirmed. */
  atPause: boolean
  /** Answers this call showed before this one (0 for its first). */
  nthInCall: number
  model?: string
  effort?: string
  fast?: boolean
  /**
   * Reply preparation started, the model's first text came back, words appeared, and the answer finished streaming:
   * one started at the pause can finish before the final transcript lets it show.
   */
  request: number
  /** The provider was called after local context and images were ready. Older logs omit this. */
  providerStarted?: number
  modelText?: number
  shown?: number
  done?: number
  deep?: { start: number; firstText?: number; done?: number }
  tokens?: { input: number; cached: number; output: number; reasoning: number }
  secondCopy?: boolean
  error?: boolean
}

/** One finished utterance: who transcribed it and how long that took. */
export interface HeardTiming {
  at: string
  /** This PC's recognizers, or the speech API picked for the side. */
  by: 'parakeet' | 'whisper' | SpeechApiId
  noisy: boolean
  seconds: number
  ms: number
}

// Past this size the oldest lines go, so the log stays small.
const MAX_BYTES = 2_000_000
const KEEP_LINES = 5_000

/**
 * Timings of answers and transcripts, never their words, appended to a file in Togle's data folder so real
 * calls can be measured (npm run perf).
 */
export class PerfLog {
  private queue: string[] = []
  private writing = false
  private lastPlan = ''

  constructor(private file: string) {}

  /** The ChatGPT plan's usage each time it moves, so what calls cost of its limits can be read off. */
  plan(usage: PlanUsage): void {
    const windows = usage.windows.map((w) => ({ minutes: w.minutes, used: w.usedPercent }))
    const limited = !!usage.limitedUntil
    const key = JSON.stringify([windows, limited])
    if (key === this.lastPlan) return
    this.lastPlan = key
    this.add({ type: 'plan', at: new Date().toISOString(), windows, limited })
  }

  answer(timing: AnswerTiming): void {
    this.add({ type: 'answer', ...timing })
  }

  heard(timing: HeardTiming): void {
    this.add({ type: 'heard', ...timing })
  }

  /** Every request to the model as it ends (answers, frame descriptions, notes, reviews), stopped ones too. */
  request(u: Usage): void {
    const { lane, model, input, cached, output, reasoning, rounds, hedged, end } = u
    this.add({ type: 'request', at: new Date().toISOString(), lane, model, input, cached, output, reasoning, rounds, hedged, end, ms: Math.round(u.ms), ...(u.firstTextMs === undefined ? {} : { firstTextMs: Math.round(u.firstTextMs) }), ...(u.phases ? { phases: Object.fromEntries(Object.entries(u.phases).map(([key, value]) => [key, Math.round(value)])) } : {}) })
  }

  private add(record: object): void {
    this.queue.push(JSON.stringify(record))
    void this.flush()
  }

  private async flush(): Promise<void> {
    if (this.writing) return
    this.writing = true
    try {
      while (this.queue.length) await fs.appendFile(this.file, `${this.queue.splice(0).join('\n')}\n`)
      if ((await fs.stat(this.file)).size > MAX_BYTES) {
        const lines = (await fs.readFile(this.file, 'utf8')).trim().split('\n')
        await fs.writeFile(this.file, `${lines.slice(-KEEP_LINES).join('\n')}\n`)
      }
    } catch (err) {
      console.warn('[perf]', (err as Error).message)
    } finally {
      this.writing = false
    }
  }
}
