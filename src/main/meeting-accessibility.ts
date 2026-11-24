import { createHash } from 'node:crypto'
import { CALL_APPS, desktopCallApps, type CallApp, type MeetingMic } from '@shared/call-apps'

export type AccessibleRef = bigint
export interface AccessibleApp { pid: number; program: string; root?: AccessibleRef; active?: boolean }

/** Native references returned during a read belong to the reader until clear(). The current call retains its window and tab. */
export interface MeetingAccessibility {
  applications(): AccessibleApp[] | undefined
  windows(app: AccessibleApp): AccessibleRef[] | undefined
  children(ref: AccessibleRef): AccessibleRef[]
  role(ref: AccessibleRef): string
  name(ref: AccessibleRef): string
  help(ref: AccessibleRef): string
  active(ref: AccessibleRef): boolean
  selected(ref: AccessibleRef): boolean
  enabled(ref: AccessibleRef): boolean
  showing(ref: AccessibleRef): boolean
  address(ref: AccessibleRef): string
  same(a: AccessibleRef, b: AccessibleRef): boolean
  retain(ref: AccessibleRef): void
  release(ref: AccessibleRef): void
  clear(): void
  watch(app: AccessibleApp, ref: AccessibleRef, changed: () => void): boolean
  unwatch(): void
  pump(): void
  dispose(): void
}

export interface MeetingObservation { id: string; app?: CallApp; state: MeetingMic | 'gap' | 'left' }
type Button = { name: string; help?: string; groups: AccessibleRef[]; ref: AccessibleRef }
type Controls = { joined: boolean; ended: boolean; mic: MeetingMic; toggle?: AccessibleRef }

