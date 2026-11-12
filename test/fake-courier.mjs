// A stand-in for Togle Studio's courier, for Togle's tests. It speaks the same messages (src/shared/courier-protocol.ts)
// with the same rules in short: a device proves its key; a known device is a member, any other a guest; the first
// computer to sign in starts an account's devices; rooms by two letters, joined once; boxes only within an account, kept
// for a device that is off; enroll and forget. The real courier is part of Togle Studio and is not in this repository.
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import { WebSocketServer } from 'ws'

const ED25519 = Buffer.from('302a300506032b6570032100', 'hex')
const LETTERS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const idOf = (sign, agree) => createHash('sha256').update('togle-reach-device-v1').update(Buffer.from(sign, 'base64url')).update(Buffer.from(agree, 'base64url')).digest().subarray(0, 16).toString('base64url').slice(0, 22)
const helloText = (nonce, device) => `togle-courier-hello\n{"device":${JSON.stringify(device)},"nonce":${JSON.stringify(nonce)}}`

/**
 * @param {{ tokens?: Map<string, string>, connection?: (user: string) => 'on' | 'needs-pro' | 'off' }} [options]
 *   tokens: access token → account; connection: whether an account's connection is on.
 */
export async function fakeCourier({ tokens = new Map(), connection = () => 'on' } = {}) {
  const records = new Map()
  const online = new Map()
  const rooms = new Map()
  const kept = new Map()
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
  await new Promise((resolve) => server.once('listening', resolve))

  server.on('connection', (ws) => {
    const conn = { ws, state: 'hello', rooms: new Set(), send: (frame) => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)) } }
    ws.on('message', (data) => { try { handle(conn, JSON.parse(String(data))) } catch (error) { conn.send({ t: 'error', code: 'bad-frame', message: error.message }) } })
    ws.on('close', () => left(conn))
  })

  const drop = (conn, frame) => { conn.send(frame); left(conn); conn.ws.close() }

  function member(conn, user, extra = {}) {
    const old = online.get(conn.device)
    if (old && old !== conn) drop(old, { t: 'refused', code: 'elsewhere', message: 'This device connected again.' })
    conn.state = 'member'
    conn.user = user
    online.set(conn.device, conn)
    const others = [...online.values()].filter((other) => other !== conn && other.state === 'member' && other.user === user)
    conn.send({ t: 'welcome', member: true, ...extra, online: others.map((other) => other.device), connection: connection(user) })
    for (const frame of kept.get(conn.device) ?? []) conn.send(frame)
    kept.delete(conn.device)
    for (const other of others) other.send({ t: 'online', device: conn.device, online: true })
  }

  function guest(conn, extra = {}) {
    const old = online.get(conn.device)
    if (old && old !== conn) drop(old, { t: 'refused', code: 'elsewhere', message: 'This device connected again.' })
    conn.state = 'guest'
    online.set(conn.device, conn)
    conn.send({ t: 'welcome', member: false, ...extra, online: [] })
  }

  function handle(conn, frame) {
    const answer = (body) => conn.send({ ...body, t: 'ok', id: frame.id })
    const fail = (code, message) => conn.send({ t: 'error', id: frame.id, code, message })
    if (conn.state === 'hello') {
      if (frame.t !== 'hello' || idOf(frame.sign, frame.agree) !== frame.device) return drop(conn, { t: 'refused', code: 'bad-hello', message: 'Those keys do not make that device.' })
      Object.assign(conn, { device: frame.device, sign: frame.sign, agree: frame.agree, kind: frame.kind, nonce: randomBytes(16).toString('base64url'), state: 'proving' })
      return conn.send({ t: 'challenge', nonce: conn.nonce })
    }
    if (conn.state === 'proving') {
      const key = createPublicKey({ key: Buffer.concat([ED25519, Buffer.from(conn.sign, 'base64url')]), format: 'der', type: 'spki' })
      if (frame.t !== 'prove' || !verify(null, Buffer.from(helloText(conn.nonce, conn.device)), key, Buffer.from(String(frame.signature), 'base64url'))) {
        return drop(conn, { t: 'refused', code: 'bad-proof', message: 'The device did not prove it holds its key.' })
      }
      const record = records.get(conn.device)
      if (record) { conn.kind = record.kind; return member(conn, record.user) }
      if (frame.account === undefined) return guest(conn)
      const user = tokens.get(frame.account)
      if (!user || conn.kind !== 'computer') return drop(conn, { t: 'refused', code: 'account', message: 'The sign-in did not hold. Sign in again.' })
      const has = [...records.values()].some((other) => other.user === user)
      if (has && !frame.restart) return guest(conn, { group: true })
      if (has) {
        for (const [device, other] of records) {
          if (other.user !== user) continue
          records.delete(device)
          const there = online.get(device)
          if (there && there !== conn) drop(there, { t: 'forgotten' })
        }
      }
      records.set(conn.device, { user, kind: 'computer', addedBy: null })
      conn.kind = 'computer'
      return member(conn, user, { first: true })
    }
    switch (frame.t) {
      case 'room-open': {
        let name
        do name = LETTERS[randomBytes(1)[0] & 31] + LETTERS[randomBytes(1)[0] & 31]; while (rooms.has(name))
        rooms.set(name, { name, session: frame.session, opener: conn })
        conn.rooms.add(name)
        return answer({ room: name, expiresAt: Date.now() + 600_000 })
      }
      case 'room-join': {
        if (conn.state !== 'member') return fail('not-member', 'This device is not on an account yet.')
        if (conn.kind !== 'computer') return fail('not-computer', 'A device is added at a computer.')
        if (connection(conn.user) !== 'on') return fail('connection', 'Adding a device is part of Pro.')
        const room = rooms.get(frame.room)
        if (!room) return fail('no-room', 'No device shows that code now. Check the code, or show a new one.')
        if (room.joiner) return fail('room-used', 'That code was used once already. Show a new one on the device you are adding.')
        room.joiner = conn
        conn.rooms.add(room.name)
        room.opener.send({ t: 'room-peer', room: room.name })
        return answer({ room: room.name, session: room.session })
      }
      case 'room-say': {
        const room = rooms.get(frame.room)
        if (!room?.joiner) return
        return (room.opener === conn ? room.joiner : room.opener).send({ t: 'room-say', room: room.name, data: frame.data })
      }
      case 'room-close': {
        const room = rooms.get(frame.room)
        if (!room) return
        rooms.delete(room.name)
        for (const side of [room.opener, room.joiner]) if (side) { side.rooms.delete(room.name); if (side !== conn) side.send({ t: 'room-closed', room: room.name, reason: 'closed' }) }
        return
      }
      case 'enroll': {
        if (conn.state !== 'member') return fail('not-member', 'This device is not on an account yet.')
        if (conn.kind !== 'computer') return fail('not-computer', 'Only a computer adds a device.')
        records.set(frame.device, { user: conn.user, kind: frame.kind, addedBy: conn.device })
        const waiting = online.get(frame.device)
        if (waiting?.state === 'guest') { waiting.kind = frame.kind; waiting.send({ t: 'enrolled' }); member(waiting, conn.user) }
        return answer({})
      }
      case 'forget': {
        const record = records.get(frame.device)
        if (conn.kind !== 'computer') return fail('not-computer', 'Only a computer removes a device.')
        if (!record || record.user !== conn.user) return fail('not-yours', 'That device is not one of this account.')
        records.delete(frame.device)
        kept.delete(frame.device)
        const there = online.get(frame.device)
        if (there) drop(there, { t: 'forgotten' })
        return answer({})
      }
      case 'send': {
        if (conn.state !== 'member') return fail('not-member', 'This device is not on an account yet.')
        if (connection(conn.user) !== 'on') return fail('connection', 'The connection between devices is part of Pro.')
        const box = frame.box
        const record = records.get(box?.to)
        if (!record || record.user !== conn.user || box.from !== conn.device) return fail('not-yours', 'That device is not one of this account.')
        const target = online.get(box.to)
        const delivered = { t: 'box', box, at: Date.now() }
        if (target?.state === 'member') { target.send(delivered); return answer({ queued: false }) }
        kept.set(box.to, [...(kept.get(box.to) ?? []), delivered])
        return answer({ queued: true })
      }
      default:
        return fail('bad-frame', 'The courier does not know that message.')
    }
  }

  function left(conn) {
    if (conn.state === 'gone') return
    const was = conn.state
    conn.state = 'gone'
    for (const name of conn.rooms) {
      const room = rooms.get(name)
      if (!room) continue
      rooms.delete(name)
      for (const side of [room.opener, room.joiner]) if (side && side !== conn) { side.rooms.delete(name); side.send({ t: 'room-closed', room: name, reason: 'left' }) }
    }
    if (online.get(conn.device) === conn) {
      online.delete(conn.device)
      if (was === 'member') for (const other of online.values()) if (other.state === 'member' && other.user === conn.user) other.send({ t: 'online', device: conn.device, online: false })
    }
  }

  return {
    url: `ws://127.0.0.1:${server.address().port}/v1`,
    records,
    rooms,
    online,
    /** Hangs up on every device, as a courier that restarts does. */
    dropAll: () => { for (const ws of server.clients) ws.terminate() },
    close: () => new Promise((resolve) => { for (const ws of server.clients) ws.terminate(); server.close(() => resolve()) })
  }
}
