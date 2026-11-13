import assert from 'node:assert/strict'
import { crc32, deflateSync } from 'node:zlib'
import { test } from 'node:test'
import { workDir } from './helpers.mjs'
workDir('attention')
const T = await import('./.build/togle.mjs')

const request = (id, kind, extra = {}) => ({ id, kind, offersAlways: false, ...extra })
const task = (key, state, pending = [], extra = {}) => ({ key, runner: key.split(':')[0], title: `Task ${key}`, folder: 'C:\\work\\api-server', state, pending, line: '', ...extra })
const clock = () => {
  let at = 1000
  return () => (at += 10)
}

// ---- what a notice says ----

test('a command that waits becomes a notice with the command in full and both buttons', () => {
  const attention = new T.Attention(clock())
  const look = attention.look([task('codex:a', 'waiting', [request('r1', 'command', { command: 'npm run migrate', raw: 'powershell -Command "npm run migrate"' })])])
  assert.equal(look.waiting, 1)
  assert.equal(look.notices.length, 1)
  const [notice] = look.notices
  assert.deepEqual({ ...notice }, {
    id: 'codex:a#r1', kind: 'waiting', key: 'codex:a', title: 'Task codex:a', where: 'Codex · api-server', says: 'wants to run', detail: 'npm run migrate',
    detailKind: 'command', requestId: 'r1', canRefuse: true, canAllow: true, others: 0
  })
  assert.deepEqual(look.finished, [])
})

test('a task that stopped, by the Stop button or by an error, waits for a reply: the tray counts it, and no notice asks', () => {
  const attention = new T.Attention(clock())
  const look = attention.look([task('codex:a', 'stopped'), task('claude:b', 'failed', [], { line: 'Codex is signed out.' }), task('claude:c', 'idle'), task('claude:d', 'working')])
  assert.equal(look.waiting, 2, 'the stopped one and the broken one')
  assert.deepEqual(look.notices, [], 'there is nothing to allow or answer in a notice')
  const asked = attention.look([task('codex:a', 'stopped'), task('codex:e', 'waiting', [request('r1', 'command', { command: 'ls', raw: 'ls' })])])
  assert.equal(asked.waiting, 2)
  assert.equal(asked.notices[0].others, 1, 'the notice for the one that asks counts the stopped one among the others')
})

test('a task in the background that waits on its own screen counts, with a notice that only opens it, until it no longer waits', () => {
  const attention = new T.Attention(clock())
  const waiting = task('claude:a', 'waiting', [], { screen: true, waitingFor: 'permission prompt' })
  assert.equal(attention.look([waiting]).waiting, 1, 'the tray counts it')
  const look = attention.look([waiting, task('codex:b', 'waiting', [request('r1', 'command', { command: 'ls', raw: 'ls' })])])
  assert.equal(look.waiting, 2, 'and with the other')
  assert.deepEqual(look.notices.map((notice) => notice.id), ['claude:a#screen', 'codex:b#r1'], 'oldest first')
  assert.deepEqual({ ...look.notices[0] }, {
    id: 'claude:a#screen', kind: 'waiting', key: 'claude:a', title: 'Task claude:a', where: 'Claude Code · api-server', says: 'waits on its screen', detail: 'permission prompt',
    detailKind: 'words', canRefuse: false, canAllow: false, others: 1
  })
  attention.dismiss('claude:a#screen')
  assert.deepEqual(attention.look([waiting]).notices, [], 'a notice the person closed does not come back')
  const gone = attention.look([task('claude:a', 'idle', [], { screen: true })])
  assert.equal(gone.waiting, 0)
  assert.deepEqual(gone.notices, [])
  assert.equal(attention.look([waiting]).notices.length, 1, 'it waits again: a new notice')
})

