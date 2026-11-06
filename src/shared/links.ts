/** Only destinations a user can open from rendered conversation text. */
export function externalUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return
  const text = value.trim()
  if (!text || /[\x00-\x1f\x7f]/.test(text)) return
  try {
    const url = new URL(text)
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.hostname && !url.username && !url.password) return url.href
    } else if (url.protocol === 'mailto:') {
      const recipients = decodeURIComponent(url.pathname).split(',')
      if (recipients.length && recipients.every(email => /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email))) return url.href
    }
  } catch { /* An incomplete streamed URL remains readable text. */ }
}
