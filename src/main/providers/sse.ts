/** Yields the JSON payload of each `data:` line in a Server-Sent Events response body. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trimEnd()
      buffer = buffer.slice(newline + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data)
      } catch {
        // Ignore keep-alives and partial garbage; the stream will continue.
      }
    }
  }
}

export async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  try {
    const json = JSON.parse(text)
    const message = json.error?.message ?? json.detail?.message ?? json.detail ?? json.message ?? text
    return typeof message === 'string' ? message : JSON.stringify(message)
  } catch {
    return text.slice(0, 500) || res.statusText
  }
}

/**
 * How a request that threw ended: stopped by whoever asked, because it wasn't needed any more, or failed. A
 * caller's own time limit (AbortSignal.timeout) running out is a failure.
 */
export function howItEnded(signal: AbortSignal): 'stopped' | 'failed' {
  return signal.aborted && (signal.reason as Error | undefined)?.name !== 'TimeoutError' ? 'stopped' : 'failed'
}
