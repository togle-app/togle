// Reach's cryptography: each device's own keys; pairing by a code that the relay carrying it can't try offline, with
// one try; messages only the two devices open; passes signed by a computer of the group for a week; and proofs that tie
// an Allow to the person, that exact command and the last minute.
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { test } from 'node:test'

const {
  Cpace, actText, canonical, deviceId, issuePass, lock, makeIdentity, normalCode, pairKey, pairingCode, passHolds, proofHolds, publicKeys, signWith, signedBy, unlock
} = await import('./.build/togle.mjs')

test('each device makes its own keys, and its id follows from them', () => {
  const a = makeIdentity(), b = makeIdentity()
  assert.notEqual(a.device, b.device)
  assert.equal(a.device.length, 22)
  assert.equal(deviceId(a.sign, a.agree), a.device)
  assert.deepEqual(Object.keys(publicKeys(a)).sort(), ['agree', 'device', 'sign'], 'only public keys travel')
  assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}')
  const signature = signWith(a, 'test', { x: 1 })
  assert.equal(signedBy(a.sign, 'test', { x: 1 }, signature), true)
  assert.equal(signedBy(a.sign, 'test', { x: 2 }, signature), false)
  assert.equal(signedBy(b.sign, 'test', { x: 1 }, signature), false)
  assert.equal(signedBy(a.sign, 'another purpose', { x: 1 }, signature), false, 'a signature for one purpose fits no other')
})

test('pairing: the same code gives both sides the same key; a wrong code gives none, and says so', () => {
  const code = pairingCode()
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/)
  assert.equal(normalCode('7f3k 92qd'), normalCode('7F3K-92QD'))
  assert.equal(normalCode('O1LI'), '0111', 'letters that look like digits count as them')
  const session = randomBytes(16)
  const computer = new Cpace(code.toLowerCase(), session, 'initiator'), phone = new Cpace(code, session, 'responder')
  assert.notDeepEqual(computer.share, phone.share)
  const a = computer.finish(phone.share), b = phone.finish(computer.share)
  assert.deepEqual(a.key, b.key)
  assert.equal(computer.confirmed(b.confirm), true)
  assert.equal(phone.confirmed(a.confirm), true)
  assert.notDeepEqual(a.confirm, b.confirm, 'each side proves itself, not echoes')
  // A wrong code: the keys differ, and the confirmation says so before anything else is sent.
  const wrong = new Cpace('AAAA-AAAA', session, 'initiator'), other = new Cpace(code, session, 'responder')
  const x = wrong.finish(other.share), y = other.finish(wrong.share)
  assert.notDeepEqual(x.key, y.key)
  assert.equal(other.confirmed(x.confirm), false)
  assert.equal(wrong.confirmed(y.confirm), false)
  // Another session with the same code shares nothing with this one.
  const elsewhere = new Cpace(code, randomBytes(16), 'responder')
  assert.notDeepEqual(new Cpace(code, session, 'initiator').finish(elsewhere.share).key, elsewhere.finish(computer.share).key)
  assert.throws(() => new Cpace(code, randomBytes(8), 'initiator'), /too short/)
})

test('locked messages: only the pair opens them, unchanged, between those two', () => {
  const laptop = makeIdentity(), server = makeIdentity(), stranger = makeIdentity()
  const key = pairKey(laptop, publicKeys(server))
  assert.deepEqual(pairKey(server, publicKeys(laptop)), key, 'both sides make the same key')
  const sent = lock(key, laptop.device, server.device, { kind: 'stop', task: 'codex:t1' })
  assert.deepEqual(unlock(pairKey(server, publicKeys(laptop)), sent), { kind: 'stop', task: 'codex:t1' })
  assert.throws(() => unlock(pairKey(stranger, publicKeys(laptop)), sent), 'a third device opens nothing')
  assert.throws(() => unlock(key, { ...sent, to: stranger.device }), 'readdressed, it no longer opens')
  const box = Buffer.from(sent.box, 'base64url'); box[3] ^= 1
  assert.throws(() => unlock(key, { ...sent, box: box.toString('base64url') }), 'changed by one bit, it no longer opens')
  assert.notEqual(lock(key, laptop.device, server.device, 'same').box, lock(key, laptop.device, server.device, 'same').box, 'never the same twice')
})

