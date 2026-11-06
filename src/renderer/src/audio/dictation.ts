import { Segmenter } from './capture'

export interface DictationMicrophone { name: string; muted: boolean }
interface CaptureOptions { deviceId?: string; microphone?: (state: DictationMicrophone) => void; streaming?: boolean; virtualDelay?: (label:string)=>Promise<number> }

export function microphoneProblem(error: unknown): string {
  const name = (error as Error)?.name
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'That microphone is disconnected or unavailable. Choose another microphone in Dictation settings.'
  if (name === 'NotReadableError') return 'The microphone is busy or unavailable. Check the device, then try again.'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access is blocked. Allow Togle to use the microphone in your system settings.'
  return 'Could not open your microphone. Check the device and microphone access, then try again.'
}

/** A bounded mic-only capture; the call's audio objects remain untouched. */
export class DictationCapture {
  private generation = 0
  private ctx?: AudioContext
  private stream?: MediaStream
  private tap?: AudioWorkletNode
  private input?: MediaStreamAudioSourceNode
  private segmenter?: Segmenter
  private liveFrames: Float32Array[] = []
  private liveSamples = 0
  private sendLive?: (pcm: Float32Array) => void
  private drained?: () => void
  private drainTimer?: ReturnType<typeof setTimeout>
  private tailTimer?: ReturnType<typeof setTimeout>
  private releaseTailMs = 0
  private virtualDelay?:CaptureOptions['virtualDelay']
  private sourceLabel=''
  private finishing?: Promise<void>
  private finishResolve?: () => void
  async start(chunk: (pcm: Float32Array) => void, failed: (message: string) => void, level?: (amplitude: number) => void, options: CaptureOptions = {}): Promise<void> {
    this.stop(false)
    this.finishing = undefined
    this.virtualDelay=options.virtualDelay
    const generation = ++this.generation
    const ctx = this.ctx = new AudioContext()
    try {
      await ctx.audioWorklet.addModule(new URL('pcm-tap.js', document.baseURI).href)
      if (generation !== this.generation) return
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
        ...(options.deviceId ? { deviceId: { exact: options.deviceId } } : {}) } })
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return }
      this.stream = stream
      const source = stream.getAudioTracks()[0]
      this.sourceLabel=source?.label||''
      // The virtual mic is intentionally delayed by its local noise processor.
      // Drain that audio on release so the last syllable isn't cut off.
      this.releaseTailMs = /\bTogle Microphone\b|\bBlackHole (?:2|16|64)ch\b|\bCABLE(?:-[A-D])? Output\b/i.test(source?.label || '') ? 90 : 0
      const segmenter = this.segmenter = options.streaming ? undefined : new Segmenter((pcm, _at, _id, kind) => { if (kind === 'final' && pcm.length) chunk(pcm) }, false, 160)
      this.sendLive = options.streaming ? chunk : undefined
      this.input = ctx.createMediaStreamSource(stream)
      const tap = this.tap = new AudioWorkletNode(ctx, 'pcm-tap')
      // Reuse the 32 ms PCM frames. No second microphone, analyser, IPC stream, or animation loop.
      tap.port.onmessage = (event: MessageEvent<Float32Array | { type: string }>) => {
        if (generation !== this.generation) return
        if (!(event.data instanceof Float32Array)) { if (event.data?.type === 'flushed') this.drained?.(); return }
        if (level) {
          let energy = 0
          for (const sample of event.data) energy += sample * sample
          const rms = Math.sqrt(energy / (event.data.length || 1))
          level(Number.isFinite(rms) ? Math.min(1, Math.max(0, (20 * Math.log10(Math.max(rms, 1e-6)) + 60) / 48)) : 0)
        }
        if (options.streaming) {
          this.liveFrames.push(event.data); this.liveSamples += event.data.length
          // Small batches keep latency below 128 ms without 31 IPC sends/second.
          if (this.liveSamples >= 2048) this.flushLive()
        } else segmenter!.push(event.data)
      }
      this.input.connect(tap); tap.connect(ctx.destination)
      for (const track of stream.getAudioTracks()) {
        const report = (): void => { if (generation === this.generation) options.microphone?.({ name: track.label || 'Microphone', muted: track.muted }) }
        track.onmute = report; track.onunmute = report; report()
        track.onended = () => { if (generation === this.generation) failed('Microphone disconnected. Reconnect it or choose another in Dictation settings.') }
      }
      await ctx.resume()
    } catch (error) { if (generation === this.generation) { this.stop(false); throw error } }
  }
  private flushLive(): void {
    if (!this.liveSamples) return
    const audio = new Float32Array(this.liveSamples)
    let at = 0
    for (const frame of this.liveFrames) { audio.set(frame, at); at += frame.length }
    this.liveFrames = []; this.liveSamples = 0
    this.sendLive?.(audio)
  }
  /** Drain the worklet's last partial frame before telling main that F9 is released. */
  finish(): Promise<void> {
    if (this.finishing) return this.finishing
    if (!this.tap?.port.postMessage) { this.stop(true); return Promise.resolve() }
    this.finishing = new Promise<void>(resolve => {
      this.finishResolve = resolve
      this.drained = () => this.stop(true)
      const flush = (): void => {
        this.drainTimer = setTimeout(() => this.drained?.(), 200)
        try { this.tap!.port.postMessage({ type: 'flush' }) } catch { this.drained?.() }
      }
      if(this.releaseTailMs && this.virtualDelay){
        const released=performance.now(),readDelay=this.virtualDelay,label=this.sourceLabel;let decided=false
        const schedule=(value:number):void=>{
          if(decided || this.finishResolve!==resolve)return
          decided=true;clearTimeout(this.tailTimer)
          const delay=Number.isFinite(value)?Math.max(0,Math.min(400,value)):220
          this.tailTimer=setTimeout(flush,Math.max(0,delay-(performance.now()-released)))
        }
        // Query only at release, and count query time inside the drain budget.
        this.tailTimer=setTimeout(()=>schedule(220),80)
        void Promise.resolve().then(()=>this.finishResolve===resolve?readDelay(label):220).then(schedule).catch(()=>schedule(220))
      }
      else if (this.releaseTailMs) this.tailTimer = setTimeout(flush, this.releaseTailMs)
      else flush()
    })
    return this.finishing
  }
  stop(flush: boolean): void {
    this.generation++
    if (flush) { this.segmenter?.flush(); this.flushLive() }
    this.liveFrames = []; this.liveSamples = 0; this.sendLive = undefined
    const finishResolve = this.finishResolve
    this.drained = undefined; this.finishResolve = undefined; clearTimeout(this.drainTimer); clearTimeout(this.tailTimer); this.releaseTailMs = 0
    this.virtualDelay=undefined;this.sourceLabel=''
    if (this.tap) { this.tap.port.onmessage = null; this.tap.disconnect() }
    this.input?.disconnect()
    this.stream?.getTracks().forEach(track => { track.onended = null; track.onmute = null; track.onunmute = null; track.stop() })
    void this.ctx?.close().catch(() => {})
    this.ctx = undefined; this.stream = undefined; this.tap = undefined; this.input = undefined; this.segmenter = undefined
    // Cancellation also releases an awaiting finish; the job id guards its late acknowledgement.
    finishResolve?.()
  }
}
