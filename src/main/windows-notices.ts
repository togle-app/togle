import { Notification } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { callAppName, type CallApp } from '@shared/call-apps'
import type { NoticeDestination } from '@shared/api'
import type { TaskNotice } from '@shared/runner'
import type { AttentionLook } from './runners/attention'
import { readJson, writeJson } from './storage'
import { DevNotification, registerDevNotifications } from './windows-dev-notifications'
import { taskNotificationText } from './task-notification-text'

// Windows retains activation arguments after our process exits. Task routing uses only an opaque ID.
const HISTORY = 'windows-notice-targets.json'
type Target = { id: string; keys: string[]; waiting?: boolean }
type Toast = Notification | DevNotification
type Entry = { notice: Toast; keys: string[]; waiting: boolean }
const idFor = (request: string): string => createHash('sha256').update(request).digest('hex').slice(0, 16)
const newId = (): string => randomUUID().replaceAll('-', '').slice(0, 16)

function escapeXml(text: string): string {
  return text.replace(/[^\t\n\r\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function toast(source: boolean, id: string, title: string, body: string, launch: string, buttons: [string, string][], silent: boolean): Toast {
  // Electron forwards structured actions from both Windows' live Activated event and the COM cold-start callback.
  const args = (route: string, index: number): string => escapeXml(`type=action&action=${index}&tag=${id}&route=${route}`)
  const actions = buttons.map(([label, action], index) => `<action content="${escapeXml(label)}" arguments="${args(action, index)}" activationType="foreground"/>`).join('')
  const xml = [
    `<toast launch="${args(launch, 0)}"><visual><binding template="ToastGeneric">`,
    `<text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual>`,
    `<actions>${actions}</actions>`, silent ? '<audio silent="true"/>' : '', '</toast>'
  ].join('')
  return source ? new DevNotification(id, xml) : new Notification({ id, groupId: 'togle', toastXml: xml })
}

export class WindowsNotices {
  private targets: Target[] = []
  private saving: Promise<void> = Promise.resolve()
  private readonly active = new Map<string, Entry>()
  private readonly announced = new Set<string>()
  private readonly afterMeeting = new Map<string, TaskNotice>()
  private readonly status = new Map<'studio' | 'devices', Toast>()
  private call?: { app: CallApp; token: string; notice: Toast }
  private supported = false
  private stopped = false

  constructor(private readonly navigate: (where: NoticeDestination) => void, private readonly acceptCall: (app: CallApp) => void, private readonly source = false) {}

  async start(): Promise<void> {
    const saved = await readJson<unknown>(HISTORY, [])
    if (Array.isArray(saved)) this.targets = saved.filter((row): row is Target => row && /^[a-f0-9]{16}$/.test(row.id) && Array.isArray(row.keys) && row.keys.length && row.keys.every((key: unknown) => typeof key === 'string'))
    if (this.source) {
      try { registerDevNotifications(); this.supported = true } catch (error) { console.warn('[notifications]', (error as Error).message) }
      return
    }
    Notification.handleActivation(details => this.activate(details.arguments))
    // Also initializes the Windows COM server when a notification launches a fresh process.
    this.supported = Notification.isSupported()
  }

  activate(argument: string): void {
    if (this.stopped) return
    const route = new URLSearchParams(argument).get('route')
    if (!route) return
    if (route === 'togle.meetings') { this.navigate({ page: 'meetings' }); return }
    if (route === 'togle.studio') { this.navigate({ page: 'studio' }); return }
    if (route === 'togle.devices') { this.navigate({ page: 'devices' }); return }
    const [prefix, id, choice] = route.split('.')
    if (prefix === 'togle-task' && /^[a-f0-9]{16}$/.test(id)) {
      const target = this.targets.find(row => row.id === id)
      this.navigate({ keys: target?.keys ?? [] })
      return
    }
    const call = this.call
    if (prefix !== 'togle-call' || !call || id !== call.token || choice !== 'start') return
    this.endCall()
    this.acceptCall(call.app)
  }

  refresh(look: AttentionLook, options: { front: boolean; meeting: boolean; notices: boolean; finished: boolean; notificationPreviews: boolean }, unread: (key: string) => boolean): void {
    if (!this.supported || this.stopped) return
    const waiting = new Set(look.notices.map(item => item.id))
    let resolved = false
    for (const id of this.announced) {
      if (waiting.has(id) && options.notices) continue
      this.announced.delete(id)
      const target = this.targets.find(row => row.id === idFor(id))
      if (target?.waiting) { target.waiting = false; resolved = true }
    }
    if (resolved) this.save()
    const liveTags = new Set([...waiting].map(idFor))
    for (const [id, entry] of this.active) {
      if (entry.waiting ? !options.notices || !liveTags.has(id) : !options.finished || !entry.keys.some(unread)) this.withdraw(id)
    }
    if (!options.finished) this.afterMeeting.clear()
    if (options.meeting) {
      if (options.finished) for (const item of look.finished) this.afterMeeting.set(item.key, item)
      return
    }
    if (options.front) return
    if (options.notices) for (const item of look.notices) {
      if (this.announced.has(item.id)) continue
      this.announced.add(item.id)
      const id = idFor(item.id)
      if (!this.targets.some(target => target.id === id && target.waiting)) this.post(id, [item], options.notificationPreviews)
    }
    if (!options.finished) return
    for (const item of look.finished) this.afterMeeting.set(item.key, item)
    const results = [...this.afterMeeting.values()].filter(item => unread(item.key))
    this.afterMeeting.clear()
    if (!results.length) return
    this.post(newId(), results, options.notificationPreviews)
  }

  private post(id: string, items: TaskNotice[], previews: boolean): void {
    const { title, body } = taskNotificationText(items, previews)
    const keys = items.map(item => item.key)
    const waiting = items[0].kind === 'waiting'
    const launch = 'togle-task.' + id
    const notice = toast(this.source, id, title, body, launch, [[waiting ? 'Review request' : keys.length === 1 ? 'View result' : 'View results', launch]], !waiting)
    const entry = { notice, keys, waiting }
    this.active.set(id, entry)
    // More than the number of notifications Windows keeps. Only navigation targets are retained.
    this.targets = [...this.targets.filter(row => row.id !== id), { id, keys, waiting }].slice(-256)
    for (const old of this.active.keys()) if (!this.targets.some(row => row.id === old)) this.withdraw(old)
    const remove = (): void => { if (this.active.get(id) === entry) this.active.delete(id) }
    // Windows can keep an entry after its banner is dismissed. Retain the handle until its task is resolved or read.
    notice.on('failed', (_event, message) => { remove(); console.warn('[notifications]', message) })
    void this.save().then(() => { if (!this.stopped && this.active.get(id) === entry) notice.show() })
  }

  private save(): Promise<void> {
    const targets = this.targets.slice()
    this.saving = this.saving.then(() => writeJson(HISTORY, targets)).catch(error => console.warn('[notifications] Could not save notification destinations:', error.message))
    return this.saving
  }

  private withdraw(id: string): void {
    const entry = this.active.get(id)
    this.active.delete(id)
    entry?.notice.close()
  }

  get offeredCall(): CallApp | undefined { return this.call?.app }

  showStatus(page: 'studio' | 'devices'): void {
    if (!this.supported || this.stopped) return
    this.closeStatus(page)
    const route = 'togle.' + page
    const notice = page === 'studio'
      ? toast(this.source, idFor(page), 'Togle Studio stopped', 'Your call may be silent. Reconnect in Studio or choose your microphone in the call app.', route, [['Open Studio', route]], false)
      : toast(this.source, idFor(page), 'A paired device acted on this computer', 'Open Devices to review the activity.', route, [['View activity', route]], false)
    this.status.set(page, notice)
    notice.show()
  }

  closeStatus(page: 'studio' | 'devices'): void {
    this.status.get(page)?.close()
    this.status.delete(page)
  }

  offerCall(app: CallApp): void {
    if (!this.supported || this.stopped || this.call?.app === app) return
    this.endCall()
    const token = newId()
    const name = callAppName(app)
    const notice = toast(this.source, token, app === 'other' ? 'Take notes for this call?' : `Take notes for this ${name} call?`, 'Ask everyone before transcription starts.', 'togle.meetings', [
      ['Take notes', `togle-call.${token}.start`]
    ], false)
    this.call = { app, token, notice }
    notice.on('failed', () => { if (this.call?.token === token) this.call = undefined })
    notice.show()
  }

  endCall(app?: CallApp): void {
    if (!this.call || (app && app !== this.call.app)) return
    const { notice } = this.call
    this.call = undefined
    notice.close()
  }

  stop(): void {
    this.stopped = true
    this.endCall()
    // Task notifications remain in Notification Center and their saved destinations survive a restart.
  }
}
