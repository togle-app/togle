// Compare embeddings on held-out utterances, not copies of the enrollment recording.
const { app, utilityProcess } = require('electron')
const fs = require('node:fs'), path = require('node:path')
const { pathToFileURL } = require('node:url')
const { readWave } = require('sherpa-onnx-node')
const folder = path.join(__dirname, '.work/voice-benchmark')
const timeout = setTimeout(() => { console.error('Speaker benchmark timed out'); app.exit(1) }, 180000)
app.whenReady().then(async () => {
  const { voiceSimilarity, VoiceClusters } = await import(pathToFileURL(path.join(__dirname, '.build/togle.mjs')).href)
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'))
  const models = JSON.parse(fs.readFileSync(path.join(folder, 'models.json'), 'utf8'))
  const reports = [], all = {}
  for (const model of models) {
    const worker = utilityProcess.fork(path.join(__dirname, '../out/main/voice-worker.js'), [path.join(folder, model.name), process.env.TOGLE_TEST_SEGMENTATION], { stdio: 'ignore' })
    const waiters = new Map()
    await new Promise((resolve, reject) => worker.on('message', message => {
      if (message.type === 'ready') resolve()
      else if (message.type === 'failed') reject(new Error(message.error))
      else if (message.type === 'result') { waiters.get(message.id)?.(message); waiters.delete(message.id) }
    }))
    const results = []
    for (const person of manifest.people) for (const [index, clip] of person.clips.entries()) {
      const wave = readWave(path.join(folder, clip.file), false)
      const pcm = wave.samples.slice(0, 8 * 16000)
      // Held-out utterances alternate quiet, filtered and noisy channels.
      if (index >= 3) {
        let low = 0
        for (let n = 0; n < pcm.length; n++) { low += .55 * (pcm[n] - low); pcm[n] = (index % 2 ? low : pcm[n]) * .65 + .0015 * Math.sin(n * .79 + index) }
      }
      const started = performance.now()
      const value = await new Promise(resolve => { waiters.set(clip.file, resolve); worker.postMessage({ id: clip.file, pcm }) })
      results.push({ ...value, speaker: person.speaker, index, duration: pcm.length / 16000, ms: performance.now() - started, embedding: value.embedding && Array.from(value.embedding) })
    }
    worker.kill()
    all[model.name] = results
    const enrollment = manifest.people.slice(0, 12).map(person => ({ speaker: person.speaker, samples: results.filter(row => row.speaker === person.speaker && row.index < 3 && row.embedding) }))
    let correct = 0, wrong = 0, unknown = 0, rejectedNew = 0, falseKnown = 0
    const margins = [], same = [], different = []
    for (const row of results.filter(row => row.index >= 3)) {
      const ranked = enrollment.map(person => ({ speaker: person.speaker, score: row.embedding ? Math.max(-1, ...person.samples.map(sample => voiceSimilarity(sample.embedding, row.embedding))) : -1 })).sort((a,b)=>b.score-a.score)
      const best = ranked[0], margin = best.score - ranked[1].score
      const predicted = best.score >= .60 && margin >= .08 ? best.speaker : null
      const known = enrollment.some(person => person.speaker === row.speaker)
      if (known) { if (predicted === row.speaker) correct++; else if (predicted) wrong++; else unknown++; margins.push(margin); same.push(ranked.find(p=>p.speaker===row.speaker).score) }
      else { if (predicted) falseKnown++; else rejectedNew++ }
      different.push(...ranked.filter(p=>p.speaker!==row.speaker).map(p=>p.score))
    }
    const voices = new VoiceClusters(), assignments = new Map(), truth = new Map(), selected = manifest.people.slice(0,5)
    let at = 10000
    for (let turn = 0; turn < 8; turn++) for (const person of selected) {
      const row = results.find(row=>row.speaker===person.speaker&&row.index===turn), end = at + row.duration * 1000
      truth.set(row.id, row.speaker)
      for (const a of voices.observe({ ...row, embedding: row.embedding && new Float32Array(row.embedding), at, end })) assignments.set(a.id, a.voice)
      at = end + 300
    }
    const mapping = new Map()
    for (const [id, voice] of assignments) { if (!mapping.has(voice)) mapping.set(voice, new Map()); const map = mapping.get(voice), speaker = truth.get(id); map.set(speaker, (map.get(speaker)||0)+1) }
    const attributionErrors = [...mapping.values()].reduce((total, counts)=>total+[...counts.values()].reduce((a,b)=>a+b,0)-Math.max(...counts.values()),0)
    const sorted = results.map(r=>r.ms).sort((a,b)=>a-b)
    const report = { model: model.name, returning: {correct,wrong,unknown}, unseen: {falseKnown,rejectedNew}, fivePersonCall: {profiles: voices.size,labeled: assignments.size,turns:40,attributionErrors}, similarity:{sameMin:Math.min(...same),differentMax:Math.max(...different)}, latency:{medianMs:Math.round(sorted[Math.floor(sorted.length/2)]),p95Ms:Math.round(sorted[Math.floor(sorted.length*.95)])} }
    reports.push(report); console.log(JSON.stringify(report))
  }
  fs.writeFileSync(path.join(folder, 'embeddings.json'), JSON.stringify(all))
  fs.writeFileSync(path.join(folder, 'report.json'), JSON.stringify(reports,null,2))
  clearTimeout(timeout); app.exit(0)
}).catch(error => { console.error(error.stack); clearTimeout(timeout); app.exit(1) })
