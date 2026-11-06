import { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { existsSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  encodeLinkMessage, LinkLineReader, MICROPHONE_LINK_FILE, MICROPHONE_PROTOCOL, readLinkFile, readLinkState,
  type MicrophoneLaunch, type MicrophoneLinkFile, type MicrophoneLinkMethod, type MicrophoneLinkPage, type MicrophoneLinkState
} from '@shared/microphone-link'
import type { MicrophoneSettings, TogleMicrophoneStatus } from '@shared/microphone'

const REQUEST_TIMEOUT_MS = 5_000
/** How often Togle looks for Togle Microphone when it isn't connected (a file read and a failed connect: cheap). */
const POLL_MS = 15_000
/** After a launch, how long to wait for it to come up. */
const LAUNCH_WAIT_MS = 15_000
/** A call doesn't wait longer than this for the clean microphone; capture follows the system input when it switches. */
const CALL_WAIT_MS = 4_000

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export interface MicrophoneLinkOptions {
  /** Togle Microphone's user-data folder, where it writes link.json. */
  folder: string
  client: { name: string; version: string }
  platform?: NodeJS.Platform
  /** Starts a program, detached (tests replace it). */
  run?: (launch: MicrophoneLaunch) => void
  /** Opens a togle-microphone:// address (tests replace it). */
  open?: (url: string) => Promise<void>
}

/**
 * Finds Togle Microphone on this computer and talks to it over its local link (see @shared/microphone-link): its
 * state, watched as it changes, and turning it on and off around calls. Togle works the same without it.
 */
export class MicrophoneLink extends EventEmitter {
  private file?: MicrophoneLinkFile
  private socket?: net.Socket
  private state?: MicrophoneLinkState
  private connected = false
  private connecting?: Promise<boolean>
  private nextId = 1
  private pending = new Map<number, Pending>()
  private watcher?: FSWatcher
  private poll?: NodeJS.Timeout
  private debounce?: NodeJS.Timeout
  private started = false
  private forCall = false
  private last = ''
  private readonly platform: NodeJS.Platform

  constructor(private options: MicrophoneLinkOptions) {
    super()
    this.platform = options.platform ?? process.platform
  }

  status(): TogleMicrophoneStatus {
    const running = this.connected && !!this.state
    return { installed: !!this.file, running, ...(running ? { state: this.state } : {}), ...(this.forCall ? { forCall: true } : {}) }
  }

  start(): void {
    if (this.started) return
    this.started = true
    void this.refresh()
    this.poll = setInterval(() => { if (!this.connected) void this.refresh() }, POLL_MS)
    this.poll.unref?.()
  }

  stop(): void {
    this.started = false
    clearInterval(this.poll)
    clearTimeout(this.debounce)
    this.watcher?.close()
    this.watcher = undefined
    this.disconnect()
  }

  /** Reads the link file again and connects if Togle Microphone is running. */
  async refresh(): Promise<TogleMicrophoneStatus> {
    const file = await this.readFile()
    const moved = !!this.file && !!file && (file.token !== this.file.token || file.socket !== this.file.socket)
    this.file = file
    this.watchFolder()
    if (!file || moved) this.disconnect()
    if (file && !this.connected) await this.connect()
    this.publish()
    return this.status()
  }

  /** Before a call: turns Togle Microphone on when it's installed and the setting asks for it. */
  async prepareCall(settings: MicrophoneSettings): Promise<TogleMicrophoneStatus> {
    const status = await this.refresh()
    if (!settings.autoStart || !status.installed || this.forCall) return status
    const phase = status.state?.phase
    if (phase === 'on' || phase === 'starting' || status.state?.setup === 'missing' || status.state?.setup === 'restart') return status
    try {
      await this.turnOn('call', CALL_WAIT_MS)
      this.forCall = true
    } catch (error) {
      console.warn('[microphone] not turned on for the call:', (error as Error).message)
    }
    this.publish()
    return this.status()
  }

  /** After the call: what Togle turned on for it goes off again. */
  async endCall(): Promise<void> {
    if (!this.forCall) return
    this.forCall = false
    this.publish()
    const phase = this.state?.phase
    if (this.connected && (phase === 'on' || phase === 'starting')) await this.request('stop', { reason: 'call' }).catch(error => console.warn('[microphone] not turned off after the call:', (error as Error).message))
  }

  async turnOn(reason: 'call' | 'user' = 'user', wait = LAUNCH_WAIT_MS): Promise<TogleMicrophoneStatus> {
    if (!this.connected) await this.refresh()
    if (!this.connected) {
      if (!this.file) throw new Error("Togle Microphone isn't installed.")
      await this.launch(['--start'])
      await this.waitFor(status => status.running, wait)
      if (!this.connected) throw new Error("Togle Microphone didn't start.")
    }
    if (this.state?.phase !== 'on' && this.state?.phase !== 'starting') this.accept(await this.request('start', { reason }))
    await this.waitFor(status => status.state?.phase === 'on' || status.state?.phase === 'error', Math.min(wait, CALL_WAIT_MS))
    if (this.state?.phase === 'error') throw new Error(this.state.error || 'Togle Microphone could not start.')
    return this.status()
  }

  async turnOff(): Promise<TogleMicrophoneStatus> {
    this.forCall = false
    if (!this.connected) await this.refresh()
    if (this.connected) this.accept(await this.request('stop', { reason: 'user' }))
    this.publish()
    return this.status()
  }

  /** Opens Togle Microphone's window, starting the app first when it isn't running. */
  async show(page: MicrophoneLinkPage = 'settings'): Promise<void> {
    if (!this.connected) await this.refresh()
    if (this.connected) { await this.request('show', { page }); return }
    if (!this.file) throw new Error("Togle Microphone isn't installed.")
    await this.launch([], true)
  }

  private accept(value: unknown): void {
    const state = readLinkState(value)
    if (state) this.state = state
    this.publish()
  }

  private async readFile(): Promise<MicrophoneLinkFile | undefined> {
    try {
      return readLinkFile(JSON.parse(await fs.readFile(path.join(this.options.folder, MICROPHONE_LINK_FILE), 'utf8')))
    } catch {
      return undefined
    }
  }

  private watchFolder(): void {
    if (this.watcher || !this.started || !existsSync(this.options.folder)) return
    try {
      this.watcher = watch(this.options.folder, (_event, name) => {
        if (name && String(name) !== MICROPHONE_LINK_FILE) return
        clearTimeout(this.debounce)
        this.debounce = setTimeout(() => void this.refresh(), 250)
      })
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = undefined })
    } catch {
      this.watcher = undefined
    }
  }

  /** Only Togle Microphone's own pipe or socket. */
  private validSocket(socket: string): boolean {
    if (this.platform === 'win32') return /^\\\\\.\\pipe\\togle-microphone-[0-9a-f]{8,64}$/i.test(socket)
    if (!path.isAbsolute(socket) || !socket.endsWith('.sock')) return false
    const inside = (folder?: string): boolean => !!folder && path.dirname(socket) === path.resolve(folder)
    return inside(this.options.folder) || inside(process.env.XDG_RUNTIME_DIR)
  }

  private connect(): Promise<boolean> {
    return this.connecting ??= new Promise<boolean>(resolve => {
      const file = this.file
      if (!file || !this.validSocket(file.socket)) return resolve(false)
      const socket = net.connect(file.socket)
      const reader = new LinkLineReader()
      let settled = false
      const done = (ok: boolean): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(ok) } }
      const timer = setTimeout(() => { socket.destroy(); done(false) }, REQUEST_TIMEOUT_MS)
      socket.setEncoding('utf8')
      socket.on('data', chunk => {
        try { for (const message of reader.push(String(chunk))) this.receive(socket, message) }
        catch { socket.destroy() }
      })
      socket.on('error', () => done(false))
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = undefined
          this.connected = false
          this.rejectAll(new Error('Togle Microphone closed the link.'))
          this.publish()
        }
        done(false)
      })
      socket.once('connect', () => {
        this.socket = socket
        void (async () => {
          try {
            await this.request('hello', { token: file.token, client: this.options.client.name, version: this.options.client.version })
            const state = readLinkState(await this.request('state'))
            if (!state) throw new Error('Togle Microphone sent a state Togle does not understand.')
            this.state = state
            this.connected = true
            await this.request('watch')
            done(true)
          } catch {
            this.connected = false
            socket.destroy()
            done(false)
          }
        })()
      })
    }).finally(() => { this.connecting = undefined })
  }

  private disconnect(): void {
    const socket = this.socket
    this.socket = undefined
    this.connected = false
    this.rejectAll(new Error('Togle Microphone is not connected.'))
    socket?.destroy()
  }

  private receive(socket: net.Socket, message: unknown): void {
    if (socket !== this.socket) return
    const value = message as { id?: number; result?: unknown; error?: unknown; event?: string; data?: unknown }
    if (value.event === 'state') {
      const state = readLinkState(value.data)
      if (state && this.connected) { this.state = state; this.publish() }
      return
    }
    if (typeof value.id !== 'number') return
    const pending = this.pending.get(value.id)
    if (!pending) return
    this.pending.delete(value.id)
    clearTimeout(pending.timer)
    if (typeof value.error === 'string') pending.reject(new Error(value.error))
    else pending.resolve(value.result)
  }

  private request(method: MicrophoneLinkMethod, params?: object): Promise<unknown> {
    const socket = this.socket
    if (!socket || socket.destroyed) return Promise.reject(new Error('Togle Microphone is not connected.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Togle Microphone did not answer.'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(encodeLinkMessage({ id, method, ...(params ? { params } : {}) } as never))
    })
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id) }
  }

  private publish(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.last) return
    this.last = key
    this.emit('changed', status)
  }

  private waitFor(done: (status: TogleMicrophoneStatus) => boolean, ms: number): Promise<void> {
    if (done(this.status())) return Promise.resolve()
    return new Promise(resolve => {
      const finish = (): void => { clearTimeout(timer); clearInterval(look); this.off('changed', changed); resolve() }
      const changed = (status: TogleMicrophoneStatus): void => { if (done(status)) finish() }
      const timer = setTimeout(finish, ms)
      // A launched app writes its link file: the folder watcher sees it, and this looks too in case it can't.
      const look = setInterval(() => { if (!this.connected) void this.refresh() }, 1000)
      this.on('changed', changed)
    })
  }

  /** What link.json says starts Togle Microphone, if it's really Togle Microphone. */
  private launchCommand(extra: string[], visible: boolean): MicrophoneLaunch | undefined {
    const launch = this.file?.launch
    if (!launch) return
    const args = visible ? launch.args.filter(arg => arg !== '--hidden') : launch.args
    if (this.platform === 'win32') {
      if (!path.isAbsolute(launch.command) || !/\\Togle Microphone\.exe$/i.test(launch.command) || !existsSync(launch.command)) return
    } else if (this.platform === 'darwin') {
      if (launch.command !== '/usr/bin/open' || launch.args[0] !== '-b' || launch.args[1] !== 'io.togle.microphone') return
      if (extra.length && !args.includes('--args')) return { command: launch.command, args: [...args, '--args', ...extra] }
    } else if (!path.isAbsolute(launch.command) || !/togle[- ]?microphone/i.test(path.basename(launch.command)) || !existsSync(launch.command)) return
    return { command: launch.command, args: [...args, ...extra] }
  }

  private async launch(extra: string[], visible = false): Promise<void> {
    const launch = this.launchCommand(extra, visible)
    if (launch) {
      (this.options.run ?? runDetached)(launch)
      return
    }
    // Not a launch Togle can check: the app's own address starts it instead (it registers it when it runs).
    const action = extra.includes('--start') ? 'start' : 'open'
    if (!this.options.open) throw new Error("Togle Microphone can't be started from Togle. Open it from your apps.")
    await this.options.open(`${MICROPHONE_PROTOCOL}://${action}`)
  }
}

function runDetached(launch: MicrophoneLaunch): void {
  const child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', error => console.warn('[microphone] could not start Togle Microphone:', error.message))
  child.unref()
}
