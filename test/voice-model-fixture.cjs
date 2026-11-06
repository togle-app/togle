const fs = require('node:fs/promises'), path = require('node:path')
const { createHash } = require('node:crypto')
module.exports = async function prepareVoices() {
  const { VOICE_MODEL, VOICE_SEGMENTATION_MODEL } = await import('./.build/togle.mjs')
  const folder = path.join(__dirname, '.work/voice-models')
  await fs.mkdir(folder, { recursive: true })
  const entries = [['embedding', 'campplus-zh-en.onnx', VOICE_MODEL], ['segmentation', 'segmentation-3.onnx', VOICE_SEGMENTATION_MODEL]]
  const output = {}
  await Promise.all(entries.map(async ([key, name, model]) => {
    const file = path.join(folder, name)
    let bytes = await fs.readFile(file).catch(() => null)
    if (!bytes) {
      const response = await fetch(model.url, { signal: AbortSignal.timeout(90000) })
      if (!response.ok) throw new Error('Voice model download failed: ' + response.status)
      bytes = Buffer.from(await response.arrayBuffer())
    }
    if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error('Voice model checksum does not match: ' + name)
    await fs.writeFile(file, bytes); output[key] = file
  }))
  return output
}
