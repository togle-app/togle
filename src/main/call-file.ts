import type { CallAnswer, CallSessionInfo, CallView, Frame, TranscriptEntry } from '@shared/types'
import { canStoreSecrets, readSecret, writeSecret, writeSecretSync } from './storage'

const FILE = 'call.bin'
// Saved this long after the call last changed, and at least this often while it keeps changing: a crash
// loses a few seconds of it at most.
const SAVE_DELAY_MS = 2000
const SAVE_EVERY_MS = 10_000
// An older call isn't picked up again: its pictures are deleted after as long (frames.ts).
const KEEP_MS = 3 * 24 * 3600_000
// A save that failed (the file held by another program, a full disk) is tried again this long after.
const RETRY_MS = 5_000

/** What the copilot keeps of a call, to pick it up again. */
export interface CallState {
  transcript: TranscriptEntry[]
  frames: Frame[]
  notes: string
  notesUntil: number
  answeredUntil: number
  callAnswers: (CallAnswer & { reviewed: boolean })[]
  /** What the call is, in the user's words (saved by later versions; older saves have none). */
  brief?: string
  /** When the brief was told (older saves don't say). */
  briefAt?: number
  /** A call with several people (see Copilot.setGroup). */
  group?: boolean
  /** The frames still waiting for a description (ids), to be described when the call is picked up again. */
  undescribed?: string[]
}

export interface SavedCall {
  version: 1
  savedAt: number
  /** The folder of the call's pictures (frames.ts). */
  frameSession: string
  state: CallState
  view?: CallView
  session?: CallSessionInfo
}

/**
 * The call so far, saved as it goes and encrypted like the ChatGPT sign-in, so closing Togle, a crash or a
 * restart loses neither the call nor what its review would teach the agent. Clearing the call deletes it.
 */
export class CallFile {
  private timer: NodeJS.Timeout | null = null
  /** When the oldest change not saved yet happened (0: everything is saved). */
  private dirtySince = 0
  /** When the call last changed: what the saved call says it's from, and what its 3 days count from. */
  private changedAt = 0
  private writes: Promise<void> = Promise.resolve()
  /** Saves still being written. */
  private inFlight = 0
  private savedView: CallView | undefined
  private warned = false

  /** `current` gives the call to save, or null when there's nothing in it (told whether the window has cards). */
  constructor(
    private current: (hasCards: boolean) => { frameSession: string; state: CallState; session?: CallSessionInfo } | null,
    private onSaved?: (saved: SavedCall) => Promise<void>
  ) {}

  /** Whether a change is waiting to be saved, or still being written. */
  get pending(): boolean {
    return this.dirtySince > 0 || this.inFlight > 0
  }

  /** The window's part of the call, as last saved or told. */
  get view(): CallView | undefined {
    return this.savedView
  }

  /** The call changed: it's saved shortly. */
  changed(): void {
    const now = Date.now()
    this.dirtySince ||= now
    this.changedAt = now
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(SAVE_DELAY_MS, this.dirtySince + SAVE_EVERY_MS - now))
    this.timer = setTimeout(() => void this.flush(), wait)
  }

  /** The window's part of the call changed. */
  setView(view: CallView): void {
    // The same cards again (the window showing what was picked up) are no change to the call.
    if (JSON.stringify(view) === JSON.stringify(this.savedView)) return
    this.savedView = view
    this.changed()
  }

  /** Saves now what's waiting to be saved. */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.dirtySince) return this.writes
    this.dirtySince = 0
    return this.queue(this.saved())
  }

  /** Saves now what's waiting, all at once: Windows is shutting down and won't wait. */
  flushSync(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    // A save still being written may not get to its end before Windows stops Togle: the call is written here too.
    if (!this.dirtySince && !this.inFlight) return
    this.dirtySince = 0
    const saved = this.saved()
    try {
      writeSecretSync(FILE, saved)
    } catch (err) {
      console.warn('[call] could not save the call:', (err as Error).message)
    }
    // One still being written ends after this one, with what the call was before: this one goes again after it.
    if (this.inFlight) void this.queue(saved)
  }

  private saved(): SavedCall | null {
    const call = this.current(!!this.savedView?.cards.length)
    return call && { version: 1, savedAt: this.changedAt || Date.now(), ...call, view: this.savedView }
  }

  private queue(saved: SavedCall | null): Promise<void> {
    this.inFlight++
    this.writes = this.writes.then(() => this.write(saved)).finally(() => this.inFlight--)
    return this.writes
  }

  /**
   * A new call: `forget` empties the call in memory, which it does at once, before it waits on anything (the
   * copilot's clear() then deletes the pictures, which takes a while); then the saved call is deleted. So nothing
   * saved meanwhile (Windows shutting down) can bring the cleared call back.
   */
  async clear(forget: () => Promise<void> = async () => {}): Promise<void> {
    const forgetting = forget()
    // Its error comes from the await below, once the saved call is deleted.
    forgetting.catch(() => undefined)
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.dirtySince = 0
    this.changedAt = 0
    this.savedView = undefined
    await this.queue(null)
    await forgetting
  }

  /** The call that was open when Togle last closed, if it's recent enough to pick up. */
  async load(): Promise<SavedCall | null> {
    const saved = await readSecret<SavedCall>(FILE)
    if (!saved || saved.version !== 1 || Date.now() - saved.savedAt > KEEP_MS) return null
    this.savedView = saved.view
    this.changedAt = saved.savedAt
    return saved
  }

  private async write(saved: SavedCall | null): Promise<void> {
    try {
      await writeSecret(FILE, saved)
      if (saved) await this.onSaved?.(saved)
    } catch (err) {
      if (!this.warned) console.warn('[call] could not save the call:', (err as Error).message)
      this.warned = true
      // Without the OS keystore the call isn't written in plain text: it's just not saved. Otherwise it's waiting to
      // be saved again, and tried again in a while (closing tries it once more).
      if (canStoreSecrets()) {
        this.dirtySince ||= Date.now()
        if (this.timer) clearTimeout(this.timer)
        this.timer = setTimeout(() => void this.flush(), RETRY_MS)
      }
    }
  }
}
