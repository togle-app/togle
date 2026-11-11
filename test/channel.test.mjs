import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, existsSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('channel')
const T = await import('./.build/togle.mjs')

const made = []
const scratch = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'togle-channel-'))
  made.push(dir)
  return dir
}
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
const address = () => (process.platform === 'win32' ? `\\\\.\\pipe\\togle-test-${randomBytes(6).toString('hex')}` : path.join(scratch(), 's.sock'))
const secretA = T.secretOf(randomBytes(32).toString('hex'))
const secretB = T.secretOf(randomBytes(32).toString('hex'))
const until = async (check, what, ms = 4000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  assert.fail(`timed out waiting for ${what}`)
}
const serve = async (handlers, extra = {}) => {
  const where = address()
  const server = new T.ChannelServer({ secret: secretA, address: where, handlers, ...extra })
  await server.listen()
  return { server, where }
}
/** A connection by hand: what is sent, and every line that comes back. */
const raw = (where) => {
  const socket = net.connect(where)
  const lines = []
  let closed = false
  const reader = new T.LineReader((value) => lines.push(value), () => socket.destroy())
  socket.on('data', (chunk) => reader.push(chunk))
  socket.on('close', () => (closed = true))
  socket.on('error', () => undefined)
  return { socket, lines, get closed() { return closed }, send: (message) => socket.write(T.line(message)) }
}

test('an ask is signed, answered by its kind, and the answer is checked', async () => {
  const seen = []
  const { server, where } = await serve({ echo: async (body) => (seen.push(body), { said: body.toUpperCase() }) })
  try {
    const answer = await T.askChannel({ address: where, secret: secretA, kind: 'echo', body: 'hello there' })
    assert.deepEqual(answer, { ok: true, result: '{"said":"HELLO THERE"}' })
    assert.deepEqual(seen, ['hello there'])
    const text = 'line one\nline "two" ✓ \u0000 odd'
    assert.equal(JSON.parse((await T.askChannel({ address: where, secret: secretA, kind: 'echo', body: text })).result).said, text.toUpperCase(), 'any text goes through whole')
  } finally {
    await server.close()
  }
})

test('a kind Togle does not know, and a handler that fails, are answered in words and signed', async () => {
  const { server, where } = await serve({ fail: async () => { throw new Error('That went wrong.') } })
  try {
    assert.deepEqual(await T.askChannel({ address: where, secret: secretA, kind: 'nope', body: '' }), { ok: false, result: 'Togle does not know that.' })
    assert.deepEqual(await T.askChannel({ address: where, secret: secretA, kind: 'fail', body: '' }), { ok: false, result: 'That went wrong.' })
  } finally {
    await server.close()
  }
})

test('a program that holds another secret is refused, and so is one that has none to prove', async () => {
  const handled = []
  const { server, where } = await serve({ echo: async (body) => (handled.push(body), 'x') })
  try {
    await assert.rejects(T.askChannel({ address: where, secret: secretB, kind: 'echo', body: 'with the wrong secret' }), (error) => error instanceof T.ChannelRefused)
    // By hand: a proper hello, then an ask signed with the wrong secret, and one with no signature at all.
    for (const mac of [T.askMac(secretB, '0'.repeat(32), 'echo', 'forged'), undefined, 'zz', '']) {
      const c = raw(where)
      c.send({ t: 'hello', v: T.PROTOCOL, nc: T.newNonce() })
      await until(() => c.lines.length === 1, 'the welcome')
      c.send({ t: 'ask', kind: 'echo', body: 'forged', mac })
      await until(() => c.closed, 'the channel to close')
      assert.equal(c.lines.length, 1, 'nothing was answered')
    }
    assert.deepEqual(handled, [], 'nothing signed wrongly was ever acted on')
  } finally {
    await server.close()
  }
})

test('what answers on the pipe without the secret is never told anything, so it cannot allow a command', async () => {
  const where = address()
  const heard = []
  // An impostor that took the name first: it answers the hello with a welcome it cannot sign, and listens.
  const impostor = net.createServer((socket) => {
    const reader = new T.LineReader((value) => {
      heard.push(value)
      if (value.t === 'hello') socket.write(T.line({ t: 'welcome', ns: T.newNonce(), mac: T.welcomeMac(secretB, value.nc, 'a'.repeat(32)) }))
    }, () => socket.destroy())
    socket.on('data', (chunk) => reader.push(chunk))
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => impostor.listen(where, resolve))
  try {
    await assert.rejects(T.askChannel({ address: where, secret: secretA, kind: 'claude-permission', body: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }) }), (error) => error instanceof T.ChannelRefused)
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(heard.map((m) => m.t), ['hello'], 'only the hello was heard: the command was not sent')
  } finally {
    impostor.close()
  }
})

