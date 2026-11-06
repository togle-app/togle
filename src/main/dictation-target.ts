import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readFileSync } from 'node:fs'
import type { DictationInsertion, DictationTarget } from '@shared/dictation'

/** UI Automation runs outside Electron so a slow application cannot block a call or the UI. */
export class DictationTargetBridge {
  private child?: ChildProcessWithoutNullStreams
  private ready?: Promise<void>
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>()
  private sequence = 0
  constructor(private script: string) {}
  start(): Promise<void> {
    if (process.platform !== 'win32') return Promise.resolve()
    if (this.ready) return this.ready
    const preparing = new Promise<void>((resolve, reject) => {
      let buffer = '', ready = false
      const child = this.child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-Command', readFileSync(this.script, 'utf8')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const timer = setTimeout(() => { reject(new Error('Text insertion is taking too long to start.')); this.stop() }, 12_000)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > 100_000) { this.stop(); return }
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1)
          try {
            const reply = JSON.parse(line)
            if (reply.ready) { ready = true; clearTimeout(timer); resolve(); continue }
            const pending = this.pending.get(reply.id)
            if (!pending) continue
            clearTimeout(pending.timer); this.pending.delete(reply.id)
            if (reply.error) pending.reject(new Error(String(reply.error)))
            else pending.resolve(reply.result)
          } catch { /* Shell startup noise is not protocol output. */ }
        }
      })
      child.stderr.resume()
      const ended = (): void => { clearTimeout(timer); if (!ready) reject(new Error('Automatic text insertion is unavailable.')); if (this.child === child) this.stop() }
      child.once('error', ended); child.once('exit', ended)
      child.stdin.on('error', ended)
    })
    this.ready = preparing
    void preparing.catch(() => { if (this.ready === preparing) this.ready = undefined })
    return preparing
  }
  private async request<T>(command: string, input: Record<string, unknown> = {}): Promise<T> {
    await this.start()
    if (!this.child?.stdin.writable) throw new Error('Automatic text insertion is unavailable.')
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The text box did not respond.')); this.stop() }, 3500)
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer })
      this.child?.stdin.write(JSON.stringify({ id, command, ...input }) + '\n')
    })
  }
  async capture(): Promise<DictationTarget> {
    if (process.platform !== 'win32') return { label: 'Your text box', reason: 'Copy your text when ready. Automatic insertion is currently available on Windows.' }
    try { return await this.request('capture') } catch { return { label: 'Your text box', reason: 'Automatic insertion is unavailable. Your text will be ready to copy.' } }
  }
  async insert(token: string, text: string): Promise<DictationInsertion> {
    // Paragraphs/tabs are literal paste text in editors, never synthesized keys.
    // The native bridge separately rejects them in terminals.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return { inserted: false, message: 'This text contains unsupported control characters.' }
    try { return await this.request('insert', { token, text }) }
    catch (error) { return { inserted: false, message: (error as Error).message || 'The text box did not respond. Your words are still available.' } }
  }
  stop(): void {
    const child = this.child; this.child = undefined; this.ready = undefined
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Text insertion stopped.')) }
    this.pending.clear(); child?.kill()
  }
}