test('Allow once is offered only when everything asked is shown and nothing looks dangerous', () => {
  const attention = new T.Attention(clock())
  const long = `npm run build -- ${'--flag '.repeat(60)}`
  const many = 'one\ntwo\nthree\nfour\nfive'
  const look = attention.look([
    task('claude:a', 'waiting', [
      request('short', 'command', { command: 'git status' }),
      request('danger', 'command', { command: 'rm -rf build', danger: 'It deletes files or folders for good.' }),
      request('long', 'command', { command: long }),
      request('lines', 'command', { command: many }),
      request('empty', 'command', { command: '' }),
      request('edit', 'edit', { files: ['C:\\work\\a.css', 'C:\\work\\b.css'] }),
      request('edits', 'edit', { files: ['1', '2', '3', '4', '5'].map((n) => `C:\\work\\file-${n}.css`) }),
      request('ask', 'question', { questions: [{ id: '0', text: 'Which pricing table?', options: [], free: true, secret: false }] })
    ])
  ])
  const by = Object.fromEntries(look.notices.map((n) => [n.requestId, n]))
  assert.deepEqual(['short', 'danger', 'long', 'lines', 'empty', 'edit', 'edits', 'ask'].map((id) => [id, by[id].canAllow, by[id].canRefuse]), [
    ['short', true, true], ['danger', false, true], ['long', false, true], ['lines', false, true], ['empty', false, true], ['edit', true, true], ['edits', false, true], ['ask', false, false]
  ])
  assert.equal(by.danger.danger, 'It deletes files or folders for good.')
  assert.equal(by.danger.detail, 'rm -rf build', 'a dangerous command is still shown, with its reason')
  assert.ok(by.long.detail.length <= 241 && by.long.detail.endsWith('…'), 'what does not fit is cut, and says so')
  assert.equal(by.lines.detail, 'one\ntwo\nthree\nfour…')
  assert.equal(by.edit.says, 'wants to change')
  assert.equal(by.edit.detail, 'C:\\work\\a.css\nC:\\work\\b.css')
  assert.equal(by.ask.says, 'asks')
  assert.equal(by.ask.detail, 'Which pricing table?')
})

test('the one that has waited longest comes first, and each says how many others wait', () => {
  const attention = new T.Attention(clock())
  const first = attention.look([task('codex:a', 'waiting', [request('r1', 'command', { command: 'one' })]), task('claude:b', 'working')])
  assert.deepEqual(first.notices.map((n) => [n.key, n.others]), [['codex:a', 0]])
  const second = attention.look([task('claude:b', 'waiting', [request('r9', 'command', { command: 'two' })]), task('codex:a', 'waiting', [request('r1', 'command', { command: 'one' })])])
  assert.equal(second.waiting, 2)
  assert.deepEqual(second.notices.map((n) => [n.key, n.others]), [['codex:a', 1], ['claude:b', 1]], 'oldest first, whatever order the tasks come in')
  const same = attention.look([task('codex:a', 'waiting', [request('r1', 'command', { command: 'one' }), request('r2', 'command', { command: 'one more' })])])
  assert.equal(same.waiting, 1, 'a task with two requests is one task waiting')
  assert.deepEqual(same.notices.map((n) => [n.requestId, n.others]), [['r1', 0], ['r2', 0]])
})

test('a closed notice stays closed while its request waits, and is forgotten once the request is gone', () => {
  const attention = new T.Attention(clock())
  const waiting = [task('codex:a', 'waiting', [request('r1', 'command', { command: 'one' })])]
  assert.equal(attention.look(waiting).notices.length, 1)
  attention.dismiss('codex:a#r1')
  const quiet = attention.look(waiting)
  assert.equal(quiet.notices.length, 0, 'closed')
  assert.equal(quiet.waiting, 1, 'it still waits: the tray still says so')
  assert.equal(attention.look([task('codex:a', 'working')]).waiting, 0)
  assert.equal(attention.look([task('codex:a', 'waiting', [request('r1', 'command', { command: 'one' })])]).notices.length, 1, 'the same id asked again later is a new request')
})

// ---- a task that finished ----

test('a task that finished or broke is told once, and only if it was seen working', () => {
  const attention = new T.Attention(clock())
  assert.deepEqual(attention.look([task('codex:a', 'idle', [], { line: 'Old news' })]).finished, [], 'a task first seen finished is not news')
  attention.look([task('codex:a', 'working'), task('claude:b', 'working'), task('hermes:c', 'waiting', [request('r', 'command', { command: 'x' })]), task('codex:d', 'working'), task('codex:e', 'waiting', [request('r', 'command', { command: 'y' })])])
  const look = attention.look([
    task('codex:a', 'idle', [], { line: 'Added the status column and ran the tests.' }),
    task('claude:b', 'failed', [], { line: 'The agent program stopped.' }),
    task('hermes:c', 'failed'),
    task('codex:d', 'stopped'),
    task('codex:e', 'idle', [], { line: 'Done.' })
  ])
  assert.deepEqual(look.finished.map((n) => [n.key, n.kind, n.says, n.detail, n.detailKind, n.canAllow, n.canRefuse]), [
    ['codex:a', 'done', 'finished', 'Added the status column and ran the tests.', 'words', false, false],
    ['claude:b', 'failed', 'stopped with an error', 'The agent program stopped.', 'words', false, false],
    ['hermes:c', 'failed', 'stopped with an error', '', 'words', false, false],
    ['codex:e', 'done', 'finished', 'Done.', 'words', false, false]
  ], 'a task the person stopped is not news, and one that finished between two looks is')
  assert.equal(new Set(look.finished.map((n) => n.id)).size, 4, 'each has its own id')
  const again = attention.look([task('codex:a', 'idle'), task('claude:b', 'failed'), task('hermes:c', 'failed'), task('codex:d', 'stopped'), task('codex:e', 'idle')])
  assert.deepEqual(again.finished, [], 'told once')
  assert.deepEqual(attention.look([task('codex:a', 'working')]).finished, [])
  assert.equal(attention.look([task('codex:a', 'idle')]).finished.length, 1, 'a second turn that ends is news again')
})