const HANG_UP = /^(?:Leave (?:the |this )?(?:call|meeting|huddle|conference|voice channel|room)|End (?:the |this )?(?:call|meeting)|Hang up|Disconnect from voice|Anruf (?:verlassen|beenden)|Besprechung verlassen|Auflegen|Quitter (?:la |le |l.)?(?:r.union|appel)|Salir de (?:la |la video)?(?:reuni.n|llamada)|Colgar)\b/i
const LEAVE = /^(?:Leave|Disconnect|Beenden|Verlassen)(?:\s*\([^)]*\))?$/i
const ENDED = /^(?:Rejoin(?: meeting)?|Return to home screen|Join (?:now|meeting|a meeting|huddle|voice channel)|Start (?:a |the )?(?:huddle|voice call|audio call|video call)|Call again|Wieder teilnehmen|Erneut (?:beitreten|teilnehmen)|Zur Startseite|Jetzt teilnehmen)\b/i
const OWN_OPEN = /^(?:Turn off (?:the |your )?microphone|Turn off (?:your )?mic|Mute (?:(?:your |my )(?:mic|microphone|audio)|myself|yourself)|Mikrofon (?:ausschalten|deaktivieren|stummschalten)|D.sactiver (?:le |votre )?micro|Silenciar (?:mi |el )?micr.fono)\b/i
const OWN_MUTED = /^(?:Turn on (?:the |your )?microphone|Turn on (?:your )?mic|Unmute (?:(?:your |my )(?:mic|microphone|audio)|myself|yourself)|Mikrofon (?:einschalten|aktivieren)|Stummschaltung (?:des Mikrofons )?aufheben|Activer (?:le |votre )?micro|Activar (?:mi |el )?micr.fono)\b/i
const BARE_MIC = /^(mute|unmute|stummschalten)(?: (?:microphone|mic|audio))?(?:\s*[,(:\[].*)?$/i
const MIC_SHORTCUT = /(?:(?:ctrl|control|alt|option|cmd|command|shift)\s*\+\s*|[⌥⌘⇧⌃])+[DMA]\b/i
const CALL_CAPTION = /\b(?:meet(?:ing)?|call|webinar|conference|huddle|besprechung|anruf|videollamada|webex|jitsi|zoom|teams|slack|discord|whereby|ringcentral|whatsapp|signal)\b|[a-z]{3}-[a-z]{4}-[a-z]{3}/i
const BROWSER = /^(?:com\.google\.chrome|org\.chromium\.|com\.microsoft\.edgemac|org\.mozilla\.firefox|com\.brave\.browser|com\.operasoftware\.opera|com\.vivaldi\.|company\.thebrowser\.browser|com\.apple\.safari)|^(?:chrome|google-chrome(?:-stable|-beta|-unstable)?|chromium(?:-browser)?|brave(?:-browser)?|msedge|microsoft-edge(?:-stable|-beta|-dev)?|firefox(?:-esr|-bin)?|opera|vivaldi(?:-stable|-bin)?)$/i

export function meetingControls(buttons: Button[]): Controls {
  const leave = buttons.filter(button => HANG_UP.test(button.name) || LEAVE.test(button.name))
  const leaveGroups = new Set(leave.flatMap(button => button.groups))
  const own: { mic: MeetingMic; button: Button }[] = []
  const ambiguous: typeof own = []
  for (const button of buttons) {
    const name = /^(?:mic|microphone|audio|mikrofon)$/i.test(button.name) ? button.help || button.name : button.name
    if (OWN_OPEN.test(name)) own.push({ mic: 'open', button })
    else if (OWN_MUTED.test(name)) own.push({ mic: 'muted', button })
    else {
      const bare = BARE_MIC.exec(name)
      if (!bare) continue
      const candidates = MIC_SHORTCUT.test(name) ? own : ambiguous
      candidates.push({ mic: bare[1].toLowerCase() === 'unmute' ? 'muted' : 'open', button })
    }
  }
  const matches = own.length ? own : ambiguous.filter(({ button }) => button.groups.some(group => leaveGroups.has(group)))
  const mic = matches.length === 1 ? matches[0] : undefined
  const ended = buttons.some(button => ENDED.test(button.name))
    || buttons.some(button => /^(?:New meeting|Start meeting|Meet now|Neue Besprechung)$/i.test(button.name))
      && buttons.some(button => /^(?:Join|Join voice|Beitreten)$/i.test(button.name))
    || buttons.some(button => /^(?:Voice call|Audio call)$/i.test(button.name)) && buttons.some(button => /^Video call$/i.test(button.name))
  return { joined: leave.some(button => HANG_UP.test(button.name)) || !!leave.length && !!mic, ended, mic: mic?.mic ?? 'unknown', toggle: mic?.button.ref }
}

function browserMeeting(address: string): { app: CallApp; route: string; origin: string } | undefined {
  let url: URL
  try { url = new URL(address) } catch { return }
  if (url.username || url.password || url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) return
  const app = desktopCallApps.find(item => item.hosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host)))?.id ?? 'other'
  if (app === 'meet' && !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/i.test(url.pathname)) return
  return { app, route: url.origin + url.pathname, origin: url.origin }
}

type Tab = { ref: AccessibleRef; name: string; selected: boolean }
type Tracked = {
  id: string
  app: CallApp
  process: AccessibleApp
  window: AccessibleRef
  browser: boolean
  tab?: Tab
  route?: string
  origin?: string
  missing: number
}

const BUTTON_ROLES = new Set(['button', 'toggle button', 'check box', 'menu button', 'push button'])
const SKIP_ROLES = new Set(['menu', 'menu bar', 'tree', 'table', 'list item', 'paragraph', 'text', 'link', 'image'])
const BROWSER_DOCUMENT = new Set(['web area', 'document web', 'document frame', 'document'])
const CALL_GROUP = /(?:call|meeting|huddle|voice|audio).*(?:control|action)|controls.*(?:call|meeting)/i
const SAME_TAB_SERVICES = new Set<CallApp>(['teams', 'slack', 'discord', 'whatsapp', 'webex', 'ringcentral', 'other'])

