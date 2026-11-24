import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { APP_ID, appUserModelId } from './app-id'

const run = promisify(execFile)
const protocol = 'togle-free-dev'
const sourceId = appUserModelId(false)
const changes = new Map<string, Promise<void>>()

// electron.exe has Electron's embedded name, icon and launch command. A development launch needs the project argument.
export function registerDevNotifications(): void {
  const programs = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  mkdirSync(programs, { recursive: true })
  const root = app.getAppPath()
  const userData = '--user-data-dir=' + app.getPath('userData')
  const shortcut = path.join(programs, 'Togle (Development).lnk')
  const details = { target: process.execPath, args: `"${root}" "${userData}"`, cwd: root, icon: path.join(root, 'build', 'icon.ico'), iconIndex: 0, appUserModelId: sourceId, toastActivatorClsid: '{965C78C6-7CA2-4D14-A2EC-FE98371F4477}' }
  if (!shell.writeShortcutLink(shortcut, existsSync(shortcut) ? 'update' : 'create', details)) throw new Error('Could not register the Togle development shortcut.')
  if (!app.setAsDefaultProtocolClient(protocol, process.execPath, [root, userData])) throw new Error('Could not register Togle development notification clicks.')
  const legacy = path.join(programs, 'Electron.lnk')
  if (existsSync(legacy)) {
    const old = shell.readShortcutLink(legacy)
    if (old.target.toLowerCase() === process.execPath.toLowerCase() && (old.appUserModelId === APP_ID || old.appUserModelId === sourceId)) unlinkSync(legacy)
  }
}

export function devNotificationArgument(argv: string[]): string | undefined {
  const link = argv.find(value => value.startsWith(protocol + '://notice/?'))
  if (!link || link.length > 1024) return
  try { return new URL(link).searchParams.get('args') ?? undefined } catch { return }
}

export class DevNotification extends EventEmitter {
  private shown = false
  constructor(private readonly id: string, private readonly xml: string) { super() }
  private change(action: 'Show' | 'Remove'): Promise<void> {
    const script = path.join(app.getAppPath(), 'scripts', 'dev-notification.ps1')
    const done = (changes.get(this.id) ?? Promise.resolve()).catch(() => {}).then(() => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File', script, action, this.id], {
      windowsHide: true, timeout: 10000, env: { ...process.env, TOGLE_DEV_TOAST_XML: this.xml }
    })).then(() => {})
    changes.set(this.id, done)
    const clear = (): void => { if (changes.get(this.id) === done) changes.delete(this.id) }
    void done.then(clear, clear)
    return done
  }
  show(): void {
    this.shown = true
    void this.change('Show').catch(error => this.emit('failed', {}, error.message))
  }
  close(): void {
    if (this.shown) void this.change('Remove').catch(error => console.warn('[notifications]', error.message))
    this.shown = false
  }
}
