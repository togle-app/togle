// Reach between devices, through a stand-in courier (fake-courier.mjs): the first computer signs in and starts the
// devices, another computer and a server are added by their codes (a wrong code adds nothing), a computer's tasks reach
// the other computer and not the server, Refuse and Stop from another device are done and recorded, and a removed
// device is let go. Also Togle's sign-in to Studio and its connection, against stand-ins.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fakeCourier } from './fake-courier.mjs'

const { CourierLink, Reach, StudioAccount, WRONG_CODE, makeIdentity } = await import('./.build/togle.mjs')

const memoryStore = () => {
  const files = new Map()
  return { files, read: async (name) => structuredClone(files.get(name) ?? null), write: async (name, value) => { if (value === null) files.delete(name); else files.set(name, structuredClone(value)) } }
}

const signedIn = (token) => ({ who: () => ({ email: 'ana@example.com', user: 'ana' }), token: async () => token, signOut: async () => {}, load: async () => {} })

/** The agents on a computer, as Reach sees them: one task waits to run a command. */
class Tasks {
  constructor() {
    this.done = []
    this.tasks = [{
      key: 'codex:t1', id: 't1', runner: 'codex', agent: 'Codex', title: 'Apply the staging plan', folder: '/work/infra', state: 'waiting',
      updatedAt: Date.now(), mine: true, commandsRunning: false, line: 'Wants to run terraform apply',
      pending: [{ id: 'r1', kind: 'command', command: 'terraform apply -var-file=staging.tfvars', offersAlways: false, danger: 'Changes what runs in production' }]
    }, {
      key: 'claude:s9', id: 's9', runner: 'claude', agent: 'Claude Code', title: 'Fix the login redirect', folder: '/work/website', state: 'working',
      updatedAt: Date.now(), mine: false, commandsRunning: false, line: 'Working', pending: []
    }]
  }
  async list() { return structuredClone(this.tasks) }
  answer(key, request, decision) { this.done.push(['answer', key, request, decision]); const task = this.tasks.find((item) => item.key === key); task.pending = task.pending.filter((item) => item.id !== request) }
  async stop(key) { this.done.push(['stop', key]) }
  async endCommands(key) { this.done.push(['end-commands', key]); return 1 }
}

const until = async (check, what, ms = 8000) => {
  const began = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - began > ms) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

let courier
const started = []
const device = async (name, kind = 'computer', extra = {}) => {
  const reach = new Reach({ courier: courier.url, store: memoryStore(), kind, name: () => name, delays: [50, 100], ...extra })
  await reach.start()
  started.push(reach)
  return reach
}

before(async () => { courier = await fakeCourier({ tokens: new Map([['token-ana', 'ana']]) }) })
after(async () => {
  for (const reach of started) reach.stop()
  await courier.close()
})

/** Adds a device by its code at a computer, the way the person does: type the code, read the add screen, say yes. */
async function add(computer, newDevice) {
  await newDevice.showCode()
  const { code } = newDevice.state().code
  await computer.addByCode(code.toLowerCase())
  await until(() => computer.state().adding?.stage === 'confirm', 'the add screen')
  const shown = computer.state().adding
  await computer.confirmAdd()
  await until(() => newDevice.state().standing === 'member' && computer.state().adding?.stage === 'added', 'the device to be added')
  return shown
}

let pc, laptop, server, pcTasks
test('the first computer to sign in starts the devices; a computer and a server are added by their codes', async () => {
  pcTasks = new Tasks()
  pc = await device('Windows PC', 'computer', { account: signedIn('token-ana'), tasks: pcTasks })
  assert.deepEqual([pc.state().standing, pc.state().link], ['alone', 'off'], 'nothing connects before the person signs in or shows a code')
  await pc.connectAccount()
  await until(() => pc.state().standing === 'member', 'the first computer')
  assert.deepEqual(pc.state().devices.map((item) => [item.name, item.me]), [['Windows PC', true]])
  assert.equal(pc.state().connection, 'on')

  laptop = await device('MacBook', 'computer', { tasks: new Tasks() })
  const shown = await add(pc, laptop)
  assert.deepEqual([shown.name, shown.role], ['MacBook', 'computer'], 'the add screen says what joins, and as what')
  server = await device('build-server', 'server', { tasks: new Tasks() })
  assert.deepEqual([(await add(pc, server)).role], ['server'])

  await until(() => laptop.state().devices.length === 3 && laptop.state().devices.every((item) => item.online), 'the laptop to know every device')
  assert.deepEqual(pc.state().devices.map((item) => item.name), ['Windows PC', 'build-server', 'MacBook'], 'this computer first, then by name')
  assert.equal(courier.records.get(server.state().me.device).kind, 'server')
  assert.equal(courier.records.get(server.state().me.device).addedBy, pc.state().me.device)
})

