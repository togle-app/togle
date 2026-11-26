// Reach's rules on each device, without a courier: the book of devices (who signs, renewals, removals, what a server is
// told), the exchange that adds a device by its code, and what a computer shares about its tasks.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

const {
  Adding, Book, Joining, RENEW_WITHIN_MS, WRONG_CODE, codeFor, hideSecrets, isCode, issuePass, makeIdentity, normalCode, publicKeys, roomOf, sharePhoneTasks, shareTask
} = await import('./.build/togle.mjs')

const DAY = 86_400_000
const now = Date.UTC(2026, 10, 13, 9)

/** A group: a computer that started it, and devices it added. */
function group() {
  const pc = makeIdentity(), laptop = makeIdentity(), phone = makeIdentity(), server = makeIdentity()
  const book = Book.start(pc, 'Windows PC', undefined, now)
  const passFor = (identity, name, role) => issuePass(pc, { ...publicKeys(identity), name, role }, now)
  for (const pass of [passFor(laptop, 'MacBook', 'computer'), passFor(phone, 'Phone', 'phone'), passFor(server, 'build-server', 'server')]) assert.equal(book.add(pass, now), true)
  return { pc, laptop, phone, server, book }
}

test('only the original computer can sign membership or renew a paired device', () => {
  const { pc, laptop, phone, server, book } = group()
  assert.deepEqual(book.list().map((pass) => pass.name).sort(), ['MacBook', 'Phone', 'Windows PC', 'build-server'])
  assert.ok(book.trusted(pc.device, now) && book.trusted(phone.device, now))
  const stranger = makeIdentity()
  assert.equal(book.add(issuePass(stranger, { ...publicKeys(stranger), name: 'Mine', role: 'computer' }, now), now), false, 'a device that signs its own pass is not added')
  assert.equal(book.add(issuePass(phone, { ...publicKeys(stranger), name: 'Friend', role: 'phone' }, now), now), false, 'a phone adds nobody')
  assert.equal(book.add(issuePass(server, { ...publicKeys(stranger), name: 'Friend', role: 'server' }, now), now), false, 'nor does a server')
  assert.equal(book.add(issuePass(laptop, { ...publicKeys(stranger), name: 'Extra', role: 'computer' }, now), now), false)
  assert.equal(book.bindOwner(laptop.device), false)
  assert.deepEqual(book.renew(laptop, now + 8 * DAY), [])
  assert.throws(() => book.remove(laptop, phone.device, now))
  assert.equal(book.trusted(laptop.device, now + 8 * DAY), undefined, 'a pass lasts a week')
  const old = Book.joined(laptop.device, book.get(pc.device), book.data(), now)
  const later = now + 9 * DAY
  assert.equal(old.trusted(pc.device, later), undefined)
  assert.equal(old.ownerPass(pc.device).device, pc.device)
  book.renew(pc, later)
  assert.equal(old.merge(book.data(), later), true)
  assert.ok(old.trusted(laptop.device, later), 'the pinned computer can renew the group after a long absence')
})

test('a server is told about the devices that may act on it, never about the other servers', () => {
  const { pc, book } = group()
  const other = makeIdentity()
  book.add(issuePass(pc, { ...publicKeys(other), name: 'gpu-box', role: 'server' }, now), now)
  const server = book.list().find((pass) => pass.name === 'build-server')
  assert.deepEqual(book.for(server).members.map((pass) => pass.name).sort(), ['MacBook', 'Phone', 'Windows PC', 'build-server'])
  const phone = book.list().find((pass) => pass.name === 'Phone')
  assert.equal(book.for(phone).members.length, 5, 'a phone sees every device')
})

test('a book sent from another device is checked pass by pass; keys never change, and older passes lose', () => {
  const { pc, laptop, phone, book } = group()
  const copy = new Book(laptop.device)
  copy.merge({ v: 1, members: [book.get(pc.device)], removed: [] }, now)
  assert.equal(copy.list().length, 0, 'a book with no computer the device knows is not taken in')
  const joined = Book.joined(laptop.device, book.get(pc.device), book.data(), now)
  assert.ok(joined && joined.trusted(phone.device, now), 'a new device starts from the computer that added it')
  const swapped = { ...book.get(phone.device), agree: makeIdentity().agree, issuedAt: now + 1000 }
  assert.equal(joined.merge({ v: 1, members: [swapped], removed: [] }, now + 2000), false, 'a pass that swaps a device’s keys is not taken')
  const forged = { ...book.get(phone.device), role: 'computer', issuedAt: now + 1000 }
  assert.equal(joined.merge({ v: 1, members: [forged], removed: [] }, now + 2000), false, 'nor one changed after it was signed')
  const older = issuePass(pc, { ...publicKeys(phone), name: 'Old phone', role: 'phone' }, now - DAY)
  assert.equal(joined.merge({ v: 1, members: [older], removed: [] }, now), false, 'nor an older one')
  assert.equal(joined.merge({ v: 1, members: 'nothing', removed: [] }, now), false)
})

