const { spawn } = require('node:child_process')
const path = require('node:path')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const fs = require('node:fs/promises')
const { createHash } = require('node:crypto')
async function prepare() {
  const models = await require('./voice-model-fixture.cjs')()
  env.TOGLE_TEST_SEGMENTATION = models.segmentation
  const folder = path.join(__dirname, '.work/voice-samples')
  await fs.mkdir(folder, { recursive: true })
  const base = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/'
  const model = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx'
  for (const name of [model, ...['fangjun', 'leijun', 'liudehua'].flatMap(name => [name + '-sr-1.wav', name + '-test-sr-1.wav'])]) {
    const file = path.join(folder, name === model ? 'campplus-zh-en.onnx' : name)
    let data = await fs.readFile(file).catch(() => null)
    if (!data) { const response = await fetch(base + name); if (!response.ok) throw new Error('Voice fixture download failed: ' + response.status); data = Buffer.from(await response.arrayBuffer()); await fs.writeFile(file, data) }
    if (name === model && createHash('sha256').update(data).digest('hex') !== 'aa3cfc16963a10586a9393f5035d6d6b57e98d358b347f80c2a30bf4f00ceba2') throw new Error('Voice model checksum does not match')
  }
  const child = spawn(require('electron'), [path.join(__dirname, 'voices-live.cjs')], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
}
prepare().catch(error => { console.error(error.message); process.exitCode = 1 })
