// Parakeet's worker: restarted after occasional crashes, given up on in a crash loop (Whisper takes over).
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

const work = workDir('parakeet')
// parakeet.ts reads __dirname (it's bundled to CommonJS in the app).
globalThis.__dirname = work
const { LocalParakeet, PARAKEET_MODEL } = await import('./.build/togle.mjs')

function fakeWorkers() {
  const forks = []
  electron.utilityProcess.fork = () => {
    const child = new EventEmitter()
    child.postMessage = () => {}
    child.kill = () => child.emit('exit', null)
    forks.push(child)
    return child
  }
  return forks
}

function parakeetFiles() {
  const bin = path.join(work, 'bin')
  const models = path.join(work, 'models')
  mkdirSync(bin, { recursive: true })
  mkdirSync(models, { recursive: true })
  writeFileSync(path.join(bin, 'parakeet.dll'), '')
  writeFileSync(path.join(models, PARAKEET_MODEL), '')
  return { bin, models }
}

test('Parakeet keeps restarting after occasional crashes in a long session', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const forks = fakeWorkers()
  const { bin, models } = parakeetFiles()
  const parakeet = new LocalParakeet({ binDir: bin, library: path.join(bin, 'parakeet.dll'), ggml: null, gpu: false, parakeetModel: path.join(models, PARAKEET_MODEL) })
  parakeet.start()
  for (let crash = 1; crash <= 5; crash++) {
    forks.at(-1).emit('exit', 0xc0000005)
    t.mock.timers.tick(10_000) // past the restart delay
    t.mock.timers.tick(20 * 60_000) // then a quiet stretch of the call
  }
  assert.equal(forks.length, 6, 'a crash went without a restart')
  parakeet.stop()
})

test('a Parakeet crash loop still hands over to Whisper', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const forks = fakeWorkers()
  const { bin, models } = parakeetFiles()
  const parakeet = new LocalParakeet({ binDir: bin, library: path.join(bin, 'parakeet.dll'), ggml: null, gpu: false, parakeetModel: path.join(models, PARAKEET_MODEL) })
  parakeet.start()
  for (let crash = 1; crash <= 6; crash++) {
    forks.at(-1).emit('exit', 1)
    t.mock.timers.tick(10_000)
  }
  assert.equal(forks.length, 4, 'the first start and three restarts, then no more')
  parakeet.stop()
})

test('stopping Parakeet releases its current and queued clips before the worker exits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const forks = fakeWorkers()
  const { bin, models } = parakeetFiles()
  const parakeet = new LocalParakeet({ binDir: bin, library: path.join(bin, 'parakeet.dll'), ggml: null, gpu: false, parakeetModel: path.join(models, PARAKEET_MODEL) })
  parakeet.start()
  const child = forks[0]
  let killed = 0
  child.kill = () => { killed++ }
  child.emit('message', { type: 'ready' })
  const outcomes = []
  const pending = [1, 2].map((id) => parakeet.transcribe(new Float32Array(16000), { partial: false, stream: 'them' }).then(
    () => outcomes.push([id, 'heard']),
    (err) => outcomes.push([id, err.message])
  ))
  parakeet.stop()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(parakeet.available, false)
  assert.deepEqual(outcomes, [[1, 'Parakeet stopped'], [2, 'Parakeet stopped']], 'both clips can fall back to Whisper immediately')
  await Promise.all(pending)
  child.emit('message', { type: 'ready' })
  assert.equal(parakeet.available, false, 'a late ready message cannot revive a stopped worker')
  t.mock.timers.tick(30_000)
  assert.equal(killed, 1, 'the old clip timeout was cleared')
  child.emit('exit', 0)
  t.mock.timers.tick(10_000)
  assert.equal(forks.length, 1, 'an intentional stop does not restart')
})

test('stopping while a Parakeet restart is waiting cancels that restart', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const forks = fakeWorkers()
  const { bin, models } = parakeetFiles()
  const parakeet = new LocalParakeet({ binDir: bin, library: path.join(bin, 'parakeet.dll'), ggml: null, gpu: false, parakeetModel: path.join(models, PARAKEET_MODEL) })
  parakeet.start()
  forks[0].emit('exit', 1)
  parakeet.stop()
  t.mock.timers.tick(10_000)
  assert.equal(forks.length, 1, 'removing or replacing speech models must not start the old worker again')
})