test('passes are renewed by a computer while a device stays on the list, and a removed one runs out everywhere', () => {
  const { pc, laptop, phone, server, book } = group()
  const later = now + 7 * DAY - RENEW_WITHIN_MS + 1000
  const onLaptop = Book.joined(laptop.device, book.get(pc.device), book.data(), now)
  const renewed = book.renew(pc, later)
  assert.equal(renewed.length, 4, 'every pass with less than three days left')
  assert.ok(book.trusted(phone.device, now + 8 * DAY), 'renewed, it lasts another week')
  assert.equal(new Book(server.device).renew(server, later).length, 0, 'a server renews nothing')

  // Removal: signed by a computer of the group, it travels in the book, and the device is let go.
  book.remove(pc, phone.device, later + 1)
  assert.equal(book.trusted(phone.device, later + 2), undefined)
  assert.equal(onLaptop.merge(book.data(), later + 2), true)
  assert.equal(onLaptop.get(phone.device), undefined, 'the other computer lets it go as soon as it hears')
  assert.equal(onLaptop.wasRemoved(phone.device), true)
  // The removed phone's old pass, sent again, is not taken back.
  assert.equal(onLaptop.merge({ v: 1, members: [renewed.find((pass) => pass.device === phone.device)], removed: [] }, later + 3), false)
  // A removal signed by a phone or a server counts for nothing.
  const fake = new Book(laptop.device, book.data())
  const byServer = { device: laptop.device, by: server.device, at: later, signature: 'x'.repeat(86) }
  assert.equal(fake.merge({ v: 1, members: [], removed: [byServer] }, later + 4), false)
  // Added again later, by a computer, it is back.
  const again = issuePass(pc, { ...publicKeys(phone), name: 'Phone', role: 'phone' }, later + 10)
  assert.equal(book.add(again, later + 10), true)
  assert.equal(onLaptop.merge(book.data(), later + 11), true)
  assert.ok(onLaptop.trusted(phone.device, later + 11))
})

/** Runs the exchange between a new device and a computer, the courier left out: each says what the other reads. */
function exchange({ shown, typed, session = randomBytes(16), sessionTyped = session, kind = 'server', yes = true }) {
  const newDevice = makeIdentity(), pc = makeIdentity()
  const candidate = { ...publicKeys(newDevice), kind, name: 'build-server' }
  const joining = new Joining(shown, session, candidate)
  const adding = new Adding(typed, sessionTyped)
  let toNew = adding.open(), toComputer, result = {}
  for (let round = 0; round < 6; round++) {
    if (toNew) {
      const out = joining.receive(toNew); toNew = undefined
      if (out.failed) { result.newFailed = out.failed }
      if (out.result) result.welcome = out.result
      toComputer = out.say
    }
    if (toComputer) {
      const out = adding.receive(toComputer); toComputer = undefined
      if (out.failed) { result.computerFailed = out.failed; toNew = out.say }
      else if (out.result === 'done') result.done = true
      else if (out.result) {
        result.candidate = out.result
        if (yes) {
          const book = Book.start(pc, 'Windows PC', undefined, now)
          const pass = issuePass(pc, { ...publicKeys(newDevice), name: out.result.name, role: out.result.kind }, now)
          book.add(pass, now)
          toNew = adding.welcome({ pass, adder: book.get(pc.device), book: book.for(pass) })
        } else toNew = adding.refuse()
      } else toNew = out.say
    }
  }
  return { ...result, newDevice, pc }
}

