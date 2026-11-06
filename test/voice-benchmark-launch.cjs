// Public, attributed recordings only. Separate from ordinary tests because fixtures download once.
const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { readWave } = require('sherpa-onnx-node')
const folder = path.join(__dirname, '.work/voice-benchmark')
const memoryTest = process.argv.includes('--memory')
const modelNames = [
  '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx',
  '3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx',
  'wespeaker_en_voxceleb_resnet34_LM.onnx'
]
const base = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/'
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Fixture download failed (${response.status})`)
  return response
}
async function prepare() {
  const voiceModels = await require('./voice-model-fixture.cjs')()
  process.env.TOGLE_TEST_SEGMENTATION = voiceModels.segmentation
  await fs.mkdir(folder, { recursive: true })
  const models = []
  for (const name of memoryTest ? modelNames.slice(0, 1) : modelNames) {
    const file = path.join(folder, name)
    let data = await fs.readFile(file).catch(() => null)
    if (!data) { data = Buffer.from(await (await get(base + name)).arrayBuffer()); await fs.writeFile(file, data) }
    models.push({ name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  }
  const manifestFile = path.join(folder, 'manifest.json')
  let manifest = await fs.readFile(manifestFile, 'utf8').then(JSON.parse).catch(() => null)
  if (!manifest) {
    const people = new Map()
    // Uniformly spaced pages include different speakers, not successive files from one narrator.
    for (let offset = 0; offset < 2600 && people.size < 16; offset += 160) {
      const url = `https://datasets-server.huggingface.co/rows?dataset=openslr%2Flibrispeech_asr&config=clean&split=test&offset=${offset}&length=24`
      const data = await (await get(url)).json()
      const candidates = new Map()
      for (const { row } of data.rows) {
        if (!candidates.has(row.speaker_id)) candidates.set(row.speaker_id, [])
        candidates.get(row.speaker_id).push(row)
      }
      for (const [speaker, rows] of candidates) {
        if (people.has(speaker) || rows.length < 8 || people.size >= 16) continue
        const clips = []
        for (const row of rows) {
          const file = row.id + '.wav', target = path.join(folder, file)
          const audio = Array.isArray(row.audio) ? row.audio[0] : row.audio
          let data = await fs.readFile(target).catch(() => null)
          if (!data) data = Buffer.from(await (await get(audio.src)).arrayBuffer())
          if (data.toString('ascii', 0, 4) === 'RIFF') await fs.writeFile(target, data)
          else {
            const source = path.join(folder, row.id + '.flac')
            await fs.writeFile(source, data)
            const decoded = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', source, '-ar', '16000', '-ac', '1', target], { windowsHide: true, encoding: 'utf8' })
            if (decoded.status !== 0) throw new Error('Install ffmpeg to decode the public FLAC fixtures: ' + (decoded.stderr || decoded.error?.message))
            data = await fs.readFile(target)
          }
          const wave = readWave(target, false)
          if (wave.sampleRate !== 16000 || wave.samples.length < 2.4 * 16000) continue
          clips.push({ file, seconds: wave.samples.length / 16000, sha256: createHash('sha256').update(data).digest('hex') })
          if (clips.length === 8) break
        }
        if (clips.length === 8) { people.set(speaker, { speaker: String(speaker), clips }); console.log('Prepared public speaker ' + speaker + ' (' + people.size + '/16)') }
      }
    }
    if (people.size < 16) throw new Error('The benchmark requires 16 distinct public speakers')
    manifest = { source: 'https://huggingface.co/datasets/openslr/librispeech_asr', license: 'CC-BY-4.0', split: 'clean/test', people: [...people.values()] }
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2))
  }
  if (!memoryTest) await fs.writeFile(path.join(folder, 'models.json'), JSON.stringify(models, null, 2))
  console.log(JSON.stringify({ speakers: manifest.people.length, recordings: manifest.people.reduce((n, p) => n + p.clips.length, 0), models }))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [path.join(__dirname, memoryTest ? 'voice-memory-live.cjs' : 'voice-benchmark.cjs')], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1 })