/** Read only accessible controls in candidate desktop windows. Titles and addresses stay in the worker. */
export class AccessibleMeetings {
  private call?: Tracked
  private watched?: AccessibleRef
  private watchReady = false
  private changed = false
  private discoveredAt = 0

  constructor(private ui: MeetingAccessibility, private os: 'darwin' | 'linux', private report: (event: MeetingObservation) => void, private ownPid = process.pid) {}

  get tracking(): boolean { return !!this.call }

  read(): void {
    this.changed = false
    try {
      const apps = this.ui.applications()
      if (!apps) return this.unknown()
      if (this.call) this.readCurrent(this.call, apps.find(app => app.pid === this.call?.process.pid))
      else this.discover(apps)
    } catch { this.unknown() }
    finally { this.ui.clear() }
  }

  private discover(apps: AccessibleApp[]): void {
    const candidates = apps.filter(app => app.pid !== this.ownPid && !/^(?:io\.togle\.|togle(?: studio)?$)/i.test(app.program))
    // Start with known meeting apps and browsers. Rotate between candidates when several windows are open.
    const identity = (app: AccessibleApp) => CALL_APPS.find(item => (this.os === 'darwin' ? item.mac : item.linux)?.test(app.program))?.id
    candidates.sort((a, b) => Number(!!(identity(b) || BROWSER.test(b.program))) - Number(!!(identity(a) || BROWSER.test(a.program))))
    const until = Date.now() + 1300
    for (let count = 0; count < candidates.length && Date.now() < until; count++) {
      const app = candidates[this.discoveredAt++ % candidates.length]
      const browser = BROWSER.test(app.program)
      const native = identity(app)
      for (const window of this.ui.windows(app) ?? []) {
        const title = this.ui.name(window)
        if (!browser && !native && !app.active && !this.ui.active(window) && !CALL_CAPTION.test(title)) continue
        const page = browser ? this.page(window) : undefined
        const provider = browser ? page?.meeting?.app : native ?? 'other'
        if (!provider) continue
        const controls = this.controls(page?.document ?? window)
        if (!controls.joined || provider === 'other' && !controls.toggle) continue
        const tab = page?.tabs.find(tab => tab.selected)
        const route = page?.meeting?.route
        const id = createHash('sha256').update(`${app.pid}/${app.program}/${route ?? title}`).digest('hex').slice(0, 32)
        this.ui.retain(window)
        if (tab) this.ui.retain(tab.ref)
        this.call = { id, app: provider, process: app, window, browser, tab, route, origin: page?.meeting?.origin, missing: 0 }
        this.state(this.call, controls)
        return
      }
    }
  }

