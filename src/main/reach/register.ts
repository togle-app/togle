// Reach in the app: where it keeps its keys and book (encrypted by the system's keystore), what the window may ask of it,
// and when it is in this Togle at all. It stays out of every release until an outside review has tried to break it:
// only a development run with a courier set (TOGLE_COURIER) has it.
import { app, BrowserWindow, clipboard, dialog, safeStorage, systemPreferences } from 'electron'
import os from 'node:os'
import type { ReachState, RemoteAct } from '@shared/reach'
import { readSecret, writeSecret } from '../storage'
import { Reach, type ReachStore, type ReachTasks } from './reach'
import type { StudioAccount } from './studio-account'

export function reachConfig(): { courier: string } | undefined {
  if (app.isPackaged) return undefined
  try {
    const url = new URL(process.env.TOGLE_COURIER ?? '')
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    const allowed = loopback ? ['ws:', 'wss:'].includes(url.protocol) : url.protocol === 'wss:' && url.hostname.endsWith('.togle.app')
    if (allowed && url.pathname === '/v1' && !url.username && !url.password && !url.search && !url.hash) return { courier: url.href }
  } catch { /* no valid development endpoint configured */ }
  return undefined
}

/** A real keystore: not Linux's basic_text fallback, whose key is the same on every computer. */
const keystore = (): boolean => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text')

const store: ReachStore = {
  read: async <T>(name: string) => (keystore() ? await readSecret<T>(`${name}.bin`) : null),
  write: async (name, value) => {
    if (!keystore()) throw new Error('This computer has no keystore to keep Reach’s keys in, so Reach is off here.')
    await writeSecret(`${name}.bin`, value)
  }
}

const OFF: ReachState = { available: false, link: 'off', standing: 'alone', devices: [], actOnThis: true, acted: [] }

export interface ReachDeps {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void
  send(channel: string, payload: unknown): void
  tasks: ReachTasks
  /** Another device acted on this computer: shown where the person sees it. */
  acted?(what: string, by: string): void
}

const text = (value: unknown, what: string, max = 200): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${what} is missing.`)
  return value
}

const DEVICE_CHANGE = {
  enable: { title: 'Enable remote access?', detail: 'This computer will manage a private group. You can add devices to it in Togle.', action: 'Enable' },
  recover: { title: 'Recover remote access?', detail: 'Your old device group will disconnect. Pair the devices you still use after recovery.', action: 'Recover' },
  save: { title: 'Copy recovery key?', detail: 'Paste this key into your password manager. Anyone who has the key and access to your Togle account can replace this group.', action: 'Copy key' }
} as const

async function approveDeviceChange(operation: keyof typeof DEVICE_CHANGE): Promise<void> {
  const { title, detail, action } = DEVICE_CHANGE[operation]
  if (!keystore()) throw new Error('Set up your system key store to use remote access.')
  if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
    await systemPreferences.promptTouchID(title).catch(() => { throw new Error('Device confirmation was cancelled.') })
    return
  }
  // This development-only dialog asks for local consent. A platform unlock requires native support.
  const options = { type: 'question' as const, title, message: title, detail, buttons: ['Cancel', action], defaultId: 0, cancelId: 0 }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
  if (result.response !== 1) throw new Error('Device confirmation was cancelled.')
}

export function registerReach(deps: ReachDeps, account?: StudioAccount): Reach | undefined {
  const config = reachConfig()
  const { handle } = deps
  if (!config) {
    handle('reach:state', () => OFF)
    handle('reach:remote-tasks', () => [])
    return undefined
  }
  const reach = new Reach({
    courier: config.courier,
    approveDeviceChange,
    phonePilot: process.env.TOGLE_PHONE_PILOT === '1',
    phoneActivity: process.env.TOGLE_PHONE_PILOT_ACTIVITY === '1',
    accountUsage: process.env.TOGLE_PILOT_ACCOUNT_USAGE === '1',
    desktopActivity: process.env.TOGLE_DESKTOP_PILOT_ACTIVITY === '1',
    phoneMessages: process.env.TOGLE_PHONE_PILOT_MESSAGES === '1',
    pilotFolder: process.env.TOGLE_PHONE_PILOT_FOLDER,
    store,
    kind: 'computer',
    // Two Togles tried on one computer would share its name: a development run can give each its own.
    name: () => process.env.TOGLE_DEVICE_NAME || os.hostname(),
    account,
    tasks: deps.tasks
  })
  reach.on('changed', () => deps.send('reach:changed', null))
  reach.on('acted', (record) => deps.acted?.(record.what, record.name))
  void account?.load().then(() => reach.start()).catch((error: Error) => console.warn('[reach]', error.message))
  if (!account) void reach.start().catch((error: Error) => console.warn('[reach]', error.message))

  handle('reach:state', () => reach.state())
  handle('reach:remote-tasks', () => reach.remoteTasks())
  handle('reach:session', (device, task) => reach.readSession(text(device, 'The device', 40), text(task, 'The task')))
  handle('reach:send-code', async (email) => {
    if (!account) throw new Error('Togle account sign-in isn’t set up in this build.')
    await account.sendCode(text(email, 'The email address'))
  })
  handle('reach:sign-in', async (email, code) => {
    if (!account) throw new Error('Togle account sign-in isn’t set up in this build.')
    await account.verify(text(email, 'The email address'), text(code, 'The code', 20))
    deps.send('reach:changed', null)
    return reach.state()
  })
  handle('reach:connect', async () => { await reach.connectAccount(); return reach.state() })
  handle('reach:start-again', async (key) => { await reach.connectAccount(text(key, 'Your recovery key', 120)); return reach.state() })
  handle('reach:invite', async () => { await reach.openInvite(); return reach.state() })
  handle('reach:copy-recovery', async () => { clipboard.writeText(await reach.recoveryKeyForCopy()) })
  handle('reach:sign-out', async () => { await reach.signOut(); return reach.state() })
  handle('reach:show-code', async () => { await reach.showCode(); return reach.state() })
  handle('reach:cancel-code', () => { reach.cancelCode(); return reach.state() })
  handle('reach:add', async (code) => { await reach.addByCode(text(code, 'The code', 20)); return reach.state() })
  handle('reach:confirm-add', async () => { await reach.confirmAdd(); return reach.state() })
  handle('reach:cancel-add', () => { reach.cancelAdd(); return reach.state() })
  handle('reach:remove', async (device) => { await reach.remove(text(device, 'The device', 40)); return reach.state() })
  handle('reach:act-on-this', async (on) => { await reach.setActOnThis(on === true); return reach.state() })
  handle('reach:act', async (device, act) => {
    const given = (act ?? {}) as Record<string, unknown>
    const what = given.what
    if (what === 'reply-choice') {
      const choice = given.choice
      if (typeof choice !== 'number' || !Number.isSafeInteger(choice) || choice < 0) throw new Error('Select one of the answers shown.')
      await reach.act(text(device, 'The device', 40), {
        what, task: text(given.task, 'The task'), request: text(given.request, 'The question'), choice
      })
      return
    }
    if (what !== 'refuse' && what !== 'stop' && what !== 'end-commands') throw new Error('That action is not available from another device.')
    const remote: RemoteAct = { what, task: text(given.task, 'The task'), ...(typeof given.request === 'string' ? { request: given.request } : {}) }
    await reach.act(text(device, 'The device', 40), remote)
  })
  return reach
}
