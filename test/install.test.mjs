// Speech recognition installed on this PC from Settings: files fetched in ranges, picked up after a stop, refused
// when damaged, the engine unpacked with the system's tar, and what to run found again (or the development copy).
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import electron from './electron.mjs'
import { workDir } from './helpers.mjs'

const work = workDir('install')
const { download, SpeechInstaller } = await import('./.build/togle.mjs')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const item = (name, buf) => ({ url: `https://files.test/${name}`, bytes: buf.length, sha256: sha256(buf) })

/** A host for these files that answers range requests, and keeps the ranges it was asked for. */
function host(files, { failOnce } = {}) {
  const asked = []
  let failed = false
  electron.net.fetch = async (url, init = {}) => {
    const name = String(url).split('/').pop()
    const buf = files[name]
    if (!buf) return new Response('not found', { status: 404 })
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? '') ?? []
    asked.push(`${name} ${from}-${to}`)
    if (failOnce && !failed && asked.length === failOnce) {
      failed = true
      throw new Error('net::ERR_CONNECTION_RESET')
    }
    init.signal?.throwIfAborted()
    // A megabyte at a time, as a connection brings it.
    const part = buf.subarray(Number(from), Number(to) + 1)
    let at = 0
    const body = new ReadableStream({
      async pull(controller) {
        await new Promise((resolve) => setImmediate(resolve))
        if (at >= part.length) return controller.close()
        controller.enqueue(part.subarray(at, (at += 1048576)))
      }
    })
    return new Response(body, { status: 206 })
  }
  return asked
}

test('a file comes in ranges over parallel connections, and a dropped one is fetched again', async () => {
  const data = randomBytes(40 * 1048576)
  const asked = host({ 'model.bin': data }, { failOnce: 2 })
  const dest = path.join(work, 'a', 'model.bin')
  let bytes = 0
  await download(item('model.bin', data), dest, new AbortController().signal, (n) => (bytes += n))
  assert.ok(readFileSync(dest).equals(data))
  assert.equal(bytes, data.length)
  assert.deepEqual([...new Set(asked)].sort(), ['model.bin 0-16777215', 'model.bin 16777216-33554431', 'model.bin 33554432-41943039'])
  assert.equal(asked.length, 4, 'the dropped range was asked for again')
  assert.ok(!existsSync(`${dest}.part`) && !existsSync(`${dest}.part.json`), 'nothing is left of the download')
})

test('a download stopped partway picks up where it was', async () => {
  const data = randomBytes(40 * 1048576)
  const files = { 'big.bin': data }
  host(files)
  const dest = path.join(work, 'b', 'big.bin')
  const stop = new AbortController()
  let bytes = 0
  await assert.rejects(
    download(item('big.bin', data), dest, stop.signal, (n) => {
      bytes += n
      // Stopped once some of it is in.
      if (bytes > 8 * 1048576) stop.abort(new Error('Stopped'))
    }),
    /Stopped/
  )
  assert.ok(existsSync(`${dest}.part`) && existsSync(`${dest}.part.json`), 'what came is kept')
  const asked = host(files)
  let again = 0
  let first = -1
  await download(item('big.bin', data), dest, new AbortController().signal, (n) => {
    if (first < 0) first = n
    again += n
  })
  assert.ok(readFileSync(dest).equals(data))
  assert.ok(first > 8 * 1048576, `what was in already counts first (${first})`)
  assert.ok(asked.length <= 3 && asked.every((a) => !a.endsWith(' 0-16777215') || first < 16777216), `only what was missing is asked for: ${asked.join(', ')}`)
  assert.equal(again, data.length)
})

test('a file that comes down damaged is deleted, never used', async () => {
  const data = randomBytes(1024)
  host({ 'bad.bin': Buffer.alloc(1024, 7) })
  const dest = path.join(work, 'c', 'bad.bin')
  await assert.rejects(download({ ...item('bad.bin', data) }, dest, new AbortController().signal, () => {}), /came down damaged/)
  assert.ok(!existsSync(dest) && !existsSync(`${dest}.part`))
})