test('a task that stopped because its agent is signed out says so, with the command that signs it in', () => {
  const attention = new T.Attention(clock())
  attention.look([task('codex:a', 'working'), task('acp-gemini:b', 'working')])
  const look = attention.look([
    task('codex:a', 'failed', [], { line: 'Codex is signed out.', signedOut: true, fix: 'codex login' }),
    task('acp-gemini:b', 'failed', [], { line: 'Gemini is signed out.', signedOut: true })
  ])
  assert.deepEqual(look.finished.map((n) => [n.key, n.kind, n.says, n.detail, n.detailKind]), [
    ['codex:a', 'failed', 'is signed out', 'codex login', 'command'],
    ['acp-gemini:b', 'failed', 'is signed out', 'Gemini is signed out.', 'words']
  ], 'an added agent has no command Togle knows')
  assert.equal(look.waiting, 2, 'both wait for a reply')
  // Signed out, the first turn ends before any look sees it working: it is told all the same, once. Another error is not.
  const quick = attention.look([
    task('claude:c', 'failed', [], { line: 'Claude Code is signed out.', signedOut: true, fix: 'claude auth login' }),
    task('codex:d', 'failed', [], { line: 'The model was overloaded.' })
  ])
  assert.deepEqual(quick.finished.map((n) => [n.key, n.says, n.detail]), [['claude:c', 'is signed out', 'claude auth login']])
  assert.deepEqual(attention.look([task('claude:c', 'failed', [], { signedOut: true, fix: 'claude auth login' })]).finished, [], 'told once')
})

// ---- the tray's dot ----

const pixel = (bitmap, width, x, y) => [...bitmap.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)]

test('the dot is painted amber in the lower right corner, in the byte order of the picture, and nothing else changes', () => {
  for (const order of ['bgra', 'rgba']) {
    const width = 32
    const bitmap = new Uint8Array(width * width * 4)
    for (let at = 0; at < bitmap.length; at += 4) bitmap.set([10, 20, 30, 255], at)
    const before = Uint8Array.from(bitmap)
    T.paintDot(bitmap, width, width, order)
    const centre = pixel(bitmap, width, width - 9, width - 9)
    assert.deepEqual(centre, order === 'bgra' ? [0x24, 0xa5, 0xf5, 255] : [0xf5, 0xa5, 0x24, 255], `amber at the middle of the dot (${order})`)
    assert.deepEqual(pixel(bitmap, width, 0, 0), [10, 20, 30, 255], 'the far corner is as it was')
    assert.deepEqual(pixel(bitmap, width, width >> 1, 2), [10, 20, 30, 255], 'the top is as it was')
    let changed = 0
    for (let at = 0; at < bitmap.length; at += 4) if (bitmap[at] !== before[at] || bitmap[at + 1] !== before[at + 1] || bitmap[at + 2] !== before[at + 2]) changed++
    assert.ok(changed > 40 && changed < width * width * 0.3, `a dot with a ring, not the whole icon: ${changed} pixels`)
  }
  const clear = new Uint8Array(16 * 16 * 4)
  T.paintDot(clear, 16, 16, 'bgra')
  assert.ok(pixel(clear, 16, 12, 12)[3] === 255, 'on a clear picture the dot is solid')
  assert.equal(pixel(clear, 16, 0, 0)[3], 0, 'and the rest is still clear')
  assert.throws(() => T.paintDot(new Uint8Array(10), 16, 16, 'bgra'), /smaller than its size/)
})

/** A picture of one pixel, as a PNG, so the byte order can be told from it. */
function onePixelPng(r, g, b) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc32(body), 8 + data.length)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header.set([8, 6, 0, 0, 0], 8)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, r, g, b, 255]))), chunk('IEND', Buffer.alloc(0))])
}

test('the byte order of a picture is told from the one pixel it was probed with', () => {
  assert.equal(T.orderFromProbe(onePixelPng(255, 0, 0)), 'bgra', 'bytes written blue, green, red, alpha read back as red')
  assert.equal(T.orderFromProbe(onePixelPng(0, 0, 255)), 'rgba')
})