  private readCurrent(call: Tracked, app: AccessibleApp | undefined): void {
    if (!app) {
      try { process.kill(call.process.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return this.finish(call) }
      return this.unknown()
    }
    const windows = this.ui.windows(app)
    const window = windows?.find(ref => this.ui.same(ref, call.window))
    if (!window) return this.missing(call, !!windows)
    const page = call.browser ? this.page(window) : undefined
    if (page) {
      const matchingTab = call.tab && page.tabs.find(tab => this.ui.same(tab.ref, call.tab!.ref))
      const leftTab = call.tab && !matchingTab && !!page.tabs.find(tab => tab.selected) && !page.tabs.some(tab => tab.name === call.tab?.name)
      const sameRoom = page.meeting?.route === call.route
      const sameSite = matchingTab && matchingTab.selected && page.meeting?.origin === call.origin && SAME_TAB_SERVICES.has(call.app)
      if (!page.document || !page.address || matchingTab?.selected === false || !sameRoom && !sameSite) {
        return this.missing(call, !!page.address && (!!leftTab || !!matchingTab?.selected && !sameRoom && !sameSite))
      }
      if (leftTab) return this.missing(call, true)
    }
    call.missing = 0
    const controls = this.controls(page?.document ?? window)
    if (controls.joined) this.state(call, controls)
    else if (controls.ended) this.finish(call)
    else this.unknown()
  }

  private missing(call: Tracked, confirmed: boolean): void {
    call.missing = confirmed ? call.missing + 1 : 0
    if (call.missing >= 2) this.finish(call)
    else this.unknown()
  }

  private unknown(): void {
    if (this.call) this.report({ id: this.call.id, app: this.call.app, state: 'unknown' })
  }

  private state(call: Tracked, controls: Controls): void {
    const toggle = controls.toggle
    if (!toggle || !this.watched || !this.ui.same(toggle, this.watched) || !this.watchReady) {
      this.ui.unwatch()
      if (this.watched) this.ui.release(this.watched)
      this.watched = toggle
      this.watchReady = false
      if (toggle) {
        this.ui.retain(toggle)
        this.watchReady = this.ui.watch(call.process, toggle, () => {
          this.changed = true
          this.report({ id: call.id, state: 'gap' })
        })
      }
    }
    this.ui.pump()
    const mic = !this.changed && (this.watchReady || controls.mic === 'muted') ? controls.mic : 'unknown'
    this.report({ id: call.id, app: call.app, state: mic })
  }

  private finish(call: Tracked): void {
    this.report({ id: call.id, app: call.app, state: 'left' })
    this.releaseCall(call)
  }

  stop(): void {
    if (this.call) this.releaseCall(this.call)
    this.ui.dispose()
  }

  private releaseCall(call: Tracked): void {
    this.ui.unwatch()
    if (this.watched) this.ui.release(this.watched)
    this.watched = undefined
    this.watchReady = false
    this.ui.release(call.window)
    if (call.tab) this.ui.release(call.tab.ref)
    this.call = undefined
  }

  private page(window: AccessibleRef): { document?: AccessibleRef; tabs: Tab[]; address: string; meeting: ReturnType<typeof browserMeeting> } {
    const tabs: Tab[] = []
    let document: AccessibleRef | undefined
    let address = ''
    for (const { ref, role } of this.walk(window, 150, 9, true)) {
      if (role === 'page tab' && this.ui.showing(ref)) tabs.push({ ref, name: this.ui.name(ref), selected: this.ui.selected(ref) })
      if (BROWSER_DOCUMENT.has(role) && this.ui.showing(ref) && !document) {
        document = ref
        const url = this.ui.address(ref)
        if (url) address = url
      }
      if (!address && role === 'address bar') address = this.ui.address(ref)
    }
    return { document, tabs, address, meeting: document ? browserMeeting(address) : undefined }
  }

  private controls(root: AccessibleRef): Controls {
    const buttons: Button[] = []
    for (const { ref, role, groups } of this.walk(root, 340, 24)) {
      if (!BUTTON_ROLES.has(role) || !this.ui.enabled(ref) || !this.ui.showing(ref)) continue
      const name = this.ui.name(ref).trim()
      if (!name) continue
      const help = /^(?:mic|microphone|audio|mikrofon)$/i.test(name) ? this.ui.help(ref).trim() : undefined
      buttons.push({ ref, name, help, groups })
    }
    return meetingControls(buttons)
  }

  private *walk(root: AccessibleRef, limit: number, maxDepth: number, browserChrome = false) {
    const queue = [{ ref: root, depth: 0, groups: [] as AccessibleRef[] }]
    for (let at = 0; at < queue.length && at < limit; at++) {
      const { ref, depth, groups } = queue[at]
      const role = this.ui.role(ref)
      yield { ref, role, groups }
      if (depth >= maxDepth || SKIP_ROLES.has(role) || BUTTON_ROLES.has(role) || browserChrome && BROWSER_DOCUMENT.has(role)) continue
      const toolbar = role === 'tool bar' || role === 'group' && CALL_GROUP.test(this.ui.name(ref))
      const nextGroups = toolbar ? [...groups, ref] : groups
      for (const child of this.ui.children(ref)) queue.push({ ref: child, depth: depth + 1, groups: nextGroups })
    }
  }
}
