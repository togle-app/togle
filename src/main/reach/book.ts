// The group: which devices are this person's, what each may do, and which were removed. Every device keeps its own copy
// and checks every change it is sent: a pass counts only when a computer of the group signed it, and a removal only when a
// computer did. Studio's courier never sees this book, and nothing the courier says changes it.
import { deviceId, issuePass, passHolds, signWith, signedBy, type Identity, type Pass, type PresenceKey, type Role } from './crypto'

export interface Removal { device: string; by: string; at: number; signature: string }
export interface BookData { v: 1; members: Pass[]; removed: Removal[] }

/** A computer renews a pass once less than this is left of its week. */
export const RENEW_WITHIN_MS = 3 * 86_400_000
/** A removal is kept this long: longer than a pass lasts, so a removed device's last pass runs out first. */
export const REMOVAL_KEEP_MS = 30 * 86_400_000

const REMOVAL = 'togle-reach-removal'
const ROLES: Role[] = ['computer', 'server', 'phone']
const text = (value: unknown, max: number): boolean => typeof value === 'string' && value.length > 0 && value.length <= max

/** Whether something sent as a pass has a pass's shape (its signature is checked separately). */
export function isPass(value: unknown): value is Pass {
  if (!value || typeof value !== 'object') return false
  const pass = value as Record<string, unknown>
  const presence = pass.presence as Record<string, unknown> | undefined
  return pass.v === 1 && text(pass.device, 22) && text(pass.sign, 43) && text(pass.agree, 43) && text(pass.name, 80)
    && ROLES.includes(pass.role as Role) && typeof pass.issuedAt === 'number' && typeof pass.expiresAt === 'number'
    && text(pass.issuer, 22) && text(pass.signature, 200) && (pass.starts === undefined || typeof pass.starts === 'boolean')
    && (presence === undefined || (!!presence && (presence.kind === 'ed25519' || presence.kind === 'rsa-pkcs1-sha256') && text(presence.key, 2048)))
}

function isRemoval(value: unknown): value is Removal {
  if (!value || typeof value !== 'object') return false
  const removal = value as Record<string, unknown>
  return text(removal.device, 22) && text(removal.by, 22) && typeof removal.at === 'number' && text(removal.signature, 200)
}

export class Book {
  readonly me: string
  private readonly members = new Map<string, Pass>()
  private readonly removed = new Map<string, Removal>()

  constructor(me: string, data?: BookData) {
    this.me = me
    for (const pass of data?.members ?? []) if (isPass(pass)) this.members.set(pass.device, pass)
    for (const removal of data?.removed ?? []) if (isRemoval(removal)) this.removed.set(removal.device, removal)
  }

  /** A group of one: this computer, its pass signed by itself. */
  static start(identity: Identity, name: string, presence?: PresenceKey, now = Date.now()): Book {
    const book = new Book(identity.device)
    const { device, sign, agree } = identity
    book.members.set(device, issuePass(identity, { device, sign, agree, name, role: 'computer', ...(presence ? { presence } : {}) }, now))
    return book
  }

  /**
   * The book a new device starts from: the computer that added it (known from the exchange its code protected), then what
   * that computer sent, each pass checked as usual. Undefined when the new device's own pass doesn't hold.
   */
  static joined(me: string, adder: Pass, sent: BookData, now = Date.now()): Book | undefined {
    if (!isPass(adder) || adder.role !== 'computer' || adder.device !== deviceId(adder.sign, adder.agree)) return undefined
    const book = new Book(me)
    book.members.set(adder.device, adder)
    book.merge(sent, now)
    return book.trusted(me, now) ? book : undefined
  }

  data(): BookData { return { v: 1, members: [...this.members.values()], removed: [...this.removed.values()] } }

  /** What a device is sent: a server gets its own pass and the devices that may act on it, never the other servers. */
  for(recipient: Pass): BookData {
    const members = [...this.members.values()].filter((pass) => recipient.role !== 'server' || pass.role !== 'server' || pass.device === recipient.device)
    return { v: 1, members, removed: [...this.removed.values()] }
  }

