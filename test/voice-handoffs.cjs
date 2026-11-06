// Public AMI meeting audio, with handoffs selected from annotations before model execution.
// The model sees contiguous audio, never the annotated speaker or transition boundary.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const { readWave } = require('sherpa-onnx-node')
const folder = path.join(__dirname, '.work/voice-meetings'), output = path.join(__dirname, '.work/voice-handoffs')
fs.mkdirSync(output, { recursive: true }); app.setPath('userData', path.join(output, 'profile'))
const timeout = setTimeout(() => { console.error('Handoff evaluation timed out'); app.exit(1) }, 90000)
let worker
app.whenReady().then(async () => {
  const embedding = path.join(__dirname, '.work/voice-benchmark/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx')
  const segmentation = path.join(folder, 'sherpa-onnx-pyannote-segmentation-3-0/model.onnx')
  assert.ok(fs.existsSync(embedding) && fs.existsSync(segmentation), 'Prepare public fixtures with test:voices:meetings first.')
  worker = utilityProcess.fork(path.resolve(__dirname, '../out/main/voice-worker.js'), [embedding, segmentation], { stdio: 'ignore' })
  let pending
  await new Promise((resolve, reject) => {
    worker.on('message', message => {
      if (message.type === 'ready') resolve()
      else if (message.type === 'failed') reject(Error(message.error))
      else if (message.type === 'result') { const done = pending; pending = undefined; done?.(message) }
    })
    worker.on('exit', () => { if (pending) { const done = pending; pending = undefined; done({ stopped: true }) } })
  })
  const results = [], controls = []
  const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'voice-meetings-reference.json'), 'utf8'))
  const similarity = (a, b) => {
    let dot = 0, aa = 0, bb = 0
    for (let n = 0; n < a.length; n++) { dot += a[n] * b[n]; aa += a[n] ** 2; bb += b[n] ** 2 }
    return dot / Math.sqrt(aa * bb)
  }
  const processAudio = async (id, wave, start, end) => {
    const from = Math.round(start * 16000), to = Math.round(end * 16000)
    const pcm = Float32Array.from(wave.samples.subarray(from, to), sample => Math.max(-1, Math.min(1, sample * 12)))
    return new Promise(resolve => { pending = resolve; worker.postMessage({ id, pcm, preview: false, request: id }) })
  }
  for (const name of ['ES2002a', 'ES2003a']) {
    const words = JSON.parse(fs.readFileSync(path.join(folder, name + '.json'), 'utf8')).sort((a, b) => a.start - b.start), turns = []
    for (const word of words) {
      const last = turns.at(-1)
      if (last && last.speaker === word.speaker && word.start - last.end <= .8) { last.words.push(word); last.end = Math.max(last.end, word.end) }
      else turns.push({ speaker: word.speaker, start: word.start, end: word.end, words: [word] })
    }
    const fixtures = []
    for (let n = 0; n < turns.length - 1; n++) {
      const a = turns[n], b = turns[n + 1]
      if (a.speaker === b.speaker || a.words.length < 20 || b.words.length < 4 || b.start < a.end || b.start - a.end > .6) continue
      const start = Math.max(0, a.words.at(-20).start - .08), end = b.words[3].end + .08
      if (end - start > 27 || b.words[3].end - b.start < .7) continue
      fixtures.push({ start, end, boundary: b.start, first: a.speaker, second: b.speaker })
    }
    const wave = readWave(path.join(folder, name + '.wav'), false)
    assert.equal(wave.sampleRate, 16000)
    for (const [n, fixture] of fixtures.entries()) {
      const from = Math.round(fixture.start * 16000)
      const started = performance.now()
      const message = await processAudio(name + '-' + n, wave, fixture.start, fixture.end)
      const slices = message.turns || [], expected = (fixture.boundary * 16000 - from) / 16000
      const error = slices.length > 1 ? Math.min(...slices.slice(1).map(turn => Math.abs(turn.from / 16000 - expected))) : null
      const result = { meeting: name, ...fixture, words: [20, 4], ms: Math.round(performance.now() - started), slices: slices.map(turn => ({ from: turn.from / 16000, to: turn.to / 16000, hasEmbedding: !!turn.embedding })), boundaryErrorMs: error === null ? null : Math.round(error * 1000), detected: error !== null && error <= .4 }
      results.push(result); console.log(JSON.stringify(result))
    }
    const raw = JSON.parse(fs.readFileSync(path.join(folder, `current-${name}-raw.json`), 'utf8'))
    const enrolled = raw.filter(row => reference.meetings[name].enrollment.includes(row.id) && row.embedding)
    // First three eligible clean turns per person, chosen only from manual word times.
    // Exclude enrollment, overlap and handoff windows; no model output selects a control.
    for (const speaker of [...new Set(words.map(word => word.speaker))].sort()) {
      const clean = turns.filter(turn => turn.speaker === speaker && turn.end - turn.start >= 3 && turn.end - turn.start <= 10 && turn.words.length >= 8
        && !words.some(word => word.speaker !== speaker && word.end > turn.start - .08 && word.start < turn.end + .08)
        && !enrolled.some(row => row.start + row.duration > turn.start && row.start < turn.end)
        && !fixtures.some(row => row.end > turn.start && row.start < turn.end)).slice(0, 3)
      for (const [n, turn] of clean.entries()) {
        const started = performance.now(), message = await processAudio(`${name}-control-${speaker}-${n}`, wave, Math.max(0, turn.start - .08), turn.end + .08)
        const slices = message.turns || [message]
        const labels = slices.map(slice => {
          if (!slice.embedding) return null
          const scores = [...new Set(enrolled.map(row => row.speaker))].map(person => ({ person, score: Math.max(...enrolled.filter(row => row.speaker === person).map(row => similarity(row.embedding, slice.embedding))) })).sort((a, b) => b.score - a.score)
          return scores[0]?.score >= .6 && scores[0].score - (scores[1]?.score ?? 0) >= .08 ? scores[0].person : null
        })
        controls.push({ meeting: name, speaker, start: turn.start, end: turn.end, ms: Math.round(performance.now() - started), slices: slices.length, labels, wrong: labels.some(label => label !== null && label !== speaker) })
      }
    }
  }
  const sorted = results.map(result => result.ms).sort((a, b) => a - b)
  const report = { source: 'https://groups.inf.ed.ac.uk/ami/download/', license: 'CC-BY-4.0', kind: 'Fixed regression handoffs: 20 words then 4 words; not end-to-end identity accuracy. Single-speaker controls use independent enrollment.', cases: results.length, detected: results.filter(result => result.detected).length, p95Ms: sorted[Math.ceil(sorted.length * .95) - 1], results, controls, controlSplits: controls.filter(row => row.slices > 1).length, controlWrong: controls.filter(row => row.wrong).length, controlUnknown: controls.filter(row => row.labels.every(label => label === null)).length }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ cases: report.cases, detected: report.detected, p95Ms: report.p95Ms, controls: controls.length, controlSplits: report.controlSplits, controlWrong: report.controlWrong, controlUnknown: report.controlUnknown }))
  assert.ok(results.length >= 5, 'Keep all eligible examples from both fixed meetings.')
  assert.ok(report.detected >= Math.ceil(report.cases * .8), 'At least 80% of these fixed regression handoffs need a boundary within 400 ms.')
  assert.ok(report.p95Ms < 1800, 'Diarization must fit the live transcription deadline.')
  assert.ok(controls.length >= 12, 'Retain independent single-speaker controls across both meetings.')
  assert.equal(report.controlWrong, 0, 'Do not confidently relabel a single-speaker control as someone else.')
  assert.ok(report.controlSplits <= Math.ceil(controls.length * .1), 'At most 10% of clean single-speaker controls may split.')
}).then(() => { worker?.kill(); clearTimeout(timeout); app.exit(0) }, error => { console.error(error.stack); worker?.kill(); clearTimeout(timeout); app.exit(1) })
