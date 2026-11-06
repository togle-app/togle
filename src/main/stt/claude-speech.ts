import WebSocket, { type ClientOptions } from 'ws'
import type { ClaudeSpeechAccess } from '../auth/claude-speech'
import { speechLanguageCode, speechLanguageProblem } from '@shared/speech'

export const CLAUDE_SPEECH_URL = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream'
type SocketFactory = (url: URL, options: ClientOptions) => WebSocket
const connectionProblem = 'Could not connect to Claude speech. Check your connection and try again.'
export interface ClaudeSpeechStream {
  push(pcm: Float32Array): void
  finish(): Promise<string>
  cancel(): void
}

export function claudeSpeechLanguage(value: string): string {
  const problem = speechLanguageProblem('claude', value)
  if (problem) throw new Error(problem)
  return speechLanguageCode(value)
}

export function claudeSpeechPcm(pcm: Float32Array): Buffer {
  if (!(pcm instanceof Float32Array) || pcm.length > 30 * 16000 || !pcm.every(Number.isFinite)) throw new Error('Claude speech received invalid audio. Start dictation again.')
  const bytes = Buffer.alloc(pcm.length * 2)
  for (let i = 0; i < pcm.length; i++) { const sample = Math.max(-1, Math.min(1, pcm[i])); bytes.writeInt16LE(Math.round(sample * (sample < 0 ? 32768 : 32767)), i * 2) }
  return bytes
}

/** Claude Code 2.1.312's account-backed speech protocol; separate from the Agent SDK text-model API. */
export class ClaudeSpeech {
  constructor(private access: Pick<ClaudeSpeechAccess, 'prepare' | 'token'>, private socket: SocketFactory = (url, options) => new WebSocket(url, options)) {}