  /** Every device of the group, this one included. */
  list(): Pass[] { return [...this.members.values()] }
  get(device: string): Pass | undefined { return this.members.get(device) }
  wasRemoved(device: string): boolean { return this.removed.has(device) }

  /** The computers that sign passes and removals: each computer of the group, whether or not its own pass is current. */
  issuers(): Pass[] { return [...this.members.values()].filter((pass) => pass.role === 'computer') }

  /** A device of the group whose pass holds now; undefined for any other. */
  trusted(device: string, now = Date.now()): Pass | undefined {
    const pass = this.members.get(device)
    return pass && !this.removed.has(device) && passHolds(pass, this.issuers(), now) ? pass : undefined
  }

  /** A device this computer just added, with the pass it signed. A device removed before can be added again. */
  add(pass: Pass, now = Date.now()): boolean {
    if (!isPass(pass) || !passHolds(pass, this.issuers(), now)) return false
    const removal = this.removed.get(pass.device)
    if (removal && pass.issuedAt <= removal.at) return false
    this.removed.delete(pass.device)
    this.members.set(pass.device, pass)
    return true
  }

  /** Removes a device, signed by this computer. The removal travels with the book to every other device. */
  remove(identity: Identity, device: string, now = Date.now()): Removal {
    const body = { device, by: identity.device, at: now }
    const removal = { ...body, signature: signWith(identity, REMOVAL, body) }
    this.removed.set(device, removal)
    this.members.delete(device)
    return removal
  }

  /**
   * Renews the passes that have less than three days left, signed by this computer, and returns them. A computer renews
   * its own too: a group of one has nobody else to.
   */
  renew(identity: Identity, now = Date.now()): Pass[] {
    if (this.members.get(identity.device)?.role !== 'computer') return []
    const renewed: Pass[] = []
    for (const pass of this.members.values()) {
      if (this.removed.has(pass.device) || pass.expiresAt - now > RENEW_WITHIN_MS) continue
      const { v: _v, issuedAt: _issued, expiresAt: _expires, issuer: _issuer, signature: _signature, ...device } = pass
      const fresh = issuePass(identity, device, now)
      this.members.set(pass.device, fresh)
      renewed.push(fresh)
    }
    for (const [device, removal] of this.removed) if (now - removal.at > REMOVAL_KEEP_MS) this.removed.delete(device)
    return renewed
  }

  /**
   * Takes in another device's book: removals signed by a computer of the group, then passes that hold and are newer than
   * what this book has. A device's keys never change, so a pass naming other keys for a known device is not taken.
   * Returns whether anything changed.
   */
  merge(incoming: BookData, now = Date.now()): boolean {
    if (!incoming || incoming.v !== 1 || !Array.isArray(incoming.members) || !Array.isArray(incoming.removed)) return false
    let changed = false
    for (const removal of incoming.removed) {
      if (!isRemoval(removal) || now - removal.at > REMOVAL_KEEP_MS) continue
      const known = this.removed.get(removal.device)
      if (known && known.at >= removal.at) continue
      const signer = this.members.get(removal.by)
      if (!signer || signer.role !== 'computer') continue
      if (!signedBy(signer.sign, REMOVAL, { device: removal.device, by: removal.by, at: removal.at }, removal.signature)) continue
      const current = this.members.get(removal.device)
      if (current && current.issuedAt > removal.at) continue
      this.removed.set(removal.device, { device: removal.device, by: removal.by, at: removal.at, signature: removal.signature })
      this.members.delete(removal.device)
      changed = true
    }
    // A pass can be signed by a computer that arrives in the same book, so go round until nothing more is taken.
    for (let taken = true; taken;) {
      taken = false
      for (const pass of incoming.members) {
        if (!isPass(pass)) continue
        const removal = this.removed.get(pass.device)
        if (removal && pass.issuedAt <= removal.at) continue
        const current = this.members.get(pass.device)
        if (current && (current.issuedAt >= pass.issuedAt || current.sign !== pass.sign || current.agree !== pass.agree)) continue
        if (!passHolds(pass, this.issuers(), now)) continue
        if (removal) this.removed.delete(pass.device)
        this.members.set(pass.device, pass)
        taken = changed = true
      }
    }
    return changed
  }
}