/** An engine archive as whisper.cpp's release has them: a folder with the server and the libraries, packed with tar. */
function engineArchive() {
  const dir = path.join(work, 'engine-src')
  mkdirSync(path.join(dir, 'Release'), { recursive: true })
  for (const name of ['whisper-server.exe', 'parakeet.dll', 'ggml.dll']) writeFileSync(path.join(dir, 'Release', name), `fake ${name}`)
  const archive = path.join(work, 'engine.tar.gz')
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-czf', archive, '-C', dir, 'Release'])
  return readFileSync(archive)
}

test('installing sets up the engine and the models, says how far it got, and is found again until removed', async () => {
  const archive = engineArchive()
  const base = randomBytes(3000)
  const parakeet = randomBytes(5000)
  const turbo = randomBytes(7000)
  host({ 'engine.tar.gz': archive, 'base.bin': base, 'parakeet.bin': parakeet, 'turbo.bin': turbo })
  const engine = {
    id: 'test',
    ...item('engine.tar.gz', archive),
    dir: 'Release',
    server: 'whisper-server.exe',
    library: 'parakeet.dll',
    ggml: 'ggml.dll',
    gpu: false
  }
  const models = {
    parakeet: { file: 'parakeet.bin', ...item('parakeet.bin', parakeet) },
    'whisper-turbo': { file: 'turbo.bin', ...item('turbo.bin', turbo) },
    'whisper-base': { file: 'base.bin', ...item('base.bin', base) }
  }
  const home = path.join(work, 'speech')
  const installer = new SpeechInstaller(home, null, { engine, models })
  const before = await installer.state()
  assert.deepEqual(before.installed, [])
  assert.equal(before.offer.engine, archive.length, 'the engine is to download')
  assert.deepEqual(
    before.offer.models.filter((m) => m.recommended).map((m) => m.id),
    ['parakeet', 'whisper-base'],
    'on a CPU: Parakeet and Whisper base'
  )
  assert.equal(installer.local(), null)
  const seen = []
  installer.on('change', (state) => state.installing && seen.push(state.installing.what))
  await installer.install(['whisper-base', 'parakeet'])
  const local = installer.local()
  const engineDir = path.join(home, 'engine-b5454-test', 'Release')
  assert.deepEqual(local, {
    binDir: engineDir,
    server: path.join(engineDir, 'whisper-server.exe'),
    library: path.join(engineDir, 'parakeet.dll'),
    ggml: path.join(engineDir, 'ggml.dll'),
    gpu: false,
    whisperModel: path.join(home, 'models', 'base.bin'),
    parakeetModel: path.join(home, 'models', 'parakeet.bin')
  })
  assert.ok(seen.includes('whisper.cpp') && seen.includes('Whisper base') && seen.includes('Parakeet'), `progress for each file: ${[...new Set(seen)]}`)
  assert.ok(!existsSync(path.join(home, 'downloads', 'engine.tar.gz')), 'the archive is deleted once unpacked')
  const after = await installer.state()
  assert.deepEqual(after.installed, ['whisper-base', 'parakeet'])
  assert.equal(after.offer.engine, 0, 'nothing more to download for the engine')
  // Another model later: added beside the others, and the bigger Whisper is the one run.
  const asked = host({ 'turbo.bin': turbo })
  await installer.install(['whisper-turbo'])
  assert.deepEqual(asked.map((a) => a.split(' ')[0]), ['turbo.bin'], 'only the new model is fetched')
  assert.equal(installer.local().whisperModel, path.join(home, 'models', 'turbo.bin'))
  assert.deepEqual((await installer.state()).installed, ['whisper-base', 'parakeet', 'whisper-turbo'])
  // A model gone from disk isn't counted installed.
  await installer.remove()
  assert.equal(installer.local(), null)
  assert.ok(!existsSync(home))
})