test('passes: signed by a computer of the group, for a week, for the keys they name', () => {
  const computer = makeIdentity(), phone = makeIdentity(), server = makeIdentity()
  const now = Date.UTC(2026, 10, 12, 18)
  const issuers = [{ device: computer.device, sign: computer.sign, role: 'computer' }, { device: server.device, sign: server.sign, role: 'server' }]
  const pass = issuePass(computer, { ...publicKeys(phone), name: 'Phone', role: 'phone', starts: false }, now)
  assert.equal(passHolds(pass, issuers, now + 3_600_000), true)
  assert.equal(passHolds(pass, issuers, now + 7 * 86_400_000 + 1), false, 'a week, then renewed or gone')
  assert.equal(passHolds({ ...pass, role: 'computer' }, issuers, now), false, 'a phone cannot make itself a computer')
  assert.equal(passHolds({ ...pass, starts: true }, issuers, now), false, 'nor switch on starting tasks')
  assert.equal(passHolds({ ...pass, agree: server.agree }, issuers, now), false, 'nor swap its keys')
  const byServer = issuePass(server, { ...publicKeys(phone), name: 'Phone', role: 'phone' }, now)
  assert.equal(passHolds(byServer, issuers, now), false, 'a server never adds a device')
  assert.equal(passHolds(pass, [], now), false, 'an issuer this device does not trust signs nothing')
})

test('proofs: an Allow from another device holds for that command, from that device, in the last minute', () => {
  const computer = makeIdentity(), phone = makeIdentity()
  const presence = generateKeyPairSync('ed25519')
  const presenceKey = presence.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64url')
  const pass = issuePass(computer, { ...publicKeys(phone), name: 'Phone', role: 'phone', presence: { kind: 'ed25519', key: presenceKey } })
  const now = Date.now()
  const act = { kind: 'allow', task: 'codex:t1', request: 'r1', command: 'terraform apply -var-file=staging.tfvars', at: now - 2_000, device: phone.device }
  const proof = sign(null, actText(act), presence.privateKey).toString('base64url')
  const expected = { kind: 'allow', task: 'codex:t1', request: 'r1', command: 'terraform apply -var-file=staging.tfvars' }
  assert.equal(proofHolds(act, proof, pass, expected, now), true)
  assert.equal(proofHolds(act, proof, pass, { ...expected, command: 'terraform destroy' }, now), false, 'another command')
  assert.equal(proofHolds({ ...act, command: 'terraform destroy' }, proof, pass, { ...expected, command: 'terraform destroy' }, now), false, 'the proof covers the words it was made for')
  assert.equal(proofHolds(act, proof, pass, expected, now + 61_000), false, 'stale after a minute')
  assert.equal(proofHolds(act, proof, pass, { ...expected, request: 'r2' }, now), false, 'another request')
  assert.equal(proofHolds(act, proof, { ...pass, presence: undefined }, expected, now), false, 'no presence key, no proof')
  // Windows Hello signs with an RSA key, PKCS #1 v1.5 over SHA-256.
  const hello = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const laptop = makeIdentity()
  const helloPass = issuePass(computer, { ...publicKeys(laptop), name: 'Laptop', role: 'computer', presence: { kind: 'rsa-pkcs1-sha256', key: hello.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url') } })
  const start = { kind: 'start', task: 'new:1', command: 'Roll back yesterday’s deploy', folder: 'infra', at: now, device: laptop.device }
  const helloProof = sign('sha256', actText(start), hello.privateKey).toString('base64url')
  assert.equal(proofHolds(start, helloProof, helloPass, { kind: 'start', task: 'new:1', command: 'Roll back yesterday’s deploy' }, now), true)
})
