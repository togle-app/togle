import { EventEmitter } from 'node:events'
import net from 'node:net'
import path from 'node:path'
import { existsSync, readFileSync, promises as fs, watch, type FSWatcher } from 'node:fs'
import { spawn } from 'node:child_process'
import {
  encodeLinkMessage, LinkLineReader, MICROPHONE_LINK_FILE, MICROPHONE_PRODUCT, MICROPHONE_PROTOCOL, readLinkFile, readLinkState,
  type MicrophoneLaunch, type MicrophoneLinkFile, type MicrophoneLinkMethod, type MicrophoneLinkPage, type MicrophoneLinkState
} from '@shared/microphone-link'
import { MICROPHONE_SIGN_IN, type MicrophoneSettings, type TogleMicrophoneStatus } from '@shared/microphone'

const REQUEST_TIMEOUT_MS = 5_000
/** How often Togle looks for Togle Studio when it isn't connected (a file read and a failed connect: cheap). */
const POLL_MS = 15_000
/** After a launch, how long to wait for it to come up. */
const LAUNCH_WAIT_MS = 15_000
/** A call doesn't wait longer than this for the clean microphone; capture follows the system input when it switches. */
const CALL_WAIT_MS = 4_000

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }

export interface MicrophoneLinkOptions {
  /** Togle Studio's user-data folder, where it writes link.json. */
  folder: string
  client: { name: string; version: string }
  platform?: NodeJS.Platform
  /** Starts a program, detached (tests replace it). */
  run?: (launch: MicrophoneLaunch) => void
  /** Opens a togle-studio:// address (tests replace it). */
  open?: (url: string) => Promise<void>
  /**
   * Togle runs from source: a development build of Togle Studio (Electron from a node_modules folder, given the
   * microphone app's own folder) may be started too. A packaged Togle only starts the installed app's program.
   */
  development?: boolean
  /**
   * Where the app wrote its link file while it was still called Togle Microphone (before release). Read only, never
   * watched (that would keep the renamed app from moving the folder), and only to start the renamed app.
   */
  previousFolder?: string
  /** Whether the system has an app for togle-studio:// addresses (the app registers one when it is installed). */
  handlesAddress?: () => boolean
  /** The installed program and how to start it, found by asking the computer (see studio-install.ts); none when it is not installed. */
  installed?: () => MicrophoneLaunch | undefined
}

