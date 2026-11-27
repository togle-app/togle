// Reach between devices, through a stand-in courier (fake-courier.mjs): the first computer signs in and starts the
// devices, another computer and a server are added by their codes (a wrong code adds nothing), a computer's tasks reach
// the other computer and not the server, Refuse and Stop from another device are done and recorded, and a removed
// device is let go. Also Togle's sign-in to Studio and its connection, against stand-ins.
import assert from 'node:assert/strict'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fakeCourier } from './fake-courier.mjs'

const { accountConfig, CourierLink, Reach, StudioAccount, WRONG_CODE, makeIdentity, unlock } = await import('./.build/togle.mjs')

test('only public account keys and HTTPS origins can enter release packages', () => {
  const key = 'sb_publishable_test'
  const origin = 'https://account.example.com'
  const jwt = role => ['header', Buffer.from(JSON.stringify({ role })).toString('base64url'), 'signature'].join('.')
  assert.equal(accountConfig(), undefined)
  assert.deepEqual(accountConfig(origin + '/', key), { url: origin, publicKey: key })
  assert.equal(accountConfig(origin, jwt('anon')).url, origin)
  assert.throws(() => accountConfig(origin))
  assert.throws(() => accountConfig(undefined, key))
  for (const secret of ['sb_secret_private', jwt('service_role')]) assert.throws(() => accountConfig(origin, secret))
  for (const unsafe of ['http://example.com', 'http://127.0.0.1:54321', 'https://localhost', 'https://one:two@example.com', origin + '/unexpected']) {
    assert.throws(() => accountConfig(unsafe, key))
  }
  assert.equal(accountConfig('http://127.0.0.1:54321', key, true).url, 'http://127.0.0.1:54321')
})

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
    }, {
      // A task in the background with the agent's own screen (Claude Code): its screen is open in Togle on that computer.
      key: 'claude:bg1', id: 'bg1', runner: 'claude', agent: 'Claude Code', title: 'Rebuild the pricing page', folder: '/work/website', state: 'waiting',
      updatedAt: Date.now(), mine: true, commandsRunning: false, line: 'Wants to run npm run migrate', terminal: true, screen: true, job: 'abc12345',
      pending: [{ id: 'r2', kind: 'command', command: 'npm run migrate', offersAlways: false }]
    }, {
      // An agent without a protocol, run in a terminal of Togle's own: Togle only watches it.
      key: 'term-aider:t1', id: 't1', runner: 'term-aider', agent: 'Aider', title: 'Rename the module', folder: '/work/api-server', state: 'working',
      updatedAt: Date.now(), mine: true, commandsRunning: false, line: 'Working', terminal: true, pending: []
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

before(async () => { courier = await fakeCourier({ tokens: new Map([['token-ana', 'ana'], ['token-pause', 'pause'], ['token-pilot', 'pilot'], ['token-reports', 'reports'], ['token-desktop-reports', 'desktop-reports'], ['token-beta', 'beta']]) }) })
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

test('hosted beta shares only the selected folder, with remote actions off until enabled', async () => {
  const tasks = new Tasks()
  for (const task of tasks.tasks) task.folder = path.resolve(task.folder)
  const store = memoryStore()
  const host = await device('Beta PC', 'computer', {
    account: signedIn('token-beta'), tasks, store, hostedBeta: true, phonePilot: true, desktopActivity: true
  })
  await host.connectAccount()
  await until(() => host.state().standing === 'member', 'the hosted beta computer')
  const viewer = await device('Beta laptop')
  await add(host, viewer)
  const remote = () => viewer.remoteTasks().find(item => item.device === host.state().me.device)
  await until(() => remote()?.at, 'the initial empty host report')
  assert.deepEqual(remote().tasks, [])
  assert.equal(host.state().actOnThis, false)
  await host.setSharedFolder(tasks.tasks[0].folder)
  await until(() => remote()?.tasks.length === 1, 'the selected folder report')
  assert.equal(remote().tasks[0].key, tasks.tasks[0].key)
  assert.equal(store.files.get('reach-settings').sharedFolder, tasks.tasks[0].folder)
  await host.setSharedFolder(null)
  await until(() => remote()?.tasks.length === 0, 'the folder to stop sharing')
})

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

test('paired computers control each other and phones can answer a current Codex choice in the pilot workspace', async () => {
  const tasks = new Tasks()
  const task = tasks.tasks[0]
  const [command] = task.pending
  const question = { id: 'rpc-1', kind: 'question', codexInputId: 'one-live-question', questions: [
    { id: 'color', text: 'Which color?', options: ['Blue', 'Green'], secret: false, free: false }
  ], offersAlways: false }
  task.pending = [question, command]
  tasks.tasks.push({ ...task, key: 'codex:outside', folder: path.join(task.folder, 'other'), pending: [question] })
  tasks.tasks.push({ ...task, key: 'codex:command', pending: [command] })
  const answerChoice = (owned, key, request, choice) => {
    const current = owned.tasks.find(item => item.key === key && item.pending.some(pending => pending.codexInputId === request))
    if (!current) throw new Error('That Codex question is no longer available.')
    owned.done.push([key, request, choice])
    current.pending = current.pending.filter(pending => pending.codexInputId !== request)
  }
  tasks.replyChoice = (...args) => answerChoice(tasks, ...args)
  const otherTasks = new Tasks()
  const otherTask = otherTasks.tasks[0]
  const otherQuestion = { ...question, codexInputId: 'other-live-question' }
  otherTask.pending = [otherQuestion]
  otherTasks.replyChoice = (...args) => answerChoice(otherTasks, ...args)
  const host = await device('Pilot PC', 'computer', { account: signedIn('token-pilot'), tasks, phonePilot: true, pilotFolder: path.resolve(task.folder) })
  await host.connectAccount()
  await until(() => host.state().standing === 'member', 'the pilot host')
  const other = await device('Other PC', 'computer', { tasks: otherTasks, phonePilot: true, pilotFolder: path.resolve(otherTask.folder) })
  const spare = await device('Spare PC', 'computer', { phonePilot: true })
  const phone = await device('Pilot phone', 'phone')
  await add(host, other)
  await add(host, spare)
  await add(host, phone)
  const hostId = host.state().me.device
  const otherId = other.state().me.device
  const report = (viewer, device) => viewer.remoteTasks().find(entry => entry.device === device)
  const tasksOn = (viewer, device) => report(viewer, device)?.tasks
  const requestOn = (viewer, device) => tasksOn(viewer, device)?.find(item => item.key === task.key)?.pending[0]
  const request = await until(() => requestOn(phone, hostId)?.choices && requestOn(phone, hostId), 'listed choices on the phone')
  assert.deepEqual(request, { id: 'one-live-question', kind: 'question', question: 'Which color?', choices: ['Blue', 'Green'] })
  assert.deepEqual(tasksOn(phone, hostId), [{
    key: task.key, title: task.title, agent: 'Codex', folder: '', state: 'waiting', line: '',
    pending: [request], mine: true, commandsRunning: false, updatedAt: 0
  }])
  for (const what of ['refuse', 'stop', 'end-commands', 'allow']) {
    await assert.rejects(phone.act(hostId, { what, task: task.key, request: command.id }), /only select an answer/)
  }
  assert.deepEqual(await until(() => requestOn(other, hostId)?.choices && requestOn(other, hostId), 'listed choices on the other computer'), request)
  assert.deepEqual(await until(() => requestOn(host, otherId)?.choices && requestOn(host, otherId), 'the first computer sees the other one’s question'), { ...request, id: otherQuestion.codexInputId })
  assert.equal(tasksOn(other, hostId).find(item => item.key === task.key).pending[1].command, command.command)
  assert.ok(!tasksOn(other, hostId).some(item => item.key === 'codex:outside'))
  const spareId = spare.state().me.device
  const spareReport = await until(() => report(other, spareId)?.online && report(other, spareId), 'a paired computer before its first task report')
  assert.equal(spareReport.at, 0)
  assert.deepEqual(spareReport.tasks, [])
  assert.equal(report(phone, spareId), undefined)
  const act = { what: 'reply-choice', task: task.key, request: request.id, choice: 1 }
  await until(() => phone.state().devices.some(device => device.device === spareId && device.online), 'the phone sees the spare computer')
  await assert.rejects(phone.act(spareId, act), /not accepting remote answers/)
  spare.stop()
  await until(() => report(other, spareId)?.online === false, 'the spare computer stays in the list when offline')
  await assert.rejects(phone.act(otherId, act), /no longer available/)
  await host.setActOnThis(false)
  await assert.rejects(phone.act(hostId, act), /doesn’t take answers/)
  await assert.rejects(other.act(hostId, act), /doesn’t take answers/)
  await until(() => tasksOn(phone, hostId)?.length === 0, 'the phone task to disappear')
  await until(() => report(other, hostId)?.canAct === false && !requestOn(other, hostId)?.choices, 'the other desktop sees view-only access')
  await host.setActOnThis(true)
  await until(() => requestOn(phone, hostId)?.choices && requestOn(other, hostId)?.choices, 'both controllers see the choices again')
  for (const choice of [-1, 2, 'Green']) await assert.rejects(other.act(hostId, { ...act, choice }), /Select one/)
  await assert.rejects(other.act(hostId, { ...act, task: 'codex:outside' }), /no longer available/)
  await assert.rejects(other.act(hostId, { ...act, request: question.id }), /no longer available/)
  assert.deepEqual(tasks.done, [])
  await other.act(hostId, act)
  await host.act(otherId, { ...act, request: otherQuestion.codexInputId, choice: 0 })
  await until(() => tasksOn(phone, hostId)?.length === 0, 'the answered task to disappear from the phone')
  await assert.rejects(phone.act(hostId, act), /no longer available/)
  assert.deepEqual(tasks.done, [[task.key, request.id, 1]])
  assert.deepEqual(otherTasks.done, [[otherTask.key, otherQuestion.codexInputId, 0]])
  assert.equal(host.state().acted[0].name, 'Other PC')
  assert.equal(other.state().acted[0].name, 'Pilot PC')

  const fresh = { ...question, codexInputId: 'fresh-question' }
  task.pending = [fresh, command]
  host.tasksChanged()
  await until(() => requestOn(phone, hostId)?.id === fresh.codexInputId && requestOn(other, hostId)?.id === fresh.codexInputId, 'the next question on both devices')
  const concurrent = await Promise.allSettled([
    phone.act(hostId, { ...act, request: fresh.codexInputId }),
    other.act(hostId, { ...act, request: fresh.codexInputId, choice: 0 })
  ])
  assert.equal(concurrent.filter(answer => answer.status === 'fulfilled').length, 1)
  assert.match(concurrent.find(answer => answer.status === 'rejected').reason.message, /no longer available/)
  assert.equal(tasks.done.filter(([, requestId]) => requestId === fresh.codexInputId).length, 1)

  const phoneQuestion = { ...question, codexInputId: 'phone-answer' }
  task.pending = [phoneQuestion]
  host.tasksChanged()
  await until(() => requestOn(phone, hostId)?.id === phoneQuestion.codexInputId, 'the phone has a fresh question')
  await phone.act(hostId, { ...act, request: phoneQuestion.codexInputId })
  assert.equal(host.state().acted[0].name, 'Pilot phone')
  assert.deepEqual(tasks.done.at(-1), [task.key, phoneQuestion.codexInputId, 1])
})

test('phone reports are limited to managed sessions in the opted-in folder', async () => {
  const tasks = new Tasks()
  const task = tasks.tasks[0]
  task.folder = path.resolve(task.folder)
  const outside = { ...task, key: 'codex:outside', folder: path.join(task.folder, 'other') }
  const observed = { ...task, key: 'codex:observed', mine: false }
  const hermes = { ...task, key: 'hermes:inside', agent: 'Hermes', runner: 'hermes', state: 'idle', pending: [] }
  tasks.tasks.push(outside, observed, hermes)
  const details = []
  const meter = []
  const messages = []
  const queued = []
  const revision = 'q'.repeat(43)
  tasks.phoneMessage = async (key, text, quote) => {
    messages.push([key, text, quote])
    queued.push(text)
    return 'queued'
  }
  tasks.phoneQueue = async (key, version, action, index) => {
    assert.equal(key, task.key)
    if (version !== revision) throw new Error('The queue changed.')
    assert.equal(action, 'remove')
    queued.splice(index, 1)
  }
  const at = Date.now()
  const log = [
    { id: 1, at, kind: 'you', text: 'Check the release' },
    { id: 2, at, kind: 'command', text: 'private command output' },
    { id: 3, at, kind: 'agent', text: 'Check complete. password=demo-secret-123' },
  ]
  const hermesPrompt = { id: 1, at, kind: 'you', text: 'Check the Linux build' }
  const hermesReply = { id: 102, at, kind: 'agent', text: 'The Linux build passed.' }
  let hermesHistory = [{ ...hermesPrompt, id: 101 }, hermesReply]
  tasks.phone = {
    detail: async key => {
      details.push(key)
      if (key === hermes.key) return { task: hermes, log: [hermesPrompt] }
      return { task, log }
    },
    history: async key => key === hermes.key ? { entries: hermesHistory } : null,
    model: async () => ({ model: 'gpt-6.2-sol', effort: 'high', fast: true }),
    usage: async (runner, id) => {
      meter.push([runner, id])
      if (runner === 'hermes') return { kind: 'providers', period: 'all', sources: [
        { provider: 'OpenAI', billing: 'subscription', tokens: 456 },
        { provider: 'Kimi', billing: 'api', tokens: 789, cost: { currency: 'USD', amount: 0.04 } }
      ] }
      return { kind: 'tokens', period: id ? 'session' : '7d', total: id ? 123 : 567 }
    },
    limits: () => [{ label: 'weekly', usedPercent: 32, resetsAt: Date.now() + 100_000 }],
    queue: () => queued.length ? { revision, messages: [...queued], canSend: false } : undefined
  }
  const host = await device('Reports computer', 'computer', {
    account: signedIn('token-reports'), tasks, phonePilot: true,
    phoneActivity: true, phoneMessages: true, accountUsage: true, pilotFolder: task.folder
  })
  await host.connectAccount()
  await until(() => host.state().connection === 'on', 'the reports host')
  await host.setActOnThis(false)
  const phone = await device('Reports phone', 'phone')
  const laptop = await device('Reports laptop', 'computer')
  await add(host, phone)
  await add(host, laptop)
  const hostId = host.state().me.device
  const report = await until(() => phone.remoteTasks().find(peer => peer.phoneReports && peer.device === hostId), 'the phone’s report capability')
  assert.equal(report.canAct, false)
  assert.deepEqual(report.tasks.map(item => [item.key, item.line, item.pending]), [[task.key, '', []], [hermes.key, '', []]])
  assert.equal(laptop.remoteTasks().find(peer => peer.device === hostId)?.phoneReports, undefined)
  await assert.rejects(laptop.readSession(hostId, task.key), /not sharing/)
  const replies = new Map()
  phone.link.on('box', box => {
    if (box.from !== hostId) return
    const note = unlock(phone.keyFor(phone.book.get(hostId)), box)
    if (note.kind === 'phone-report') replies.set(note.n, note.report)
  })
  const send = (sender, n, query) => sender.send(hostId, { kind: 'phone-read', n, at: Date.now(), query })
  const read = async (n, query) => {
    await send(phone, n, query)
    await until(() => replies.has(n), `the report ${n}`)
    return replies.get(n)
  }
  assert.equal(await read('outside', { kind: 'session', task: outside.key }), undefined)
  assert.equal(await read('observed', { kind: 'session', task: observed.key }), undefined)
  await send(laptop, 'computer', { kind: 'session', task: task.key })
  const result = await read('activity', { kind: 'session', task: task.key })
  assert.equal(result.model, 'GPT 6.2 Sol · high · Fast')
  assert.deepEqual(result.activity, [
    { kind: 'you', text: 'Check the release' },
    { kind: 'work', text: '1 step: ran 1 command' },
    { kind: 'agent', text: 'Check complete. password=••••' },
  ])
  assert.deepEqual(result.usage.readings, ['123 tokens'])
  const measured = await read('usage', { kind: 'usage' })
  assert.deepEqual(measured.agents.map(agent => agent.runner), ['codex', 'hermes'])
  assert.deepEqual(measured.agents[0].usage.readings, ['567 tokens · Last 7 days'])
  assert.equal(measured.agents[0].usage.limits[0].usedPercent, 32)
  assert.match(measured.agents[1].usage.readings[0], /^OpenAI subscription · 456 tokens$/)
  assert.match(measured.agents[1].usage.readings[1], /^Kimi API · /)
  assert.deepEqual(details, [task.key])
  assert.deepEqual(meter, [['codex', task.id], ['codex', undefined], ['hermes', undefined]])
  const message = '## Results\n\n' + 'Each check passed. '.repeat(90).trimEnd()
  log.push({ id: 4, at, kind: 'agent', text: message })
  const chat = await read('chat', { kind: 'session', task: task.key, view: 'chat' })
  assert.equal(chat.activity[0].delivery, 'delivered')
  assert.deepEqual(chat.activity.at(-1), { kind: 'agent', text: message, id: 4, at })
  assert.equal(chat.activity[1].text, '1 step: ran 1 command')
  const earlier = await read('older-phone', { kind: 'session', task: task.key })
  assert.equal(earlier.activity.at(-1).text.length, 800)
  assert.equal(earlier.activity.at(-1).id, undefined)

  const hermesChat = await read('hermes-chat', { kind: 'session', task: hermes.key, view: 'chat' })
  assert.deepEqual(hermesChat.activity, [
    { ...hermesPrompt, id: 101, delivery: 'delivered' },
    hermesReply,
  ])
  hermesHistory = []
  const startingHermes = await read('hermes-starting', { kind: 'session', task: hermes.key, view: 'chat' })
  assert.deepEqual(startingHermes.activity, [{ ...hermesPrompt, delivery: 'delivered' }])

  const messageAct = { what: 'send-message', task: task.key, id: 'a'.repeat(24), text: 'Review the checks', quote: 'Check complete.' }
  await assert.rejects(phone.act(hostId, messageAct), /doesn’t take answers/)
  await host.setActOnThis(true)
  await until(() => phone.remoteTasks().find(peer => peer.device === hostId)?.tasks.some(row => row.key === task.key && row.canSend && row.canStop), 'the writable conversation')
  await assert.rejects(laptop.act(hostId, messageAct))
  await assert.rejects(phone.act(hostId, { ...messageAct, task: outside.key }), /Continue this conversation/)
  await assert.rejects(phone.act(hostId, { ...messageAct, task: observed.key }), /Continue this conversation/)
  assert.equal(await phone.act(hostId, messageAct), 'queued')
  assert.equal(await phone.act(hostId, messageAct), 'queued')
  assert.deepEqual(messages, [[task.key, 'Review the checks', 'Check complete.']])
  await assert.rejects(phone.act(hostId, { ...messageAct, text: 'Different text' }), /already sent/)
  const withQueue = await read('queue', { kind: 'session', task: task.key, view: 'chat' })
  assert.deepEqual(withQueue.queue, { revision, messages: ['Review the checks'], canSend: false })
  log.push({ id: 5, at, kind: 'you', text: 'In transit', delivery: 'sent' })
  const forwarding = await read('forwarding', { kind: 'session', task: task.key, view: 'chat' })
  assert.equal(forwarding.activity.at(-1).delivery, 'sent')
  await assert.rejects(phone.act(hostId, { what: 'manage-queue', task: task.key, revision: 'b'.repeat(43), action: 'remove', index: 0 }), /queue changed/)
  await phone.act(hostId, { what: 'manage-queue', task: task.key, revision, action: 'remove', index: 0 })
  await phone.act(hostId, { what: 'stop', task: task.key })
  assert.deepEqual(queued, [])
  assert.deepEqual(tasks.done.at(-1), ['stop', task.key])
})

test('a paired desktop reads a shared conversation from its host with remote actions off', async () => {
  const tasks = new Tasks()
  const task = tasks.tasks[0]
  task.folder = path.resolve(task.folder)
  const outside = { ...task, key: 'codex:outside', folder: path.join(task.folder, 'other') }
  const observed = { ...task, key: 'codex:observed', mine: false }
  tasks.tasks.push(outside, observed)
  const at = Date.now()
  const log = [
    { id: 1, at, kind: 'you', text: 'Check the new layout', delivery: 'delivered' },
    { id: 2, at, kind: 'command', text: 'Private command output' },
    { id: 3, at, kind: 'agent', text: 'The **checks** passed. password=demo-secret-123' }
  ]
  const details = []
  tasks.phone = {
    detail: async key => { details.push(key); return { task, log } },
    history: async () => null,
    model: async () => ({ model: 'gpt-6.2-sol', effort: 'high', fast: true }),
    usage: async () => ({ kind: 'tokens', period: 'session', total: 305, trackedApi: { kind: 'cost', scope: 'agent-sessions', amounts: [{ currency: 'USD', amount: 9 }] } }),
    limits: () => [{ label: 'weekly', usedPercent: 92 }]
  }
  const host = await device('Desktop reports host', 'computer', {
    account: signedIn('token-desktop-reports'), tasks, desktopActivity: true, pilotFolder: task.folder
  })
  await host.connectAccount()
  await until(() => host.state().connection === 'on', 'the desktop report host')
  await host.setActOnThis(false)
  const other = await device('Desktop report reader', 'computer')
  const phone = await device('Phone without reports', 'phone')
  await add(host, other)
  await add(host, phone)
  const hostId = host.state().me.device
  const shared = await until(() => other.remoteTasks().find(peer => peer.device === hostId && peer.desktopReports), 'the shared desktop session')
  assert.equal(shared.canAct, false)
  assert.equal(shared.phoneReports, undefined)
  await assert.rejects(phone.readSession(hostId, task.key), /not sharing/)
  await assert.rejects(other.readSession(hostId, observed.key), /not sharing/)
  await assert.rejects(other.readSession(hostId, outside.key), /not sharing/)
  const report = await other.readSession(hostId, task.key)
  assert.deepEqual(report.activity, [
    { kind: 'you', text: 'Check the new layout', id: 1, at, delivery: 'delivered' },
    { kind: 'work', text: '1 step: ran 1 command', id: 2, at },
    { kind: 'agent', text: 'The **checks** passed. password=••••', id: 3, at }
  ])
  assert.equal(report.model, 'GPT 6.2 Sol · high · Fast')
  assert.deepEqual(report.usage, { readings: ['305 tokens'], limits: [] }, 'sharing this session alone keeps broader cost and limits private')
  assert.deepEqual(details, [task.key])
  // The host still checks the scope when a session changes between listing and opening it.
  task.folder = outside.folder
  await assert.rejects(other.readSession(hostId, task.key), /conversation is unavailable/)
  assert.deepEqual(details, [task.key])
  await host.remove(other.state().me.device)
  await until(() => other.state().standing === 'removed', 'the reader to be removed')
  await assert.rejects(other.readSession(hostId, task.key), /not sharing/)
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

test('the host honors its remote-actions switch even while a validated request is in flight', async () => {
  const host = pc.state().me.device
  const total = pcTasks.done.length
  courier.beforeDirectory.set(host, () => { void pc.setActOnThis(false) })
  try {
    await assert.rejects(laptop.act(host, { what: 'stop', task: 'codex:t1' }), /unavailable/)
    assert.equal(pcTasks.done.length, total)
  } finally { await pc.setActOnThis(true) }
})

test('a task in the background is refused and stopped from another device like any other, its screen open or not; a terminal Togle only watches is not', async () => {
  pc.tasksChanged()
  const remote = await until(() => laptop.remoteTasks().find((item) => item.name === 'Windows PC' && item.tasks.some((task) => task.key === 'claude:bg1')), 'the task in the background on the laptop')
  assert.equal(remote.tasks.find((item) => item.key === 'claude:bg1').terminal, undefined, 'it is not marked as a terminal that is only watched')
  assert.equal(remote.tasks.find((item) => item.key === 'term-aider:t1').terminal, true)
  const pcId = pc.state().me.device
  await laptop.act(pcId, { what: 'refuse', task: 'claude:bg1', request: 'r2' })
  assert.deepEqual(pcTasks.done.at(-1), ['answer', 'claude:bg1', 'r2', 'refuse'])
  await laptop.act(pcId, { what: 'stop', task: 'claude:bg1' })
  assert.deepEqual(pcTasks.done.at(-1), ['stop', 'claude:bg1'])
  const before = pcTasks.done.length
  await assert.rejects(laptop.act(pcId, { what: 'stop', task: 'term-aider:t1' }), /runs in a terminal. It is answered only at its own computer/)
  assert.equal(pcTasks.done.length, before, 'what Togle only watches is left alone')
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

test('a signed-in computer can start an isolated group and a saved key can recover only its old group', async () => {
  const account = signedIn('token-ana')
  const other = await device('Another group', 'computer', { account })
  await other.connectAccount()
  assert.equal(other.state().standing, 'member')
  assert.deepEqual(other.state().devices.map(item => item.name), ['Another group'])
  assert.equal(pc.state().link, 'member')

  const key = await pc.recoveryKeyForCopy()
  assert.match(key, /^togle-recovery:v1:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]{43}$/)
  assert.ok(!JSON.stringify(pc.state()).includes(key))
  const fresh = await device('Replacement computer', 'computer', { account })
  const wrongKey = key.slice(0, -43) + 'A'.repeat(43)
  await assert.rejects(fresh.connectAccount(wrongKey), /recovery key/)
  assert.equal(pc.state().link, 'member')
  await fresh.connectAccount(key)
  await until(() => pc.state().standing === 'removed' && server.state().standing === 'removed', 'the old group to be disconnected')
  assert.deepEqual(fresh.state().devices.map(item => item.name), ['Replacement computer'])
  assert.equal(other.state().link, 'member', 'recovery leaves other groups alone')
  assert.notEqual(await fresh.recoveryKeyForCopy(), key)
})

test('sign-out hides the group and the same account resumes it after an app restart', async () => {
  let who = { email: 'test@example.com', user: 'pause' }
  const account = { who: () => who, token: async () => who?.user === 'pause' ? 'token-pause' : undefined, signOut: async () => { who = undefined } }
  const store = memoryStore()
  const approved = []
  const approveDeviceChange = async operation => { approved.push(operation) }
  const host = await device('Bound PC', 'computer', { account, store, approveDeviceChange })
  const id = host.state().me.device
  await host.connectAccount()
  await until(() => host.state().canManageDevices, 'first verification')
  await host.signOut()
  assert.equal(host.state().accountPaused, true)
  assert.deepEqual(host.state().devices, [])
  await until(() => !courier.online.has(id), 'sign-out to disconnect the host')
  host.stop()
  const resumed = await device('Bound PC', 'computer', { account, store, approveDeviceChange })
  who = { email: 'elsewhere@example.com', user: 'another' }
  resumed.accountChanged()
  assert.equal(resumed.state().accountPaused, true)
  assert.deepEqual(resumed.remoteTasks(), [])
  who = { email: 'test@example.com', user: 'pause' }
  resumed.accountChanged()
  await until(() => resumed.state().link === 'member', 'the verified account to resume')
  assert.equal(resumed.state().me.device, id)
  assert.deepEqual(approved, ['enable'], 'routine reconnect does not prompt again')
})

test('Togle account sign-in: an email code and an encrypted session that renews before it expires', async () => {
  const calls = []
  let clock = 1_000_000
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const fetcher = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search
    calls.push([path, JSON.parse(init.body ?? '{}'), init.headers.authorization])
    if (path === '/auth/v1/otp?redirect_to=https%3A%2F%2Ftogle.app') return reply(200, {})
    if (path === '/auth/v1/verify') return JSON.parse(init.body).token === '123456' ? reply(200, { access_token: 'a1', refresh_token: 'f1', expires_in: 3600, user: { id: 'u1', email: 'ana@example.com' } }) : reply(403, {})
    if (path === '/auth/v1/token?grant_type=refresh_token') return reply(200, { access_token: 'a2', refresh_token: 'f2', expires_in: 3600, user: { id: 'u1', email: 'ana@example.com' } })
    if (path === '/rest/v1/rpc/my_pro_waitlist') return reply(200, false)
    if (path === '/rest/v1/rpc/join_pro_waitlist') return reply(200, true)
    if (path === '/rest/v1/rpc/leave_pro_waitlist') return reply(200, false)
    if (path === '/rest/v1/rpc/my_plan') return reply(200, [{ plan: 'trial', trial_ends: '2026-11-20T09:00:00Z', pro_ends: null }])
    if (path === '/auth/v1/logout?scope=local') return new Response(null, { status: 204 })
    return reply(404, {})
  }
  const kept = memoryStore()
  const account = new StudioAccount({ url: 'http://studio.test', publicKey: 'public', fetch: fetcher, now: () => clock, store: { read: () => kept.read('s'), write: (value) => kept.write('s', value) } })
  await assert.rejects(account.sendCode('not an address'), /email address/)
  await account.sendCode(' ana@example.com ')
  assert.deepEqual(calls[0].slice(0, 2), ['/auth/v1/otp?redirect_to=https%3A%2F%2Ftogle.app', { email: 'ana@example.com', create_user: true }])
  await assert.rejects(account.verify('ana@example.com', '000000'), /didn’t work/)
  await account.verify('ana@example.com', '123 456')
  assert.equal(account.who().email, 'ana@example.com')
  assert.equal(await account.token(), 'a1')
  assert.equal(await account.waitlist('u1', 'status'), false)
  assert.deepEqual(calls.at(-1), ['/rest/v1/rpc/my_pro_waitlist', {}, 'Bearer a1'])
  const before = calls.length
  await assert.rejects(account.waitlist('other', 'join'), /Sign in/)
  assert.equal(calls.length, before, 'a stale window cannot change a different account')
  assert.equal(await account.waitlist('u1', 'join'), true)
  assert.equal(await account.waitlist('u1', 'leave'), false)
  clock += 3600_000
  assert.equal(await account.token(), 'a2', 'renewed when it runs out')
  assert.equal((await kept.read('s')).refresh, 'f2', 'kept for the next start')
  assert.deepEqual(await account.plan(), { plan: 'trial', trialEnds: Date.parse('2026-11-20T09:00:00Z') })
  await account.signOut()
  assert.deepEqual(calls.at(-1), ['/auth/v1/logout?scope=local', {}, 'Bearer a2'])
  assert.equal(account.who(), undefined)
  assert.equal(await kept.read('s'), null)
  await assert.rejects(account.waitlist('u1', 'join'), /Sign in/)
})

test('a stored Togle session stays bound to its service and a revoked refresh token signs out locally', async () => {
  const kept = memoryStore()
  const url = 'https://accounts.example.test'
  const user = { id: 'u1', email: 'ana@example.com' }
  const token = 'header.' + Buffer.from(JSON.stringify({ iss: url + '/auth/v1' })).toString('base64url') + '.signature'
  const saved = { access: token, refresh: 'old-refresh', expiresAt: 10000000, user: user.id, email: user.email }
  const opts = { url, publicKey: 'public', now: () => 1000000, store: { read: () => kept.read('s'), write: value => kept.write('s', value) } }
  await kept.write('s', saved)
  const previous = new StudioAccount(opts)
  await previous.load()
  assert.equal((await previous.token()), token, 'old sessions without an explicit origin can reopen against their issuer')
  for (const record of [saved, { ...saved, origin: url }]) {
    await kept.write('s', record)
    const another = new StudioAccount({ ...opts, url: 'https://elsewhere.example.test' })
    assert.equal(await another.token(), undefined)
  }
  let changed = 0
  const fetch = async address => {
    assert.equal(new URL(address).pathname, '/auth/v1/token')
    return new Response('{}', { status: 401 })
  }
  const expired = new StudioAccount({ ...opts, now: () => saved.expiresAt, fetch, changed: () => { changed++ } })
  await assert.rejects(expired.waitlist(user.id, 'join'), /Sign in/)
  assert.equal(changed, 1)
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
  await assert.rejects(link.request({ t: 'room-open', session: 'x'.repeat(22) }), /The device connection is unavailable/)
  twin.stop()
})
