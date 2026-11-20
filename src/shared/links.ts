/** Destinations Togle can hand to a browser or email client. */
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

/** Absolute paths in agent Markdown, including the /C:/ form used by Codex. */
export function localFilePath(value: unknown, platform: string): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/.test(value)) return
  let file = value
  if (/^file:/i.test(file)) {
    if (!/^file:\/\//i.test(file)) return
    try {
      const url = new URL(file)
      if (url.host || url.search) return
      file = decodeURIComponent(url.pathname)
    } catch { return }
  } else {
    // Native Markdown paths can contain a literal percent sign or URL-escaped spaces.
    try { file = decodeURIComponent(file) } catch { /* Keep the literal path. */ }
  }
  if (/[\x00-\x1f\x7f]/.test(file) || /^[\\/]{2}/.test(file)) return
  if (platform === 'win32') {
    file = file.replace(/^\/(?=[A-Za-z]:[\\/])/, '').replaceAll('/', '\\')
    // A source link may end in :line or :line:column. Other colons are not file names on Windows.
    file = file.replace(/:\d+(?::\d+)?$/, '')
    if (!/^[A-Za-z]:\\/.test(file) || /[<>:"|?*]/.test(file.slice(2))) return
    if (file.slice(3).split('\\').some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return
    return file
  }
  if (file.startsWith('/') && !/^\/[A-Za-z]:[\\/]/.test(file)) return file
}