/**
 * Finds Togle Studio on this computer and talks to it over its local link (see @shared/microphone-link): its
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
    return { installed: running || this.canStart(), running, ...(running ? { state: this.state } : {}), ...(this.forCall ? { forCall: true } : {}) }
  }

  /**
   * Installed means Togle can start it: the computer has it installed (the program its installer put there), its link
   * file names a program Togle starts, or the system has an app for its address. The link file alone says nothing: it
   * outlives the app (an uninstall, or a copy run from source and then gone) and is missing for an app that never ran.
   * One Togle cannot start must not read as installed: Open would do nothing, and every call would try to turn it on.
   */
  private canStart(): boolean {
    if (this.launchCommand([], true)) return true
    try { return !!this.options.handlesAddress?.() } catch { return false }
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

  /** Reads the link file again and connects if Togle Studio is running. */
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

  /** Before a call: turns Togle Studio on when it's installed and the setting asks for it. */
  async prepareCall(settings: MicrophoneSettings): Promise<TogleMicrophoneStatus> {
    const status = await this.refresh()
    if (!settings.autoStart || !status.installed || this.forCall) return status
    const phase = status.state?.phase
    // Signed out of Togle Studio: it can't start, and a call is no moment to open its sign-in. Togle shows that instead.
    if (phase === 'on' || phase === 'starting' || status.state?.setup === 'missing' || status.state?.setup === 'restart' || status.state?.account === 'signed-out') return status
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
      if (!this.canStart()) throw new Error("Togle Studio isn't installed.")
      await this.launch(['--start'])
      await this.waitFor(status => status.running, wait)
      if (!this.connected) throw new Error("Togle Studio didn't start.")
    }
    if (this.state?.account === 'signed-out') {
      // Asked by the user: its window opens at the sign-in.
      if (reason === 'user') await this.request('show', { page: 'settings' }).catch(() => undefined)
      throw new Error(MICROPHONE_SIGN_IN)
    }
    if (this.state?.phase !== 'on' && this.state?.phase !== 'starting') this.accept(await this.request('start', { reason }))
    await this.waitFor(status => status.state?.phase === 'on' || status.state?.phase === 'error', Math.min(wait, CALL_WAIT_MS))
    if (this.state?.phase === 'error') throw new Error(this.state.error || 'Togle Studio could not start.')
    return this.status()
  }

  async turnOff(): Promise<TogleMicrophoneStatus> {
    this.forCall = false
    if (!this.connected) await this.refresh()
    if (this.connected) this.accept(await this.request('stop', { reason: 'user' }))
    this.publish()
    return this.status()
  }

  /** Opens Togle Studio's window, starting the app first when it isn't running. */
  async show(page: MicrophoneLinkPage = 'settings'): Promise<void> {
    if (!this.connected) await this.refresh()
    if (this.connected) { await this.request('show', { page }); return }
    if (!this.canStart()) throw new Error("Togle Studio isn't installed.")
    await this.launch([], true)
  }

  private accept(value: unknown): void {
    const state = readLinkState(value)
    if (state) this.state = state
    this.publish()
  }

  private async readFile(): Promise<MicrophoneLinkFile | undefined> {
    const read = async (folder: string): Promise<unknown> => JSON.parse(await fs.readFile(path.join(folder, MICROPHONE_LINK_FILE), 'utf8'))
    try {
      return readLinkFile(await read(this.options.folder))
    } catch {
      if (!this.options.previousFolder) return undefined
    }
    // The app's link from before it was renamed: good for starting it (it moves its folder and writes a new link), not for talking to it.
    try {
      const old = await read(this.options.previousFolder) as { product?: unknown; socket?: unknown } | null
      if (old?.product !== 'Togle Microphone') return undefined
      return readLinkFile({ ...old, product: MICROPHONE_PRODUCT })
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

  /** Only Togle Studio's own pipe or socket. */
  private validSocket(socket: string): boolean {
    if (this.platform === 'win32') return /^\\\\\.\\pipe\\togle-studio-[0-9a-f]{8,64}$/i.test(socket)
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
          this.rejectAll(new Error('Togle Studio closed the link.'))
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
            if (!state) throw new Error('Togle Studio sent a state Togle does not understand.')
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
    this.rejectAll(new Error('Togle Studio is not connected.'))
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
    if (!socket || socket.destroyed) return Promise.reject(new Error('Togle Studio is not connected.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Togle Studio did not answer.'))
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

  /** What starts Togle Studio: what its link file says, if that is really Togle Studio, else the program installed on this computer. */
  private launchCommand(extra: string[], visible: boolean): MicrophoneLaunch | undefined {
    const fromFile = this.launchFromFile(extra, visible)
    if (fromFile) return fromFile
    const installed = this.options.installed?.()
    if (!installed) return
    const args = visible ? installed.args.filter(arg => arg !== '--hidden') : installed.args
    return { command: installed.command, args: [...args, ...(extra.length && this.platform === 'darwin' && !args.includes('--args') ? ['--args'] : []), ...extra] }
  }

  /** What link.json says starts Togle Studio, if it's really Togle Studio. */
  private launchFromFile(extra: string[], visible: boolean): MicrophoneLaunch | undefined {
    const launch = this.file?.launch
    if (!launch) return
    const args = visible ? launch.args.filter(arg => arg !== '--hidden') : launch.args
    if (this.options.development && this.developmentBuild(launch)) return { command: launch.command, args: [...args, ...extra] }
    if (this.platform === 'win32') {
      if (!path.isAbsolute(launch.command) || !/\\Togle Studio\.exe$/i.test(launch.command) || !existsSync(launch.command)) return
    } else if (this.platform === 'darwin') {
      if (launch.command !== '/usr/bin/open' || launch.args[0] !== '-b' || launch.args[1] !== 'io.togle.studio') return
      if (extra.length && !args.includes('--args')) return { command: launch.command, args: [...args, '--args', ...extra] }
    } else if (!path.isAbsolute(launch.command) || !/togle[- ]?studio/i.test(path.basename(launch.command)) || !existsSync(launch.command)) return
    return { command: launch.command, args: [...args, ...extra] }
  }

  /** A development build of Togle Studio: Electron from a node_modules folder, run on the microphone app's folder. */
  private developmentBuild(launch: MicrophoneLaunch): boolean {
    const electron = this.platform === 'win32'
      ? /[\\/]node_modules[\\/]electron[\\/]dist[\\/]electron\.exe$/i
      : /[\\/]node_modules[\\/]electron[\\/]dist[\\/](?:electron|Electron\.app[\\/]Contents[\\/]MacOS[\\/]Electron)$/
    const folder = launch.args[0]
    if (!path.isAbsolute(launch.command) || !electron.test(launch.command) || !existsSync(launch.command) || !folder || !path.isAbsolute(folder)) return false
    try { return (JSON.parse(readFileSync(path.join(folder, 'package.json'), 'utf8')) as { productName?: unknown }).productName === MICROPHONE_PRODUCT }
    catch { return false }
  }

  private async launch(extra: string[], visible = false): Promise<void> {
    const launch = this.launchCommand(extra, visible)
    if (launch) {
      await (this.options.run ?? runDetached)(launch)
      return
    }
    // Not a launch Togle can check: the app's own address starts it instead (it registers it when it runs).
    const action = extra.includes('--start') ? 'start' : 'open'
    if (!this.options.open) throw new Error(COULD_NOT_START)
    try { await this.options.open(`${MICROPHONE_PROTOCOL}://${action}`) }
    catch { throw new Error(COULD_NOT_START) }
  }
}

const COULD_NOT_START = "Togle couldn't start Togle Studio. Open it from your apps, then try again."

/**
 * The environment Togle Studio starts with: Togle's, minus what was meant for Togle alone. Above all its development
 * server's address (ELECTRON_RENDERER_URL), which made Togle Studio load Togle's page and show a blank window.
 */
export function launchEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !/^(?:ELECTRON_RENDERER_URL|ELECTRON_RUN_AS_NODE|ELECTRON_ENABLE_LOGGING|ELECTRON_ENABLE_STACK_DUMPING|ELECTRON_NO_ATTACH_CONSOLE|NODE_ENV|NODE_OPTIONS|VITE_.*|TOGLE_.*)$/i.test(key)))
}