test('adding by code: the same code adds the device, with its own keys and the role it said', () => {
  const code = codeFor('7F')
  assert.match(code, /^7F[0-9A-HJKMNP-TV-Z]{2}-[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.equal(isCode(code.toLowerCase().replace('-', ' ')), true)
  assert.equal(roomOf(code), '7F')
  const ran = exchange({ shown: code, typed: normalCode(code.toLowerCase()) })
  assert.equal(ran.candidate.name, 'build-server')
  assert.equal(ran.candidate.kind, 'server')
  assert.equal(ran.candidate.device, ran.newDevice.device)
  assert.equal(ran.welcome.pass.device, ran.newDevice.device)
  assert.equal(ran.welcome.adder.device, ran.pc.device)
  assert.equal(ran.done, true)
  const book = Book.joined(ran.newDevice.device, ran.welcome.adder, ran.welcome.book, now)
  assert.ok(book?.trusted(ran.newDevice.device, now), 'its book starts from the computer that added it')
})

test('adding by code: a wrong code ends it on both sides before the device says anything about itself', () => {
  const code = codeFor('7F')
  const wrong = `${code.slice(0, 5)}${code[5] === 'A' ? 'B' : 'A'}${code.slice(6)}`
  const ran = exchange({ shown: code, typed: wrong })
  assert.equal(ran.computerFailed, WRONG_CODE)
  assert.equal(ran.newFailed, WRONG_CODE, 'the new device hears it too')
  assert.equal(ran.candidate, undefined, 'the computer never learns who it is')
  const otherSession = exchange({ shown: code, typed: code, sessionTyped: randomBytes(16) })
  assert.equal(otherSession.computerFailed, WRONG_CODE, 'nor does a code from another session')
  const no = exchange({ shown: code, typed: code, yes: false })
  assert.match(no.newFailed, /said no/)
})

test('adding by code: out of order or tampered, the exchange stops', () => {
  const me = makeIdentity()
  const joining = new Joining(codeFor('7F'), randomBytes(16), { ...publicKeys(me), kind: 'server', name: 'x' })
  assert.match(joining.receive(JSON.stringify({ step: 'welcome', nonce: 'a'.repeat(16), box: 'b'.repeat(40) })).failed, /out of order/)
  const adding = new Adding(codeFor('7F'), randomBytes(16))
  assert.match(adding.receive('not json').failed, /can’t read/)
  assert.throws(() => adding.welcome({}), /no device waiting/)
})

test('phone choices need an owned Codex request with one non-secret question and fully visible labels', () => {
  const question = { id: 'color', text: 'Which color?', options: ['Blue', 'Green'], secret: false, free: true }
  const request = { id: '1', codexInputId: 'this-question', kind: 'question', questions: [question], offersAlways: false }
  const task = { key: 'codex:t1', runner: 'codex', title: 'Choose a color', folder: '/work/demo', state: 'waiting', mine: true, line: '', pending: [request] }
  assert.deepEqual(sharePhoneTasks([task])[0].pending[0], { id: 'this-question', kind: 'question', question: question.text, choices: question.options })
  for (const override of [{ runner: 'claude' }, { mine: false }, { terminal: true }, { state: 'stopped' }])
    assert.deepEqual(sharePhoneTasks([{ ...task, ...override }]), [])
  for (const override of [{ codexInputId: undefined }, { kind: 'command' }, { kind: 'edit' }, { questions: [question, question] },
    { questions: [{ ...question, secret: true }] }, { questions: [{ ...question, options: [] }] },
    { questions: [{ ...question, options: ['password: something-private'] }] }])
    assert.deepEqual(sharePhoneTasks([{ ...task, pending: [{ ...request, ...override }] }]), [])
})

test('what a computer shares about a task: the command whole, keys and passwords hidden elsewhere', () => {
  const shared = shareTask({
    key: 'codex:t1', id: 't1', runner: 'codex', agent: 'Codex', title: 'Deploy with token=ghp_abcdefghijklmnopqrstuvwxyz123456',
    // A folder as the computer that shares it has it, with a closing separator: the other devices get only its own name.
    folder: process.platform === 'win32' ? 'C:\\work\\infra\\' : '/work/infra/', state: 'waiting', updatedAt: now, mine: true, commandsRunning: false,
    line: 'Wants to run terraform apply with password: hunter2hunter2',
    pending: [{ id: 'r1', kind: 'command', command: 'curl -H "Authorization: Bearer sk-live-abcdefghijklmnopqrstuvwx" https://api.example.com', offersAlways: true, always: 'Always allow curl', danger: 'Sends data to the internet' }]
  })
  assert.equal(shared.folder, 'infra', 'the folder’s own name, not its path')
  assert.doesNotMatch(shared.title, /ghp_/)
  assert.match(shared.line, /password: ••••/)
  assert.doesNotMatch(shared.line, /hunter2/)
  assert.equal(shared.pending[0].command, 'Review this command on its computer')
  assert.equal(shared.pending[0].always, undefined, 'always-allow is never offered to another device')
  assert.equal(hideSecrets('postgres://ana:s3cretpass@db.local/app'), 'postgres://ana:••••@db.local/app')
  assert.equal(hideSecrets('AKIAABCDEFGHIJKLMNOP and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXNpZ25hdHVyZQ'), '•••• and ••••')
  assert.equal(hideSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'), '••••')
  assert.equal(hideSecrets('Run the tests in api-server'), 'Run the tests in api-server', 'ordinary words stay')
})