test('a development copy (npm run setup:whisper) is run while nothing is installed', async () => {
  const root = path.join(work, 'dev-whisper')
  mkdirSync(path.join(root, 'bin', 'Release'), { recursive: true })
  mkdirSync(path.join(root, 'models'), { recursive: true })
  writeFileSync(path.join(root, 'bin', 'Release', 'whisper-server.exe'), '')
  writeFileSync(path.join(root, 'models', 'ggml-large-v3-turbo-q5_0.bin'), '')
  writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({ server: path.join('bin', 'Release', 'whisper-server.exe'), model: path.join('models', 'ggml-large-v3-turbo-q5_0.bin'), gpu: true })
  )
  const installer = new SpeechInstaller(path.join(work, 'empty-speech'), root, { engine: null })
  const local = installer.local()
  assert.equal(local.server, path.join(root, 'bin', 'Release', 'whisper-server.exe'))
  assert.equal(local.whisperModel, path.join(root, 'models', 'ggml-large-v3-turbo-q5_0.bin'))
  assert.equal(local.parakeetModel, null, 'no Parakeet in this copy')
  const state = await installer.state()
  assert.equal(state.dev, true)
  assert.equal(state.offer, null, 'no build for this system (as the catalog given says)')
  await assert.rejects(installer.install(['whisper-base']), /no build for this system/)
})

test('what this PC has already is taken from there, checked, not downloaded; at start, all of it is taken by itself', async () => {
  const archive = engineArchive()
  const parakeet = randomBytes(5000)
  const base = randomBytes(3000)
  const turbo = randomBytes(7000)
  const engine = { id: 'test', ...item('engine.tar.gz', archive), dir: 'Release', server: 'whisper-server.exe', library: 'parakeet.dll', ggml: 'ggml.dll', gpu: false }
  const models = {
    parakeet: { file: 'parakeet.bin', ...item('parakeet.bin', parakeet) },
    'whisper-turbo': { file: 'turbo.bin', ...item('turbo.bin', turbo) },
    'whisper-base': { file: 'base.bin', ...item('base.bin', base) }
  }
  // A development copy with the same files, under other names, a level down; and a file the size of turbo that isn't it.
  const seed = path.join(work, 'seed')
  mkdirSync(path.join(seed, 'models'), { recursive: true })
  writeFileSync(path.join(seed, 'whisper-bin-test.tar.gz'), archive)
  writeFileSync(path.join(seed, 'models', 'ggml-parakeet.bin'), parakeet)
  writeFileSync(path.join(seed, 'models', 'ggml-base.bin'), base)
  writeFileSync(path.join(seed, 'models', 'turbo-look-alike.bin'), randomBytes(7000))
  const asked = host({ 'turbo.bin': turbo })
  const home = path.join(work, 'speech-seeded')
  const installer = new SpeechInstaller(home, null, { engine, models }, [seed])
  const offer = (await installer.state()).offer
  assert.equal(offer.engine, 0, 'the engine is here: nothing to download')
  assert.deepEqual(offer.models.filter((m) => m.here).map((m) => m.id).sort(), ['parakeet', 'whisper-base', 'whisper-turbo'], 'by size, before the check')
  // At start: what suits this PC (on a CPU, Parakeet and Whisper base) is all here, so it's taken.
  assert.equal(await installer.adopt(), true)
  assert.deepEqual(asked, [], 'nothing was downloaded')
  assert.deepEqual((await installer.state()).installed.sort(), ['parakeet', 'whisper-base'])
  assert.ok(readFileSync(installer.local().whisperModel).equals(base))
  assert.ok(existsSync(path.join(seed, 'whisper-bin-test.tar.gz')), 'what it was taken from stays')
  assert.equal(await installer.adopt(), false, 'installed: nothing more to take')
  // The look-alike fails the check: turbo is downloaded, as any other file.
  await installer.install(['whisper-turbo'])
  assert.deepEqual([...new Set(asked.map((a) => a.split(' ')[0]))], ['turbo.bin'])
  assert.ok(readFileSync(installer.local().whisperModel).equals(turbo))
  await installer.remove()
})
