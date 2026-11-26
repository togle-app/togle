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
import path from 'node:path'
import type { Box, DeviceKind } from '@shared/courier-protocol'
import { isPhoneQuery, isSessionReport, type PhoneDelivery, type PhoneQuery, type PhoneReport, type PhoneSessionReport } from '@shared/phone-report'
import type { ActedHere, DeviceTasks, ReachDevice, ReachState, RemoteAct, RemoteTask } from '@shared/reach'
import type { TaskView } from '@shared/runner'
import { issuePass, lock, makeIdentity, normalCode, pairKey, unlock, type Identity, type Pass } from './crypto'
import { Book, type BookData } from './book'
import { CourierError, CourierLink, type LinkOptions } from './link'
import { formatRecoveryKey, makeRecoveryKey, parseRecoveryKey, recoveryPublicKey, type RecoveryKey } from './recovery'
import { Adding, Joining, codeFor, isCode, roomOf, type Candidate, type Welcome } from './pairing'
import { phoneReport, type PhoneReportSources } from './phone-report'
import { canMessageFromPhone, pilotQuestion, recentTasks, sharePhoneSummaries, sharePhoneTasks, shareTasks } from './share'
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
  replyChoice(key: string, inputId: string, choice: number): void
  stop(key: string): Promise<void>
  endCommands(key: string): Promise<number>
  phone?: PhoneReportSources
  phoneMessage?(key: string, text: string, quote?: string): Promise<PhoneDelivery>
  phoneQueue?(key: string, revision: string, action: 'send' | 'remove', index?: number): Promise<void>
}

export interface ReachOptions {
  approveDeviceChange?: (operation: 'enable' | 'recover' | 'save') => Promise<void>
  courier: string
  store: ReachStore
  /** What this install is: the app on a computer you sit at, or the connector on a server. */
  kind: DeviceKind
  /** This device's name, as the person's other devices list it. */
  name: () => string
  account?: StudioAccount
  tasks?: ReachTasks
  /** Opt-in for listed Codex answers from paired controllers in the private pilot. */
  phonePilot?: boolean
  /** Independent opt-in to share scoped session activity and provider usage with a paired phone. */
  phoneActivity?: boolean
  /** Also share this host’s provider-wide totals and limits outside the shared folder. */
  accountUsage?: boolean
  /** Shares scoped conversations with paired computers in the development pilot. */
  desktopActivity?: boolean
  /** Opt-in to typed replies and their controls in a development host's shared folder. */
  phoneMessages?: boolean
  /** When supplied in the pilot, only this exact absolute workspace is shared or acted upon. */
  pilotFolder?: string
  now?: () => number
  open?: LinkOptions['open']
  delays?: number[]
}

