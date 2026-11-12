// Reach in the app: where it keeps its keys and book (encrypted by the system's keystore), what the window may ask of it,
// and when it is in this Togle at all. It stays out of every release until an outside review has tried to break it:
// only a development run with a courier set (TOGLE_COURIER) has it.
import { app, safeStorage } from 'electron'
import os from 'node:os'
import type { ReachState, RemoteAct } from '@shared/reach'
import { readSecret, writeSecret } from '../storage'
import { Reach, type ReachStore, type ReachTasks } from './reach'
import { StudioAccount, type StudioSession } from './studio-account'

/** Studio's courier and Studio's sign-in, once they run for everyone: empty until then. */
export const COURIER_URL = ''
export const STUDIO_URL = ''
export const STUDIO_PUBLIC_KEY = ''

interface ReachConfig { courier: string; studio?: { url: string; key: string } }

export function reachConfig(): ReachConfig | undefined {
  if (app.isPackaged) return undefined
  const courier = process.env.TOGLE_COURIER || COURIER_URL
  if (!/^wss?:\/\//.test(courier)) return undefined
  const url = process.env.TOGLE_STUDIO_SUPABASE_URL || STUDIO_URL, key = process.env.TOGLE_STUDIO_SUPABASE_KEY || STUDIO_PUBLIC_KEY
  return { courier, ...(url && key ? { studio: { url, key } } : {}) }
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

export function registerReach(deps: ReachDeps): Reach | undefined {
  const config = reachConfig()
  const { handle } = deps
  if (!config) {
    handle('reach:state', () => OFF)
    handle('reach:remote-tasks', () => [])
    return undefined
  }
  const account = config.studio ? new StudioAccount({
    url: config.studio.url,
    publicKey: config.studio.key,
    store: { read: () => store.read<StudioSession>('studio-account'), write: (session) => store.write('studio-account', session) }
  }) : undefined
  const reach = new Reach({
    courier: config.courier,
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
  handle('reach:send-code', async (email) => {
    if (!account) throw new Error('Signing in to Togle Studio isn’t set up in this Togle.')
    await account.sendCode(text(email, 'The email address'))
  })
  handle('reach:sign-in', async (email, code) => {
    if (!account) throw new Error('Signing in to Togle Studio isn’t set up in this Togle.')
    await account.verify(text(email, 'The email address'), text(code, 'The code', 20))
    await reach.connectAccount()
    return reach.state()
  })
  handle('reach:start-again', async () => { await reach.connectAccount(true); return reach.state() })
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
    if (what !== 'refuse' && what !== 'stop' && what !== 'end-commands') throw new Error('From another device, a task can be refused or stopped.')
    const remote: RemoteAct = { what, task: text(given.task, 'The task'), ...(typeof given.request === 'string' ? { request: given.request } : {}) }
    await reach.act(text(device, 'The device', 40), remote)
  })
  return reach
}