  async prepare(language: string, email: string, signal: AbortSignal): Promise<(pcm: Float32Array, signal: AbortSignal) => Promise<string>> {
    const selected = claudeSpeechLanguage(language)
    const profile = await this.access.prepare(email, signal)
    signal.throwIfAborted()
    return async (pcm, signal) => {
      signal.throwIfAborted()
      const audio = claudeSpeechPcm(pcm)
      if (!audio.length) return ''
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(25_000)])
      const token = await this.access.token(profile, bounded)
      bounded.throwIfAborted()
      const stream = this.connect(selected, token, bounded)
      stream.write(audio)
      return stream.finish()
    }
  }

  /** A single account-pinned connection consumes audio as it is spoken, not after release. */
  async open(language: string, email: string, signal: AbortSignal): Promise<ClaudeSpeechStream> {
    const selected = claudeSpeechLanguage(language)
    const profile = await this.access.prepare(email, signal)
    const token = await this.access.token(profile, signal)
    signal.throwIfAborted()
    const stream = this.connect(selected, token, signal)
    return { push: pcm => stream.write(claudeSpeechPcm(pcm)), finish: stream.finish, cancel: stream.cancel }
  }

  private connect(language: string, token: string, signal: AbortSignal): { write(audio: Buffer): void; finish(): Promise<string>; cancel(): void } {
    signal.throwIfAborted()
    const url = new URL(CLAUDE_SPEECH_URL)
    url.search = new URLSearchParams({ encoding: 'linear16', sample_rate: '16000', channels: '1', endpointing_ms: '300', utterance_end_ms: '1000', language, use_conversation_engine: 'true' }).toString()
    let write!: (audio: Buffer) => void, end!: () => void, cancel!: () => void
    const result = new Promise<string>((resolve, reject) => {
      let socket: WebSocket, settled = false, opened = false, ending = false, sent = false, pending = '', length = 0, bytes = 0
      let failure: Error | undefined, deadline: NodeJS.Timeout | undefined, keepalive: NodeJS.Timeout | undefined
      const buffered: Buffer[] = []
      const parts: string[] = []
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true; failure = error; buffered.length = 0
        clearTimeout(deadline); clearInterval(keepalive); signal.removeEventListener('abort', abort)
        if (socket) {
          socket.removeAllListeners(); socket.on('error', () => {})
          socket.terminate()
        }
        if (error) reject(error)
        else { if (pending.trim()) parts.push(pending.trim()); resolve(parts.join(' ')) }
      }
      const abort = (): void => finish(signal.reason instanceof Error ? signal.reason : new Error('Dictation cancelled.'))
      cancel = () => finish(new Error('Dictation cancelled.'))
      const sendAudio = (audio: Buffer): void => {
        if (socket.bufferedAmount > 512 * 1024) throw new Error('Claude speech could not keep up. Check your connection and try again.')
        for (let offset = 0; offset < audio.length; offset += 3200) socket.send(audio.subarray(offset, offset + 3200))
      }
      const closeStream = (): void => {
        if (sent || !opened || settled) return
        sent = true
        try { socket.send(JSON.stringify({ type: 'CloseStream' }), error => { if (error) finish(new Error(connectionProblem)) }) }
        catch { finish(new Error(connectionProblem)) }
      }
      write = audio => {
        signal.throwIfAborted()
        if (failure) throw failure
        if (settled || ending) throw new Error('The recording has already finished.')
        bytes += audio.length
        if (bytes > 125 * 16000 * 2) { const error = new Error('Dictation is too long. Try a shorter phrase.'); finish(error); throw error }
        if (!audio.length) return
        try { if (opened) sendAudio(audio); else buffered.push(audio) }
        catch (error) { finish(error as Error); throw error }
      }
      end = () => {
        if (ending || settled) return
        ending = true; clearInterval(keepalive)
        deadline = setTimeout(() => finish(new Error('Claude speech took too long to finish. Try again.')), 25_000)
        deadline.unref?.(); closeStream()
      }
      try {
        socket = this.socket(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'togle/0.1.0', 'x-app': 'cli', 'anthropic-client-platform': process.platform === 'win32' ? 'windows' : process.platform }, followRedirects: false, perMessageDeflate: false, handshakeTimeout: 10_000, maxPayload: 256 * 1024 })
      } catch { finish(new Error(connectionProblem)); return }
      signal.addEventListener('abort', abort, { once: true })
      socket.on('open', () => {
        if (signal.aborted || settled) { abort(); return }
        try {
          opened = true
          socket.send(JSON.stringify({ type: 'KeepAlive' }))
          for (const audio of buffered) sendAudio(audio)
          buffered.length = 0
          if (ending) closeStream()
          else {
            keepalive = setInterval(() => {
              try { socket.send(JSON.stringify({ type: 'KeepAlive' })) } catch { finish(new Error(connectionProblem)) }
            }, 5000)
            keepalive.unref?.()
          }
        } catch { finish(new Error(connectionProblem)) }
      })
      socket.on('message', (data, binary) => {
        if (settled) return
        let frame: { type?: string; data?: unknown }
        try { if (binary) throw new Error(); frame = JSON.parse(data.toString()) } catch { finish(new Error('Claude speech returned an unreadable response. Try again.')); return }
        if (!frame || typeof frame !== 'object') { finish(new Error('Claude speech returned an unreadable response. Try again.')); return }
        if (frame.type === 'TranscriptText' || frame.type === 'TranscriptInterim') {
          if (typeof frame.data !== 'string' || length + frame.data.length > 16_000) { finish(new Error('Claude speech returned an invalid transcript. Try a shorter phrase.')); return }
          pending = frame.data
        } else if (frame.type === 'TranscriptEndpoint') {
          if (pending.trim()) { parts.push(pending.trim()); length += pending.length; pending = '' }
          // An endpoint completes one utterance. Later utterances can still follow in the same audio clip.
        } else if (frame.type === 'TranscriptError' || frame.type === 'error') finish(new Error('Claude could not transcribe this recording. Try again.'))
      })
      socket.on('unexpected-response', (request, response) => {
        response.resume(); request.destroy()
        const status = response.statusCode
        finish(Object.assign(new Error(status === 401 ? 'Claude speech rejected your sign-in. Sign in again in Settings.' : status === 403 ? 'Claude speech is not available for this account or workspace.' : status === 429 ? 'Claude speech is busy or at its limit. Try again shortly.' : connectionProblem), { status }))
      })
      socket.on('error', () => finish(new Error(connectionProblem)))
      socket.on('close', code => {
        if (sent && (code === 1000 || code === 1005)) finish()
        else finish(new Error('The Claude speech connection ended before the recording finished. Try again.'))
      })
      if (signal.aborted) abort()
    })
    // A server failure can precede F9 release. Keep the rejection handled until
    // the next audio frame or finish call reports it to the active dictation.
    void result.catch(() => {})
    return { write, finish: () => { end(); return result }, cancel }
  }
}