test('an answer that was not signed for that ask is not believed', async () => {
  const where = address()
  const fake = net.createServer((socket) => {
    let nc = ''
    const ns = T.newNonce()
    const reader = new T.LineReader((value) => {
      if (value.t === 'hello') {
        nc = value.nc
        socket.write(T.line({ t: 'welcome', ns, mac: T.welcomeMac(secretA, nc, ns) }))
      } else if (value.t === 'ask') {
        // Properly signed, but for a different ask: a recorded "allow" played back.
        const result = '{"decision":"allow"}'
        socket.end(T.line({ t: 'answer', ok: true, result, mac: T.answerMac(secretA, nc, ns, 'f'.repeat(64), true, result) }))
      }
    }, () => socket.destroy())
    socket.on('data', (chunk) => reader.push(chunk))
    socket.on('error', () => undefined)
  })
  await new Promise((resolve) => fake.listen(where, resolve))
  try {
    await assert.rejects(T.askChannel({ address: where, secret: secretA, kind: 'k', body: 'b' }), (error) => error instanceof T.ChannelRefused)
  } finally {
    fake.close()
  }
})

test('what was recorded from one conversation does nothing in another', async () => {
  const handled = []
  const { server, where } = await serve({ echo: async (body) => (handled.push(body), 'ok') })
  try {
    // A listener in the middle records a real ask.
    const relayAddress = address()
    let recorded
    const relay = net.createServer((client) => {
      const upstream = net.connect(where)
      client.on('data', (chunk) => {
        for (const text of chunk.toString().split('\n')) if (text.includes('"t":"ask"')) recorded = text
        upstream.write(chunk)
      })
      upstream.on('data', (chunk) => client.write(chunk))
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => client.destroy())
      client.on('error', () => undefined)
      upstream.on('error', () => undefined)
    })
    await new Promise((resolve) => relay.listen(relayAddress, resolve))
    await T.askChannel({ address: relayAddress, secret: secretA, kind: 'echo', body: 'allow this once' })
    relay.close()
    assert.ok(recorded, 'the ask was recorded')
    assert.deepEqual(handled, ['allow this once'])
    // Played back on a new conversation (a new number from the server): the signature no longer fits.
    const c = raw(where)
    c.send({ t: 'hello', v: T.PROTOCOL, nc: T.newNonce() })
    await until(() => c.lines.length === 1, 'the welcome')
    c.socket.write(recorded + '\n')
    await until(() => c.closed, 'the channel to close')
    assert.deepEqual(handled, ['allow this once'], 'the played back ask was not acted on')
  } finally {
    await server.close()
  }
})

test('garbage, a wrong version, a line that is too long and a silent connection all end quietly', async () => {
  const { server, where } = await serve({ echo: async () => 'x' }, { helloMs: 250 })
  try {
    const garbage = raw(where)
    garbage.socket.write('this is not json\n')
    await until(() => garbage.closed, 'garbage to be dropped')
    const wrong = raw(where)
    wrong.send({ t: 'hello', v: 99, nc: T.newNonce() })
    await until(() => wrong.closed, 'a wrong version to be dropped')
    const shortNonce = raw(where)
    shortNonce.send({ t: 'hello', v: T.PROTOCOL, nc: 'abc' })
    await until(() => shortNonce.closed, 'a bad number to be dropped')
    const long = raw(where)
    long.socket.write('x'.repeat(1_100_000))
    await until(() => long.closed, 'a long line to be dropped', 8000)
    const silent = raw(where)
    await until(() => silent.closed, 'a silent connection to be dropped')
    const stillWorks = await T.askChannel({ address: where, secret: secretA, kind: 'echo', body: '' })
    assert.equal(stillWorks.ok, true, 'and the server still serves')
  } finally {
    await server.close()
  }
})

