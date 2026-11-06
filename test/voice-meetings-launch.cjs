// Public AMI meeting audio and manual words. Cached, attributed, separate from ordinary tests.
const fs = require('node:fs/promises'), path = require('node:path')
const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const Zip = require('jszip')
const folder = path.join(__dirname, '.work/voice-meetings')
const base = 'https://groups.inf.ed.ac.uk/ami/'
const meetings = ['ES2002a', 'ES2003a']
const reference = require('./voice-meetings-reference.json')
async function get(name, url) {
  const file = path.join(folder, name)
  let bytes = await fs.readFile(file).catch(() => null)
  if (!bytes) {
    const response = await fetch(url, { signal: AbortSignal.timeout(240000) })
    if (!response.ok) throw new Error(`AMI fixture download failed: ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer()); await fs.writeFile(file, bytes)
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== reference.sha256[name]) throw new Error('The public AMI fixture has changed: ' + name)
  return { file: name, url, sha256 }
}
async function main() {
  await fs.mkdir(folder, { recursive: true })
  const annotations = await get('ami_public_manual_1.6.2.zip', base + 'AMICorpusAnnotations/ami_public_manual_1.6.2.zip')
  const zip = await Zip.loadAsync(await fs.readFile(path.join(folder, annotations.file)))
  for (const meeting of meetings) {
    const words = []
    for (const speaker of ['A', 'B', 'C', 'D']) {
      const text = await zip.file(`words/${meeting}.${speaker}.words.xml`).async('string')
      for (const tag of text.matchAll(/<w\s[^>]*>/g)) {
        const start = Number(tag[0].match(/starttime="([0-9.]+)"/)?.[1]), end = Number(tag[0].match(/endtime="([0-9.]+)"/)?.[1])
        if (Number.isFinite(start) && end > start) words.push({ speaker, start, end })
      }
    }
    words.sort((a, b) => a.start - b.start)
    await fs.writeFile(path.join(folder, meeting + '.json'), JSON.stringify(words))
  }
  if (process.argv.includes('--annotations-only')) return
  const signals = await Promise.all(meetings.map(id => get(id + '.wav', process.argv.includes('--mirror')
    ? `https://huggingface.co/datasets/ggfox00000/dia-AMICorpus-all/resolve/main/amicorpus/${id}/audio/${id}.Mix-Headset.wav`
    : `${base}AMICorpusMirror/amicorpus/${id}/audio/${id}.Mix-Headset.wav`)))
  await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ source: base + 'download/', license: 'CC-BY-4.0', annotations, signals }, null, 2))
  if (process.argv.includes('--prepare-only')) return
  const models = await require('./voice-model-fixture.cjs')()
  process.env.TOGLE_TEST_SEGMENTATION = models.segmentation
  process.env.TOGLE_TEST_EMBEDDING = models.embedding
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [path.join(__dirname, 'voice-meetings.cjs'), ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' })
  child.on('exit', code => { process.exitCode = code ?? 1 })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
}
main().catch(error => { console.error(error.stack); process.exitCode = 1 })