/** What passes between two devices, inside a locked box. */
type Note =
  | { kind: 'book'; book: BookData }
  | { kind: 'tasks'; tasks: RemoteTask[]; at: number; canAct?: boolean; phoneReports?: boolean; desktopReports?: boolean }
  | { kind: 'want'; at: number }
  | { kind: 'act'; act: RemoteAct; n: string; at: number }
  | { kind: 'acted'; n: string; ok: boolean; message?: string; delivery?: PhoneDelivery; at: number }
  | { kind: 'phone-read'; n: string; at: number; query: PhoneQuery }
  | { kind: 'phone-report'; n: string; report?: PhoneReport }

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
  private savingReceipts: Promise<void> = Promise.resolve()
  private readonly asked = new Map<string, { device: string; resolve: (delivery?: PhoneDelivery) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private readonly shared = new Map<string, string>()
  private readonly reporting = new Set<string>()
  private readonly sessionReads = new Map<string, {
    device: string
    task: string
    resolve: (report: PhoneSessionReport) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly phoneSends = new Map<string, { request: string; delivery: Promise<PhoneDelivery>; done: boolean }>()
  private readonly sendingToTasks = new Set<string>()
  private sharing?: ReturnType<typeof setTimeout>
  private renewing?: ReturnType<typeof setInterval>
  private code?: { room: string; joining: Joining; expiresAt: number; joined: boolean; problem?: string }
  private codeWanted = false
  private codeTries = 0
  /** A device being added here: its room, and the exchange once the room is joined. */
  private adding?: { room: string; adding?: Adding; stage: NonNullable<ReachState['adding']>['stage']; candidate?: Candidate; message?: string }
  private boundAccount?: string
  private legacyBinding = false
  private verifyingAccount?: string
  private claimingOwner = false
  private changingGroup = false
  private copyingRecovery = false
  private recovery?: { account: string; key: RecoveryKey }
  private invite?: { code: string; expiresAt: number; joined: boolean }
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
    this.recovery = (await this.options.store.read<{ account: string; key: RecoveryKey }>('reach-recovery')) ?? undefined
    const saved = await this.options.store.read<{ standing?: ReachState['standing']; book?: BookData; account?: string }>(FILES.book)
    this.boundAccount = saved?.account
    this.legacyBinding = this.options.kind === 'computer' && !!saved?.book && !Object.hasOwn(saved, 'account')
    if (saved?.book) this.book = new Book(this.identity.device, saved.book)
    if (saved?.standing === 'removed') this.standing = 'removed'
    else if (this.book?.get(this.identity.device)) this.standing = 'member'
    const seen = await this.options.store.read<[string, number][]>('reach-action-receipts')
    for (const [key, expires] of seen ?? []) if (Number.isFinite(expires) && expires >= this.now) this.seen.set(key, expires)
    const settings = await this.options.store.read<{ actOnThis?: boolean }>(FILES.settings)
    this.actOnThis = settings?.actOnThis !== false
    this.acted = (await this.options.store.read<ActedHere[]>(FILES.acted)) ?? []
    this.link = new CourierLink({
      url: this.options.courier, identity: this.identity, kind: this.options.kind, open: this.options.open, delays: this.options.delays,
      accountToken: async () => {
        if (!this.boundAccount && !this.legacyBinding) return undefined
        const user = this.options.account?.who()?.user
        const token = await this.options.account?.token()
        if (!token || !user || user !== this.options.account?.who()?.user || this.accountPaused()) throw new Error('Sign in to resume remote access.')
        return token
      }
    })
    this.wire(this.link)
    if (this.standing === 'member' && !this.accountPaused()) {
      if (this.boundAccount || this.legacyBinding || this.legacyOwner()) await this.connectAccount().catch(() => undefined)
      else this.link.start()
    }
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
    this.checkSessionReads()
  }

  // ---- What the window shows ------------------------------------------------------------------------------------------

  state(): ReachState {
    if (this.accountPaused() || this.legacyBinding) return { available: true, standing: 'alone', link: 'off', devices: [], acted: [], actOnThis: false, accountPaused: true }
    const me = this.identity && this.book?.get(this.identity.device)
    const devices: ReachDevice[] = (this.book?.list() ?? []).map((pass) => ({
      device: pass.device, name: pass.name, role: pass.role, me: pass.device === this.identity?.device,
      online: pass.device === this.identity?.device ? this.link?.state === 'member' : this.online.has(pass.device),
      ...(pass.role === 'phone' ? { starts: !!pass.starts } : {})
    }))
    const who = this.options.account?.who()
    return {
      available: true,
      ...(this.options.phonePilot && this.options.kind === 'computer' ? { phonePilot: true } : {}),
      ...(who ? { account: { email: who.email } } : {}),
      link: this.link?.state ?? 'off',
      ...(this.link?.state === 'member' && this.link.welcome?.connection ? { connection: this.link.welcome.connection } : {}),
      standing: this.standing,
      canManageDevices: !!this.identity && !!this.book?.manages(this.identity.device),
      ...(this.invite && this.link?.state === 'member' ? { invite: this.invite } : {}),
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
    if (this.accountPaused() || this.legacyBinding || this.standing !== 'member' || !this.book || this.options.kind === 'server') return []
    const peers = this.options.kind === 'computer' ? this.book.list().map(pass => pass.device) : this.remote.keys()
    const list: DeviceTasks[] = []
    for (const device of peers) {
      const pass = this.book.trusted(device, this.now)
      if (!pass || pass.device === this.identity?.device || pass.role === 'phone') continue
      const shared = this.remote.get(device)
      list.push({
        device, name: pass.name, role: pass.role, online: this.online.has(device),
        tasks: shared?.tasks ?? [], at: shared?.at ?? 0,
        ...(shared?.canAct === undefined ? {} : { canAct: shared.canAct }),
        ...(shared?.phoneReports ? { phoneReports: true } : {}),
        ...(shared?.desktopReports ? { desktopReports: true } : {})
      })
    }
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }

  // ---- Signing in, and the first computer -----------------------------------------------------------------------------

  /** A local decision enables sharing for a new device group. Existing members reconnect automatically. */
  async connectAccount(recoveryInput?: string): Promise<void> {
    if (!this.identity || !this.link || this.options.kind !== 'computer') throw new Error('Open Togle on the computer you want to connect.')
    if (this.accountPaused()) throw new Error('Sign in with the Togle account that connected this computer.')
    const account = this.options.account?.who()?.user
    if (!account) throw new Error('Sign in to your Togle account first.')
    const resuming = this.standing === 'member'
    if (resuming && recoveryInput) throw new Error('Use Togle on your replacement computer to recover your devices.')
    if (this.changingGroup) throw new Error('A device connection is already in progress.')
    const previous = recoveryInput === undefined ? undefined : parseRecoveryKey(recoveryInput)
    if (previous?.owner === this.identity.device) throw new Error('You are already using the computer in this recovery key.')
    this.changingGroup = true
    try {
      if (!resuming) {
        await this.options.approveDeviceChange?.(previous ? 'recover' : 'enable')
        if (account !== this.options.account?.who()?.user) throw new Error('Sign in with your Togle account first.')
        this.cancelCode()
      }
      const token = await this.options.account?.token()
      if (!token || account !== this.options.account?.who()?.user) throw new Error('Sign in to your Togle account first.')
      this.problem = undefined
      this.verifyingAccount = account
      this.claimingOwner = !resuming
      const recovery = resuming ? undefined : recoveryPublicKey(await this.localRecoveryKey(account))
      if (account !== this.options.account?.who()?.user) throw new Error('Sign in with your Togle account first.')
      this.link.signInWith(token, resuming ? {} : { recovery, previous })
      this.emit('changed')
      if (!resuming) {
        await this.until(() => this.link?.state === 'refused' || this.standing === 'member', 20_000)
        if (this.standing !== 'member') throw new Error(this.problem ?? 'Togle couldn’t connect your computer.')
      }
    } catch (error) {
      if (!resuming && this.standing !== 'member') {
        this.claimingOwner = false
        this.verifyingAccount = undefined
        this.link.stop()
      }
      throw error
    } finally {
      this.changingGroup = false
    }
  }

  private async localRecoveryKey(account: string): Promise<RecoveryKey> {
    if (this.recovery?.account === account && this.recovery.key.owner === this.identity!.device) return this.recovery.key
    const recovery = { account, key: makeRecoveryKey(this.identity!.device) }
    await this.options.store.write('reach-recovery', recovery)
    this.recovery = recovery
    return recovery.key
  }

  async recoveryKeyForCopy(): Promise<string> {
    const account = this.options.account?.who()?.user
    if (!account || this.accountPaused() || !this.identity || !this.book?.manages(this.identity.device) || this.link?.state !== 'member') {
      throw new Error('Open Devices on the computer that manages the group.')
    }
    if (this.copyingRecovery) throw new Error('Recovery key confirmation is already open.')
    this.copyingRecovery = true
    try {
      await this.options.approveDeviceChange?.('save')
      if (this.options.account?.who()?.user !== account || this.link.state !== 'member') throw new Error('Open Devices on the computer that manages the group.')
      const legacy = this.link.welcome?.recoveryConfigured === false
      const saved = this.recovery?.account === account && this.recovery.key.owner === this.identity.device ? this.recovery.key : undefined
      const key = saved ?? (legacy ? await this.localRecoveryKey(account) : undefined)
      if (!key) throw new Error('This computer no longer holds the recovery key.')
      if (legacy) {
        await this.link.request({ t: 'set-recovery', recovery: recoveryPublicKey(key) })
        if (this.link.welcome) this.link.welcome.recoveryConfigured = true
      }
      if (this.options.account?.who()?.user !== account || !this.book?.manages(key.owner)) throw new Error('Open Devices on the computer that manages the group.')
      return formatRecoveryKey(key)
    } finally {
      this.copyingRecovery = false
    }
  }

  /** Signing out pauses this account’s paired connection on this computer. */
  async signOut(): Promise<void> {
    await this.options.account?.signOut()
    this.accountChanged()
  }

  accountChanged(): void {
    if (!this.link) return
    if (!this.options.account?.who() || this.accountPaused()) {
      this.claimingOwner = false
      this.verifyingAccount = undefined
      this.addFromAnother = false
      this.codeWanted = false
      this.code = undefined
      this.adding = undefined
      this.invite = undefined
      this.link.stop()
      this.remote.clear()
      this.online.clear()
      this.keys.clear()
      for (const waiter of this.asked.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('Remote access is paused.')) }
      this.asked.clear()
    } else if (this.standing === 'member' && ((!this.boundAccount && !this.verifyingAccount) || this.link.state === 'off')) {
      void this.connectAccount().catch(() => undefined)
    }
    this.emit('changed')
  }

  private legacyOwner(): boolean {
    const me = this.identity && this.book?.get(this.identity.device)
    return !!me && me.issuer === me.device && this.options.kind === 'computer'
  }

  private accountPaused(): boolean {
    const user = this.options.account?.who()?.user
    return this.boundAccount ? user !== this.boundAccount : (this.legacyBinding || this.legacyOwner()) && !user
  }

  // ---- Showing a code (the new device) -----------------------------------------------------------------------------------

  /** Shows a code to type into a computer of the group; a new one comes by itself after a wrong try or when time is up. */
  async showCode(): Promise<void> {
    if (this.accountPaused()) throw new Error('Sign in with the Togle account that connected this computer.')
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
      const user = this.options.account?.who()?.user
      if (user) {
        const token = await this.options.account?.token()
        if (!token || user !== this.options.account?.who()?.user || !this.codeWanted) throw new Error('Sign in again to pair this computer.')
        link.signInWith(token, { pairOnly: true })
      } else link.start()
      await this.until(() => link.state === 'guest' || link.state === 'member' || link.state === 'refused', 20_000)
    }
    if (link.state === 'refused') throw new Error(link.refusal?.message ?? 'Togle Studio turned this device away.')
    const session = randomBytes(16)
    if (!this.codeWanted || this.accountPaused()) return
    const opened = await link.request({ t: 'room-open', session: session.toString('base64url') })
    if (!this.codeWanted || this.accountPaused()) {
      if (opened.room) link.say({ t: 'room-close', room: opened.room })
      return
    }
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

  /** Creates a one-time invitation. The secret in its QR code stays off the relay. */
  async openInvite(): Promise<void> {
    const link = this.link
    if (link?.state !== 'member' || link.welcome?.connection !== 'on' || !this.identity || !this.book?.manages(this.identity.device)) {
      throw new Error('Open Devices on the computer that manages the group.')
    }
    if (this.adding && this.adding.stage !== 'added' && this.adding.stage !== 'failed') throw new Error('A device is being added already.')
    const session = randomBytes(16)
    const secret = randomBytes(32).toString('hex').toUpperCase()
    const adding = new Adding(secret, session)
    this.adding = { room: '', adding, stage: 'joining' }
    const pending = this.adding
    this.emit('changed')
    try {
      const { room, expiresAt } = await link.request({ t: 'invite-open', session: session.toString('base64url') })
      if (!room || !/^[A-Za-z0-9_-]{22}$/.test(room) || !expiresAt) throw new Error('Togle couldn’t create a pairing invitation.')
      if (link.state !== 'member' || this.adding !== pending) {
        link.say({ t: 'room-close', room })
        return
      }
      pending.room = room
      this.invite = { code: `togle-pair:v1:${room}:${secret}`, expiresAt, joined: false }
    } catch (error) {
      if (this.adding === pending) this.adding = undefined
      throw error
    } finally {
      this.emit('changed')
    }
  }

  /** The person typed another device's code: joins its room and runs the exchange, up to the person's yes. */
  async addByCode(typed: string): Promise<void> {
    if (!this.identity || !this.book?.manages(this.identity.device)) throw new Error('Add devices on the computer that manages this group.')
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
    if (!this.identity || !this.book?.manages(this.identity.device)) throw new Error('Add devices on the computer that manages this group.')
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
    this.invite = undefined
    this.emit('changed')
  }

  // ---- The group ------------------------------------------------------------------------------------------------------

  /** Removes a device from the person's devices, at this computer. Other computers stop accepting it as they hear. */
  async remove(device: string): Promise<void> {
    if (this.options.kind !== 'computer' || this.standing !== 'member' || !this.book) throw new Error('Remove a device at a computer that is one of your devices.')
    if (device === this.identity!.device) throw new Error('This is the computer you are on.')
    if (!this.book.get(device)) throw new Error('That device is not one of yours.')
    if (!this.book.manages(this.identity!.device)) throw new Error('Remove devices on the computer that manages this group.')
    await this.link!.request({ t: 'forget', device })
    this.book.remove(this.identity!, device, this.now)
    this.remote.delete(device)
    this.checkSessionReads()
    this.keys.delete(device)
    await this.saveBook()
    await this.sendBookToAll()
    this.emit('changed')
  }

  async setActOnThis(on: boolean): Promise<void> {
    this.actOnThis = on
    this.tasksChanged()
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

  /** Sends an action to the device that owns the task and waits for its receipt. */
  async act(device: string, act: RemoteAct): Promise<PhoneDelivery | undefined> {
    if (this.standing !== 'member') throw new Error('This device is not one of your devices.')
    const pass = this.book?.trusted(device, this.now)
    if (!pass) throw new Error('That device is not one of yours now.')
    if (!this.online.has(device)) throw new Error(`${pass.name} is offline. It can be answered once it is back.`)
    const n = randomBytes(12).toString('base64url')
    const answered = new Promise<PhoneDelivery | undefined>((resolve, reject) => {
      const timer = setTimeout(() => { this.asked.delete(n); reject(new Error(`${pass.name} didn’t answer in time.`)) }, 15_000)
      timer.unref?.()
      this.asked.set(n, { device, resolve, reject, timer })
    })
    try {
      const [delivery] = await Promise.all([answered, this.send(device, { kind: 'act', act, n, at: this.now })])
      return delivery
    } finally {
      clearTimeout(this.asked.get(n)?.timer)
      this.asked.delete(n)
    }
  }

  async readSession(device: string, task: string): Promise<PhoneSessionReport> {
    if (!this.canReadSession(device, task)) throw new Error('This device is not sharing that conversation.')
    const n = randomBytes(12).toString('base64url')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finishSessionRead(n), 15_000)
      timer.unref?.()
      this.sessionReads.set(n, { device, task, resolve, reject, timer })
      void this.send(device, { kind: 'phone-read', n, at: this.now, query: { kind: 'session', task, view: 'chat' } })
        .catch(() => this.finishSessionRead(n))
    })
  }

  private canReadSession(device: string, task: string): boolean {
    if (this.options.kind !== 'computer' || !this.connectedDevice(device, 'computer')) return false
    const shared = this.remote.get(device)
    return shared?.desktopReports === true && shared.tasks.some(item => item.key === task && item.mine)
  }

  private connectedDevice(device: string, role: DeviceKind): boolean {
    return this.standing === 'member' && this.link?.state === 'member' && this.link.welcome?.connection === 'on' &&
      this.online.has(device) && this.book?.trusted(device, this.now)?.role === role
  }

  private finishSessionRead(n: string, report?: unknown): void {
    const read = this.sessionReads.get(n)
    if (!read) return
    this.sessionReads.delete(n)
    clearTimeout(read.timer)
    if (isSessionReport(report, read.task) && this.canReadSession(read.device, read.task)) read.resolve(report)
    else read.reject(new Error('The conversation is unavailable.'))
  }

  private checkSessionReads(): void {
    for (const [n, read] of this.sessionReads)
      if (!this.canReadSession(read.device, read.task)) this.finishSessionRead(n)
  }

  // ---- The courier ------------------------------------------------------------------------------------------------------

  private wire(link: CourierLink): void {
    link.on('state', () => {
      if (link.state !== 'member') {
        this.online.clear()
        if (this.invite) {
          this.invite = undefined
          this.adding = undefined
        }
      }
      this.checkSessionReads()
      this.emit('changed')
    })
    link.on('welcome', (welcome) => void this.welcomed(welcome.member, !!welcome.first, !!welcome.group, welcome.online, welcome.owner))
    link.on('refused', (refused) => {
      this.verifyingAccount = undefined
      this.claimingOwner = false
      this.problem = refused.message
      this.emit('changed')
    })
    link.on('online', (device, online) => {
      if (online) this.online.add(device); else this.online.delete(device)
      this.checkSessionReads()
      if (online && this.book?.trusted(device, this.now)) void this.greet(device)
      this.emit('changed')
    })
    link.on('box', (box) => void this.received(box).catch(() => undefined))
    // Removed at a computer of the person's, or their devices started again from another computer.
    link.on('forgotten', () => this.letGo())
    link.on('room-peer', (room) => {
      if (this.code?.room === room) { this.code.joined = true; this.emit('changed') }
      const current = this.adding
      if (!this.invite || this.invite.joined || current?.room !== room || !current.adding) return
      this.invite = { ...this.invite, joined: true }
      link.say({ t: 'room-say', room, data: current.adding.open() })
      this.emit('changed')
    })
    link.on('room-say', (room, data) => this.roomSaid(room, data))
    link.on('room-closed', (room, reason) => {
      if (this.code?.room === room) return this.codeEnded(reason === 'expired' ? undefined : 'That code was used or closed. Here is a new one.')
      if (this.adding?.room === room && this.adding.stage !== 'added' && this.adding.stage !== 'failed') {
        this.invite = undefined
        this.adding.stage = 'failed'
        this.adding.message = reason === 'expired' ? 'The code ran out of time. Show a new one on the other device.' : 'The other device closed its code.'
        this.emit('changed')
      }
    })
  }

  private async welcomed(member: boolean, first: boolean, group: boolean, online: string[], owner?: string): Promise<void> {
    const identity = this.identity!
    if (this.accountPaused()) return
    this.online.clear()
    for (const device of online) this.online.add(device)
    this.addFromAnother = !member && group
    const mayStart = this.claimingOwner && owner === identity.device && !this.book?.get(identity.device)
    this.claimingOwner = false
    if (member && this.book && (!owner || !this.book.bindOwner(owner))) {
      this.problem = 'The managing computer could not be verified. Pair this device again.'
      this.link?.stop()
      this.remote.clear()
      this.emit('changed')
      return
    }
    if (member && mayStart && (first || !this.code)) {
      // This computer signed in and started the person's devices (or started them again).
      this.boundAccount = this.options.account?.who()?.user
      this.book = Book.start(identity, this.options.name().slice(0, 60) || 'Computer', undefined, this.now)
      this.standing = 'member'
      this.problem = undefined
      this.remote.clear()
      await this.saveBook()
    } else if (member && this.code && !this.code.joining.finished) {
      // Added a moment ago: the welcome with the book is on its way through the room.
    } else if (member && !this.book?.get(identity.device)) {
      this.problem = 'This device lost its list. Remove it from the computer that manages your devices, then pair it again.'
    } else if (!member && this.standing === 'member' && !this.code) {
      // The courier no longer knows this device: it was removed while it was off, or the devices started again elsewhere.
      this.letGo()
    }
    if (member && this.standing === 'member' && this.verifyingAccount && this.verifyingAccount === this.options.account?.who()?.user) {
      this.boundAccount = this.verifyingAccount
      this.legacyBinding = false
      this.verifyingAccount = undefined
      await this.saveBook()
    }
    if (this.link?.welcome?.connection !== 'on') this.remote.clear()
    if (member && this.standing === 'member' && this.link?.welcome?.connection === 'on') {
      for (const device of online) if (this.book?.trusted(device, this.now)) void this.greet(device)
      await this.renew()
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
      this.invite = undefined
      current.stage = 'failed'
      current.message = outcome.failed
      this.link?.say({ t: 'room-close', room })
    } else if (outcome.result === 'done') {
      this.invite = undefined
      current.stage = 'added'
      this.link?.say({ t: 'room-close', room })
    } else if (outcome.result) {
      this.invite = undefined
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
    if (this.link?.welcome?.owner !== welcome.adder.device) {
      this.problem = 'The pairing computer could not be verified. Show a new code.'
      this.emit('changed')
      return
    }
    this.boundAccount = this.options.account?.who()?.user
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
    if (!pass || !this.identity || this.link?.state !== 'member' || this.link.welcome?.connection !== 'on') {
      throw new Error('Remote access to this device is unavailable.')
    }
    const box: Box = lock(this.keyFor(pass), this.identity.device, device, note)
    await this.link!.request({ t: 'send', box, keep: note.kind === 'book' })
  }

  /** A device came online (or this one did): it gets this device's book, its tasks when it may see them, and a wish for its own. */
  private async greet(device: string): Promise<void> {
    const pass = this.book?.trusted(device, this.now)
    if (!pass) return
    try {
      await this.send(device, { kind: 'book', book: this.book!.for(pass) })
      if (pass.role !== 'server' && this.options.tasks) await this.sendTasks(pass)
      await this.send(device, { kind: 'want', at: this.now })
    } catch { /* offline again; it is greeted when it is back */ }
  }

  private async sendBookToAll(): Promise<void> {
    for (const device of this.online) {
      const pass = this.book?.trusted(device, this.now)
      if (pass) await this.send(device, { kind: 'book', book: this.book!.for(pass) }).catch(() => undefined)
    }
  }

  private async sendTasks(pass: Pass, updated?: TaskView[]): Promise<void> {
    const phone = pass.role === 'phone'
    const choices = this.pilotChoicesOn()
    const reports = phone && this.canShareReports('phone')
    const desktopReports = pass.role === 'computer' && this.canShareReports('computer')
    const list = phone && !choices && !reports ? [] : updated ?? await this.localTasks()
    const tasks = reports ? sharePhoneSummaries(this.reportTasks(list), choices, this.phoneChatOn())
      : phone ? sharePhoneTasks(list) : shareTasks(list, this.now, choices)
    const report = { tasks, ...(reports ? { phoneReports: true, canAct: choices } : phone ? {} : { canAct: this.actOnThis }),
      ...(desktopReports ? { desktopReports: true } : {}) }
    const snapshot = JSON.stringify(report)
    if (updated && this.shared.get(pass.device) === snapshot) return
    await this.send(pass.device, { kind: 'tasks', ...report, at: this.now })
    this.shared.set(pass.device, snapshot)
  }

  private pilotChoicesOn(): boolean {
    return this.options.kind === 'computer' && this.options.phonePilot === true && this.actOnThis
      && path.isAbsolute(this.options.pilotFolder ?? '')
  }

  private canShareReports(role: DeviceKind): boolean {
    const enabled = role === 'computer' ? this.options.desktopActivity === true
      : role === 'phone' && this.options.phonePilot === true && this.options.phoneActivity === true
    return enabled && this.options.kind === 'computer' && !!this.options.tasks?.phone && path.isAbsolute(this.options.pilotFolder ?? '')
  }

  private phoneChatOn(): boolean {
    return this.options.phoneMessages === true && this.canShareReports('phone') && this.pilotChoicesOn() && !!this.options.tasks?.phoneMessage
  }

  private reportTasks(tasks: TaskView[]): TaskView[] {
    return recentTasks(tasks.filter(task => task.mine), this.now)
  }

  private async localTasks(): Promise<TaskView[]> {
    const tasks = await this.options.tasks!.list()
    const folder = this.options.pilotFolder
    if ((!this.options.phonePilot && !this.options.desktopActivity) || folder === undefined) return tasks
    if (!path.isAbsolute(folder)) return []
    const workspace = path.resolve(folder)
    return tasks.filter(task => path.isAbsolute(task.folder) && path.resolve(task.folder) === workspace)
  }

  private async shareTasks(): Promise<void> {
    if (this.standing !== 'member' || !this.options.tasks) return
    const list = await this.localTasks()
    for (const device of this.online) {
      const pass = this.book?.trusted(device, this.now)
      // A server only runs agents: it doesn't see the person's other devices.
      if (pass && pass.role !== 'server') await this.sendTasks(pass, list).catch(() => undefined)
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
    if (this.accountPaused() || this.legacyBinding) return
    if (!this.identity || box.to !== this.identity.device || this.standing !== 'member') return
    if (this.link?.state !== 'member' || this.link.welcome?.connection !== 'on') return
    const trusted = this.book?.trusted(box.from, this.now)
    const pass = trusted ?? this.book?.ownerPass(box.from)
    if (!pass) return
    let note: Note
    try { note = unlock<Note>(this.keyFor(pass), box) } catch { return }
    if (!note || typeof note !== 'object' || (!trusted && note.kind !== 'book')) return
    switch (note.kind) {
      case 'book': {
        if (!this.book!.merge(note.book, this.now)) return
        if (this.book!.wasRemoved(this.identity.device)) return this.letGo()
        this.checkSessionReads()
        await this.saveBook()
        this.emit('changed')
        return
      }
      case 'tasks': {
        if (pass.role === 'phone' || !Array.isArray(note.tasks) || !Number.isFinite(note.at) || note.at < 0) return
        const previous = this.remote.get(pass.device)
        if (previous && previous.at > note.at) return
        this.remote.set(pass.device, {
          device: pass.device, name: pass.name, role: pass.role, online: true, tasks: note.tasks.slice(0, 60), at: note.at,
          ...(typeof note.canAct === 'boolean' ? { canAct: note.canAct } : {}),
          ...(pass.role === 'computer' && note.phoneReports === true ? { phoneReports: true } : {}),
          ...(this.options.kind === 'computer' && pass.role === 'computer' && note.desktopReports === true ? { desktopReports: true } : {})
        })
        this.checkSessionReads()
        this.emit('changed')
        return
      }
      case 'want':
        if (pass.role !== 'server' && this.options.tasks) await this.sendTasks(pass).catch(() => undefined)
        return
      case 'act':
        await this.actOn(pass, note)
        return
      case 'phone-read':
        await this.reportTo(pass, note)
        return
      case 'phone-report':
        if (this.sessionReads.get(note.n)?.device === pass.device) this.finishSessionRead(note.n, note.report)
        return
      case 'acted': {
        const waiter = this.asked.get(note.n)
        if (!waiter || waiter.device !== pass.device) return
        this.asked.delete(note.n)
        clearTimeout(waiter.timer)
        if (note.ok) waiter.resolve(note.delivery); else waiter.reject(new Error(note.message ?? 'It wasn’t done.'))
        return
      }
    }
  }

  private async reportTo(pass: Pass, { n, at, query }: Extract<Note, { kind: 'phone-read' }>): Promise<void> {
    if (!this.canShareReports(pass.role) || !this.connectedDevice(pass.device, pass.role) || !isPhoneQuery(query) ||
      typeof n !== 'string' || !n.length || n.length > 40 || !Number.isFinite(at) || Math.abs(this.now - at) > ACT_FRESH_MS) return
    if (pass.role === 'computer' && (query.kind !== 'session' || query.view !== 'chat')) return
    const key = `${pass.device}:${query.kind}`
    if (this.reporting.has(key)) {
      await this.send(pass.device, { kind: 'phone-report', n })
      return
    }
    this.reporting.add(key)
    try {
      const tasks = this.reportTasks(await this.localTasks().catch((): TaskView[] => []))
      if (!this.connectedDevice(pass.device, pass.role)) return
      const includeQueue = pass.role === 'phone' && this.options.phoneMessages === true
      const report = await phoneReport(this.options.tasks!.phone!, tasks, query, includeQueue, this.options.accountUsage === true).catch(() => undefined)
      if (this.connectedDevice(pass.device, pass.role)) await this.send(pass.device, { kind: 'phone-report', n, report })
    } finally {
      this.reporting.delete(key)
    }
  }

  private async sendPhoneMessage(pass: Pass, act: Extract<RemoteAct, { what: 'send-message' }>): Promise<{ delivery: PhoneDelivery; repeated: boolean }> {
    if (typeof act.id !== 'string' || !/^[a-f0-9]{24}$/.test(act.id) || typeof act.text !== 'string' ||
      !act.text.trim() || act.text.length > 4_000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(act.text) ||
      (act.quote !== undefined && (typeof act.quote !== 'string' || act.quote.length > 500))) throw new Error('Enter a message of up to 4,000 characters.')
    const key = `${pass.device}:${act.id}`
    const request = JSON.stringify([act.task, act.text, act.quote])
    const previous = this.phoneSends.get(key)
    if (previous) {
      if (previous.request !== request) throw new Error('That message was already sent.')
      return { delivery: await previous.delivery, repeated: true }
    }
    if (this.sendingToTasks.has(act.task)) throw new Error('This session is receiving a message. Try again in a moment.')
    this.sendingToTasks.add(act.task)
    try {
      const delivery = this.options.tasks!.phoneMessage!(act.task, act.text.replace(/\r\n?/g, '\n'), act.quote)
      const receipt = { request, delivery, done: false }
      this.phoneSends.set(key, receipt)
      const result = await delivery
      receipt.done = true
      if (this.phoneSends.size > 160) {
        for (const [id, earlier] of this.phoneSends) {
          if (!earlier.done) continue
          this.phoneSends.delete(id)
          break
        }
      }
      return { delivery: result, repeated: false }
    } catch (error) {
      this.phoneSends.delete(key)
      throw error
    } finally {
      this.sendingToTasks.delete(act.task)
    }
  }

  /** This host checks the sending device's role and the current request before acting. */
  /** Persist the receipt before dispatch so a reconnect or crash cannot execute the same action twice. */
  private rememberAction(key: string, expires: number): Promise<boolean> {
    const save = this.savingReceipts.then(async () => {
      for (const [id, end] of this.seen) if (end < this.now) this.seen.delete(id)
      if (this.seen.has(key) || this.seen.size >= 2048 || expires < this.now) return false
      this.seen.set(key, expires)
      await this.options.store.write('reach-action-receipts', [...this.seen])
      return true
    })
    this.savingReceipts = save.then(() => undefined, () => undefined)
    return save.catch(() => false)
  }

  private async canDispatch(pass: Pass, note: Extract<Note, { kind: 'act' }>): Promise<boolean> {
    const at = note.at
    const link = this.link
    if (!this.actOnThis || link?.state !== 'member') return false
    if (!await this.rememberAction(pass.device + ':' + note.n, at + ACT_FRESH_MS)) return false
    const listed = await link.request({ t: 'devices' }).catch(() => undefined)
    return !this.legacyBinding && !this.accountPaused() && this.actOnThis && this.standing === 'member' && link.state === 'member' && link.welcome?.connection === 'on'
      && this.online.has(pass.device) && this.book?.trusted(pass.device, this.now)?.role === pass.role
      && Number.isFinite(at) && Math.abs(this.now - at) <= ACT_FRESH_MS
      && !!listed?.devices?.some(device => device.device === pass.device && device.kind === pass.role && device.online)
  }

  private async actOn(pass: Pass, note: Extract<Note, { kind: 'act' }>): Promise<void> {
    const answer = (ok: boolean, message?: string, delivery?: PhoneDelivery): Promise<void> => this.send(pass.device, { kind: 'acted', n: note.n, ok, ...(message ? { message } : {}), ...(delivery ? { delivery } : {}), at: this.now }).catch(() => undefined)
    if (typeof note.n !== 'string' || !note.n.length || note.n.length > 40 || !Number.isFinite(note.at) || Math.abs(this.now - note.at) > ACT_FRESH_MS) return
    if (pass.role === 'server') return answer(false, 'A server only runs agents. It can’t act on your other devices.')
    const act = note.act
    const chatAct = act?.what === 'send-message' || act?.what === 'manage-queue' || (pass.role === 'phone' && act?.what === 'stop')
    if (chatAct && (pass.role !== 'phone' || this.options.phoneMessages !== true)) return answer(false, 'This device can only select an answer to a Codex question.')
    if (pass.role === 'phone' && act?.what !== 'reply-choice' && !chatAct) return answer(false, 'A phone can only select an answer to a Codex question.')
    if (!this.actOnThis) return answer(false, `${this.book?.get(this.identity!.device)?.name ?? 'That computer'} doesn’t take answers from other devices right now.`)
    if (act?.what === 'reply-choice' && !this.pilotChoicesOn()) return answer(false, 'This computer is not accepting remote answers to Codex questions.')
    if (chatAct && !this.phoneChatOn()) return answer(false, 'Continue this conversation on its computer.')
    const tasks = this.options.tasks
    if (!tasks || !act || typeof act.task !== 'string') return answer(false, 'That task is not here.')
    try {
      const task = (await this.localTasks()).find((item) => item.key === act.task)
      if (!await this.canDispatch(pass, note)) return answer(false, 'Remote access to this task is unavailable.')
      let what: string
      let delivery: PhoneDelivery | undefined
      if (chatAct) {
        if (!this.phoneChatOn() || this.book?.trusted(pass.device, this.now)?.role !== 'phone' || !this.online.has(pass.device) ||
          this.link?.state !== 'member' || this.link.welcome?.connection !== 'on' || !task || !canMessageFromPhone(task))
          return answer(false, 'Continue this conversation on its computer.')
        if (act.what === 'send-message') {
          const result = await this.sendPhoneMessage(pass, act)
          delivery = result.delivery
          if (result.repeated) return answer(true, undefined, delivery)
          what = `${delivery === 'queued' ? 'Queued' : 'Sent'} a message in ${task.title}`
        } else if (act.what === 'manage-queue') {
          if (!tasks.phoneQueue || typeof act.revision !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(act.revision) ||
            (act.action !== 'send' && act.action !== 'remove')) return answer(false, 'The queue has changed. Open it again.')
          await tasks.phoneQueue(task.key, act.revision, act.action, act.index)
          what = `${act.action === 'send' ? 'Sent queued messages' : 'Removed a queued message'} in ${task.title}`
        } else {
          if (task.state !== 'working' && task.state !== 'waiting') return answer(false, 'Nothing is running in this session.')
          await tasks.stop(task.key)
          what = `Stopped ${task.title}`
        }
      } else if (act.what === 'reply-choice') {
        if (!this.pilotChoicesOn() || this.book?.trusted(pass.device, this.now)?.role !== pass.role)
          return answer(false, 'This computer is not accepting remote answers to Codex questions.')
        const question = task && pilotQuestion(task)
        if (!task || !question || question.id !== act.request) return answer(false, 'That Codex question is no longer available.')
        if (!Number.isSafeInteger(act.choice) || act.choice < 0 || act.choice >= question.choices.length) return answer(false, 'Select one of the answers shown.')
        tasks.replyChoice(task.key, question.id, act.choice)
        what = `Answered a Codex question in ${task.title}`
      } else if (!task) return answer(false, 'That task is gone.')
      else if (!task.mine) return answer(false, 'Togle doesn’t run that task, so it is answered where it runs.')
      // A terminal Togle only watches is answered at its computer. A background task uses the agent's own controls.
      else if (task.terminal && !task.screen) return answer(false, 'That task runs in a terminal. It is answered only at its own computer.')
      else if (act.what === 'refuse') {
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
      this.tasksChanged()
      this.emit('changed')
      await answer(true, undefined, delivery)
    } catch (error) {
      await answer(false, (error as Error).message)
    }
  }

  // ---- Keeping --------------------------------------------------------------------------------------------------------------

  /** This device is no longer one of the person's devices: what it knew of them goes. Its own keys stay. */
  private letGo(): void {
    this.standing = 'removed'
    this.invite = undefined
    this.adding = undefined
    this.recovery = undefined
    void this.options.store.write('reach-recovery', null).catch(() => undefined)
    this.boundAccount = undefined
    this.legacyBinding = false
    this.verifyingAccount = undefined
    this.book = undefined
    this.remote.clear()
    this.shared.clear()
    this.phoneSends.clear()
    this.online.clear()
    this.checkSessionReads()
    this.keys.clear()
    this.problem = undefined
    void this.saveBook()
    this.emit('changed')
  }

  private async saveBook(): Promise<void> {
    await this.options.store.write(FILES.book, { standing: this.standing, account: this.boundAccount ?? null, ...(this.book ? { book: this.book.data() } : {}) })
  }

  private async until(check: () => boolean, ms: number): Promise<void> {
    const began = Date.now()
    while (!check()) {
      if (Date.now() - began > ms) throw new CourierError('later', 'Togle Studio didn’t answer. Check the connection and try again.')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}

