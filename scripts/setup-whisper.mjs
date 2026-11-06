// Downloads whisper.cpp and a Whisper model into resources/whisper for local transcription.
//
//   npm run setup:whisper                 CUDA build + large-v3-turbo if an NVIDIA GPU is found, else CPU + base
//   npm run setup:whisper -- --cpu        force the CPU build
//   npm run setup:whisper -- --model ggml-small.bin
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Pinned whisper.cpp build; bump deliberately after checking the release assets.
const RELEASE = 'b5454'
const ASSETS = { cuda: 'whisper-bin-win-cuda-12.4.0-x64.zip', cpu: 'whisper-bin-x64.zip' }
const DEFAULT_MODELS = { cuda: 'ggml-large-v3-turbo-q5_0.bin', cpu: 'ggml-base.bin' }
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
// Parakeet TDT v3 for whisper.cpp's parakeet.dll: Togle's main recognizer (Whisper handles unclear speech).
const PARAKEET_URL = 'https://huggingface.co/ggml-org/parakeet-GGUF/resolve/main/ggml-parakeet-tdt-0.6b-v3-q8_0.bin'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'whisper')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function hasNvidiaGpu() {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// Hosts like GitHub throttle long-lived connections, so large files are fetched as many short
// range requests over parallel connections. Progress is saved next to the .part file so an
// interrupted run picks up where it stopped.
const CONNECTIONS = 8
const CHUNK_BYTES = 16 * 1048576
const STALL_MS = 30_000
const MAX_CHUNK_ATTEMPTS = 30

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function remoteSize(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { method: 'HEAD' })
      const size = Number(res.headers.get('content-length')) || 0
      if (res.ok && size && res.headers.get('accept-ranges') === 'bytes') return size
      if (res.ok) throw new Error(`${url} does not support ranged downloads`)
    } catch (err) {
      if (attempt === 5) throw err
    }
    await sleep(1000 * attempt)
  }
}

/** Splits [from, size) into fixed-size chunks; `pos` is the next byte each chunk still needs. */
function planChunks(from, size) {
  const chunks = []
  for (let start = from; start < size; start += CHUNK_BYTES) chunks.push({ pos: start, end: Math.min(size, start + CHUNK_BYTES) })
  return chunks
}

async function fetchChunk(url, chunk, file, onBytes) {
  for (let attempt = 1; chunk.pos < chunk.end; attempt++) {
    const abort = new AbortController()
    let watchdog = setTimeout(() => abort.abort(new Error('stalled')), STALL_MS)
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${chunk.pos}-${chunk.end - 1}` }, signal: abort.signal })
      if (res.status !== 206 || !res.body) throw new Error(`HTTP ${res.status}`)
      for await (const buf of res.body) {
        clearTimeout(watchdog)
        watchdog = setTimeout(() => abort.abort(new Error('stalled')), STALL_MS)
        const len = Math.min(buf.byteLength, chunk.end - chunk.pos)
        await file.write(buf, 0, len, chunk.pos)
        chunk.pos += len
        onBytes(len)
      }
      if (chunk.pos < chunk.end) throw new Error('connection closed early')
    } catch (err) {
      if (attempt >= MAX_CHUNK_ATTEMPTS) throw err
      await sleep(Math.min(20_000, 1000 * attempt))
    } finally {
      clearTimeout(watchdog)
    }
  }
}

async function download(url, dest) {
  const name = path.basename(dest)
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`  already have ${name}`)
    return
  }
  const tmp = `${dest}.part`
  const stateFile = `${tmp}.json`
  const size = await remoteSize(url)

  let chunks
  const saved = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : null
  if (saved?.size === size && existsSync(tmp)) chunks = saved.chunks.filter((c) => c.pos < c.end)
  else {
    // A .part without a state file came from a plain sequential download, so its bytes are a valid prefix.
    const prefix = !saved && existsSync(tmp) ? Math.min(statSync(tmp).size, size) : 0
    if (!prefix) rmSync(tmp, { force: true })
    chunks = planChunks(prefix, size)
  }

  const file = await open(tmp, existsSync(tmp) ? 'r+' : 'w+')
  let done = size - chunks.reduce((sum, c) => sum + (c.end - c.pos), 0)
  const saveState = () => writeFileSync(stateFile, JSON.stringify({ size, chunks }))
  const ticker = setInterval(() => {
    saveState()
    process.stdout.write(`\r  ${name}: ${((done / size) * 100).toFixed(1)}% of ${(size / 1048576).toFixed(0)} MB`)
  }, 1000)

  try {
    const queue = [...chunks]
    const worker = async () => {
      for (let chunk = queue.shift(); chunk; chunk = queue.shift()) {
        await fetchChunk(url, chunk, file, (n) => {
          done += n
        })
      }
    }
    await Promise.all(Array.from({ length: CONNECTIONS }, worker))
  } finally {
    clearInterval(ticker)
    saveState()
    await file.close()
  }
  renameSync(tmp, dest)
  rmSync(stateFile, { force: true })
  process.stdout.write(`\r  ${name}: done${' '.repeat(30)}\n`)
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findFile(full, name)
      if (hit) return hit
    } else if (entry.name.toLowerCase() === name) {
      return full
    }
  }
  return null
}

async function main() {
  if (process.platform !== 'win32') throw new Error('This script fetches Windows binaries. On macOS and Linux, install speech recognition from Togle itself: Settings → Speech recognition.')
  const variant = !flag('--cpu') && hasNvidiaGpu() ? 'cuda' : 'cpu'
  const model = option('--model') ?? DEFAULT_MODELS[variant]
  console.log(`Setting up whisper.cpp ${RELEASE} (${variant}) with ${model}`)

  const binDir = path.join(root, 'bin')
  const modelsDir = path.join(root, 'models')
  mkdirSync(modelsDir, { recursive: true })

  const zip = path.join(root, ASSETS[variant])
  await download(`https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/${ASSETS[variant]}`, zip)
  rmSync(binDir, { recursive: true, force: true })
  mkdirSync(binDir, { recursive: true })
  // Windows' bundled bsdtar reads zip files; a GNU tar earlier on PATH (Git Bash) does not.
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  execFileSync(tar, ['-xf', zip, '-C', binDir], { stdio: 'inherit' })
  const server = findFile(binDir, 'whisper-server.exe')
  if (!server) throw new Error('whisper-server.exe not found in the release archive')

  await download(`${MODEL_BASE_URL}/${model}`, path.join(modelsDir, model))
  if (!flag('--no-parakeet')) {
    if (!findFile(binDir, 'parakeet.dll')) console.warn('This whisper.cpp release has no parakeet.dll; skipping Parakeet.')
    else await download(PARAKEET_URL, path.join(modelsDir, path.basename(PARAKEET_URL)))
  }

  const config = { server: path.relative(root, server), model: path.join('models', model), gpu: variant === 'cuda' }
  writeFileSync(path.join(root, 'config.json'), JSON.stringify(config, null, 2))
  console.log(`Ready: ${path.join(root, 'config.json')}`)
}

main().catch((err) => {
  console.error(`\nsetup:whisper failed: ${err.message}`)
  process.exit(1)
})