test('a wrong code adds nothing, and the device shows a new code by itself', async () => {
  const phone = await device('Phone', 'phone')
  await phone.showCode()
  const first = phone.state().code.code
  const wrong = `${first.slice(0, 5)}${first[5] === 'A' ? 'B' : 'A'}${first.slice(6)}`
  await pc.addByCode(wrong)
  await until(() => pc.state().adding?.stage === 'failed', 'the computer to give up')
  assert.equal(pc.state().adding.message, WRONG_CODE)
  await until(() => phone.state().code && phone.state().code.code !== first, 'a new code on the phone')
  assert.equal(phone.state().standing, 'alone')
  assert.equal(courier.records.has(phone.state().me.device), false, 'the courier never heard of it as a device of the account')
  await assert.rejects(pc.addByCode(first), /used once already|No device shows/, 'the old code is spent')
  phone.cancelCode()
  assert.equal(phone.state().code, undefined)
})

test('a computer’s tasks reach the other computer, never the server; Refuse and Stop from there are done and recorded', async () => {
  pc.tasksChanged()
  const remote = await until(() => laptop.remoteTasks().find((item) => item.name === 'Windows PC' && item.tasks.length), 'the PC’s tasks on the laptop')
  const task = remote.tasks.find((item) => item.key === 'codex:t1')
  assert.equal(task.folder, 'infra')
  assert.equal(task.pending[0].command, 'terraform apply -var-file=staging.tfvars')
  assert.equal(remote.role, 'computer')
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.deepEqual(server.remoteTasks(), [], 'a server only runs agents: it sees no other device’s tasks')

  const pcId = pc.state().me.device
  await laptop.act(pcId, { what: 'refuse', task: 'codex:t1', request: 'r1' })
  assert.deepEqual(pcTasks.done.at(-1), ['answer', 'codex:t1', 'r1', 'refuse'])
  await laptop.act(pcId, { what: 'stop', task: 'codex:t1' })
  assert.deepEqual(pcTasks.done.at(-1), ['stop', 'codex:t1'])
  const acted = pc.state().acted
  assert.equal(acted[0].name, 'MacBook')
  assert.equal(acted[0].what, 'Stopped Apply the staging plan')
  assert.match(acted[1].what, /^Refused terraform apply/)

  await assert.rejects(laptop.act(pcId, { what: 'refuse', task: 'codex:t1', request: 'r1' }), /answered already/)
  await assert.rejects(laptop.act(pcId, { what: 'stop', task: 'claude:s9' }), /Togle doesn’t run that task/)
  await assert.rejects(server.act(pcId, { what: 'stop', task: 'codex:t1' }), /server only runs agents/)
  await pc.setActOnThis(false)
  await assert.rejects(laptop.act(pcId, { what: 'stop', task: 'codex:t1' }), /doesn’t take answers from other devices/)
  await pc.setActOnThis(true)
  assert.equal(pcTasks.done.length, 2, 'nothing else was done')
})

test('a removed device is let go at once, and the others stop listing it', async () => {
  const laptopId = laptop.state().me.device
  await pc.remove(laptopId)
  await until(() => laptop.state().standing === 'removed', 'the laptop to know it was removed')
  assert.equal(laptop.state().devices.length, 0)
  assert.equal(courier.records.has(laptopId), false)
  await until(() => !server.state().devices.some((item) => item.device === laptopId), 'the server to hear of it')
  assert.deepEqual(pc.state().devices.map((item) => item.name), ['Windows PC', 'build-server'])
  await assert.rejects(server.remove(pc.state().me.device), /computer that is one of your devices/, 'a server removes nobody')
})

test('a device removed while it was off learns it when it connects again', async () => {
  const store = memoryStore()
  const tablet = await device('Tablet', 'computer', { store })
  await add(pc, tablet)
  const tabletId = tablet.state().me.device
  tablet.stop()
  await until(() => !pc.state().devices.find((item) => item.device === tabletId)?.online, 'the tablet to be off')
  await pc.remove(tabletId)
  // Togle starts again on the tablet, with what it kept: it thinks it is one of the devices until the courier says otherwise.
  const again = await device('Tablet', 'computer', { store })
  assert.equal(again.state().standing, 'member')
  await until(() => again.state().standing === 'removed', 'the tablet to learn it was removed')
  assert.equal(again.state().devices.length, 0)
  again.cancelCode()
})

