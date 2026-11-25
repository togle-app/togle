// Reach on this device: its keys, its place among the person's devices, its connection to Studio's courier, adding a
// device by its code, and what passes between devices. Everything between two devices is locked for the two of them;
// the courier carries it and reads only who it is from and for.
//
// Between devices pass: the book (who is in the group, renewed passes, removals), the tasks a computer shares, and acts
// on a task from another device. This first part carries the acts that need no proof that the person is there: Refuse,
// Stop and its second press. Allow and Start, which need that proof, come with the proof.
//
// Not reviewed yet: Reach stays out of every release until an outside review has tried to break it.
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { Box, DeviceKind } from '@shared/courier-protocol'
import type { ActedHere, DeviceTasks, ReachDevice, ReachState, RemoteAct, RemoteTask } from '@shared/reach'
import type { TaskView } from '@shared/runner'
import { issuePass, lock, makeIdentity, normalCode, pairKey, unlock, type Identity, type Pass } from './crypto'
import { Book, type BookData } from './book'
import { CourierError, CourierLink, type LinkOptions } from './link'
import { Adding, Joining, codeFor, isCode, roomOf, type Candidate, type Welcome } from './pairing'
import { shareTasks } from './share'
import type { StudioAccount } from './studio-account'

/** Where Reach keeps what it must remember, encrypted by the system's keystore in the app. */
export interface ReachStore {
  read<T>(name: string): Promise<T | null>
  write(name: string, value: unknown | null): Promise<void>
}

/** What Reach needs of the agents on this computer. */
export interface ReachTasks {
  list(): Promise<TaskView[]>
  answer(key: string, request: string, decision: 'refuse'): void
  stop(key: string): Promise<void>
  endCommands(key: string): Promise<number>
}

export interface ReachOptions {
  courier: string
  store: ReachStore
  /** What this install is: the app on a computer you sit at, or the connector on a server. */
  kind: DeviceKind
  /** This device's name, as the person's other devices list it. */
  name: () => string
  account?: StudioAccount
  tasks?: ReachTasks
  now?: () => number
  open?: LinkOptions['open']
  delays?: number[]
}

/** What passes between two devices, inside a locked box. */
type Note =
  | { kind: 'book'; book: BookData }
  | { kind: 'tasks'; tasks: RemoteTask[]; at: number }
  | { kind: 'want'; at: number }
  | { kind: 'act'; act: RemoteAct; n: string; at: number }
  | { kind: 'acted'; n: string; ok: boolean; message?: string; at: number }

/** An act counts only this soon after it was made, and only once. */
const ACT_FRESH_MS = 2 * 60_000
const RENEW_EVERY_MS = 6 * 3600_000
const TASKS_WAIT_MS = 400

const FILES = { identity: 'reach-identity', book: 'reach-book', settings: 'reach-settings', acted: 'reach-acted' }

export class Reach extends EventEmitter<{ changed: []; acted: [ActedHere] }> {
  private readonly options: ReachOptions
  private identity?: Identity
  private book?: Book
  private link?: CourierLink
  private standing: ReachState['standing'] = 'alone'
  private addFromAnother = false
  private problem?: string
  private actOnThis = true
  private acted: ActedHere[] = []
  private readonly online = new Set<string>()
  private readonly remote = new Map<string, DeviceTasks>()
  private readonly keys = new Map<string, Buffer>()
  private readonly seen = new Map<string, number>()
  private readonly asked = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private shared = ''
  private sharing?: ReturnType<typeof setTimeout>
  private renewing?: ReturnType<typeof setInterval>
  private code?: { room: string; joining: Joining; expiresAt: number; joined: boolean; problem?: string }
  private codeWanted = false
  private codeTries = 0
  /** A device being added here: its room, and the exchange once the room is joined. */
  private adding?: { room: string; adding?: Adding; stage: NonNullable<ReachState['adding']>['stage']; candidate?: Candidate; message?: string }
  private started = false

  constructor(options: ReachOptions) {
    super()
    this.options = options
  }

  private get now(): number { return (this.options.now ?? Date.now)() }

