import { BrowserWindow, type Session } from 'electron'

export interface WebPage {
  url: string
  title: string
  text: string
}

const PAGE_TIMEOUT_MS = 25_000
const RENDER_WAIT_MS = 800
const SKIP_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|zip|gz|tgz|7z|rar|iso|mp4|mp3|wav|webm|avi|mov|mkv|woff2?|ttf|exe|msi|dmg|apk|pdf|docx?|xlsx?|pptx?|csv)$/i
// Pages a crawl may load, of what it was asked for: a page too short to keep counts too, so a site of empty pages ends.
const VISITS_PER_PAGE = 3
// A site that stops answering: this many pages failing one after another ends the crawl.
const FAILURES_IN_A_ROW = 5
// The reader's session (every crawl's window uses the same one): told once to download nothing.
const refusingDownloads = new WeakSet<Session>()

// Runs inside the page: turns the main content into Markdown-ish text (headings, lists, tables, code)
// and lists the page's links for crawling.
const EXTRACT = `(() => {
  const root = document.querySelector('main, article, [role=main]') || document.body
  const skip = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','NAV','FOOTER','ASIDE','FORM','BUTTON','IFRAME','TEMPLATE','DIALOG'])
  const out = []
  const walk = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) { const t = node.textContent.replace(/\\s+/g, ' '); if (t.trim()) out.push(t); continue }
      if (node.nodeType !== 1) continue
      const tag = node.tagName
      if (skip.has(tag) || node.getAttribute('aria-hidden') === 'true' || node.hidden) continue
      if (/^H[1-6]$/.test(tag)) { out.push('\\n\\n' + '#'.repeat(+tag[1]) + ' ' + node.innerText.trim().replace(/\\s+/g, ' ') + '\\n\\n'); continue }
      if (tag === 'PRE') { out.push('\\n\\n\`\`\`\\n' + node.innerText.replace(/\\n+$/, '') + '\\n\`\`\`\\n\\n'); continue }
      if (tag === 'TR') { out.push('\\n| ' + [...node.cells].map((c) => c.innerText.trim().replace(/\\s+/g, ' ')).join(' | ') + ' |'); continue }
      if (tag === 'LI') { out.push('\\n- '); walk(node); continue }
      if (tag === 'BR') { out.push('\\n'); continue }
      const block = /^(P|DIV|SECTION|ARTICLE|UL|OL|TABLE|BLOCKQUOTE|DL|DT|DD|FIGURE|HEADER|DETAILS|SUMMARY)$/.test(tag)
      if (block) out.push('\\n')
      walk(node)
      if (block) out.push('\\n')
    }
  }
  walk(root)
  const text = out.join('').replace(/[ \\t]+\\n/g, '\\n').replace(/\\n[ \\t]+/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim()
  return { title: (document.title || location.hostname).slice(0, 200), text: text.slice(0, 5000000), links: [...document.querySelectorAll('a[href]')].slice(0, 2000).map((a) => a.href) }
})()`

function normalize(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (!/^https?:$/.test(url.protocol)) return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** Only follow links on the same site and under the starting path (crawling /docs/ stays in /docs/). */
function inScope(url: string, start: URL): boolean {
  const u = new URL(url)
  const base = start.pathname.endsWith('/') ? start.pathname : start.pathname.replace(/[^/]*$/, '')
  return u.origin === start.origin && u.pathname.startsWith(base) && !SKIP_EXTENSIONS.test(u.pathname)
}

/**
 * Reads a web page, and optionally the pages it links to within the same section of the site, in a
 * hidden sandboxed Chromium window, so JavaScript-rendered documentation sites work too.
 */
export async function readWebsite(
  startUrl: string,
  opts: { maxPages: number; followLinks: boolean; onPage?: (done: number, url: string) => void }
): Promise<WebPage[]> {
  const first = normalize(startUrl)
  if (!first) throw new Error('Enter a full web address, like https://docs.example.com/guide')
  const start = new URL(first)
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, partition: 'togle-reader', images: false }
  })
  win.webContents.setAudioMuted(true)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // Electron grants every permission unless told otherwise. Pages being read get none: no microphone
  // or camera (possibly mid-call), no notifications, no opening other apps.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  win.webContents.session.setPermissionCheckHandler(() => false)
  // A link to a file isn't a page: nothing a page offers is downloaded, nor a save dialog opened for it.
  const session = win.webContents.session
  if (!refusingDownloads.has(session)) {
    refusingDownloads.add(session)
    session.on('will-download', (event) => event.preventDefault())
  }

  /** What a page's own code gets to do, at most this long: one stuck in a loop is ended, and the crawl goes on. */
  const inTime = <T,>(work: Promise<T>): Promise<T> =>
    Promise.race([work, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), PAGE_TIMEOUT_MS))])

  const pages: WebPage[] = []
  const seen = new Set([first])
  const queue = [first]
  let visits = 0
  let failures = 0
  try {
    while (queue.length && pages.length < opts.maxPages && visits < opts.maxPages * VISITS_PER_PAGE && failures < FAILURES_IN_A_ROW) {
      const url = queue.shift()!
      visits++
      try {
        await inTime(win.loadURL(url))
        await new Promise((r) => setTimeout(r, RENDER_WAIT_MS))
        const page = await inTime(win.webContents.executeJavaScript(EXTRACT) as Promise<{ title: string; text: string; links: string[] }>)
        failures = 0
        if (page.text.length > 200) pages.push({ url, title: page.title.trim(), text: page.text })
        opts.onPage?.(pages.length, url)
        if (!opts.followLinks) break
        for (const link of page.links) {
          const next = normalize(link)
          if (next && !seen.has(next) && inScope(next, start)) {
            seen.add(next)
            queue.push(next)
          }
        }
      } catch (err) {
        if (url === first) throw new Error(`Could not open ${url}: ${(err as Error).message}`)
        failures++
        // A page whose code never finished: ended, so the next one loads in a fresh renderer.
        if ((err as Error).message === 'timed out' && !win.isDestroyed()) win.webContents.forcefullyCrashRenderer()
      }
    }
  } finally {
    win.destroy()
  }
  return pages
}