test('the devices find each other again after the courier drops every connection', async () => {
  const seen = { pc: [], server: [] }
  pc.on('changed', () => seen.pc.push(pc.state().link))
  server.on('changed', () => seen.server.push(server.state().link))
  courier.dropAll()
  await until(() => seen.pc.includes('connecting') && seen.server.includes('connecting'), 'both to notice the drop')
  await until(() => pc.state().link === 'member' && server.state().link === 'member', 'both to be back', 10_000)
  await until(() => pc.state().devices.find((item) => item.name === 'build-server')?.online, 'the server to show online again', 10_000)
})

test('a computer that signs in to an account with devices is added from one of them, or starts them again', async () => {
  const other = await device('New PC', 'computer', { account: signedIn('token-ana') })
  await other.connectAccount()
  await until(() => other.state().addFromAnother, 'the advice to add it from another computer')
  assert.equal(other.state().standing, 'alone')
  assert.equal(pc.state().link, 'member', 'the old devices are connected when it starts again')
  await other.connectAccount(true)
  await until(() => other.state().standing === 'member', 'the new start')
  await until(() => pc.state().standing === 'removed' && server.state().standing === 'removed', 'the old devices to be let go')
  assert.deepEqual(other.state().devices.map((item) => item.name), ['New PC'])
})

test('Togle’s sign-in to Studio: a code by email, a session kept encrypted, renewed before it runs out', async () => {
  const calls = []
  let clock = 1_000_000
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search
    calls.push([path, JSON.parse(init.body ?? '{}'), init.headers.authorization])
    if (path === '/auth/v1/otp') return reply(200, {})
    if (path === '/auth/v1/verify') return JSON.parse(init.body).token === '123456' ? reply(200, { access_token: 'a1', refresh_token: 'f1', expires_in: 3600, user: { id: 'u1', email: 'ana@example.com' } }) : reply(403, {})
    if (path === '/auth/v1/token?grant_type=refresh_token') return reply(200, { access_token: 'a2', refresh_token: 'f2', expires_in: 3600, user: { id: 'u1', email: 'ana@example.com' } })
    if (path === '/rest/v1/rpc/my_plan') return reply(200, [{ plan: 'trial', trial_ends: '2026-11-20T09:00:00Z', pro_ends: null }])
    if (path === '/auth/v1/logout') return reply(204, {})
    return reply(404, {})
  }
  const kept = memoryStore()
  const account = new StudioAccount({ url: 'http://studio.test', publicKey: 'public', fetch: fetcher, now: () => clock, store: { read: () => kept.read('s'), write: (value) => kept.write('s', value) } })
  await assert.rejects(account.sendCode('not an address'), /email address/)
  await account.sendCode(' ana@example.com ')
  assert.deepEqual(calls[0].slice(0, 2), ['/auth/v1/otp', { email: 'ana@example.com', create_user: true }])
  await assert.rejects(account.verify('ana@example.com', '000000'), /didn’t work/)
  await account.verify('ana@example.com', '123 456')
  assert.equal(account.who().email, 'ana@example.com')
  assert.equal(await account.token(), 'a1')
  clock += 3600_000
  assert.equal(await account.token(), 'a2', 'renewed when it runs out')
  assert.equal((await kept.read('s')).refresh, 'f2', 'kept for the next start')
  assert.deepEqual(await account.plan(), { plan: 'trial', trialEnds: Date.parse('2026-11-20T09:00:00Z') })
  await account.signOut()
  assert.equal(account.who(), undefined)
  assert.equal(await kept.read('s'), null)
})

test('the connection to the courier: a refused device is not tried again', async () => {
  const identity = makeIdentity()
  const link = new CourierLink({ url: courier.url, identity, kind: 'computer', delays: [30] })
  link.start()
  await until(() => link.state === 'guest', 'a guest')
  const twin = new CourierLink({ url: courier.url, identity, kind: 'computer', delays: [30] })
  twin.start()
  await until(() => link.state === 'refused', 'the older connection to be refused')
  assert.equal(link.refusal.code, 'elsewhere')
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(link.state, 'refused', 'and not tried again')
  await assert.rejects(link.request({ t: 'room-open', session: 'x'.repeat(22) }), /isn’t connected/)
  twin.stop()
})