  // ---- Starting and stopping ----------------------------------------------------------------------------------------

  /** Loads this device's keys and book (making its keys the first time) and connects when it is one of a group. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.identity = (await this.options.store.read<Identity>(FILES.identity)) ?? undefined
    if (!this.identity) {
      this.identity = makeIdentity()
      await this.options.store.write(FILES.identity, this.identity)
    }
    const saved = await this.options.store.read<{ standing?: ReachState['standing']; book?: BookData }>(FILES.book)
    if (saved?.book) this.book = new Book(this.identity.device, saved.book)
    if (saved?.standing === 'removed') this.standing = 'removed'
    else if (this.book?.get(this.identity.device)) this.standing = 'member'
    const settings = await this.options.store.read<{ actOnThis?: boolean }>(FILES.settings)
    this.actOnThis = settings?.actOnThis !== false
    this.acted = (await this.options.store.read<ActedHere[]>(FILES.acted)) ?? []
    this.link = new CourierLink({ url: this.options.courier, identity: this.identity, kind: this.options.kind, open: this.options.open, delays: this.options.delays })
    this.wire(this.link)
    if (this.standing === 'member') this.link.start()
    this.renewing = setInterval(() => void this.renew(), RENEW_EVERY_MS)
    this.renewing.unref?.()
    this.emit('changed')
  }

  stop(): void {
    clearInterval(this.renewing)
    clearTimeout(this.sharing)
    this.link?.stop()
    for (const waiter of this.asked.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Togle is closing.')) }
    this.asked.clear()
  }

  // ---- What the window shows ------------------------------------------------------------------------------------------

  state(): ReachState {
    const me = this.identity && this.book?.get(this.identity.device)
    const devices: ReachDevice[] = (this.book?.list() ?? []).map((pass) => ({
      device: pass.device, name: pass.name, role: pass.role, me: pass.device === this.identity?.device,
      online: pass.device === this.identity?.device ? this.link?.state === 'member' : this.online.has(pass.device),
      ...(pass.role === 'phone' ? { starts: !!pass.starts } : {})
    }))
    const who = this.options.account?.who()
    return {
      available: true,
      ...(who ? { account: { email: who.email } } : {}),
      link: this.link?.state ?? 'off',
      ...(this.link?.state === 'member' && this.link.welcome?.connection ? { connection: this.link.welcome.connection } : {}),
      standing: this.standing,
      ...(this.addFromAnother ? { addFromAnother: true } : {}),
      ...(me ? { me: { device: me.device, name: me.name, role: me.role } } : this.identity ? { me: { device: this.identity.device, name: this.options.name(), role: this.options.kind } } : {}),
      devices: devices.sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name)),
      ...(this.code ? { code: { code: this.code.joining.code, expiresAt: this.code.expiresAt, joined: this.code.joined, ...(this.code.problem ? { problem: this.code.problem } : {}) } } : {}),
      ...(this.adding ? { adding: { stage: this.adding.stage, ...(this.adding.candidate ? { name: this.adding.candidate.name, role: this.adding.candidate.kind } : {}), ...(this.adding.message ? { message: this.adding.message } : {}) } } : {}),
      actOnThis: this.actOnThis,
      acted: this.acted.slice(0, 20),
      ...(this.problem ? { problem: this.problem } : {})
    }
  }

  /** The tasks other devices shared, by device: computers and servers of the group whose passes hold. */
  remoteTasks(): DeviceTasks[] {
    const list: DeviceTasks[] = []
    for (const shared of this.remote.values()) {
      const pass = this.book?.trusted(shared.device, this.now)
      if (!pass) continue
      list.push({ ...shared, name: pass.name, role: pass.role, online: this.online.has(shared.device) })
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ---- Signing in, and the first computer -----------------------------------------------------------------------------

  /** Explicitly connect this computer after sign-in. An existing group still requires pairing. */
  async connectAccount(restart = false): Promise<void> {
    if (this.options.kind !== 'computer') throw new Error('Only a computer signs in. A server or a phone is added from a computer you use.')
    const token = await this.options.account?.token()
    if (!token) throw new Error('Sign in to your Togle account first.')
    this.problem = undefined
    this.link!.signInWith(token, restart)
    this.emit('changed')
  }

  /** Signs out of the Togle account. This computer stays paired through its device key. */
  async signOut(): Promise<void> {
    await this.options.account?.signOut()
    this.accountChanged()
  }

  accountChanged(): void {
    if (!this.options.account?.who()) this.addFromAnother = false
    this.emit('changed')
  }

  // ---- Showing a code (the new device) -----------------------------------------------------------------------------------

  /** Shows a code to type into a computer of the group; a new one comes by itself after a wrong try or when time is up. */
  async showCode(): Promise<void> {
    if (this.standing === 'member') throw new Error('This device is one of your devices already.')
    this.codeWanted = true
    this.codeTries = 0
    this.problem = undefined
    await this.openRoom()
  }

  cancelCode(): void {
    this.codeWanted = false
    if (this.code) this.link?.say({ t: 'room-close', room: this.code.room })
    this.code = undefined
    if (this.standing !== 'member' && !this.options.account?.who()) this.link?.stop()
    this.emit('changed')
  }

  private async openRoom(): Promise<void> {
    const link = this.link!
    if (link.state !== 'guest' && link.state !== 'member') {
      link.start()
      await this.until(() => link.state === 'guest' || link.state === 'member' || link.state === 'refused', 20_000)
    }
    if (link.state === 'refused') throw new Error(link.refusal?.message ?? 'Togle Studio turned this device away.')
    const session = randomBytes(16)
    const opened = await link.request({ t: 'room-open', session: session.toString('base64url') })
    if (!opened.room) throw new Error('Togle Studio gave no code.')
    const code = codeFor(opened.room)
    const { device, sign, agree } = this.identity!
    const me: Candidate = { device, sign, agree, kind: this.options.kind, name: this.options.name().slice(0, 60) || 'Computer' }
    this.code = { room: opened.room, joining: new Joining(code, session, me), expiresAt: opened.expiresAt ?? this.now + 600_000, joined: false }
    this.emit('changed')
  }

  /** The code's room ended without the device being added: another code, while the person still wants one. */
  private codeEnded(problem?: string): void {
    const had = this.code
    this.code = undefined
    if (!this.codeWanted || this.standing === 'member') { this.emit('changed'); return }
    if (++this.codeTries > 20) { this.codeWanted = false; this.problem = problem ?? 'No computer took the code. Show a new one when you are ready.'; this.emit('changed'); return }
    this.emit('changed')
    setTimeout(() => {
      if (!this.codeWanted || this.code) return
      void this.openRoom().then(() => {
        if (problem && this.code) { this.code.problem = problem; this.emit('changed') }
      }, (error: Error) => { this.problem = error.message; this.emit('changed') })
    }, had ? 500 : 0).unref?.()
  }

  // ---- Adding a device (a computer of the group) ----------------------------------------------------------------------

  /** The person typed another device's code: joins its room and runs the exchange, up to the person's yes. */
  async addByCode(typed: string): Promise<void> {
    if (this.options.kind !== 'computer' || this.standing !== 'member') throw new Error('Add a device at a computer that is one of your devices.')
    if (!isCode(typed)) throw new Error('A code is eight letters and digits, like 7F3K-92QD.')
    if (this.adding && this.adding.stage !== 'added' && this.adding.stage !== 'failed') throw new Error('A device is being added already.')
    const code = normalCode(typed)
    this.adding = { room: roomOf(code), stage: 'joining' }
    this.emit('changed')
    let joined
    try { joined = await this.link!.request({ t: 'room-join', room: roomOf(code) }) } catch (error) {
      this.adding = { ...this.adding, stage: 'failed', message: (error as Error).message }
      this.emit('changed')
      throw error
    }
    const session = Buffer.from(joined.session ?? '', 'base64url')
    if (session.length < 16) { this.adding = { ...this.adding, stage: 'failed', message: 'Togle Studio gave no session for that code.' }; this.emit('changed'); return }
    const adding = new Adding(code, session)
    this.adding = { room: roomOf(code), adding, stage: 'joining' }
    this.link!.say({ t: 'room-say', room: this.adding.room, data: adding.open() })
    this.emit('changed')
  }

  /** The person said yes to the device the add screen showed. */
  async confirmAdd(): Promise<void> {
    const current = this.adding
    if (!current?.adding || current.stage !== 'confirm' || !current.candidate) throw new Error('There is no device waiting to be added.')
    const { candidate } = current
    current.stage = 'adding'
    this.emit('changed')
    try {
      await this.link!.request({ t: 'enroll', device: candidate.device, sign: candidate.sign, agree: candidate.agree, kind: candidate.kind })
      const pass = issuePass(this.identity!, {
        device: candidate.device, sign: candidate.sign, agree: candidate.agree, name: candidate.name, role: candidate.kind,
        ...(candidate.presence ? { presence: candidate.presence } : {}), ...(candidate.kind === 'phone' ? { starts: false } : {})
      }, this.now)
      if (!this.book!.add(pass, this.now)) throw new Error('The new device’s pass didn’t hold.')
      await this.saveBook()
      const welcome: Welcome = { pass, adder: this.book!.get(this.identity!.device)!, book: this.book!.for(pass) }
      this.link!.say({ t: 'room-say', room: current.room, data: current.adding!.welcome(welcome) })
      await this.sendBookToAll()
    } catch (error) {
      current.stage = 'failed'
      current.message = (error as Error).message
      this.link?.say({ t: 'room-close', room: current.room })
    }
    this.emit('changed')
  }

  cancelAdd(): void {
    const current = this.adding
    if (current && current.stage !== 'added' && current.stage !== 'failed') {
      if (current.adding) this.link?.say({ t: 'room-say', room: current.room, data: current.adding.refuse() })
      this.link?.say({ t: 'room-close', room: current.room })
    }
    this.adding = undefined
    this.emit('changed')
  }

  // ---- The group ------------------------------------------------------------------------------------------------------

  /** Removes a device from the person's devices, at this computer. Other computers stop accepting it as they hear. */
  async remove(device: string): Promise<void> {
    if (this.options.kind !== 'computer' || this.standing !== 'member' || !this.book) throw new Error('Remove a device at a computer that is one of your devices.')
    if (device === this.identity!.device) throw new Error('This is the computer you are on.')
    if (!this.book.get(device)) throw new Error('That device is not one of yours.')
    this.book.remove(this.identity!, device, this.now)
    this.remote.delete(device)
    this.keys.delete(device)
    await this.saveBook()
    await this.sendBookToAll()
    // The courier lets it go too, so it can't reach your devices through Studio at all; the removal holds without that.
    await this.link?.request({ t: 'forget', device }).catch(() => undefined)
    this.emit('changed')
  }

  async setActOnThis(on: boolean): Promise<void> {
    this.actOnThis = on
    await this.options.store.write(FILES.settings, { actOnThis: on })
    this.emit('changed')
  }

  /** Something changed in this computer's tasks: shared with the person's other devices a moment later. */
  tasksChanged(): void {
    if (this.standing !== 'member' || !this.options.tasks) return
    clearTimeout(this.sharing)
    this.sharing = setTimeout(() => void this.shareTasks(), TASKS_WAIT_MS)
    this.sharing.unref?.()
  }

  /** Asks another device to refuse a request or stop a task of its own. */
  async act(device: string, act: RemoteAct): Promise<void> {
    if (this.standing !== 'member') throw new Error('This device is not one of your devices.')
    const pass = this.book?.trusted(device, this.now)
    if (!pass) throw new Error('That device is not one of yours now.')
    if (!this.online.has(device)) throw new Error(`${pass.name} is offline. It can be answered once it is back.`)
    const n = randomBytes(12).toString('base64url')
    const answered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.asked.delete(n); reject(new Error(`${pass.name} didn’t answer in time.`)) }, 15_000)
      timer.unref?.()
      this.asked.set(n, { resolve, reject, timer })
    })
    try {
      await this.send(device, { kind: 'act', act, n, at: this.now })
    } catch (error) {
      clearTimeout(this.asked.get(n)?.timer)
      this.asked.delete(n)
      throw error
    }
    await answered
  }

  // ---- The courier ------------------------------------------------------------------------------------------------------

  private wire(link: CourierLink): void {
    link.on('state', () => {
      if (link.state !== 'member') this.online.clear()
      this.emit('changed')
    })
    link.on('welcome', (welcome) => void this.welcomed(welcome.member, !!welcome.first, !!welcome.group, welcome.online))
    link.on('refused', (refused) => {
      this.problem = refused.message
      this.emit('changed')
    })
    link.on('online', (device, online) => {
      if (online) this.online.add(device); else this.online.delete(device)
      if (online && this.book?.trusted(device, this.now)) void this.greet(device)
      this.emit('changed')
    })
    link.on('box', (box) => void this.received(box).catch(() => undefined))
    // Removed at a computer of the person's, or their devices started again from another computer.
    link.on('forgotten', () => this.letGo())
    link.on('room-peer', (room) => {
      if (this.code?.room === room) { this.code.joined = true; this.emit('changed') }
    })
    link.on('room-say', (room, data) => this.roomSaid(room, data))
    link.on('room-closed', (room, reason) => {
      if (this.code?.room === room) return this.codeEnded(reason === 'expired' ? undefined : 'That code was used or closed. Here is a new one.')
      if (this.adding?.room === room && this.adding.stage !== 'added' && this.adding.stage !== 'failed') {
        this.adding.stage = 'failed'
        this.adding.message = reason === 'expired' ? 'The code ran out of time. Show a new one on the other device.' : 'The other device closed its code.'
        this.emit('changed')
      }
    })
  }

  private async welcomed(member: boolean, first: boolean, group: boolean, online: string[]): Promise<void> {
    const identity = this.identity!
    this.online.clear()
    for (const device of online) this.online.add(device)
    this.addFromAnother = !member && group
    if (member && first) {
      // This computer signed in and started the person's devices (or started them again).
      this.book = Book.start(identity, this.options.name().slice(0, 60) || 'Computer', undefined, this.now)
      this.standing = 'member'
      this.problem = undefined
      this.remote.clear()
      await this.saveBook()
    } else if (member && this.code && !this.code.joining.finished) {
      // Added a moment ago: the welcome with the book is on its way through the room.
    } else if (member && !this.book?.get(identity.device)) {
      this.problem = 'This device is on your Togle Studio account, but it lost its list of your devices. Remove it at a computer you use, then add it again.'
    } else if (!member && this.standing === 'member' && !this.code) {
      // The courier no longer knows this device: it was removed while it was off, or the devices started again elsewhere.
      this.letGo()
    }
    if (member && this.standing === 'member') {
      for (const device of online) if (this.book?.trusted(device, this.now)) void this.greet(device)
      void this.renew()
      this.tasksChanged()
    }
    this.emit('changed')
  }

  private roomSaid(room: string, data: string): void {
    if (this.code?.room === room) {
      const outcome = this.code.joining.receive(data)
      if (outcome.say) this.link?.say({ t: 'room-say', room, data: outcome.say })
      if (outcome.failed) {
        this.link?.say({ t: 'room-close', room })
        return this.codeEnded(outcome.failed)
      }
      if (outcome.result) void this.joined(room, outcome.result)
      return
    }
    const current = this.adding
    if (current?.room !== room || !current.adding) return
    const outcome = current.adding.receive(data)
    if (outcome.say) this.link?.say({ t: 'room-say', room, data: outcome.say })
    if (outcome.failed) {
      current.stage = 'failed'
      current.message = outcome.failed
      this.link?.say({ t: 'room-close', room })
    } else if (outcome.result === 'done') {
      current.stage = 'added'
      this.link?.say({ t: 'room-close', room })
    } else if (outcome.result) {
      current.candidate = outcome.result
      current.stage = 'confirm'
    }
    this.emit('changed')
  }

  /** This device was added: its book starts from the computer that added it. */
  private async joined(room: string, welcome: Welcome): Promise<void> {
    const book = Book.joined(this.identity!.device, welcome.adder, welcome.book, this.now)
    this.codeWanted = false
    this.code = undefined
    this.link?.say({ t: 'room-close', room })
    if (!book) {
      this.problem = 'The computer’s answer didn’t hold. Show a new code and try again.'
      this.emit('changed')
      return
    }
    this.book = book
    this.standing = 'member'
    this.problem = undefined
    await this.saveBook()
    for (const device of this.online) if (this.book.trusted(device, this.now)) void this.greet(device)
    this.tasksChanged()
    this.emit('changed')
  }

  // ---- Between devices --------------------------------------------------------------------------------------------------

  private keyFor(pass: Pass): Buffer {
    let key = this.keys.get(pass.device)
    if (!key) { key = pairKey(this.identity!, pass); this.keys.set(pass.device, key) }
    return key
  }

  private async send(device: string, note: Note): Promise<void> {
    const pass = this.book?.trusted(device, this.now)
    if (!pass || !this.identity) return
    const box: Box = lock(this.keyFor(pass), this.identity.device, device, note)
    await this.link!.request({ t: 'send', box })
  }

  /** A device came online (or this one did): it gets this device's book, its tasks when it may see them, and a wish for its own. */
  private async greet(device: string): Promise<void> {
    const pass = this.book?.trusted(device, this.now)
    if (!pass) return
    try {
      await this.send(device, { kind: 'book', book: this.book!.for(pass) })
      if (pass.role !== 'server' && this.options.tasks) await this.send(device, { kind: 'tasks', tasks: await this.myTasks(), at: this.now })
      await this.send(device, { kind: 'want', at: this.now })
    } catch { /* offline again; it is greeted when it is back */ }
  }

  private async sendBookToAll(): Promise<void> {
    for (const device of this.online) {
      const pass = this.book?.trusted(device, this.now)
      if (pass) await this.send(device, { kind: 'book', book: this.book!.for(pass) }).catch(() => undefined)
    }
  }

  private async myTasks(): Promise<RemoteTask[]> {
    return shareTasks(await this.options.tasks!.list(), this.now)
  }

  private async shareTasks(): Promise<void> {
    if (this.standing !== 'member' || !this.options.tasks) return
    const tasks = await this.myTasks()
    const text = JSON.stringify(tasks)
    if (text === this.shared) return
    this.shared = text
    for (const device of this.online) {
      const pass = this.book?.trusted(device, this.now)
      // A server only runs agents: it doesn't see the person's other devices.
      if (pass && pass.role !== 'server') await this.send(device, { kind: 'tasks', tasks, at: this.now }).catch(() => undefined)
    }
  }

  private async renew(): Promise<void> {
    if (this.standing !== 'member' || !this.book || !this.identity || this.options.kind !== 'computer') return
    const renewed = this.book.renew(this.identity, this.now)
    if (!renewed.length) return
    await this.saveBook()
    await this.sendBookToAll()
    this.emit('changed')
  }

  private async received(box: Box): Promise<void> {
    if (!this.identity || box.to !== this.identity.device || this.standing !== 'member') return
    const pass = this.book?.trusted(box.from, this.now)
    if (!pass) return
    let note: Note
    try { note = unlock<Note>(this.keyFor(pass), box) } catch { return }
    if (!note || typeof note !== 'object') return
    switch (note.kind) {
      case 'book': {
        if (!this.book!.merge(note.book, this.now)) return
        if (this.book!.wasRemoved(this.identity.device)) return this.letGo()
        await this.saveBook()
        this.emit('changed')
        return
      }
      case 'tasks': {
        if (pass.role === 'phone' || !Array.isArray(note.tasks)) return
        const previous = this.remote.get(pass.device)
        if (previous && previous.at > note.at) return
        this.remote.set(pass.device, { device: pass.device, name: pass.name, role: pass.role, online: true, tasks: note.tasks.slice(0, 60), at: note.at })
        this.emit('changed')
        return
      }
      case 'want':
        if (pass.role !== 'server' && this.options.tasks) await this.send(pass.device, { kind: 'tasks', tasks: await this.myTasks(), at: this.now }).catch(() => undefined)
        return
      case 'act':
        await this.actOn(pass, note)
        return
      case 'acted': {
        const waiter = this.asked.get(note.n)
        if (!waiter) return
        this.asked.delete(note.n)
        clearTimeout(waiter.timer)
        if (note.ok) waiter.resolve(); else waiter.reject(new Error(note.message ?? 'It wasn’t done.'))
        return
      }
    }
  }

  /** Another device asks this one to refuse a request or stop a task. Checked here; nothing the courier says counts. */
  private async actOn(pass: Pass, note: Extract<Note, { kind: 'act' }>): Promise<void> {
    const answer = (ok: boolean, message?: string): Promise<void> => this.send(pass.device, { kind: 'acted', n: note.n, ok, ...(message ? { message } : {}), at: this.now }).catch(() => undefined)
    if (typeof note.n !== 'string' || note.n.length > 40 || this.seen.has(note.n) || Math.abs(this.now - note.at) > ACT_FRESH_MS) return
    this.seen.set(note.n, this.now)
    for (const [n, at] of this.seen) if (this.now - at > 10 * 60_000) this.seen.delete(n)
    if (pass.role === 'server') return answer(false, 'A server only runs agents. It can’t act on your other devices.')
    if (!this.actOnThis) return answer(false, `${this.book?.get(this.identity!.device)?.name ?? 'That computer'} doesn’t take answers from other devices right now.`)
    const tasks = this.options.tasks
    const act = note.act
    if (!tasks || !act || typeof act.task !== 'string') return answer(false, 'That task is not here.')
    const task = (await tasks.list()).find((item) => item.key === act.task)
    if (!task) return answer(false, 'That task is gone.')
    if (!task.mine) return answer(false, 'Togle doesn’t run that task, so it is answered where it runs.')
    // A task in a terminal of Togle's own that Togle does not hear is answered only there. One that runs in the background
    // (Claude Code), with a screen or not, is refused and stopped like any other: through what Claude Code asks, and through
    // its own command to stop a session. No device ever types into its screen: a key could answer "1. Yes".
    if (task.terminal && !task.screen) return answer(false, 'That task runs in a terminal. It is answered only at its own computer.')
    try {
      let what: string
      if (act.what === 'refuse') {
        const request = task.pending.find((item) => item.id === act.request)
        if (!request || request.kind === 'question') return answer(false, 'That request was answered already.')
        tasks.answer(task.key, request.id, 'refuse')
        what = `Refused ${request.command ?? 'a change'} in ${task.title}`
      } else if (act.what === 'stop') {
        await tasks.stop(task.key)
        what = `Stopped ${task.title}`
      } else if (act.what === 'end-commands') {
        await tasks.endCommands(task.key)
        what = `Ended the commands of ${task.title}`
      } else return answer(false, 'From another device, a task can be refused or stopped.')
      const record: ActedHere = { at: this.now, device: pass.device, name: pass.name, what }
      this.acted = [record, ...this.acted].slice(0, 50)
      await this.options.store.write(FILES.acted, this.acted).catch(() => undefined)
      this.emit('acted', record)
      this.emit('changed')
      await answer(true)
    } catch (error) {
      await answer(false, (error as Error).message)
    }
  }

  // ---- Keeping --------------------------------------------------------------------------------------------------------------

  /** This device is no longer one of the person's devices: what it knew of them goes. Its own keys stay. */
  private letGo(): void {
    this.standing = 'removed'
    this.book = undefined
    this.remote.clear()
    this.online.clear()
    this.keys.clear()
    this.problem = undefined
    void this.saveBook()
    this.emit('changed')
  }

  private async saveBook(): Promise<void> {
    await this.options.store.write(FILES.book, { standing: this.standing, ...(this.book ? { book: this.book.data() } : {}) })
  }

  private async until(check: () => boolean, ms: number): Promise<void> {
    const began = Date.now()
    while (!check()) {
      if (Date.now() - began > ms) throw new CourierError('later', 'Togle Studio didn’t answer. Check the connection and try again.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