/**
 * Starts a program, detached. Says so when it could not be started, which Open must show: a program that is gone, or one
 * macOS's `open` cannot find the app for (that one hands the app to the system and ends, with an error when there is none,
 * so it is waited for). A program that runs on is started.
 */
export function startProgram(
  launch: MicrophoneLaunch,
  environment: NodeJS.ProcessEnv = launchEnvironment(),
  waitForExit = path.basename(launch.command) === 'open'
): Promise<void> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try { child = spawn(launch.command, launch.args, { detached: true, stdio: 'ignore', windowsHide: false, env: environment }) }
    catch (error) { console.warn('[microphone] could not start Togle Studio:', (error as Error).message); return reject(new Error(COULD_NOT_START)) }
    const failed = (why: string): void => { console.warn('[microphone] could not start Togle Studio:', why); reject(new Error(COULD_NOT_START)) }
    let timer: NodeJS.Timeout | undefined
    child.once('error', error => { clearTimeout(timer); failed(error.message) })
    if (waitForExit) {
      timer = setTimeout(resolve, 5_000)
      child.once('exit', code => { clearTimeout(timer); if (code) failed(`${path.basename(launch.command)} ended with ${code}`); else resolve() })
    } else {
      child.once('spawn', () => resolve())
    }
    child.unref()
  })
}

const runDetached = (launch: MicrophoneLaunch): Promise<void> => startProgram(launch)