test('only so many conversations at once, and one that waits too long is answered in words', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const { server, where } = await serve({ wait: async () => (await gate, 'late'), never: () => new Promise(() => undefined) }, { limit: 2, askMs: 300 })
  try {
    const first = T.askChannel({ address: where, secret: secretA, kind: 'wait', body: '' })
    const second = T.askChannel({ address: where, secret: secretA, kind: 'wait', body: '' })
    await new Promise((r) => setTimeout(r, 150))
    await assert.rejects(T.askChannel({ address: where, secret: secretA, kind: 'wait', body: '' }), (error) => error instanceof T.ChannelUnavailable, 'the third is dropped')
    release()
    assert.deepEqual((await first).ok && (await second).ok, true)
    // The two that finished have to be closed on this side too before their places are free again.
    await new Promise((r) => setTimeout(r, 150))
    assert.deepEqual(await T.askChannel({ address: where, secret: secretA, kind: 'never', body: '' }), { ok: false, result: 'No answer came in time.' })
  } finally {
    await server.close()
  }
})

test('a handler is told when the one who asked has gone', async () => {
  let aborted = false
  let started = false
  const { server, where } = await serve({ hold: (_body, { signal }) => new Promise(() => { started = true; signal.addEventListener('abort', () => (aborted = true)) }) })
  try {
    const c = raw(where)
    const nc = T.newNonce()
    c.send({ t: 'hello', v: T.PROTOCOL, nc })
    await until(() => c.lines.length === 1, 'the welcome')
    c.send({ t: 'ask', kind: 'hold', body: 'x', mac: T.askMac(secretA, c.lines[0].ns, 'hold', 'x') })
    await until(() => started, 'the handler to start')
    c.socket.destroy()
    await until(() => aborted, 'the handler to be told')
  } finally {
    await server.close()
  }
})

test('nobody there is told as such, quickly', async () => {
  const began = Date.now()
  await assert.rejects(T.askChannel({ address: address(), secret: secretA, kind: 'echo', body: '' }), (error) => error instanceof T.ChannelUnavailable)
  assert.ok(Date.now() - began < 1500)
})

test('the secret is made once, only this person can read it, and a program that only asks does not make one', async () => {
  const folder = scratch()
  await assert.rejects(T.readSecret(folder), /ENOENT/)
  const first = await T.loadSecret(folder)
  assert.equal(first.length, 32)
  assert.deepEqual(await T.loadSecret(folder), first, 'the same the second time')
  assert.deepEqual(await T.readSecret(folder), first)
  const both = await Promise.all([T.loadSecret(scratch()), T.loadSecret(scratch())])
  assert.notDeepEqual(both[0], both[1], 'each folder has its own')
  const shared = scratch()
  const raced = await Promise.all(Array.from({ length: 6 }, () => T.loadSecret(shared)))
  assert.ok(raced.every((s) => s.equals(raced[0])), 'six starts at once end with one secret')
  if (process.platform !== 'win32') assert.equal(statSync(path.join(T.channelFolder(folder), 'secret')).mode & 0o077, 0, 'nobody else can read it')
  writeFileSync(path.join(T.channelFolder(folder), 'secret'), 'not a secret')
  await assert.rejects(T.loadSecret(folder), /damaged/)
})

test('the address depends on the data folder, and is a pipe on Windows and a socket elsewhere', () => {
  const a = T.channelAddress('C:\\Users\\Someone\\AppData\\Roaming\\Togle')
  assert.equal(T.channelAddress('C:\\Users\\Someone\\AppData\\Roaming\\Togle'), a)
  assert.notEqual(T.channelAddress('C:\\Users\\Someone\\AppData\\Roaming\\Togle-dev'), a)
  if (process.platform === 'win32') assert.match(a, /^\\\\\.\\pipe\\togle-[0-9a-f]{16}$/)
  else assert.ok(path.isAbsolute(a) && a.length < 104)
})

test('a socket file left behind is cleared, and one that something answers on is not taken over', { skip: process.platform === 'win32' && 'sockets are files only off Windows' }, async () => {
  const where = address()
  writeFileSync(where, 'left behind by a Togle that ended badly')
  const one = new T.ChannelServer({ secret: secretA, address: where, handlers: { echo: async () => 'x' } })
  await one.listen()
  try {
    assert.equal((await T.askChannel({ address: where, secret: secretA, kind: 'echo', body: '' })).ok, true)
    const two = new T.ChannelServer({ secret: secretA, address: where, handlers: {} })
    await assert.rejects(two.listen(), /already answers/)
  } finally {
    await one.close()
  }
  assert.equal(existsSync(where), false, 'closing removes the file')
})
